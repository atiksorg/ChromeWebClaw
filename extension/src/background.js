// background.js — service worker (MV3 module)
//
// Architecture v4.1 — MV3 service worker survival:
//   - Thin orchestrator that imports modular components:
//     • bus.js          — shared runtime state, broadcast, utilities
//     • cdp.js          — Chrome DevTools Protocol (screenshots, trusted events)
//     • agent_tab.js    — Agent tab lifecycle, frame discovery, content script injection
//     • action_dispatch.js — Maps AI actions to low-level operations
//     • prompt_builder.js  — Prompt construction and response parsing
//     • task_memory.js     — Structured session memory for planning
//     • planner.js         — Strategic task analysis (simple vs batch)
//     • batch_executor.js  — Batch execution engine
//     • persistence.js     — State persistence to chrome.storage.session
//   - background.js owns: the main agent loop, message bus, webnavigation events,
//     CDP detach handling, and top-level orchestration (plan → execute or batch).
//   - PERSISTENCE: After every step, runtime state + TaskMemory are saved to
//     chrome.storage.session. A heartbeat alarm (every ~25s) keeps the SW alive.
//     If the SW is unloaded anyway (memory pressure, browser update), the next
//     alarm or message triggers resume from the last saved checkpoint.

import { getSettings } from './settings.js';
import { callModelWithBackoff } from './providers.js';
import {
  runtime, sleep, broadcast, rehydrateRuntime,
  STEP_CAP_DEFAULT, STEP_DELAY_MS, MAX_HISTORY,
  setIconMode, setBadge,
  removeDnrSessionRules
} from './bus.js';
import {
  cdpDetach, cdpAttach,
  setupNetworkIdleTracking, removeNetworkIdleTracking,
  waitPageReady, captureScreenshot
} from './cdp.js';
import {
  ensureAgentTab, sendToAgentTab,
  ensureContentScript, callFrame, getSnapshot
} from './agent_tab.js';
import { performAction } from './action_dispatch.js';
import { buildAgentPrompt, safeParseAction, extractReasoning } from './prompt_builder.js';
import { TaskMemory, PHASES } from './task_memory.js';
import { planTask } from './planner.js';
import { runBatch } from './batch_executor.js';
import { runVisionLoop, resumeVisionLoop } from './vision_loop.js';
import { SessionLogger } from './session_logger.js';
import {
  saveState, loadState, clearState, isSessionActive,
  startHeartbeat, stopHeartbeat, handleHeartbeatAlarm,
  deserializeMemory
} from './persistence.js';

// ============================================================
// MAIN LOOP (simple task mode — original reactive loop)
// ============================================================

