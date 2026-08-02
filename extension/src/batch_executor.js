// batch_executor.js — Batch execution engine for the planning-capable agent.
//
// Processes a list of candidates one-by-one, applying the action template
// from the plan to each item. Handles errors gracefully (mark as failed,
// continue), rate limiting, and progress tracking via TaskMemory.
//
// v6.0: MICRO-LOOP — each item gets up to N model steps (configurable),
//   enabling multi-step workflows per candidate (click → navigate → fill form → submit).
// v6.0: SELF-HEALING — detects empty snapshots and ad/tracker redirects,
//   automatically navigates back to the search page to recover.

import { getSettings } from './settings.js';
import { PHASES } from './task_memory.js';
import { buildBatchStepPrompt, safeParseAction, sanitizeCssSelector } from './prompt_builder.js';

// Default constants
const DEFAULT_ACTION_DELAY_MS = 2000;
const DEFAULT_MAX_ACTIONS = 50;
const DEFAULT_BATCH_STEPS_PER_ITEM = 5;

// Ad/tracker domains that signal a bad redirect (page should not stay here)
const KNOWN_AD_DOMAINS = [
  'rtb.mts.ru', 'sm.rtb.mts.ru',
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'facebook.com/tr', 'analytics.google.com',
  'google-analytics.com', 'adservice.google.com',
  'yandex.ru/ads', 'mc.yandex.ru'
];

/**
 * Check if a URL is likely an ad/tracker redirect page.
 * @param {string} url
 * @returns {boolean}
 */
function isAdRedirectUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  // 1x1 pixel tracking URLs often have query params like ?p=, &sz=1x1
  if (/[?&](p|sz|adid|click_id|track)=/.test(lower)) return true;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    for (const domain of KNOWN_AD_DOMAINS) {
      if (hostname === domain || hostname.endsWith('.' + domain)) return true;
    }
  } catch (_) {}
  return false;
}

/**
 * Execute a batch plan over a list of candidates.
 *
 * @param {Object} plan - The plan from the planner (has actionTemplate, criteria, etc.)
 * @param {TaskMemory} memory - The task memory instance (holds candidates + progress)
 * @param {Object} deps - Dependencies injected from background.js:
 *   { settings, getSnapshot, getPageInfo, performAction, captureScreenshot,
 *     callModelWithBackoff, broadcast, sleep, abortCheck, sessionLogger, saveState }
 * @returns {Promise<Object>} report - { ok, processed, succeeded, failed, skipped, errors[] }
 */
