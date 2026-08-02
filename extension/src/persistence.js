// persistence.js — State persistence layer for MV3 service worker survival.
//
// MV3 service workers can be unloaded at any time (~30s of inactivity).
// This module ensures the agent's runtime state survives unloads by
// persisting critical state to chrome.storage.session (RAM-only, no disk).
//
// Architecture:
//   - saveState()   — serialize runtime + TaskMemory → chrome.storage.session
//   - loadState()   — deserialize from chrome.storage.session → runtime + TaskMemory
//   - clearState()  — wipe persisted state (on normal stop/completion)
//   - startHeartbeat() / stopHeartbeat() — chrome.alarms to keep SW alive
//   - isSessionActive() — check if there's a persisted active session
//
// What gets persisted:
//   - Agent control: running, step, task, context, history, options, startedAt
//   - Tab/infra:     agentTabId, agentChannel, frameId
//   - TaskMemory:    phase, taskType, plan, items, userContext
//   - Flags:         pauseFlag (abortFlag is NOT persisted — abort is immediate)
//
// What does NOT get persisted (ephemeral, re-established on wake):
//   - cdpAttached, cdpTarget — CDP session must be re-attached
//   - networkIdle*, domStable* — transient tracking state
//   - _memory, _sessionLogger, _confirmResolve — runtime-only references

const STORAGE_KEY = 'webclaw_agent_state';
const HEARTBEAT_ALARM = 'webclaw_heartbeat';
const HEARTBEAT_INTERVAL_MINUTES = 0.4; // ~24 seconds (Chrome minimum is ~30s, but we try)

// ============================================================
// SAVE STATE
// ============================================================

/**
 * Persist the current agent state to chrome.storage.session.
 * Called after every step completion and on critical state changes.
 *
 * @param {Object} runtime — the runtime object from bus.js
 * @param {TaskMemory|null} memory — the TaskMemory instance (optional)
 */
export async function saveState(runtime, memory) {
  if (!runtime.running) return; // don't persist idle state

  const state = {
    // Timestamp of last save (for staleness detection)
    savedAt: Date.now(),

    // Agent control
    running: runtime.running,
    step: runtime.step,
    task: runtime.task,
    context: runtime.context,
    history: runtime.history.slice(-10), // keep last 10
    options: runtime.options,
    startedAt: runtime.startedAt,

    // Token usage
    totalTokensUsed: runtime.totalTokensUsed || 0,

    // Tab/infra (needed to reconnect after wake)
    agentTabId: runtime.agentTabId,
    agentChannel: runtime.agentChannel,
    frameId: runtime.frameId,

    // Pause state
    pauseFlag: runtime.pauseFlag,

    // TaskMemory serialization
    memory: memory ? serializeMemory(memory) : null,

    // Loop type (needed to resume the correct loop)
    loopType: runtime._loopType || 'simple', // 'simple' | 'batch'

    // Direct Tab mode
    isDirectTab: runtime.isDirectTab || false,

    // Log buffer (for UI restoration after SW wake)
    logBuffer: runtime._logBuffer ? runtime._logBuffer.slice(-runtime._logBufferMax) : []
  };

  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: state });
  } catch (e) {
    // storage.session might be unavailable in some contexts
    console.warn('[persistence] save failed:', e.message);
  }
}

// ============================================================
// LOAD STATE
// ============================================================

/**
 * Load persisted agent state from chrome.storage.session.
 * Returns null if no active session was persisted.
 *
 * @returns {Promise<Object|null>} the persisted state or null
 */
export async function loadState() {
  try {
    const data = await chrome.storage.session.get(STORAGE_KEY);
    const state = data[STORAGE_KEY];
    if (!state || !state.running) return null;

    // Staleness check: if state is older than 10 minutes, consider it dead
    // (e.g., browser was closed, then reopened)
    const age = Date.now() - (state.savedAt || 0);
    if (age > 10 * 60 * 1000) {
      await clearState();
      return null;
    }

    return state;
  } catch (e) {
    console.warn('[persistence] load failed:', e.message);
    return null;
  }
}

