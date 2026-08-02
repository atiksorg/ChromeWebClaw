// batch_executor.js — Batch execution engine for the planning-capable agent.
//
// Processes a list of candidates one-by-one, applying the action template
// from the plan to each item. Handles errors gracefully (mark as failed,
// continue), rate limiting, and progress tracking via TaskMemory.
//
// Used for tasks like: "Apply to all jobs", "Add all items to cart",
// "Extract all emails", etc.

import { getSettings } from './settings.js';
import { PHASES } from './task_memory.js';
import { buildBatchStepPrompt, safeParseAction } from './prompt_builder.js';

// Default constants
const DEFAULT_ACTION_DELAY_MS = 2000;
const DEFAULT_MAX_ACTIONS = 50;

/**
 * Execute a batch plan over a list of candidates.
 *
 * @param {Object} plan - The plan from the planner (has actionTemplate, criteria, etc.)
 * @param {TaskMemory} memory - The task memory instance (holds candidates + progress)
 * @param {Object} deps - Dependencies injected from background.js:
 *   { settings, getSnapshot, getPageInfo, performAction, captureScreenshot,
 *     callModelWithBackoff, broadcast, sleep, abortCheck, onLog }
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

    try {
      // Build the step prompt with task memory context
      let snapshot = { elements: [], viewport: {}, url: '', title: '' };
      try {
        snapshot = await getSnapshot();
      } catch (e) {
        broadcast({ kind: 'log', level: 'error', text: `[batch] Snapshot failed for ${item.id}: ${e.message}` });
      }

      let pageInfo = { url: '', title: '', bodyText: '' };
      try {
        pageInfo = await getPageInfo();
      } catch (_) {}

      const prompt = buildBatchStepPrompt({
        task: memory.plan?.goal || '',
        userContext: memory.userContext,
        item,
        actionTemplate: plan.actionTemplate || {},
        pageInfo,
        snapshot,
        taskMemoryContext: memory.toPromptContext()
      });

      // Call model for this item
      let screenshot = null;
      try {
        screenshot = await captureScreenshot();
      } catch (_) {}

      const out = await callModelWithBackoff(settings, prompt, screenshot, {
        abortCheck,
        onLog: (text) => broadcast({ kind: 'log', text: `[batch:${item.id}] ${text}` }),
        sessionLogger
      });

      // Accumulate token usage from this batch step
      if (out.tokensUsed) {
        report.totalTokensUsed += out.tokensUsed;
      }

      const action = safeParseAction(out.content);

      if (!action) {
        broadcast({ kind: 'log', level: 'error', text: `[batch:${item.id}] Unparseable model response` });
        memory.updateItemStatus(item.id, 'failed', 'unparseable_response');
        report.failed++;
        report.errors.push({ id: item.id, error: 'unparseable_response' });
      } else if (action.action === 'skip') {
        broadcast({ kind: 'log', text: `[batch:${item.id}] Skipped: ${action.reason || 'model decided to skip'}` });
        memory.skipItem(item.id);
        report.skipped++;
      } else if (action.action === 'fail') {
        broadcast({ kind: 'log', level: 'error', text: `[batch:${item.id}] Failed: ${action.reason}` });
        memory.updateItemStatus(item.id, 'failed', action.reason);
        report.failed++;
        report.errors.push({ id: item.id, error: action.reason });
      } else if (action.action === 'done') {
        broadcast({ kind: 'log', text: `[batch:${item.id}] Done: ${action.result || 'ok'}` });
        memory.updateItemStatus(item.id, 'done', null, action.result || 'ok');
        report.succeeded++;
      } else {
        // Execute the action the model returned
        broadcast({ kind: 'action', step: `${item.id}`, action });
        let observation;
        try {
          observation = await performAction(action);
        } catch (e) {
          observation = { ok: false, error: e.message };
        }

        broadcast({ kind: 'observation', step: `${item.id}`, observation });

        // Log to session logger
        if (sessionLogger) {
          sessionLogger.logStep({
            step: `batch:${item.id}`,
            phase: 'executing',
            screenshotDataUrl: screenshot,
            pageInfo,
            prompt: prompt.slice(0, 3000),
            modelResponse: out.content.slice(0, 3000),
            parsedAction: action,
            observation
          });
        }

        if (observation?.ok) {
          memory.updateItemStatus(item.id, 'done', null, JSON.stringify(observation).slice(0, 200));
          report.succeeded++;
        } else {
          memory.updateItemStatus(item.id, 'failed', observation?.error || 'action_failed');
          report.failed++;
          report.errors.push({ id: item.id, error: observation?.error || 'action_failed' });
        }
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
    if (i < toProcess.length - 1 && !(abortCheck && abortCheck())) {
      await sleep(actionDelay);
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