async function startSimpleLoop({ task, context, options, memory, sessionLogger, resumeFromStep }) {
  const settings = await getSettings();
  const stepCap = options?.stepCap || STEP_CAP_DEFAULT;
  const tokenLimit = settings.token_limit || 1000000;

  memory.startedAt = memory.startedAt || Date.now();
  memory.setPhase(PHASES.EXECUTING);

  try {
    while (!runtime.abortFlag && runtime.step < stepCap) {
      // pause support
      while (runtime.pauseFlag && !runtime.abortFlag) {
        await setIconMode('paused');
        await sleep(400);
      }
      if (runtime.abortFlag) break;
      await setIconMode('working');

      runtime.step++;
      broadcast({ kind: 'step_start', step: runtime.step });
      await setIconMode('working');

      // 0) Wait for page readiness (readyState + network idle + DOM stable)
      broadcast({ kind: 'infra', text: '⏳ Ожидание готовности страницы...' });
      try {
        await waitPageReady();
        broadcast({ kind: 'infra', text: '✅ Страница готова' });
      } catch (e) {
        broadcast({ kind: 'log', level: 'error', text: 'waitPageReady failed: ' + e.message });
      }

      // 1) capture screenshot (via CDP if available)
      let screenshot = null;
      try {
        broadcast({ kind: 'infra', text: '📸 Делаем скриншот...' });
        screenshot = await captureScreenshot();
        broadcast({ kind: 'screenshot_captured', step: runtime.step, hasImage: !!screenshot });
        broadcast({ kind: 'infra', text: '📸 Скриншот получен' });
      } catch (e) {
        broadcast({ kind: 'log', level: 'error', text: 'screenshot failed: ' + e.message });
      }

      // 2) DOM snapshot
      let snapshot = { elements: [], viewport: {}, url: '', title: '' };
      try {
        broadcast({ kind: 'infra', text: '🔍 Анализируем DOM...' });
        snapshot = await getSnapshot();
        broadcast({ kind: 'snapshot_ready', step: runtime.step, elementCount: snapshot.elements?.length || 0 });
        broadcast({ kind: 'infra', text: `🔍 Найдено ${snapshot.elements?.length || 0} элементов на странице` });
      } catch (e) {
        broadcast({ kind: 'log', level: 'error', text: 'snapshot failed: ' + e.message });
        // Persist state even on failure, then continue
        await saveState(runtime, memory);
        await sleep(STEP_DELAY_MS);
        continue;
      }
      const pageInfo = {
        url: snapshot.url || '',
        title: snapshot.title || '',
        bodyText: ''
      };
      try {
        const pi = await callFrame({ action: 'pageInfo' });
        pageInfo.bodyText = pi?.bodyText || '';
      } catch (_) {}

      // 3) build prompt + call model
      const prompt = buildAgentPrompt({
        task: runtime.task,
        userContext: runtime.context,
        history: runtime.history,
        pageInfo,
        snapshot,
        taskMemoryContext: memory.items.length > 0 ? memory.toPromptContext() : ''
      });

      let modelText = '';
      let modelCallStart = 0;
      try {
        broadcast({ kind: 'model_call_start', step: runtime.step });
        modelCallStart = Date.now();
        const out = await callModelWithBackoff(settings, prompt, screenshot, {
          abortCheck: () => runtime.abortFlag,
          onLog: (text) => broadcast({ kind: 'log', text }),
          sessionLogger
        });
        modelText = out.content;
        const modelDuration = Date.now() - modelCallStart;
        broadcast({ kind: 'model_call_end', step: runtime.step, duration: modelDuration, tokensUsed: out.tokensUsed || 0 });
        // Accumulate token usage
        if (out.tokensUsed) {
          runtime.totalTokensUsed += out.tokensUsed;
          if (sessionLogger) sessionLogger.logTokens(out.tokensUsed);
          broadcast({ kind: 'tokens_update', tokensUsed: out.tokensUsed, totalTokensUsed: runtime.totalTokensUsed });
        }
        // Token budget check — hard stop if limit exceeded
        if (runtime.totalTokensUsed >= tokenLimit) {
          broadcast({ kind: 'log', level: 'error', text: `🪙 Token limit reached: ${runtime.totalTokensUsed.toLocaleString()} / ${tokenLimit.toLocaleString()}` });
          runtime.running = false;
          await setIconMode('error');
          return { ok: false, reason: 'token_limit_reached', steps: runtime.step };
        }
        broadcast({ kind: 'log', text: `step ${runtime.step} reply: ${modelText.slice(0, 240)}` });
      } catch (e) {
        broadcast({ kind: 'model_call_end', step: runtime.step, duration: Date.now() - modelCallStart, error: e.message });
        broadcast({ kind: 'log', level: 'error', text: 'model call failed: ' + e.message });
        if (sessionLogger) sessionLogger.logError(e);
        if (e.message === 'aborted') break;
        // Persist and retry
        await saveState(runtime, memory);
        await sleep(STEP_DELAY_MS * 2);
        continue;
      }

      const action = safeParseAction(modelText);
      if (!action) {
        broadcast({ kind: 'log', level: 'error', text: 'unparseable reply, retrying' });
        await saveState(runtime, memory);
        await sleep(STEP_DELAY_MS);
        continue;
      }

      // Extract and broadcast AI's reasoning/thoughts before the action
      const thought = extractReasoning(modelText);
      if (thought) {
        broadcast({ kind: 'agent_thought', step: runtime.step, thought });
      }

      broadcast({ kind: 'action', step: runtime.step, action });

      if (action.action === 'done') {
        runtime.running = false;
        await setIconMode('idle');
        return { ok: true, answer: action.answer || '', steps: runtime.step };
      }
      if (action.action === 'fail') {
        runtime.running = false;
        await setIconMode('error');
        return { ok: false, reason: action.reason || 'model reported failure', steps: runtime.step };
      }

      // 4) execute
      let observation;
      try {
        observation = await performAction(action);
      } catch (e) {
        observation = { ok: false, error: e.message };
      }
      broadcast({ kind: 'observation', step: runtime.step, observation });

      // 4b) log step to session logger
      if (sessionLogger) {
        sessionLogger.logStep({
          step: runtime.step,
          phase: memory.phase,
          screenshotDataUrl: screenshot,
          pageInfo,
          prompt: prompt.slice(0, 3000),
          modelResponse: modelText.slice(0, 3000),
          parsedAction: action,
          observation
        });
      }

      // 5) record history
      runtime.history.push({
        action: JSON.stringify(action).slice(0, 500),
        observation: JSON.stringify(observation).slice(0, 500)
      });
      if (runtime.history.length > MAX_HISTORY) {
        runtime.history.splice(0, runtime.history.length - MAX_HISTORY);
      }

      // 5b) PERSIST STATE after every completed step
      await saveState(runtime, memory);

      // 6) brief delay between actions
      await sleep(STEP_DELAY_MS);
    }

    if (runtime.abortFlag) {
      await setIconMode('idle');
      return { ok: false, reason: 'stopped_by_user', steps: runtime.step };
    } else {
      await setIconMode('idle');
      return { ok: false, reason: 'step_cap_reached', steps: runtime.step };
    }
  } catch (e) {
    await setIconMode('error');
    return { ok: false, reason: e.message };
  }
}

// ============================================================
// START AGENT (top-level orchestrator)
// ============================================================