// ============================================================
// CLEAR STATE
// ============================================================

/**
 * Wipe persisted state. Called on normal stop/completion and on cleanup.
 */
export async function clearState() {
  try {
    await chrome.storage.session.remove(STORAGE_KEY);
  } catch (_) {}
}

// ============================================================
// IS SESSION ACTIVE
// ============================================================

/**
 * Quick check: is there a persisted active session?
 * Does NOT load full state — just checks the flag.
 */
export async function isSessionActive() {
  try {
    const data = await chrome.storage.session.get(STORAGE_KEY);
    const state = data[STORAGE_KEY];
    return !!(state && state.running);
  } catch (_) {
    return false;
  }
}

// ============================================================
// HEARTBEAT (chrome.alarms)
// ============================================================

/**
 * Start a repeating alarm that keeps the service worker alive.
 * Each alarm tick also saves state as a side effect.
 *
 * @param {Function} getRuntime — () => runtime, to access current state for save
 * @param {Function} getMemory — () => TaskMemory|null
 */
export function startHeartbeat(getRuntime, getMemory) {
  // Clear any existing heartbeat
  chrome.alarms.clear(HEARTBEAT_ALARM).catch(() => {});

  // Create repeating alarm. Chrome enforces a minimum of ~30 seconds
  // for MV3 alarms, but periodInMinutes below that just means "as often as allowed".
  chrome.alarms.create(HEARTBEAT_ALARM, {
    delayInMinutes: HEARTBEAT_INTERVAL_MINUTES,
    periodInMinutes: HEARTBEAT_INTERVAL_MINUTES
  });
}

/**
 * Stop the heartbeat alarm.
 */
export function stopHeartbeat() {
  chrome.alarms.clear(HEARTBEAT_ALARM).catch(() => {});
}

/**
 * Handle a heartbeat alarm event. Returns true if it was our heartbeat.
 *
 * @param {chrome.alarms.Alarm} alarm
 * @param {Function} getRuntime
 * @param {Function} getMemory
 * @returns {Promise<boolean>} true if this was a heartbeat alarm
 */
export async function handleHeartbeatAlarm(alarm, getRuntime, getMemory) {
  if (alarm.name !== HEARTBEAT_ALARM) return false;

  const rt = getRuntime();
  if (rt.running) {
    await saveState(rt, getMemory());
  }
  return true;
}

// ============================================================
// TASK MEMORY SERIALIZATION
// ============================================================

/**
 * Serialize a TaskMemory instance to a plain JSON-compatible object.
 */
function serializeMemory(memory) {
  return {
    phase: memory.phase,
    taskType: memory.taskType,
    plan: memory.plan,
    items: memory.items,
    userContext: memory.userContext,
    errors: memory.errors,
    startedAt: memory.startedAt,
    completedAt: memory.completedAt,
    searchPageUrl: memory.searchPageUrl || '',
    searchPageTitle: memory.searchPageTitle || ''
  };
}

/**
 * Deserialize a plain object back into a TaskMemory instance.
 * The caller must import TaskMemory and pass it here.
 *
 * @param {Object} data — serialized memory from storage
 * @param {Function} TaskMemoryClass — the TaskMemory constructor
 * @returns {TaskMemory}
 */
export function deserializeMemory(data, TaskMemoryClass) {
  const memory = new TaskMemoryClass();
  if (!data) return memory;

  memory.phase = data.phase || 'idle';
  memory.taskType = data.taskType || 'simple';
  memory.plan = data.plan || null;
  memory.items = data.items || [];
  memory.userContext = data.userContext || '';
  memory.errors = data.errors || [];
  memory.startedAt = data.startedAt || 0;
  memory.completedAt = data.completedAt || 0;
  memory.searchPageUrl = data.searchPageUrl || '';
  memory.searchPageTitle = data.searchPageTitle || '';

  return memory;
}
