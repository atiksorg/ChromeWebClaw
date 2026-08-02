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
  // Try to reuse an existing agent tab if one is open
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

  // Attach CDP to the agent tab
  try {
    await cdpAttach(tab.id);
    setupNetworkIdleTracking();
  } catch (e) {
    broadcast({ kind: 'log', level: 'error', text: 'CDP attach failed: ' + e.message });
    // CDP failure is not fatal — fall back to captureVisibleTab
  }

  // Apply DNR session rules to bypass X-Frame-Options and CSP
  // ONLY for this specific agent tab — other user tabs are unaffected
  const settings = await getSettings();
  if (settings.iframe_bypass_enabled !== false) {
    await applyDnrSessionRules(tab.id);
  }

  return tab;
}

export async function sendToAgentTab(msg) {
  if (!runtime.agentChannel || !runtime.agentTabId) return null;
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
 */
function findMainContentFrame(frames) {
  if (!frames || !frames.length) return null;
  const topFrame = frames.find(x => x.parentFrameId === -1);
  const topFrameId = topFrame ? topFrame.frameId : 0;
  const candidates = frames.filter(
    x => x.parentFrameId === topFrameId && x.url && !x.url.startsWith('chrome-extension://')
  );
  if (!candidates.length) return null;
  return candidates[0];
}

export async function callFrame(payload) {
  if (!runtime.agentTabId) throw new Error('no_agent_tab');
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