async function startAgent({ task, context, initialUrl, options }) {
  if (runtime.running) return { ok: false, error: 'already_running' };
  const settings = await getSettings();
  // Validate: need model + some form of auth (except Ollama which is local)
  const provider = (settings.provider || '').toLowerCase();
  const isOllama = provider === 'ollama' ||
    (settings.model || '').toLowerCase().startsWith('ollama/') ||
    (settings.api_base_url || '').includes('localhost');
  const hasAuth = !!(settings.auth_token || settings.api_key);
  if (!settings.model || (!hasAuth && !isOllama)) {
    return { ok: false, error: 'missing_settings' };
  }

  runtime.running = true;
  runtime.paused = false;
  runtime.abortFlag = false;
  runtime.pauseFlag = false;
  runtime.step = 0;
  runtime.task = task;
  runtime.context = context || '';
  runtime.history = [];
  runtime.options = options || {};
  runtime.startedAt = Date.now();
  runtime.totalTokensUsed = 0; // reset token counter for new session
  runtime._loopType = 'simple'; // will be updated if batch

  // Initialize task memory
  const memory = new TaskMemory();
  memory.setUserContext(context || '');
  // Expose memory for message bus queries
  runtime._memory = memory;

  try {
    await ensureAgentTab(initialUrl);
  } catch (e) {
    runtime.running = false;
    await setIconMode('error');
    return { ok: false, error: 'agent_tab_failed: ' + e.message };
  }

  // Hide overlays so CDP events pass through to the iframe
  // (only relevant in iframe mode; direct_tab has no overlays)
  if (!runtime.isDirectTab) {
    try { await sendToAgentTab({ kind: 'set_agent_mode', active: true }); } catch (_) {}
  }

  // Initialize session logger
  const sessionLogger = new SessionLogger();
  sessionLogger.setSessionMeta({
    task,
    context,
    model: settings.model,
    provider: settings.provider
  });
  runtime._sessionLogger = sessionLogger;

  broadcast({ kind: 'started', task, tabId: runtime.agentTabId, model: settings.model, provider: settings.provider, tokenLimit: settings.token_limit || 1000000 });
  await setIconMode('working');

  // Start heartbeat to keep SW alive during execution
  startHeartbeat(() => runtime, () => runtime._memory);

  // Persist initial state so resume can pick up even before first step
  await saveState(runtime, memory);

  let result;

  // ============================================================
  // VISION-FIRST MODE: single unified screenshot→model→tool loop
  // ============================================================
  if (settings.vision_mode) {
    runtime._loopType = 'vision';
    broadcast({ kind: 'log', text: '[agent] Vision-First mode: screenshot-only, no DOM snapshots' });
    memory.setPhase(PHASES.EXECUTING);
    broadcast({ kind: 'phase_changed', phase: PHASES.EXECUTING });
    await saveState(runtime, memory);

    result = await runVisionLoop({ task, context, options, memory, sessionLogger });

  } else {
  // ============================================================
  // LEGACY DOM-BASED MODE: planning → simple or batch execution
  // ============================================================

  // ---- PHASE 1: PLANNING ----
  memory.setPhase(PHASES.PLANNING);
  broadcast({ kind: 'phase_changed', phase: PHASES.PLANNING });

  // Capture initial screenshot so the planner can see the current page
  let planningScreenshot = null;
  try {
    broadcast({ kind: 'log', text: '📸 Capturing initial page screenshot for planning...' });
    planningScreenshot = await captureScreenshot();
    if (planningScreenshot) {
      broadcast({ kind: 'screenshot_captured', phase: 'planning', hasImage: true });
      broadcast({ kind: 'log', text: '📸 Initial screenshot captured successfully' });
    }
  } catch (e) {
    broadcast({ kind: 'log', level: 'error', text: '📸 Initial screenshot failed: ' + e.message });
  }

  let plan;
  let planCallStart = Date.now();
  broadcast({ kind: 'model_call_start', step: 0, phase: 'planning' });
  try {
    plan = await planTask(settings, task, context, null, () => runtime.abortFlag,
      (text) => broadcast({ kind: 'log', text }),
      sessionLogger,
      planningScreenshot
    );
    broadcast({ kind: 'model_call_end', step: 0, duration: Date.now() - planCallStart, tokensUsed: plan?.tokensUsed || 0 });
  } catch (e) {
    broadcast({ kind: 'model_call_end', step: 0, duration: Date.now() - planCallStart, error: e.message });
    broadcast({ kind: 'log', level: 'error', text: 'planning failed: ' + e.message });
    plan = { type: 'simple', reason: 'Planning failed: ' + e.message };
  }

  // Accumulate token usage from planning
  if (plan?.tokensUsed) {
    runtime.totalTokensUsed += plan.tokensUsed;
    if (sessionLogger) sessionLogger.logTokens(plan.tokensUsed);
    broadcast({ kind: 'tokens_update', tokensUsed: plan.tokensUsed, totalTokensUsed: runtime.totalTokensUsed });
  }

  memory.setPlan(plan);
  broadcast({ kind: 'plan_ready', plan });
  await saveState(runtime, memory);

  if (plan.type === 'batch') {
    runtime._loopType = 'batch';

    // ---- BATCH MODE ----
    broadcast({ kind: 'log', text: `[planner] batch mode: ${plan.goal || 'no goal specified'}` });

    // Phase: EXTRACTING — tell the model to collect candidates
    memory.setPhase(PHASES.EXTRACTING);
    broadcast({ kind: 'phase_changed', phase: PHASES.EXTRACTING });

    // Build extraction prompt
    const extractPrompt = `You are extracting candidates from a page for a batch task.

BATCH TASK:
"""
${task}
"""

EXTRACTION STRATEGY:
${JSON.stringify(plan.extractionStrategy || {}, null, 2)}

INSTRUCTIONS:
1. Look at the page elements below and extract ALL items that match the criteria.
2. For each item, output a JSON object with: id, title, url (if applicable), and any relevant data fields.
3. Output a JSON array of items: [{"id":"item_1","title":"...","url":"...","data":{...}}, ...]
4. If no items found, output an empty array: []

INTERACTIVE ELEMENTS ON PAGE:
${(await getSnapshot().catch(() => ({ elements: [] }))).elements.slice(0, 80).map((e, i) => {
  const txt = (e.text || '').replace(/\s+/g, ' ').slice(0, 80);
  return `${i + 1}. ${e.tag} | sel=${e.selector} | text="${txt}"`;
}).join('\n')}

CANDIDATES JSON:`;

    let screenshot = null;
    try {
      broadcast({ kind: 'infra', text: '📸 Скриншот для извлечения кандидатов...' });
      screenshot = await captureScreenshot();
      if (screenshot) broadcast({ kind: 'screenshot_captured', phase: 'extracting', hasImage: true });
    } catch (_) {}

    let extractCallStart = Date.now();
    broadcast({ kind: 'model_call_start', step: 0, phase: 'extracting' });
    let extractResult = [];
    try {
      const out = await callModelWithBackoff(settings, extractPrompt, screenshot, {
        abortCheck: () => runtime.abortFlag,
        onLog: (text) => broadcast({ kind: 'log', text: '[extract] ' + text }),
        sessionLogger
      });
      broadcast({ kind: 'model_call_end', step: 0, duration: Date.now() - extractCallStart, tokensUsed: out.tokensUsed || 0 });
      // Parse the extraction result
      const parsed = safeParseAction(out.content);
      // Accumulate token usage from extraction call
      if (out.tokensUsed) {
        runtime.totalTokensUsed += out.tokensUsed;
        if (sessionLogger) sessionLogger.logTokens(out.tokensUsed);
        broadcast({ kind: 'tokens_update', tokensUsed: out.tokensUsed, totalTokensUsed: runtime.totalTokensUsed });
      }
      if (parsed && Array.isArray(parsed.candidates)) {
        extractResult = parsed.candidates;
      } else {
        // Try to parse raw JSON array
        try {
          const m = out.content.match(/\[[\s\S]*\]/);
          if (m) extractResult = JSON.parse(m[0]);
        } catch (_) {}
      }
    } catch (e) {
      broadcast({ kind: 'model_call_end', step: 0, duration: Date.now() - extractCallStart, error: e.message });
      broadcast({ kind: 'log', level: 'error', text: 'extraction failed: ' + e.message });
    }

    // Add extracted items to memory
    if (extractResult.length > 0) {
      memory.addItems(extractResult);
      broadcast({ kind: 'log', text: `[extract] found ${extractResult.length} candidates` });
    } else {
      broadcast({ kind: 'log', text: '[extract] no candidates found, falling back to simple mode' });
      runtime._loopType = 'simple';
      await saveState(runtime, memory);
      // Fall back to simple mode
      result = await startSimpleLoop({ task, context, options, memory, sessionLogger });
      runtime.running = false;
      runtime._memory = null;
      return result;
    }

    // Phase: FILTERING (programmatic, not AI)
    memory.setPhase(PHASES.FILTERING);
    broadcast({ kind: 'phase_changed', phase: PHASES.FILTERING });

    // Apply criteria filters programmatically if possible
    if (plan.criteria?.exclude) {
      for (const item of memory.items) {
        const titleLower = (item.title || '').toLowerCase();
        const shouldExclude = plan.criteria.exclude.some(c => titleLower.includes(c.toLowerCase()));
        if (shouldExclude) {
          memory.skipItem(item.id);
        }
      }
    }

    const pendingCount = memory.getItemsByStatus('pending').length;
    broadcast({ kind: 'log', text: `[filter] ${pendingCount} candidates after filtering` });

    // Phase: CONFIRMING (safe mode only — full autonomy skips this)
    if (settings.autonomy_mode === 'safe') {
      memory.setPhase(PHASES.CONFIRMING);
      broadcast({ kind: 'phase_changed', phase: PHASES.CONFIRMING });
      broadcast({
        kind: 'confirmation_required',
        items: memory.getItemsByStatus('pending').map(i => ({
          id: i.id, title: i.title, url: i.url, data: i.data
        })),
        goal: plan.goal,
        isIrreversible: plan.isIrreversible || false
      });

      // Wait for user confirmation (via 'confirm_batch' message).
      // If user doesn't respond within 10 minutes → pause and wait.
      const confirmed = await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          // User didn't respond — pause the agent instead of auto-confirming
          runtime.pauseFlag = true;
          setIconMode('paused');
          broadcast({ kind: 'log', text: '[confirm] No response — entering PAUSE mode. Press ▶ Resume to continue.' });
          broadcast({ kind: 'paused_for_confirmation',
            items: memory.getItemsByStatus('pending').map(i => ({ id: i.id, title: i.title, url: i.url }))
          });
          saveState(runtime, memory);
          resolve(false);
        }, 10 * 60 * 1000);

        runtime._confirmResolve = () => {
          clearTimeout(timeout);
          runtime._confirmResolve = null;
          resolve(true);
        };
      });

      // If we paused (timeout), wait here until user resumes
      if (!confirmed) {
        while (runtime.pauseFlag && !runtime.abortFlag) {
          await sleep(400);
        }
        if (runtime.abortFlag) {
          result = { ok: false, reason: 'stopped_by_user', steps: runtime.step };
          // Skip to finalization
          memory.setPhase(PHASES.DONE);
          runtime.running = false;
          runtime._memory = null;
          stopHeartbeat();
          await clearState();
          await setIconMode('idle');
          broadcast({ kind: 'finished', ok: false, reason: result.reason, steps: runtime.step });
          return result;
        }
        broadcast({ kind: 'log', text: '[confirm] Resumed after pause — proceeding with batch execution' });
      }
    } else {
      // Full autonomy mode — skip confirmation entirely
      broadcast({ kind: 'log', text: '[confirm] Full autonomy mode — skipping confirmation' });
    }

    // Phase: EXECUTING
    memory.setPhase(PHASES.EXECUTING);
    broadcast({ kind: 'phase_changed', phase: PHASES.EXECUTING });
    await saveState(runtime, memory);

    const batchReport = await runBatch(plan, memory, {
      settings,
      getSnapshot: async () => { await ensureContentScript(); return await getSnapshot(); },
      getPageInfo: async () => { return await callFrame({ action: 'pageInfo' }); },
      performAction,
      captureScreenshot,
      callModelWithBackoff,
      broadcast,
      sleep,
      abortCheck: () => runtime.abortFlag,
      sessionLogger,
      saveState: () => saveState(runtime, memory)
    });

    // Accumulate token usage from batch execution
    if (batchReport.totalTokensUsed) {
      runtime.totalTokensUsed += batchReport.totalTokensUsed;
      if (sessionLogger) sessionLogger.logTokens(batchReport.totalTokensUsed);
      broadcast({ kind: 'tokens_update', tokensUsed: batchReport.totalTokensUsed, totalTokensUsed: runtime.totalTokensUsed });
    }

    result = {
      ok: batchReport.ok,
      answer: `Batch complete: ${batchReport.succeeded}/${batchReport.total} succeeded, ${batchReport.failed} failed, ${batchReport.skipped} skipped`,
      steps: runtime.step,
      report: batchReport
    };

  } else {
    // ---- SIMPLE MODE (original reactive loop) ----
    runtime._loopType = 'simple';
    broadcast({ kind: 'log', text: '[planner] simple mode' });
    result = await startSimpleLoop({ task, context, options, memory, sessionLogger });
  }

  } // end legacy mode (vision_mode === false)

  // Finalize
  memory.setPhase(PHASES.DONE);
  const report = memory.getReport();

  // Finalize session logger: wait for screenshot uploads, then mark complete
  sessionLogger.complete();
  try {
    await sessionLogger.waitForUploads(30000);
    broadcast({ kind: 'log', text: `Session logger: ${sessionLogger.screenshotUrls.size} screenshots uploaded, ${sessionLogger.apiCalls.length} API calls logged` });
  } catch (_) {}

  runtime.running = false;
  runtime._memory = null;

  // Stop heartbeat and clear persisted state (session is over)
  stopHeartbeat();
  await clearState();

  if (result.ok) {
    await setIconMode('idle');
    broadcast({ kind: 'finished', ok: true, answer: result.answer || '', steps: runtime.step });
  } else {
    await setIconMode('error');
    broadcast({ kind: 'finished', ok: false, reason: result.reason || 'unknown', steps: runtime.step });
  }

  return result;
}

