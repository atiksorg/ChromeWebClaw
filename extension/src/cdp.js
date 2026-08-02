// cdp.js — Chrome DevTools Protocol layer.
//
// Manages CDP attachment, screenshot capture, trusted input events (click/type/scroll/keypress),
// network idle detection, and DOM stability checks.
//
// Extracted from background.js to separate infrastructure concerns from agent logic.

import { runtime, sleep, broadcast, CDP_VERSION } from './bus.js';

// ============================================================
// CDP LIFECYCLE
// ============================================================

/**
 * Attach to the agent tab via CDP. This enables:
 * - Page.captureScreenshot (works even when tab is not active)
 * - Input.dispatchMouseEvent / Input.dispatchKeyEvent (trusted, isTrusted:true)
 * - Network domain events for idle detection
 * - Page lifecycle events
 */
export async function cdpAttach(tabId) {
  if (runtime.cdpAttached && runtime.cdpTarget?.tabId === tabId) {
    return; // already attached
  }
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
    runtime.cdpAttached = true;
    runtime.cdpTarget = { tabId };
    broadcast({ kind: 'log', text: `CDP attached to tab ${tabId}` });
  } catch (e) {
    // May already be attached by another debugger
    if (e.message && e.message.includes('already attached')) {
      runtime.cdpAttached = true;
      runtime.cdpTarget = { tabId };
    } else {
      broadcast({ kind: 'log', level: 'error', text: `CDP attach failed: ${e.message}` });
      throw e;
    }
  }
}

/** Detach CDP from the current tab. */
export async function cdpDetach() {
  if (!runtime.cdpAttached || !runtime.cdpTarget) return;
  try {
    await chrome.debugger.detach(runtime.cdpTarget);
  } catch (_) {}
  runtime.cdpAttached = false;
  runtime.cdpTarget = null;
}

/** Send a CDP command and return the result. */
export async function cdpSend(method, params = {}) {
  if (!runtime.cdpAttached || !runtime.cdpTarget) {
    throw new Error('cdp_not_attached');
  }
  try {
    return await chrome.debugger.sendCommand(runtime.cdpTarget, method, params);
  } catch (e) {
    // If detached, try to reattach once
    if (e.message && (e.message.includes('Detached') || e.message.includes('not attached'))) {
      if (runtime.agentTabId) {
        await cdpAttach(runtime.agentTabId);
        return await chrome.debugger.sendCommand(runtime.cdpTarget, method, params);
      }
    }
    throw e;
  }
}

// ============================================================
// CDP-BASED ACTIONS (trusted events via chrome.debugger)
// ============================================================

/**
 * Perform a trusted click via CDP Input.dispatchMouseEvent.
 * This generates isTrusted:true events that bypass anti-bot checks.
 */
export async function cdpClick(x, y) {
  // mouseMoved → mousePressed → mouseReleased sequence
  await cdpSend('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x, y, button: 'left', clickCount: 0
  });
  await sleep(50);
  await cdpSend('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1
  });
  await sleep(50);
  await cdpSend('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1
  });
}

/**
 * Perform trusted keyboard input via CDP Input.insertText.
 * Uses the dedicated CDP insertText command which correctly handles
 * any Unicode characters: Cyrillic, CJK, emoji, special symbols, etc.
 */
export async function cdpType(text) {
  await cdpSend('Input.insertText', { text });
}

/**
 * Perform a trusted key press via CDP.
 */
export async function cdpPressKey(key) {
  const keyMap = {
    'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
    'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
    'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
    'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    'Delete': { key: 'Delete', code: 'Delete', keyCode: 46 },
    'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    'Space': { key: ' ', code: 'Space', keyCode: 32 }
  };
  const k = keyMap[key] || { key, code: key, keyCode: key.charCodeAt(0) };
  await cdpSend('Input.dispatchKeyEvent', {
    type: 'keyDown', key: k.key, code: k.code,
    windowsVirtualKeyCode: k.keyCode,
    nativeVirtualKeyCode: k.keyCode
  });
  await sleep(30);
  await cdpSend('Input.dispatchKeyEvent', {
    type: 'keyUp', key: k.key, code: k.code,
    windowsVirtualKeyCode: k.keyCode,
    nativeVirtualKeyCode: k.keyCode
  });
}

// ============================================================
// SCREENSHOT VIA CDP (works in background, no tab focus needed)
// ============================================================

/**
 * Capture screenshot using CDP Page.captureScreenshot.
 * Falls back to captureVisibleTab if CDP is not available.
 * Returns a data:image/png;base64,... URL.
 */
