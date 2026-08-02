// vision_loop.js — Vision-First Agent main loop.
//
// A single, unified ReAct cycle that replaces all prior loops
// (simple loop, batch loop, planner, batch executor):
//
//   screenshot → model (vision prompt) → tool execution → repeat
//
// The model sees ONLY the screenshot + task + compact action log.
// No DOM snapshots, no CSS selectors, no complex planning phases.
// The model itself decides when to extract, filter, batch, etc.
//
// Visual stagnation detection: compares sampled pixels between
// consecutive screenshots to detect when the screen hasn't changed.

import { getSettings } from './settings.js';
import { callModelWithBackoff } from './providers.js';
import { runtime, sleep, broadcast, STEP_CAP_DEFAULT, STEP_DELAY_MS, MAX_HISTORY, setIconMode } from './bus.js';
import { waitPageReady, captureScreenshot } from './cdp.js';
import { sendToAgentTab } from './agent_tab.js';
import { executeVisionTool } from './vision_tools.js';
import {
  VISION_SYSTEM_PROMPT,
  buildVisionPrompt,
  parseVisionResponse,
  extractVisionThinking
} from './vision_prompt.js';
import { PHASES } from './task_memory.js';
import {
  saveState
} from './persistence.js';

// ============================================================
// SCREENSHOT HASH — simple pixel sampling for stagnation detection
// ============================================================

/**
 * Compute a quick hash from a data URL screenshot by sampling bytes.
 * Not cryptographically secure — just enough to detect "same screen".
 *
 * Samples 64 evenly-spaced characters from the middle of the base64 data
 * and concatenates them into a fingerprint string.
 *
 * @param {string} dataUrl — data:image/png;base64,...
 * @returns {string} hash fingerprint
 */
function screenshotHash(dataUrl) {
  if (!dataUrl) return '';
  // Extract base64 payload (skip "data:image/png;base64,")
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  if (b64.length < 200) return b64;

  const SAMPLES = 64;
  const step = Math.floor(b64.length / SAMPLES);
  let hash = '';
  for (let i = 0; i < SAMPLES; i++) {
    hash += b64[i * step];
  }
  return hash;
}

// ============================================================
// VISION-FIRST LOOP
// ============================================================

/**
 * The main Vision-First agent loop.
 *
 * @param {Object} params
 * @param {string} params.task — user's task description
 * @param {string} params.context — user context (resume, contacts)
 * @param {Object} params.options — stepCap, etc.
 * @param {TaskMemory} params.memory — task memory instance
 * @param {SessionLogger} params.sessionLogger — session logger
 * @returns {Promise<{ok, answer?, reason?, steps}>}
 */
