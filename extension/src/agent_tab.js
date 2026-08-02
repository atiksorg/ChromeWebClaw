// agent_tab.js — Agent tab lifecycle management.
//
// Manages the dedicated agent tab (agent.html), content script injection,
// frame discovery, communication with the agent tab, and screenshot capture.
//
// Extracted from background.js to separate tab management from agent logic.

import { runtime, sleep, broadcast, applyDnrSessionRules } from './bus.js';
import { cdpAttach, setupNetworkIdleTracking, captureScreenshot } from './cdp.js';
import { getSettings } from './settings.js';

// ============================================================
// AGENT TAB MANAGEMENT
// ============================================================

export async function ensureAgentTab(initialUrl) {
  const settings = await getSettings();

  if (settings.use_direct_tab) {
    // ─── DIRECT TAB MODE: work in the user's active tab ───
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      // No usable active tab — create a new one
      tab = await chrome.tabs.create({ url: initialUrl || 'about:blank', active: true });
      // Wait a moment for the tab to be ready
      await sleep(500);
    } else if (initialUrl && tab.url !== initialUrl) {
      // Navigate the existing tab to the initialUrl
      await chrome.tabs.update(tab.id, { url: initialUrl });
      await sleep(500);
    }
    runtime.agentTabId = tab.id;
    runtime.isDirectTab = true;
    // In direct tab mode we don't use agent.js channel or DNR iframe bypass
    runtime.agentChannel = '__direct__';
    runtime.frameId = null; // messages go to top-level frame

    broadcast({ kind: 'log', text: `[direct_tab] Using tab ${tab.id}: ${tab.url || 'new'}` });
  } else {
    // ─── IFRAME MODE (default): create agent.html with an iframe ───
    runtime.isDirectTab = false;
    const extUrl = chrome.runtime.getURL('src/agent.html');
    const existing = await chrome.tabs.query({ url: extUrl });
    let tab;
    if (existing && existing[0]) {
      tab = existing[0];
      try { await chrome.tabs.update(tab.id, { active: true }); } catch (_) {}
    } else {
      tab = await chrome.tabs.create({ url: extUrl, active: true });
    }
    runtime.agentTabId = tab.id;

    // Wait until agent.js announces its channel
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('agent_tab_timeout')), 10000);
      const handler = (msg) => {
        if (msg && msg.kind === 'agent_tab_ready' && msg.channel) {
          runtime.agentChannel = msg.channel;
          chrome.runtime.onMessage.removeListener(handler);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.runtime.onMessage.addListener(handler);
      // nudge in case it was already loaded
      chrome.tabs.sendMessage(tab.id, { kind: 'ping' }).catch(() => {});
    });

    // Set URL if provided
    if (initialUrl) {
      await sendToAgentTab({ kind: 'set_url', url: initialUrl });
    }
  }

  // Populate ad domain blocklist from settings (for frame discovery filtering)
  try {
    const adBlocklistStr = settings.ad_domain_blocklist || '';
    findMainContentFrame._adBlocklist = adBlocklistStr
      .split(',')
      .map(d => d.trim().toLowerCase())
      .filter(Boolean);
  } catch (_) {}

  // Attach CDP to the agent/direct tab (works for both modes)
  try {
    await cdpAttach(runtime.agentTabId);
    setupNetworkIdleTracking();
  } catch (e) {
    broadcast({ kind: 'log', level: 'error', text: 'CDP attach failed: ' + e.message });
    // CDP failure is not fatal — fall back to captureVisibleTab
  }

  // Apply DNR session rules to bypass X-Frame-Options and CSP
  // ONLY needed in iframe mode (direct_tab doesn't use iframes)
  if (!runtime.isDirectTab) {
    const settings2 = await getSettings();
    if (settings2.iframe_bypass_enabled !== false) {
      await applyDnrSessionRules(runtime.agentTabId);
    }
  }

  return { id: runtime.agentTabId };
}