// ============================================================
// RESUME AGENT (after SW wake from persisted state)
// ============================================================

/**
 * Attempt to resume an agent session that was interrupted by SW unloading.
 * Loads persisted state, re-attaches infrastructure, and continues the loop.
 *
 * @returns {Promise<boolean>} true if resume was successful
 */
async function attemptResume() {
  const state = await loadState();
  if (!state) return false;

  // Rehydrate runtime from persisted state
  rehydrateRuntime(state);

  // Re-create TaskMemory
  const memory = deserializeMemory(state.memory, TaskMemory);
  // Fix: items that were 'processing' when SW died should be reset to 'pending'
  // so they get retried (idempotent — the worst case is a duplicate click, but
  // that's better than silently dropping the item).
  for (const item of memory.items) {
    if (item.status === 'processing') {
      item.status = 'pending';
    }
  }
  runtime._memory = memory;

  // Re-create session logger (ephemeral — old one is lost)
  const sessionLogger = new SessionLogger();
  const settings = await getSettings();
  sessionLogger.setSessionMeta({
    task: runtime.task,
    context: runtime.context,
    model: settings.model,
    provider: settings.provider
  });
  runtime._sessionLogger = sessionLogger;

  // Re-attach agent tab (may reuse existing tab if still open)
  try {
    await ensureAgentTab();
  } catch (e) {
    broadcast({ kind: 'log', level: 'error', text: '[resume] Agent tab lost, cannot continue: ' + e.message });
    runtime.running = false;
    stopHeartbeat();
    await clearState();
    await setIconMode('error');
    broadcast({ kind: 'finished', ok: false, reason: 'resume_failed: agent tab lost' });
    return false;
  }

  // Re-attach CDP
  try {
    await cdpAttach(runtime.agentTabId);
    setupNetworkIdleTracking();
  } catch (e) {
    broadcast({ kind: 'log', level: 'error', text: '[resume] CDP re-attach failed (non-fatal): ' + e.message });
  }

  // Notify UI
  broadcast({
    kind: 'resumed_after_interrupt',
    step: runtime.step,
    phase: memory.phase,
    loopType: runtime._loopType,
    model: settings.model,
    provider: settings.provider
  });
  broadcast({ kind: 'log', text: `⚡ Resumed from step ${runtime.step} (phase: ${memory.phase}, loop: ${runtime._loopType})` });

  // Restart heartbeat
  startHeartbeat(() => runtime, () => runtime._memory);

  // Resume the appropriate loop
  let result;
  try {
    if (runtime._loopType === 'vision') {
      // Vision-First mode: resume the unified screenshot→model→tool loop
      broadcast({ kind: 'log', text: '[resume] Resuming Vision-First loop' });
      result = await resumeVisionLoop({ memory, sessionLogger });
    } else if (runtime._loopType === 'batch') {
      // For batch mode, resume from the batch execution phase.
      // runBatch reads pending items from memory, so already-processed
      // items (done/failed/skipped) will be skipped automatically.
      //
      // Special case: if we were in CONFIRMING phase (safe mode timeout),
      // we need to re-enter the confirmation flow rather than jumping to execution.
      if (memory.phase === PHASES.CONFIRMING) {
        // Re-emit confirmation_required so the popup shows the panel again
        broadcast({ kind: 'log', text: '[resume] Restoring CONFIRMING phase — waiting for user approval' });
        broadcast({
          kind: 'confirmation_required',
          items: memory.getItemsByStatus('pending').map(i => ({
            id: i.id, title: i.title, url: i.url, data: i.data
          })),
          goal: memory.plan?.goal || '',
          isIrreversible: memory.plan?.isIrreversible || false
        });
        // Set pauseFlag so the main loop waits
        runtime.pauseFlag = true;
        await setIconMode('paused');
        broadcast({
          kind: 'paused_for_confirmation',
          items: memory.getItemsByStatus('pending').map(i => ({ id: i.id, title: i.title, url: i.url }))
        });
        await saveState(runtime, memory);
        // Wait for user to confirm (via confirm_batch) or resume (via resume message)
        while (runtime.pauseFlag && !runtime.abortFlag) {
          await sleep(400);
        }
        if (runtime.abortFlag) {
          result = { ok: false, reason: 'stopped_by_user', steps: runtime.step };
          return false; // will finalize below
        }
        broadcast({ kind: 'log', text: '[resume] User confirmed — proceeding with batch execution' });
      }

      memory.setPhase(PHASES.EXECUTING);
      broadcast({ kind: 'phase_changed', phase: PHASES.EXECUTING });

      if (!memory.plan) {
        throw new Error('Batch plan missing from persisted state');
      }

      const batchReport = await runBatch(memory.plan, memory, {
        settings,
        getSnapshot: async () => { await ensureContentScript(); return await getSnapshot(); },
        getPageInfo: async () => { return await callFrame({ action: 'pageInfo' }); },
        performAction,
        captureScreenshot,
        callModelWithBackoff,
        broadcast,
        sleep,
        abortCheck: () => runtime.abortFlag,
        sessionLogger,
        saveState: () => saveState(runtime, memory)
      });

      // Accumulate token usage from batch execution
      if (batchReport.totalTokensUsed) {
        runtime.totalTokensUsed += batchReport.totalTokensUsed;
        if (sessionLogger) sessionLogger.logTokens(batchReport.totalTokensUsed);
      }

      result = {
        ok: batchReport.ok,
        answer: `Batch complete: ${batchReport.succeeded}/${batchReport.total} succeeded, ${batchReport.failed} failed, ${batchReport.skipped} skipped`,
        steps: runtime.step,
        report: batchReport
      };
    } else {
      // Simple loop — resume from current step
      result = await startSimpleLoop({
        task: runtime.task,
        context: runtime.context,
        options: runtime.options,
        memory,
        sessionLogger
      });
    }
  } catch (e) {
    result = { ok: false, reason: 'resume_error: ' + e.message, steps: runtime.step };
  }

  // Finalize (same as startAgent's finalization)
  memory.setPhase(PHASES.DONE);
  sessionLogger.complete();
  try {
    await sessionLogger.waitForUploads(30000);
  } catch (_) {}

  runtime.running = false;
  runtime._memory = null;
  stopHeartbeat();
  await clearState();

  if (result.ok) {
    await setIconMode('idle');
    broadcast({ kind: 'finished', ok: true, answer: result.answer || '', steps: runtime.step });
  } else {
    await setIconMode('error');
    broadcast({ kind: 'finished', ok: false, reason: result.reason || 'unknown', steps: runtime.step });
  }

  return true;
}