export async function runBatch(plan, memory, deps) {
  const {
    settings,
    getSnapshot,
    getPageInfo,
    performAction,
    captureScreenshot,
    callModelWithBackoff,
    broadcast,
    sleep,
    abortCheck,
    sessionLogger,
    saveState  // persistence checkpoint callback — called after each item
  } = deps;

  const actionDelay = settings?.action_delay_ms || DEFAULT_ACTION_DELAY_MS;
  const maxActions = settings?.max_actions_per_session || DEFAULT_MAX_ACTIONS;
  const batchStepsPerItem = settings?.batch_steps_per_item || DEFAULT_BATCH_STEPS_PER_ITEM;

  // Save search page URL to memory if not already set (for self-healing)
  if (!memory.searchPageUrl) {
    try {
      const pi = await getPageInfo();
      if (pi?.url) {
        memory.searchPageUrl = pi.url;
        memory.searchPageTitle = pi.title || '';
        broadcast({ kind: 'log', text: `[batch] Saved search page URL for self-healing: ${pi.url}` });
      }
    } catch (_) {}
  }

  const report = {
    ok: true,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    errors: [],
    totalTokensUsed: 0
  };

  // Trim candidates to max_actions
  const pending = memory.getItemsByStatus('pending');
  if (pending.length === 0) {
    broadcast({ kind: 'log', level: 'error', text: '[batch] No pending items to process' });
    report.ok = false;
    report.errors.push({ id: '__batch__', error: 'No pending items' });
    return report;
  }

  const toProcess = pending.slice(0, maxActions);
  if (pending.length > maxActions) {
    broadcast({ kind: 'log', text: `[batch] Limiting to ${maxActions} items (${pending.length} total pending)` });
  }

  broadcast({
    kind: 'batch_started',
    total: toProcess.length,
    goal: plan.goal || ''
  });

  memory.setPhase(PHASES.EXECUTING);

  for (let i = 0; i < toProcess.length; i++) {
    // Abort check
    if (abortCheck && abortCheck()) {
      broadcast({ kind: 'log', text: '[batch] Aborted by user' });
      report.ok = false;
      break;
    }

    const item = toProcess[i];
    memory.updateItemStatus(item.id, 'processing');

    broadcast({
      kind: 'batch_progress',
      current: i + 1,
      total: toProcess.length,
      itemId: item.id,
      itemTitle: item.title || item.id
    });

    // ── MICRO-LOOP: up to batchStepsPerItem model calls per item ──
    let itemDone = false;
    let itemFailed = false;
    let itemSkipped = false;
    let itemStepsUsed = 0;
    const itemHistory = []; // local action history for this item
    let selfHealed = false; // flag: did we recover from an ad redirect this item?

    try {
      while (itemStepsUsed < batchStepsPerItem && !itemDone && !itemFailed && !itemSkipped) {
        // Abort check inside micro-loop
        if (abortCheck && abortCheck()) {
          broadcast({ kind: 'log', text: '[batch] Aborted by user (micro-loop)' });
          report.ok = false;
          itemFailed = true;
          memory.updateItemStatus(item.id, 'failed', 'aborted');
          report.failed++;
          report.errors.push({ id: item.id, error: 'aborted' });
          break;
        }

        itemStepsUsed++;
        const stepLabel = `${item.id}:step${itemStepsUsed}`;
        broadcast({ kind: 'log', text: `[batch] ${stepLabel} (micro-loop step ${itemStepsUsed}/${batchStepsPerItem})` });

        // 1) Get snapshot + self-healing check
        let snapshot = { elements: [], viewport: {}, url: '', title: '' };
        try {
          snapshot = await getSnapshot();
        } catch (e) {
          broadcast({ kind: 'log', level: 'error', text: `[batch] Snapshot failed for ${stepLabel}: ${e.message}` });
        }

        // ── SELF-HEALING: detect bad page state ──
        const currentUrl = snapshot.url || '';
        const elementCount = snapshot.elements?.length || 0;
        let needsHealing = false;
        let healingReason = '';

        // Check 1: Empty page (no interactive elements)
        if (elementCount === 0 && itemStepsUsed > 1) {
          needsHealing = true;
          healingReason = 'empty_page';
        }

        // Check 2: Ad/tracker redirect
        if (isAdRedirectUrl(currentUrl)) {
          needsHealing = true;
          healingReason = 'ad_redirect';
        }

        // Check 3: Very few elements AND we already did something (not first step)
        // This catches pages that loaded but show unexpected content
        if (elementCount <= 1 && itemStepsUsed > 1 && currentUrl !== memory.searchPageUrl) {
          needsHealing = true;
          healingReason = 'unexpected_page';
        }

        if (needsHealing && memory.searchPageUrl && !selfHealed) {
          broadcast({
            kind: 'log',
            level: 'warn',
            text: `[batch] ${stepLabel} Self-healing: ${healingReason} (url=${currentUrl}, elements=${elementCount}) → navigating to ${memory.searchPageUrl}`
          });
          try {
            await performAction({ action: 'navigate', url: memory.searchPageUrl });
            // Wait for the search page to load
            await sleep(2000);
            // Re-get snapshot after healing
            try {
              snapshot = await getSnapshot();
              broadcast({
                kind: 'log',
                text: `[batch] ${stepLabel} Self-healing complete: ${snapshot.elements?.length || 0} elements on ${snapshot.url}`
              });
            } catch (_) {}
            selfHealed = true;
            // Don't count this as a real step — it's just recovery
            itemStepsUsed--;
            continue; // retry the step
          } catch (healErr) {
            broadcast({
              kind: 'log',
              level: 'error',
              text: `[batch] ${stepLabel} Self-healing failed: ${healErr.message}`
            });
            // Fall through to normal execution — the model will see the bad state
          }
        } else if (needsHealing && selfHealed) {
          // Already tried to heal once this item — don't loop forever
          broadcast({
            kind: 'log',
            level: 'warn',
            text: `[batch] ${stepLabel} Already self-healed once, proceeding with current page state`
          });
        }

        // 2) Get pageInfo
        let pageInfo = { url: '', title: '', bodyText: '' };
        try {
          pageInfo = await getPageInfo();
        } catch (_) {}

        // 3) Build prompt with item history context
        const prompt = buildBatchStepPrompt({
          task: memory.plan?.goal || '',
          userContext: memory.userContext,
          item: { ...item, _stepHistory: itemHistory.slice(-3) }, // last 3 steps for context
          actionTemplate: plan.actionTemplate || {},
          pageInfo,
          snapshot,
          taskMemoryContext: memory.toPromptContext()
        });

        // 4) Call model for this step
        let screenshot = null;
        try {
          broadcast({ kind: 'infra', text: `[batch:${stepLabel}] 📸 Скриншот...` });
          screenshot = await captureScreenshot();
          if (screenshot) broadcast({ kind: 'screenshot_captured', step: stepLabel, hasImage: true });
        } catch (_) {}

        let out;
        try {
          out = await callModelWithBackoff(settings, prompt, screenshot, {
            abortCheck,
            onLog: (text) => broadcast({ kind: 'log', text: `[batch:${stepLabel}] ${text}` }),
            sessionLogger
          });
        } catch (modelErr) {
          broadcast({ kind: 'log', level: 'error', text: `[batch:${stepLabel}] Model call failed: ${modelErr.message}` });
          if (modelErr.message === 'aborted') {
            itemFailed = true;
            memory.updateItemStatus(item.id, 'failed', 'aborted');
            report.failed++;
            report.errors.push({ id: item.id, error: 'aborted' });
            break;
          }
          // Model error on one step — continue to next step (retry)
          itemHistory.push({ step: itemStepsUsed, action: 'model_error', error: modelErr.message });
          continue;
        }

        // Accumulate token usage
        if (out.tokensUsed) {
          report.totalTokensUsed += out.tokensUsed;
        }

        const action = safeParseAction(out.content);

        if (!action) {
          broadcast({ kind: 'log', level: 'error', text: `[batch:${stepLabel}] Unparseable model response` });
          itemHistory.push({ step: itemStepsUsed, action: 'unparseable', response: out.content.slice(0, 200) });
          // Don't fail immediately — model might recover on next step
          if (itemStepsUsed >= batchStepsPerItem) {
            itemFailed = true;
            memory.updateItemStatus(item.id, 'failed', 'unparseable_response');
            report.failed++;
            report.errors.push({ id: item.id, error: 'unparseable_response' });
          }
          continue;
        }

        // ── Terminal actions ──
        if (action.action === 'skip') {
          broadcast({ kind: 'log', text: `[batch:${stepLabel}] Skipped: ${action.reason || 'model decided to skip'}` });
          memory.skipItem(item.id);
          report.skipped++;
          itemSkipped = true;
          itemHistory.push({ step: itemStepsUsed, action: 'skip', reason: action.reason });
          break;
        }

        if (action.action === 'fail') {
          broadcast({ kind: 'log', level: 'error', text: `[batch:${stepLabel}] Failed: ${action.reason}` });
          // In micro-loop: don't fail on first fail — give model a chance to recover
          // Only fail if this is the last step or if the error is clearly permanent
          const permanentErrors = ['captcha', 'login_required', 'blocked', 'forbidden', '403', '401'];
          const isPermanent = permanentErrors.some(e => (action.reason || '').toLowerCase().includes(e));
          if (isPermanent || itemStepsUsed >= batchStepsPerItem) {
            itemFailed = true;
            memory.updateItemStatus(item.id, 'failed', action.reason);
            report.failed++;
            report.errors.push({ id: item.id, error: action.reason });
          } else {
            broadcast({ kind: 'log', text: `[batch:${stepLabel}] Non-permanent fail, will retry next step` });
            itemHistory.push({ step: itemStepsUsed, action: 'fail', reason: action.reason });
          }
          continue;
        }

        if (action.action === 'done') {
          broadcast({ kind: 'log', text: `[batch:${stepLabel}] Done: ${action.result || 'ok'}` });
          memory.updateItemStatus(item.id, 'done', null, action.result || 'ok');
          report.succeeded++;
          itemDone = true;
          itemHistory.push({ step: itemStepsUsed, action: 'done', result: action.result });
          break;
        }

        // ── Non-terminal action: execute it ──
        // Sanitize selector before executing
        if (action.selector) {
          const sanitized = sanitizeCssSelector(action.selector);
          if (sanitized.sanitized) {
            broadcast({ kind: 'log', text: `[batch:${stepLabel}] ⚠ Selector sanitized: "${sanitized.original}" → "${sanitized.selector}"` });
            action.selector = sanitized.selector;
          }
        }

        broadcast({ kind: 'action', step: stepLabel, action });
        let observation;
        try {
          observation = await performAction(action);
        } catch (e) {
          observation = { ok: false, error: e.message };
        }

        broadcast({ kind: 'observation', step: stepLabel, observation });

        // Log to session logger
        if (sessionLogger) {
          sessionLogger.logStep({
            step: stepLabel,
            phase: 'executing',
            screenshotDataUrl: screenshot,
            pageInfo,
            prompt: prompt.slice(0, 3000),
            modelResponse: out.content.slice(0, 3000),
            parsedAction: action,
            observation
          });
        }

        // Record in item history
        itemHistory.push({
          step: itemStepsUsed,
          action: action.action,
          selector: action.selector || action.url || '',
          ok: observation?.ok ?? false,
          error: observation?.error || null
        });

        // Brief delay between micro-loop steps
        if (itemStepsUsed < batchStepsPerItem && !itemDone && !itemFailed && !itemSkipped) {
          await sleep(Math.min(800, actionDelay / 2)); // shorter delay between micro-steps
        }
      } // end micro-loop

      // If we exhausted all steps without done/fail/skip → mark as failed
      if (!itemDone && !itemFailed && !itemSkipped) {
        broadcast({ kind: 'log', level: 'warn', text: `[batch:${item.id}] Exhausted ${batchStepsPerItem} steps without completion` });
        itemFailed = true;
        memory.updateItemStatus(item.id, 'failed', `step_cap_reached (${itemStepsUsed}/${batchStepsPerItem})`);
        report.failed++;
        report.errors.push({ id: item.id, error: `step_cap_reached (${batchStepsPerItem} steps)` });
      }

    } catch (e) {
      broadcast({ kind: 'log', level: 'error', text: `[batch:${item.id}] Exception: ${e.message}` });
      memory.updateItemStatus(item.id, 'failed', e.message);
      report.failed++;
      report.errors.push({ id: item.id, error: e.message });
    }

    report.processed++;

    // Persist state after each item (checkpoint for SW survival)
    if (saveState) {
      try { await saveState(); } catch (_) {}
    }

    // Rate limit delay between items (not after the last one)
    // Use abortable check so "Stop" interrupts the delay immediately
    if (i < toProcess.length - 1) {
      if (abortCheck && abortCheck()) {
        broadcast({ kind: 'log', text: '[batch] Aborted by user (between items)' });
        report.ok = false;
        break;
      }
      // Interruptible delay: check abortFlag every 300ms
      const delayStart = Date.now();
      while (Date.now() - delayStart < actionDelay) {
        if (abortCheck && abortCheck()) {
          broadcast({ kind: 'log', text: '[batch] Aborted by user (delay)' });
          report.ok = false;
          break;
        }
        await sleep(Math.min(300, actionDelay - (Date.now() - delayStart)));
      }
      if (abortCheck && abortCheck()) {
        broadcast({ kind: 'log', text: '[batch] Aborted by user' });
        report.ok = false;
        break;
      }
    }
  }

  memory.setPhase(PHASES.DONE);

  report.ok = report.failed === 0;

  // Broadcast final batch report
  broadcast({
    kind: 'batch_finished',
    report: {
      ...report,
      total: toProcess.length,
      goal: plan.goal || ''
    }
  });

  return report;
}