export async function runVisionLoop({ task, context, options, memory, sessionLogger }) {
  const settings = await getSettings();
  const stepCap = options?.stepCap || STEP_CAP_DEFAULT;
  const tokenLimit = settings.token_limit || 1000000;

  memory.startedAt = memory.startedAt || Date.now();
  memory.setPhase(PHASES.EXECUTING);

  // Visual stagnation tracking
  let prevScreenshotHash = '';
  let consecutiveSameScreen = 0;

  try {
    while (!runtime.abortFlag && runtime.step < stepCap) {
      // Pause support
      while (runtime.pauseFlag && !runtime.abortFlag) {
        await setIconMode('paused');
        await sleep(400);
      }
      if (runtime.abortFlag) break;
      await setIconMode('working');

      runtime.step++;
      broadcast({ kind: 'step_start', step: runtime.step });

      // 0) Wait for page readiness
      broadcast({ kind: 'infra', text: '⏳ Ожидание готовности страницы...' });
      try {
        await waitPageReady();
        broadcast({ kind: 'infra', text: '✅ Страница готова' });
      } catch (e) {
        broadcast({ kind: 'log', level: 'error', text: 'waitPageReady failed: ' + e.message });
      }

      // 1) Capture screenshot
      let screenshot = null;
      try {
        broadcast({ kind: 'infra', text: '📸 Делаем скриншот...' });
        screenshot = await captureScreenshot();
        broadcast({ kind: 'screenshot_captured', step: runtime.step, hasImage: !!screenshot });
        broadcast({ kind: 'infra', text: '📸 Скриншот получен' });
      } catch (e) {
        broadcast({ kind: 'log', level: 'error', text: 'screenshot failed: ' + e.message });
        await sleep(STEP_DELAY_MS);
        continue;
      }

      if (!screenshot) {
        broadcast({ kind: 'log', level: 'error', text: 'No screenshot captured, retrying...' });
        await sleep(STEP_DELAY_MS);
        continue;
      }

      // 2) Visual stagnation detection
      const currentHash = screenshotHash(screenshot);
      if (currentHash && currentHash === prevScreenshotHash) {
        consecutiveSameScreen++;
      } else {
        consecutiveSameScreen = 0;
      }
      prevScreenshotHash = currentHash;

      if (consecutiveSameScreen >= 8) {
        broadcast({ kind: 'log', level: 'warn', text: `⚠️ Visual stagnation: screen unchanged for ${consecutiveSameScreen} steps. Forcing scroll.` });
        // Auto-scroll as a recovery action
        await executeVisionTool({ tool: 'scroll', direction: 'down', amount: 400 });
        await sleep(800);
        consecutiveSameScreen = 0;
        // Re-capture screenshot after scroll
        try { screenshot = await captureScreenshot(); } catch (_) {}
        prevScreenshotHash = screenshotHash(screenshot);
      }

      // 3) Get current page info for the prompt
      let currentUrl = '';
      let pageTitle = '';
      try {
        if (runtime.isDirectTab) {
          const tab = await chrome.tabs.get(runtime.agentTabId);
          currentUrl = tab?.url || '';
          pageTitle = tab?.title || '';
        } else {
          const r = await sendToAgentTab({ kind: 'get_url' });
          currentUrl = r?.url || '';
        }
      } catch (_) {}

      // 4) Build vision prompt
      const userMessage = buildVisionPrompt({
        task: runtime.task,
        userContext: runtime.context,
        currentUrl,
        pageTitle,
        history: runtime.history,
        step: runtime.step,
        consecutiveSame: consecutiveSameScreen,
        taskMemoryContext: memory.items.length > 0 || memory.scratchpad.length > 0 ? memory.toPromptContext() : ''
      });

      // 5) Call model with screenshot
      let modelText = '';
      let modelCallStart = 0;
      try {
        broadcast({ kind: 'model_call_start', step: runtime.step });
        modelCallStart = Date.now();
        const out = await callModelWithBackoff(settings, userMessage, screenshot, {
          abortCheck: () => runtime.abortFlag,
          onLog: (text) => broadcast({ kind: 'log', text }),
          sessionLogger,
          systemPrompt: VISION_SYSTEM_PROMPT
        });
        modelText = out.content;
        const modelDuration = Date.now() - modelCallStart;
        broadcast({ kind: 'model_call_end', step: runtime.step, duration: modelDuration, tokensUsed: out.tokensUsed || 0 });
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
        broadcast({ kind: 'log', text: `step ${runtime.step} reply: ${modelText.slice(0, 300)}` });
      } catch (e) {
        broadcast({ kind: 'model_call_end', step: runtime.step, duration: Date.now() - modelCallStart, error: e.message });
        broadcast({ kind: 'log', level: 'error', text: 'model call failed: ' + e.message });
        if (sessionLogger) sessionLogger.logError(e);
        if (e.message === 'aborted') break;
        await saveState(runtime, memory);
        await sleep(STEP_DELAY_MS * 2);
        continue;
      }

      // 6) Parse response
      const action = parseVisionResponse(modelText);
      if (!action) {
        broadcast({ kind: 'log', level: 'error', text: 'unparseable reply, retrying: ' + modelText.slice(0, 200) });
        await saveState(runtime, memory);
        await sleep(STEP_DELAY_MS);
        continue;
      }

      // Extract and broadcast AI's reasoning
      const thought = extractVisionThinking(action);
      if (thought) {
        broadcast({ kind: 'agent_thought', step: runtime.step, thought });
      }

      broadcast({ kind: 'action', step: runtime.step, action });

      // 6b) Save notes to scratchpad if present
      if (action.notes && Array.isArray(action.notes) && action.notes.length > 0) {
        memory.addNotes(action.notes);
        broadcast({ kind: 'log', text: `📝 Saved ${action.notes.length} notes to scratchpad` });
      }

      // 7) Terminal checks
      if (action.tool === 'done') {
        runtime.running = false;
        await setIconMode('idle');
        return { ok: true, answer: action.answer || '', steps: runtime.step };
      }
      if (action.tool === 'fail') {
        runtime.running = false;
        await setIconMode('error');
        return { ok: false, reason: action.reason || 'model reported failure', steps: runtime.step };
      }

      // 8) Execute tool
      let observation;
      try {
        observation = await executeVisionTool(action);
      } catch (e) {
        observation = { ok: false, error: e.message };
      }
      broadcast({ kind: 'observation', step: runtime.step, observation });

      // 9) Log step
      if (sessionLogger) {
        sessionLogger.logStep({
          step: runtime.step,
          phase: memory.phase,
          screenshotDataUrl: screenshot,
          pageInfo: { url: currentUrl, title: pageTitle },
          prompt: userMessage.slice(0, 3000),
          modelResponse: modelText.slice(0, 3000),
          parsedAction: action,
          observation
        });
      }

      // 10) Record history (compact — for action log in next prompt)
      runtime.history.push({
        action: JSON.stringify(action).slice(0, 500),
        observation: JSON.stringify(observation).slice(0, 500)
      });
      if (runtime.history.length > MAX_HISTORY) {
        runtime.history.splice(0, runtime.history.length - MAX_HISTORY);
      }

      // 11) Persist state
      await saveState(runtime, memory);

      // 12) Brief delay
      await sleep(STEP_DELAY_MS);
    }

    // Step cap or abort
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
// RESUME: Vision loop resumption after SW wake
// ============================================================

/**
 * Resume the vision loop from persisted state.
 * Called by attemptResume() when the loop type is 'vision'.
 */
export async function resumeVisionLoop({ memory, sessionLogger }) {
  const settings = await getSettings();
  const task = runtime.task;
  const context = runtime.context;
  const options = runtime.options || {};

  return await runVisionLoop({ task, context, options, memory, sessionLogger });
}
