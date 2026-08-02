// prompt_builder.js — All prompt construction and response parsing.
//
// Extracted from background.js to be reusable across:
//   - Executor (single-step agent loop)
//   - Planner (one-shot task analysis)
//   - Batch step executor (per-item action in batch mode)

// ============================================================
// EXECUTOR PROMPT (single-step, vision-based)
// ============================================================

/**
 * Build the executor prompt: screenshot + DOM snapshot + history → one next action.
 * This is the original agent prompt from background.js.
 */
export function buildAgentPrompt({ task, userContext, history, pageInfo, snapshot, taskMemoryContext }) {
  const elementsList = (snapshot.elements || []).slice(0, 80).map((e, i) => {
    const txt = (e.text || '').replace(/\s+/g, ' ').slice(0, 80);
    const r = e.rect || {};
    return `${i + 1}. ${e.tag}` +
      (e.id ? `#${e.id}` : '') +
      (e.classes ? `.${String(e.classes).split(/\s+/).slice(0, 2).join('.')}` : '') +
      ` | sel=${e.selector}` +
      (e.aria ? ` | aria=${e.aria}` : '') +
      (e.placeholder ? ` | ph="${e.placeholder}"` : '') +
      (e.disabled ? ' | DISABLED' : '') +
      (txt ? ` | text="${txt}"` : '') +
      ` | pos=(${r.x},${r.y}) ${r.w}x${r.h}`;
  }).join('\n');

  const historyTxt = (history || []).map((h, i) =>
    `#${i + 1} ${h.action}\n→ ${h.observation || ''}`
  ).join('\n\n');

  return `You are an autonomous browser agent. You SEE a screenshot of the current page AND get a structured element list with CSS selectors, coordinates and text. Drive the page by emitting EXACTLY ONE next action as a single JSON object.

${userContext ? `USER CONTEXT (use this when filling forms, writing cover letters, choosing filters):\n"""\n${userContext}\n"""\n\n` : ''}OVERALL TASK (keep going until done or impossible):
"""
${task}
"""

PAGE:
- URL: ${pageInfo.url}
- Title: ${pageInfo.title}
- Body text (first 1500 chars): ${(pageInfo.bodyText || '').slice(0, 1500)}
- Viewport: ${snapshot.viewport?.w}x${snapshot.viewport?.h}, scrollY=${snapshot.viewport?.scrollY}/${snapshot.viewport?.scrollMax}

INTERACTIVE ELEMENTS (use these selectors, do not invent others):
${elementsList || '(none detected — try scrolling)'}

${taskMemoryContext ? `TASK MEMORY:\n${taskMemoryContext}\n\n` : ''}${historyTxt ? `PREVIOUS STEPS:\n${historyTxt}\n` : ''}
RULES:
1. Output ONE JSON object, nothing else. No prose, no markdown.
2. Actions you can emit:
   - {"action":"click","selector":"<css>","reason":"<short>"}
   - {"action":"type","selector":"<css>","text":"<value>","reason":"<short>"}
   - {"action":"pressKey","selector":"<css or omit>","key":"Enter|Tab|Escape|...","reason":"<short>"}
   - {"action":"scroll","direction":"down|up|top|bottom","amount":<px>,"reason":"<short>"}
   - {"action":"navigate","url":"<absolute https url>","reason":"<short>"}
   - {"action":"back","reason":"<short>"}
   - {"action":"wait","selector":"<css>","timeoutMs":5000,"reason":"<short>"}
   - {"action":"wait_url","contains":"<substring>","timeoutMs":8000,"reason":"<short>"}
   - {"action":"wait_for_completion","condition":{...},"timeoutMs":60000,"reason":"<short>"}
   - {"action":"extract","selector":"<css>","as":"text|html","reason":"<short>"}
   - {"action":"done","answer":"<final result for user>"}
   - {"action":"fail","reason":"<why you can't continue>"}
3. ALWAYS use selectors from the INTERACTIVE ELEMENTS list. If a needed element isn't there, scroll or wait first.
4. If a captcha/login/2FA blocks you, emit {"action":"fail","reason":"<what's blocking>"}.
5. Be efficient. If the task is already satisfied by current state, emit done.

Next action JSON:`;
}

// ============================================================
// BATCH STEP PROMPT (per-item action with task memory context)
// ============================================================

/**
 * Build a prompt for executing a single item in batch mode.
 * More constrained than the general executor: knows exactly what action to perform
 * on the current item, and has full task memory context.
 */
