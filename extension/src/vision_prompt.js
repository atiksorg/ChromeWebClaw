// vision_prompt.js — Prompt construction for Vision-First Agent.
//
// Unlike the DOM-based prompt (prompt_builder.js), the Vision-First prompt:
//   - Sends ONLY the screenshot + task + compact action log
//   - Does NOT send DOM snapshots or CSS selectors
//   - Uses normalized coordinates (0–1000) instead of pixel coords
//   - Includes a visual stagnation hint when the screen hasn't changed

// ============================================================
// VISION SYSTEM PROMPT (constant, sent as system message)
// ============================================================

export const VISION_SYSTEM_PROMPT = `Вы — автономный браузерный агент, который управляет браузером по ВИЗУАЛЬНОМУ анализу.
Вы видите скриншот текущего окна браузера и принимаете решения о следующих действиях.

СИСТЕМА КООРДИНАТ:
- Все координаты нормализованы к шкале 0–1000.
- (0, 0) = верхний левый угол окна просмотра
- (1000, 1000) = нижний правый угол окна просмотра
- (500, 500) = центр окна просмотра
- Пример: чтобы нажать кнопку, расположенную на 30% слева и 60% сверху, используйте x=300, y=600

ДОСТУПНЫЕ ИНСТРУМЕНТЫ:
- click_at(x, y, click_count?) — Нажать по координатам. Используйте для кнопок, ссылок, чекбоксов, любых интерактивных элементов.
- type_at(x, y, text, clear?) — Нажать по координатам, очистить существующий текст (Ctrl+A → Delete), затем ввести новый текст. Работает для полей ввода, текстовых областей, contenteditable элементов.
- press_key(key) — Нажать клавишу: Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Space, PageDown, PageUp, Home, End.
- scroll(direction, amount?, x?, y?) — Прокрутить страницу. direction: up|down|top|bottom. amount: пиксели (по умолчанию 300). x,y: где прокручивать (по умолчанию 500,500).
- hover_at(x, y) — Навести мышь на координаты. Вызывает :hover CSS, раскрывает выпадающие меню и подсказки.
- select_at(x, y, value) — Выбрать опцию из выпадающего списка по координатам. value: значение опции для выбора.
- checkbox_at(x, y) — Переключить чекбокс или радиокнопку по координатам.
- navigate(url) — Перейти по URL.
- back — Вернуться назад в истории браузера.
- wait(seconds) — Подождать N секунд (1–30). Используйте, когда страница загружается.
- done(answer) — Задача выполнена. answer: результат или краткое описание для пользователя.
- fail(reason) — Задача не может быть выполнена. reason: что вам мешает.

ПРАВИЛА:
1. Выведите ТОЧНО ОДИН JSON объект — следующее действие для выполнения.
2. Всегда включайте поле "think" с кратким рассуждением (1-2 предложения).
3. Используйте скриншот для нахождения элементов — НЕ гадайте координаты.
4. Координаты должны быть в нормализованном пространстве 0–1000.
5. Если видите индикатор загрузки или страница меняется, сначала используйте wait(seconds).
6. Если застряли на одной и той же странице после 3 действий, попробуйте scroll, navigate или back.
7. Если капча, стена входа или 2FA блокируют вас, выведите fail(reason).
8. Будьте эффективны — минимизируйте количество необходимых действий.

ВАЖНО: ЗАПОЛНЯЙТЕ ФОРМЫ ВРУЧНУЮ, НЕ ИСПОЛЬЗУЯ ИИ-ИНСТРУМЕНТЫ НА САЙТАХ.
Если на странице есть формы, заполняйте их напрямую через type_at и click_at.
Не используйте какие-либо встроенные ИИ-инструменты, виджеты или помощники на сайтах.
Заполняйте поля ввода, выбирайте опции, нажимайте кнопки — всё это вы делаете сами.

ФОРМАТ ВЫВОДА (только JSON, без markdown-ограждений, без текста):
{"tool":"<tool_name>","think":"<ваше рассуждение>","x":500,"y":500,"text":"","key":"","direction":"down","amount":300,"url":"","seconds":3,"value":"","answer":"","reason":"","clear":true,"click_count":1,"notes":["важный факт для запоминания"]}`;

// ============================================================
// COMPACT ACTION LOG BUILDER
// ============================================================

/**
 * Build a compact text log of previous actions for the model.
 * Only sends the last N steps to save tokens — the model has
 * the previous screenshot for visual context.
 *
 * @param {Array} history — array of { action, observation, screenshotHash? }
 * @param {number} maxSteps — how many recent steps to include
 * @returns {string} compact text block
 */