export async function captureScreenshot() {
  if (!runtime.agentTabId) throw new Error('no_agent_tab');

  // Try CDP screenshot first (works even when tab is not active)
  if (runtime.cdpAttached) {
    try {
      const result = await cdpSend('Page.captureScreenshot', {
        format: 'png',
        quality: 85,
        captureBeyondViewport: false
      });
      if (result?.data) {
        return 'data:image/png;base64,' + result.data;
      }
    } catch (e) {
      broadcast({ kind: 'log', level: 'error', text: 'CDP screenshot failed: ' + e.message });
    }
  }

  // Fallback: captureVisibleTab (requires tab to be active)
  try {
    try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}
    await sleep(200);
    return await chrome.tabs.captureVisibleTab(runtime.agentTabId, { format: 'png' });
  } catch (e) {
    broadcast({ kind: 'log', level: 'error', text: 'captureVisibleTab failed: ' + e.message });
    if (/No window/i.test(e.message)) {
      try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}
      await sleep(500);
      return await chrome.tabs.captureVisibleTab(runtime.agentTabId, { format: 'png' });
    }
    throw e;
  }
}

// ============================================================
// NETWORK IDLE DETECTION
// ============================================================

// Singleton listener reference — prevents duplicate registration on repeated agent runs.
let _networkListenerAttached = false;
let _networkEventListener = null;

/**
 * Enable CDP Network domain and start tracking request count.
 * Network idle = 0 in-flight requests for `idleMs` milliseconds.
 * Safe to call multiple times — idempotent.
 */
export function setupNetworkIdleTracking() {
  if (_networkListenerAttached) return;

  _networkEventListener = (_source, method, _params) => {
    if (!runtime.cdpAttached) return;
    if (method === 'Network.requestWillBeSent') {
      runtime.networkRequestCount++;
      clearTimeout(runtime.networkIdleTimer);
      runtime.networkIdleTimer = null;
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      runtime.networkRequestCount = Math.max(0, runtime.networkRequestCount - 1);
      if (runtime.networkRequestCount === 0 && !runtime.networkIdleTimer) {
        runtime.networkIdleTimer = setTimeout(() => {
          if (runtime.networkIdlePromise) {
            runtime.networkIdlePromise.resolve();
            runtime.networkIdlePromise = null;
          }
        }, 500);
      }
    }
  };

  chrome.debugger.onEvent.addListener(_networkEventListener);
  _networkListenerAttached = true;
}

/** Tear down network idle listener and reset counters. */
export function removeNetworkIdleTracking() {
  if (_networkListenerAttached && _networkEventListener) {
    try { chrome.debugger.onEvent.removeListener(_networkEventListener); } catch (_) {}
    _networkListenerAttached = false;
    _networkEventListener = null;
  }
  runtime.networkRequestCount = 0;
  clearTimeout(runtime.networkIdleTimer);
  runtime.networkIdleTimer = null;
}

/** Wait for network to be idle (no pending requests for 500ms). */
export async function waitForNetworkIdle(timeoutMs = 10000) {
  try {
    await cdpSend('Network.enable');
  } catch (_) {}

  if (runtime.networkRequestCount === 0) {
    await sleep(300);
    if (runtime.networkRequestCount === 0) return;
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      runtime.networkIdlePromise = null;
      resolve();
    }, timeoutMs);

    runtime.networkIdlePromise = {
      resolve: () => { clearTimeout(timer); resolve(); }
    };
  });
}

// ============================================================
// DOM STABILITY DETECTION
// ============================================================

/**
 * Wait for DOM to stabilize: no mutations for `stableMs` milliseconds.
 */
export async function waitForDomStability(timeoutMs = 8000, stableMs = 300) {
  const start = Date.now();

  // Check readyState
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await cdpSend('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true
      });
      if (result?.result?.value === 'complete') break;
    } catch (_) {
      break;
    }
    await sleep(200);
  }

  // Wait for DOM stabilization period
  await sleep(stableMs);
}

// ============================================================
// COMBINED WAIT: readyState + network idle + DOM stable
// ============================================================

/**
 * Comprehensive page readiness check before each agent step:
 * 1. document.readyState === 'complete'
 * 2. Network idle: no XHR/Fetch for 500ms
 * 3. DOM stable: no mutations for 300ms
 */
export async function waitPageReady() {
  const { getSettings } = await import('./settings.js');
  const settings = await getSettings();
  const networkIdleMs = settings.spa_network_idle_ms || 500;
  const domStableMs = settings.spa_dom_stable_ms || 300;

  // 1. ReadyState
  await waitForDomStability(10000, 0);

  // 2. Network idle
  try {
    await waitForNetworkIdle(8000);
  } catch (_) {
    await sleep(networkIdleMs);
  }

  // 3. DOM stability
  await sleep(domStableMs);
}