export function buildBatchStepPrompt({ task, userContext, item, actionTemplate, pageInfo, snapshot, taskMemoryContext }) {
  const elementsList = (snapshot.elements || []).slice(0, 80).map((e, i) => {
    const txt = (e.text || '').replace(/\s+/g, ' ').slice(0, 80);
    const r = e.rect || {};
    return `${i + 1}. ${e.tag}` +
      (e.id ? `#${e.id}` : '') +
      (e.classes ? `.${String(e.classes).split(/\s+/).slice(0, 2).join('.')}` : '') +
      ` | sel=${e.selector}` +
      (e.aria ? ` | aria=${e.aria}` : '') +
      (txt ? ` | text="${txt}"` : '') +
      ` | pos=(${r.x},${r.y}) ${r.w}x${r.h}`;
  }).join('\n');

  return `You are an autonomous browser agent executing a BATCH task. You are processing ONE ITEM from a larger list.

BATCH TASK:
"""
${task}
"""

CURRENT ITEM:
- ID: ${item.id}
- Title: ${item.title || '(none)'}
- URL: ${item.url || '(none)'}
- Data: ${JSON.stringify(item.data || {})}
${item.selector ? `- Selector hint: ${item.selector}` : ''}

ACTION TEMPLATE (this is the action pattern to apply to this item):
${JSON.stringify(actionTemplate, null, 2)}

PAGE:
- URL: ${pageInfo.url}
- Title: ${pageInfo.title}
- Body text (first 800 chars): ${(pageInfo.bodyText || '').slice(0, 800)}

INTERACTIVE ELEMENTS:
${elementsList || '(none detected — try scrolling)'}

${taskMemoryContext ? `TASK MEMORY:\n${taskMemoryContext}\n\n` : ''}
${userContext ? `USER CONTEXT:\n"""\n${userContext}\n"""\n\n` : ''}
RULES:
1. Output ONE JSON object, nothing else.
2. Actions: click, type, pressKey, scroll, navigate, wait, wait_url, wait_for_completion, extract, done, fail.
3. Use ONLY selectors from the INTERACTIVE ELEMENTS list.
4. If you cannot find the right element or the item is not applicable, emit {"action":"skip","reason":"<why>"}.
5. When the action for this item is complete, emit {"action":"done","result":"<what happened>"}.

Next action JSON:`;
}

// ============================================================
// PLANNER PROMPT (one-shot task analysis)
// ============================================================

/**
 * Build the planner prompt: task description → structured plan.
 * Called ONCE before the agent starts, no screenshot needed.
 */
export function buildPlannerPrompt({ task, userContext, currentPageInfo }) {
  return `You are a task planner for an autonomous browser agent. Analyze the user's task and produce a structured plan.

USER TASK:
"""
${task}
"""

${userContext ? `USER CONTEXT:\n"""\n${userContext}\n"""\n\n` : ''}${currentPageInfo ? `CURRENT PAGE:
- URL: ${currentPageInfo.url}
- Title: ${currentPageInfo.title}

` : ''}Analyze this task and output EXACTLY ONE JSON object:

For SIMPLE tasks (single action, no list processing):
{"type":"simple","reason":"<why this is simple>"}

For BATCH tasks (process multiple items: apply to jobs, add items to cart, fill multiple forms, extract data from list):
{
  "type": "batch",
  "goal": "<one sentence: what the task achieves>",
  "steps": [
    {"phase": "extracting", "description": "Collect list of candidates from the page"},
    {"phase": "filtering", "description": "Filter candidates by criteria"},
    {"phase": "confirming", "description": "Show filtered list to user for approval"},
    {"phase": "executing", "description": "Apply action to each approved item"}
  ],
  "criteria": {
    "include": ["<criteria to INCLUDE items>"],
    "exclude": ["<criteria to EXCLUDE items>"]
  },
  "extractionStrategy": {
    "what": "<what data to extract: job titles, product names, email addresses, etc.>",
    "where": "<where on the page to find it: listing cards, table rows, search results, etc.>",
    "selectors": ["<CSS selectors that identify the list items>"],
    "fields": ["<fields to extract per item: title, url, company, salary, etc.>"]
  },
  "actionTemplate": {
    "action": "<the action to apply to each item: click_apply, add_to_cart, send_email, fill_form>",
    "steps": [
      {"action": "<sub-action 1>", "description": "<what to do>"},
      {"action": "<sub-action 2>", "description": "<what to do>"}
    ]
  },
  "requiresConfirmation": true,
  "isIrreversible": <true if the action cannot be undone (sending emails, submitting applications)>
}

RULES:
1. Output ONLY the JSON object. No prose, no markdown fences.
2. Be conservative with batch detection: only classify as batch if the task clearly involves processing MULTIPLE items of the SAME type.
3. For "extract all X" tasks, the actionTemplate should indicate extraction (no page modification).
4. Set requiresConfirmation=true for any irreversible actions (sending, submitting, deleting).

JSON:`;
}

// ============================================================
// RESPONSE PARSING
// ============================================================

/**
 * Parse a model's text response into a structured action object.
 * Handles markdown fences, trailing prose, etc.
 */
export function safeParseAction(text) {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const m = s.match(/\{[\s\S]*?\}/);
  const candidate = m ? m[0] : s;
  try {
    const obj = JSON.parse(candidate);
    if (!obj || typeof obj !== 'object') return null;
    if (!obj.action) return null;
    return obj;
  } catch (e) { return null; }
}

/**
 * Parse a planner response into a plan object.
 * More lenient than safeParseAction — the planner may return a larger JSON.
 */
export function safeParsePlan(text) {
  if (!text) return null;
  let s = text.trim();
  // Strip markdown fences
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // Find the outermost JSON object
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  const candidate = s.slice(firstBrace, lastBrace + 1);
  try {
    const obj = JSON.parse(candidate);
    if (!obj || typeof obj !== 'object') return null;
    if (!obj.type) return null;
    return obj;
  } catch (e) { return null; }
}