export function buildActionLog(history, maxSteps = 8) {
  if (!history || history.length === 0) return '';

  const recent = history.slice(-maxSteps);
  const lines = recent.map((h, i) => {
    const action = typeof h.action === 'string' ? h.action : JSON.stringify(h.action);
    const obs = typeof h.observation === 'string' ? h.observation : JSON.stringify(h.observation);
    // Truncate action to 200 chars, observation to 150 chars
    return `Шаг ${history.length - recent.length + i + 1}: ${action.slice(0, 200)} → ${obs.slice(0, 150)}`;
  });

  return lines.join('\n');
}

// ============================================================
// STAGNATION HINT
// ============================================================

/**
 * Generate a visual stagnation hint when the screen hasn't changed.
 *
 * @param {number} consecutiveSame — how many consecutive steps with same screenshot hash
 * @param {number} step — current step number
 * @returns {string} hint text to inject into prompt, or empty string
 */
export function buildStagnationHint(consecutiveSame, step) {
  if (consecutiveSame < 2) return '';

  if (consecutiveSame >= 5) {
    return `\n⚠️ ВНИМАНИЕ: Экран не изменился за последние ${consecutiveSame} действий. Вы, вероятно, застряли. Попробуйте совершенно другой подход: прокрутите в другую область, перейдите на новый URL, нажмите Escape или используйте back().`;
  }

  if (consecutiveSame >= 3) {
    return `\n⚠️ Заметка: Экран выглядит так же после последних ${consecutiveSame} действий. Ваши клики, возможно, не достигают целевого элемента. Попробуйте сначала прокрутить, или используйте другую координату.`;
  }

  return `\nЗаметка: Экран не изменился после последнего действия. Проверьте координаты.`;
}

// ============================================================
// MAIN VISION PROMPT BUILDER
// ============================================================

/**
 * Build the user message for the Vision-First agent.
 *
 * @param {Object} params
 * @param {string} params.task — user's task description
 * @param {string} params.userContext — user context (resume, contacts, etc.)
 * @param {string} params.currentUrl — current page URL
 * @param {string} params.pageTitle — current page title
 * @param {Array} params.history — action history
 * @param {number} params.step — current step number
 * @param {number} params.consecutiveSame — consecutive steps with same screenshot
 * @param {string} params.taskMemoryContext — task memory context for batch tasks (optional)
 * @returns {string} the user message text (no image — that's added by the provider)
 */
export function buildVisionPrompt({ task, userContext, currentUrl, pageTitle, history, step, consecutiveSame, taskMemoryContext }) {
  const parts = [];

  // Task
  parts.push(`ЗАДАЧА:\n"""${task}"""`);

  // User context (if any)
  if (userContext) {
    parts.push(`КОНТЕКСТ ПОЛЬЗОВАТЕЛЯ:\n"""${userContext}"""`);
  }

  // Current page info
  parts.push(`ТЕКУЩАЯ СТРАНИЦА:\nURL: ${currentUrl || '(неизвестно)'}\nЗаголовок: ${pageTitle || '(неизвестно)'}`);

  // Step counter
  parts.push(`Шаг: ${step}`);

  // Task memory (for batch tasks)
  if (taskMemoryContext) {
    parts.push(`ПАМЯТЬ ЗАДАЧИ:\n${taskMemoryContext}`);
  }

  // Action log
  const actionLog = buildActionLog(history);
  if (actionLog) {
    parts.push(`ПОСЛЕДНИЕ ДЕЙСТВИЯ:\n${actionLog}`);
  }

  // Stagnation hint
  const stagnationHint = buildStagnationHint(consecutiveSame, step);
  if (stagnationHint) {
    parts.push(stagnationHint);
  }

  return parts.join('\n\n');
}

// ============================================================
// RESPONSE PARSING
// ============================================================

/**
 * Parse the Vision-First model response into a tool call object.
 * Expected format: {"tool":"click_at","think":"...","x":500,"y":500,...}
 *
 * @param {string} text — raw model response
 * @returns {Object|null} parsed tool call or null
 */
export function parseVisionResponse(text) {
  if (!text) return null;

  let s = text.trim();

  // Strip markdown fences if present
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // Find JSON object
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;

  try {
    const obj = JSON.parse(m[0]);
    if (!obj || typeof obj !== 'object') return null;
    if (!obj.tool) return null;

    // Validate coordinates are in range (if present)
    if (obj.x !== undefined) obj.x = Math.max(0, Math.min(1000, Number(obj.x) || 0));
    if (obj.y !== undefined) obj.y = Math.max(0, Math.min(1000, Number(obj.y) || 0));

    return obj;
  } catch (e) {
    return null;
  }
}

/**
 * Extract the model's "think" reasoning from a parsed response.
 *
 * @param {Object} parsed — parsed tool call
 * @returns {string} the thinking text, or empty string
 */
export function extractVisionThinking(parsed) {
  return (parsed?.think || '').slice(0, 500);
}