export async function sendToAgentTab(msg) {
  if (!runtime.agentTabId) return null;
  // In direct_tab mode, there's no agent.js channel — skip
  if (runtime.isDirectTab) return null;
  if (!runtime.agentChannel) return null;
  return await chrome.tabs.sendMessage(runtime.agentTabId, { channel: runtime.agentChannel, ...msg });
}

export function getAgentFrameId() {
  return runtime.frameId;
}

// ============================================================
// CONTENT SCRIPT INJECTION (into the iframe)
// ============================================================

export async function ensureContentScript() {
  if (!runtime.agentTabId) throw new Error('no_agent_tab');
  // Prefer injecting into the discovered frame; fall back to all frames.
  const target = { tabId: runtime.agentTabId };
  if (runtime.frameId != null) {
    target.frameIds = [runtime.frameId];
  } else {
    target.allFrames = true;
  }
  try {
    await chrome.scripting.executeScript({
      target,
      files: ['src/content.js']
    });
  } catch (_) {}
}

/**
 * Discover the main content frame inside the agent tab.
 * The agent tab contains: top-level (agent.html) → main iframe (target site) → child iframes (ads, analytics).
 * We need the direct child iframe of the top-level frame (parentFrameId === topFrameId).
 * Among those, we prefer the one with the largest area, and exclude chrome-extension:// URLs.
 * Ad/tracker domains are filtered out using settings.ad_domain_blocklist.
 */
function findMainContentFrame(frames) {
  if (!frames || !frames.length) return null;
  const topFrame = frames.find(x => x.parentFrameId === -1);
  const topFrameId = topFrame ? topFrame.frameId : 0;

  // Build blacklist of ad/tracker domains (lazy-loaded from runtime cache)
  const blocklist = findMainContentFrame._adBlocklist || [];

  const candidates = frames.filter(x => {
    if (x.parentFrameId !== topFrameId) return false;
    if (!x.url) return false;
    if (x.url.startsWith('chrome-extension://')) return false;
    // Filter out ad/tracker domains
    try {
      const hostname = new URL(x.url).hostname.toLowerCase();
      for (const adDomain of blocklist) {
        if (hostname === adDomain || hostname.endsWith('.' + adDomain)) return false;
      }
    } catch (_) {}
    return true;
  });
  if (!candidates.length) return null;
  return candidates[0];
}

// Initialize ad blocklist cache (will be populated from settings on first use)
findMainContentFrame._adBlocklist = [];

export async function callFrame(payload) {
  if (!runtime.agentTabId) throw new Error('no_agent_tab');

  // In direct_tab mode, content.js is injected directly into the user's tab
  // (no agent.html/iframe), so we always send to the top-level frame.
  if (runtime.isDirectTab) {
    return await chrome.tabs.sendMessage(runtime.agentTabId, payload);
  }

  // IFRAME MODE: discover the main iframe inside agent.html
  if (!runtime.frameId) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: runtime.agentTabId }).catch(() => []);
    const f = findMainContentFrame(frames);
    if (f) runtime.frameId = f.frameId;
  }
  if (runtime.frameId != null) {
    try {
      return await chrome.tabs.sendMessage(runtime.agentTabId, payload, { frameId: runtime.frameId });
    } catch (e) {
      // frame may have navigated; reset and try once more after re-discovery
      runtime.frameId = null;
      const frames = await chrome.webNavigation.getAllFrames({ tabId: runtime.agentTabId }).catch(() => []);
      const f = findMainContentFrame(frames);
      if (f) {
        runtime.frameId = f.frameId;
        return await chrome.tabs.sendMessage(runtime.agentTabId, payload, { frameId: runtime.frameId });
      }
      throw e;
    }
  }
  return await chrome.tabs.sendMessage(runtime.agentTabId, payload);
}

export async function getSnapshot() {
  await ensureContentScript();
  return await callFrame({ action: 'snapshot', options: { maxElements: 120 } });
}