// ============================================================
// CLEANUP
// ============================================================

async function cleanupAgent() {
  runtime.running = false;
  try { await sendToAgentTab({ kind: 'set_agent_mode', active: false }); } catch (_) {}
  try { await cdpDetach(); } catch (_) {}
  removeNetworkIdleTracking();
  // Only remove DNR rules if we were in iframe mode (direct_tab never set them)
  if (!runtime.isDirectTab) {
    try { await removeDnrSessionRules(); } catch (_) {}
  }
  stopHeartbeat();
  await clearState();
  // Keep _sessionLogger alive so user can export reports after session ends.
  // It will be replaced on next startAgent() call.
}

// ============================================================
// MESSAGE BUS
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.kind) {
        case 'start': {
          // Respond immediately so popup UI isn't blocked for the entire session.
          // The actual agent loop runs in the background; status/events are
          // communicated via broadcast().
          sendResponse({ ok: true, started: true });
          try {
            const r = await startAgent({
              task: msg.task,
              context: msg.context,
              initialUrl: msg.initialUrl,
              options: msg.options || {}
            });
            await cleanupAgent();
          } catch (e) {
            broadcast({ kind: 'log', level: 'error', text: 'startAgent failed: ' + e.message });
            broadcast({ kind: 'finished', ok: false, reason: e.message, steps: runtime.step });
            await cleanupAgent();
          }
          break;
        }
        case 'stop':
          runtime.abortFlag = true;
          runtime.pauseFlag = false;
          if (runtime._confirmResolve) runtime._confirmResolve();
          // Immediately detach CDP to prevent reattach cycle and free the tab
          try { await cdpDetach(); } catch (_) {}
          removeNetworkIdleTracking();
          await setIconMode('idle');
          stopHeartbeat();
          await clearState();
          sendResponse({ ok: true });
          break;
        case 'pause':
          runtime.pauseFlag = true;
          await setIconMode('paused');
          await saveState(runtime, runtime._memory);
          sendResponse({ ok: true });
          break;
        case 'resume':
          runtime.pauseFlag = false;
          // Also resolve any pending confirmation wait (safe mode timeout case)
          if (runtime._confirmResolve) {
            runtime._confirmResolve();
          }
          await setIconMode('working');
          await saveState(runtime, runtime._memory);
          sendResponse({ ok: true });
          break;
        case 'confirm_batch':
          if (runtime._confirmResolve) {
            if (msg.removeItems && runtime._memory) {
              for (const id of msg.removeItems) {
                runtime._memory.removeItem(id);
              }
              broadcast({ kind: 'log', text: `[confirm] removed ${msg.removeItems.length} items by user request` });
            }
            runtime._confirmResolve();
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: 'not_waiting_for_confirmation' });
          }
          break;
        case 'get_memory':
          if (runtime._memory) {
            sendResponse({ ok: true, memory: runtime._memory.toStatusPayload() });
          } else {
            sendResponse({ ok: false, error: 'no_active_memory' });
          }
          break;
        case 'status':
          sendResponse({
            running: runtime.running,
            paused: runtime.pauseFlag,
            step: runtime.step,
            task: runtime.task,
            agentTabId: runtime.agentTabId,
            cdpAttached: runtime.cdpAttached,
            phase: runtime._memory?.phase || 'idle',
            taskType: runtime._memory?.taskType || 'simple',
            progress: runtime._memory?.getProgress() || null,
            resumed: !!runtime._resumed,
            totalTokensUsed: runtime.totalTokensUsed
          });
          break;
        case 'get_status_and_logs':
          sendResponse({
            status: {
              running: runtime.running,
              paused: runtime.pauseFlag,
              step: runtime.step,
              task: runtime.task,
              phase: runtime._memory?.phase || 'idle',
              taskType: runtime._memory?.taskType || 'simple',
              totalTokensUsed: runtime.totalTokensUsed
            },
            logBuffer: [...(runtime._logBuffer || [])]
          });
          break;
        case 'openLogs': {
          const url = chrome.runtime.getURL('src/logs.html');
          const tabs = await chrome.tabs.query({ url });
          if (tabs && tabs[0]) {
            await chrome.tabs.update(tabs[0].id, { active: true });
          } else {
            await chrome.tabs.create({ url });
          }
          sendResponse({ ok: true });
          break;
        }
        case 'openSidePanel': {
          // Open the side panel monitoring page.
          // Called from content scripts (overlay widget) which can't use
          // chrome.tabs.create or chrome.sidePanel.open directly.
          try {
            if (sender.tab?.windowId && chrome.sidePanel?.open) {
              await chrome.sidePanel.open({ windowId: sender.tab.windowId });
              sendResponse({ ok: true });
            } else {
              // Fallback: open sidepanel.html as a new tab
              const url = chrome.runtime.getURL('src/sidepanel.html');
              const existing = await chrome.tabs.query({ url });
              if (existing && existing[0]) {
                await chrome.tabs.update(existing[0].id, { active: true });
              } else {
                await chrome.tabs.create({ url });
              }
              sendResponse({ ok: true });
            }
          } catch (e) {
            // Final fallback: open logs page
            try {
              const url = chrome.runtime.getURL('src/sidepanel.html');
              await chrome.tabs.create({ url });
              sendResponse({ ok: true });
            } catch (e2) {
              sendResponse({ ok: false, error: e2.message });
            }
          }
          break;
        }
        case 'openOptions':
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          break;
        case 'export_html_report': {
          const logger = runtime._sessionLogger;
          if (logger) {
            try {
              logger.downloadHtmlReport();
              sendResponse({ ok: true });
            } catch (e) {
              sendResponse({ ok: false, error: e.message });
            }
          } else {
            sendResponse({ ok: false, error: 'no_active_session' });
          }
          break;
        }
        case 'export_api_log': {
          const logger = runtime._sessionLogger;
          if (logger) {
            try {
              logger.downloadApiLog();
              sendResponse({ ok: true });
            } catch (e) {
              sendResponse({ ok: false, error: e.message });
            }
          } else {
            sendResponse({ ok: false, error: 'no_active_session' });
          }
          break;
        }
        case 'ping':
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: 'unknown_kind', kind: msg.kind });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

