// bus.js — Shared runtime state and utility functions.
//
// Extracted from background.js. Holds:
//   - Shared runtime state (running, paused, step counter, agent tab id, etc.)
//   - Utility functions (sleep, broadcast, setBadge, setIconMode)
//   - DNR session rule management
//
// All other modules (cdp.js, agent_tab.js, action_dispatch.js, background.js)
// import from here to access shared state and broadcast events.

// ============================================================
// RUNTIME STATE (singleton, shared across all modules)
// ============================================================

export const runtime = {
  running: false,
  paused: false,
  abortFlag: false,
  pauseFlag: false,
  step: 0,
  agentTabId: null,       // chrome tab id of agent.html
  agentChannel: null,      // channel id for messaging agent.js
  frameId: null,           // the iframe's frameId inside agent.html
  task: '',
  context: '',
  history: [],
  options: {},
  startedAt: 0,
  totalTokensUsed: 0,     // accumulated token count from AI model responses
  // CDP state
  cdpAttached: false,
  cdpTarget: null,        // { tabId } or { tabId, frameId }
  // Network idle tracking
  networkRequestCount: 0,
  networkIdleTimer: null,
  networkIdlePromise: null,
  // DOM stability tracking
  domMutationCount: 0,
  domStableTimer: null,
  domStablePromise: null,
  // Persistence: loop type (needed to resume correct loop after SW wake)
  _loopType: null,        // 'simple' | 'batch'
  // Persistence: ephemeral references (NOT serialized, re-created on wake)
  _memory: null,
  _sessionLogger: null,
  _confirmResolve: null
};

/**
 * Restore runtime fields from a persisted state object (from chrome.storage.session).
 * Only overwrites serializable fields — ephemeral references (_memory, _sessionLogger, etc.)
 * and infrastructure state (cdpAttached, networkIdle) are left untouched.
 *
 * @param {Object} state — deserialized state from persistence.loadState()
 */
export function rehydrateRuntime(state) {
  if (!state) return;
  runtime.running = state.running ?? false;
  runtime.pauseFlag = state.pauseFlag ?? false;
  runtime.abortFlag = false; // never persisted — always start clean
  runtime.step = state.step ?? 0;
  runtime.agentTabId = state.agentTabId ?? null;
  runtime.agentChannel = state.agentChannel ?? null;
  runtime.frameId = state.frameId ?? null;
  runtime.task = state.task ?? '';
  runtime.context = state.context ?? '';
  runtime.history = Array.isArray(state.history) ? state.history : [];
  runtime.options = state.options ?? {};
  runtime.startedAt = state.startedAt ?? 0;
  runtime.totalTokensUsed = state.totalTokensUsed ?? 0;
  runtime._loopType = state.loopType ?? 'simple';
  // Mark that this session was resumed (not freshly started)
  runtime._resumed = true;
}

// ============================================================
// CONSTANTS
// ============================================================

export const STEP_CAP_DEFAULT = 200;
export const STEP_DELAY_MS = 1200;
export const MAX_HISTORY = 10;
export const CDP_VERSION = '1.3';

// DNR session rule IDs (must be unique within the session ruleset)
export const DNR_RULE_IDS = { xfo: 1001, csp: 1002, cspReport: 1003 };

// ============================================================
// UTILITY
// ============================================================

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Broadcast an event to all listening extension pages (popup, logs, agent tab).
 * Every message gets a timestamp and is prefixed with kind='agent_event'.
 */
export function broadcast(msg) {
  msg = { ...msg, ts: Date.now() };
  // popup
  chrome.runtime.sendMessage({ kind: 'agent_event', ...msg }).catch(() => {});
  // log page (lives in extension pages, so use tabs.sendMessage to all extension pages)
  chrome.tabs.query({ url: chrome.runtime.getURL('src/logs.html') }, (tabs) => {
    for (const t of tabs || []) {
      chrome.tabs.sendMessage(t.id, { kind: 'agent_event', ...msg }).catch(() => {});
    }
  });
}

// ============================================================
// BADGE / ICON
// ============================================================

export async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: color || '#2563eb' });
    await chrome.action.setBadgeText({ text: String(text || '').slice(0, 6) });
  } catch (_) {}
}

export async function setIconMode(mode) {
  // mode: 'idle' | 'working' | 'paused' | 'waiting' | 'error'
  const color =
    mode === 'working' ? '#16a34a' :
    mode === 'waiting' ? '#0ea5e9' :
    mode === 'paused'  ? '#ca8a04' :
    mode === 'error'   ? '#dc2626' : '#374151';
  await setBadge(runtime.step > 0 ? String(runtime.step) : '·', color);
}

// ============================================================
// DNR SESSION RULES (iframe header bypass — scoped to agent tab ONLY)
// ============================================================

/**
 * Apply session-scoped DNR rules to remove X-Frame-Options and CSP headers
 * ONLY for sub_frames inside the agent tab.
 *
 * @param {number} tabId - The agent tab ID to scope rules to
 */
export async function applyDnrSessionRules(tabId) {
  if (!tabId) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [DNR_RULE_IDS.xfo, DNR_RULE_IDS.csp, DNR_RULE_IDS.cspReport],
      addRules: [
        {
          id: DNR_RULE_IDS.xfo,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            responseHeaders: [
              { header: 'x-frame-options', operation: 'remove' },
              { header: 'X-Frame-Options', operation: 'remove' }
            ]
          },
          condition: {
            tabIds: [tabId],
            resourceTypes: ['sub_frame']
          }
        },
        {
          id: DNR_RULE_IDS.csp,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            responseHeaders: [
              { header: 'content-security-policy', operation: 'remove' },
              { header: 'Content-Security-Policy', operation: 'remove' }
            ]
          },
          condition: {
            tabIds: [tabId],
            resourceTypes: ['sub_frame']
          }
        },
        {
          id: DNR_RULE_IDS.cspReport,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            responseHeaders: [
              { header: 'content-security-policy-report-only', operation: 'remove' }
            ]
          },
          condition: {
            tabIds: [tabId],
            resourceTypes: ['sub_frame']
          }
        }
      ]
    });
    broadcast({ kind: 'log', text: `DNR session rules applied for tab ${tabId}` });
  } catch (e) {
    broadcast({ kind: 'log', level: 'error', text: `DNR session rules failed: ${e.message}` });
  }
}

/** Remove all session-scoped DNR rules (called when agent stops). */
export async function removeDnrSessionRules() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [DNR_RULE_IDS.xfo, DNR_RULE_IDS.csp, DNR_RULE_IDS.cspReport]
    });
  } catch (_) {}
}
