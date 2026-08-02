// planner.js — Strategic task planner for the planning-capable agent.
//
// Called ONCE before the agent starts executing. Analyzes the task description
// and determines whether it's a simple reactive task or a batch task that
// requires structured planning, candidate extraction, and per-item execution.
//
// For batch tasks: calls the model with a specialized planning prompt
// (no screenshot needed — text-only analysis) to produce a structured plan
// that drives the executor loop.
//
// For simple tasks: returns { type: 'simple' } and the agent falls back to
// the original reactive loop.

import { callModelWithBackoff } from './providers.js';
import { buildPlannerPrompt, safeParsePlan } from './prompt_builder.js';

// ============================================================
// HEURISTIC: detect batch-worthy tasks from keywords
// ============================================================

const BATCH_KEYWORDS = [
  // English
  'all', 'each', 'every', 'multiple', 'batch',
  'apply to', 'apply for', 'apply to all',
  'extract all', 'extract every', 'collect all',
  'fill all', 'fill out all', 'fill in all',
  'add all', 'add to cart', 'add every',
  'send to all', 'email all', 'message all',
  'delete all', 'remove all', 'close all',
  'open all', 'click all', 'download all',
  'monitor all', 'check all', 'scrape all',
  'compare all', 'list all', 'summarize all',
  // Patterns like "Apply to 50 jobs"
  'jobs', 'vacancies', 'positions', 'listings',
  'products', 'items', 'services',
  // Russian
  'все', 'каждый', 'каждую', 'каждое', 'всем',
  'откликнуться на все', 'откликнуться на кажд',
  'извлечь все', 'собрать все', 'найти все',
  'заполнить все', 'добавить все', 'удалить все',
  'отправить всем', 'написать всем',
  'вакансии', 'товары', 'продукты', 'объявления'
];

/**
 * Quick heuristic: does the task text suggest a batch operation?
 * Returns true if batch keywords are found. This is a fast pre-filter;
 * the final decision is made by the model in the planning prompt.
 */
function looksLikeBatchTask(taskText) {
  const lower = taskText.toLowerCase();
  return BATCH_KEYWORDS.some(kw => lower.includes(kw));
}

// ============================================================
// PLANNER: one-shot task analysis
// ============================================================

/**
 * Analyze a task and produce a structured plan.
 *
 * @param {Object} settings - Full settings object (model, auth, etc.)
 * @param {string} task - User's task description
 * @param {string} userContext - User context (resume, contacts, templates)
 * @param {Object|null} currentPageInfo - Current page info { url, title } (optional)
 * @param {Function} abortCheck - () => boolean, returns true if agent should stop
 * @param {Function} onLog - (text) => void, for broadcasting log messages
 * @returns {Promise<Object>} plan - { type: 'simple' } or { type: 'batch', ... }
 */
export async function planTask(settings, task, userContext, currentPageInfo, abortCheck, onLog, sessionLogger) {
  // Fast path: if heuristic says "simple", skip the model call entirely
  if (!looksLikeBatchTask(task)) {
    if (onLog) onLog('[planner] heuristic: simple task (no batch keywords)');
    return { type: 'simple', reason: 'No batch keywords detected in task description' };
  }

  if (onLog) onLog('[planner] heuristic: batch keywords detected, calling model for analysis...');

  // Build the planning prompt (text-only, no screenshot)
  const prompt = buildPlannerPrompt({ task, userContext, currentPageInfo });

  try {
    const out = await callModelWithBackoff(settings, prompt, null, {
      abortCheck,
      onLog: (text) => { if (onLog) onLog('[planner] ' + text); },
      sessionLogger
    });

    const plan = safeParsePlan(out.content);

    if (!plan) {
      if (onLog) onLog('[planner] model returned unparseable plan, falling back to simple');
      return { type: 'simple', reason: 'Model returned unparseable plan', tokensUsed: out.tokensUsed || 0 };
    }

    plan.tokensUsed = out.tokensUsed || 0;
    if (onLog) onLog(`[planner] plan type: ${plan.type}${plan.goal ? ' — ' + plan.goal : ''}`);
    return plan;
  } catch (e) {
    if (onLog) onLog('[planner] model call failed: ' + e.message + ' — falling back to simple');
    return { type: 'simple', reason: 'Planner model call failed: ' + e.message };
  }
}