// ============================================================
// HEARTBEAT ALARM HANDLER
// ============================================================

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const handled = await handleHeartbeatAlarm(
    alarm,
    () => runtime,
    () => runtime._memory
  );

  if (handled && !runtime.running) {
    // Heartbeat fired but runtime says "not running" — this means the SW
    // was reloaded and lost its in-memory state. Attempt resume from storage.
    await attemptResume();
  }
});

// ============================================================
// WEBNAVIGATION: keep frameId fresh
// ============================================================

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.tabId === runtime.agentTabId) {
    runtime.frameId = null;
  }
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.tabId === runtime.agentTabId) {
    broadcast({ kind: 'log', text: `navigated: ${details.url}` });
  }
});

// ============================================================
// CDP EVENT: handle debugger disconnection
// ============================================================

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === runtime.agentTabId) {
    runtime.cdpAttached = false;
    runtime.cdpTarget = null;
    broadcast({ kind: 'log', level: 'error', text: `CDP detached: ${reason}` });

    // Don't reattach if agent is stopping or already stopped
    if (!runtime.running || runtime.abortFlag) return;

    // Prevent infinite detach→reattach cycles
    // Use exponential backoff and limit consecutive retries
    const detachReason = reason || 'unknown';

    // If detach reason is 'canceled_by_user', it often means DevTools is open
    // or user interacted with the debugger — aggressive reattach will loop forever
    if (detachReason === 'canceled_by_user') {
      // Allow only 1 quick reattach attempt, then give up
      if (!_cdpReattachCount) _cdpReattachCount = 0;
      _cdpReattachCount++;
      if (_cdpReattachCount > 2) {
        broadcast({ kind: 'log', level: 'error', text: `CDP: too many canceled_by_user detaches (${_cdpReattachCount}), stopping reattach. Close DevTools if open.` });
        return;
      }
    }

    const delay = 2000 * Math.min(_cdpReattachCount || 1, 4); // 2s, 4s, 8s, 8s...
    sleep(delay).then(() => {
      // Re-check conditions after delay
      if (runtime.running && !runtime.abortFlag && runtime.agentTabId) {
        cdpAttach(runtime.agentTabId).then(() => {
          // Reset counter on successful reattach
          if (detachReason !== 'canceled_by_user') _cdpReattachCount = 0;
        }).catch(() => {});
      }
    });
  }
});

let _cdpReattachCount = 0;

// Hotkey
chrome.commands?.onCommand.addListener((cmd) => {
  if (cmd === 'toggle') {
    if (runtime.running) {
      runtime.abortFlag = true;
      broadcast({ kind: 'finished', ok: false, reason: 'hotkey_stop', steps: runtime.step });
    } else {
      broadcast({ kind: 'log', text: 'hotkey: use the popup to start with a task' });
    }
  }
});

// ============================================================
// INIT: check for persisted session on SW startup
// ============================================================

chrome.runtime.onInstalled.addListener(async () => {
  await setIconMode('idle');
  // Check if there's a persisted session from before the update
  await attemptResume();
});

chrome.runtime.onStartup?.addListener(async () => {
  await setIconMode('idle');
  // Browser was restarted — check for persisted session
  await attemptResume();
});

// On module load (SW wake): check for persisted session.
// This runs every time the service worker module is evaluated,
// which happens on SW wake from any event.
(async () => {
  try {
    const active = await isSessionActive();
    if (active && !runtime.running) {
      // Small delay to let any pending messages/alarm events fire first
      await sleep(500);
      if (!runtime.running) {
        await attemptResume();
      }
    }
  } catch (_) {}
})();
