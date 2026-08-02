/**
 * format_helper.js — Human-readable formatting for AI agent actions
 * 
 * Transforms raw JSON action objects into friendly text with emojis
 * so users can instantly understand what the AI agent is doing.
 */

const ACTION_FORMATTERS = {
  click_at: (action) => {
    const target = action.selector || action.target || '';
    const coords = (action.x != null && action.y != null) 
      ? ` (X: ${action.x}, Y: ${action.y})` : '';
    return `🖱️ Клик${target ? ' по «' + truncate(target, 40) + '»' : ''}${coords}`;
  },
  
  type_at: (action) => {
    const text = action.text || action.value || '';
    const target = action.selector || action.target || '';
    return `⌨️ Ввод текста${target ? ' в «' + truncate(target, 30) + '»' : ''}: «${truncate(text, 50)}»`;
  },
  
  press_key: (action) => {
    const keyName = KEY_NAMES[action.key] || action.key || '?';
    return `🎹 Нажатие клавиши [${keyName}]`;
  },
  
  scroll: (action) => {
    const dir = SCROLL_DIRS[action.direction] || action.direction || 'вниз';
    const amount = action.amount || action.pixels || 300;
    return `📜 Прокрутка ${dir} (${amount}px)`;
  },
  
  scroll_at: (action) => {
    const dir = SCROLL_DIRS[action.direction] || action.direction || 'вниз';
    const amount = action.amount || action.pixels || 300;
    return `📜 Прокрутка ${dir} (${amount}px)`;
  },
  
  hover_at: (action) => {
    const target = action.selector || action.target || '';
    return `🎯 Наведение мыши${target ? ' на «' + truncate(target, 40) + '»' : ''}`;
  },
  
  select_at: (action) => {
    const value = action.value || action.text || '?';
    return `≡ Выбор из списка: «${truncate(value, 40)}»`;
  },
  
  navigate: (action) => {
    const url = action.url || action.href || '?';
    return `🌐 Переход на: ${truncate(url, 60)}`;
  },
  
  back: () => `⬅️ Возврат назад по истории`,
  
  forward: () => `➡️ Вперёд по истории`,
  
  reload: () => `🔄 Перезагрузка страницы`,
  
  wait: (action) => {
    const secs = action.seconds || action.duration || 3;
    return `⏳ Ожидание (${secs} сек)`;
  },
  
  screenshot: () => `📸 Сделать скриншот`,
  
  get_text: (action) => {
    const target = action.selector || action.target || '';
    return `👁️ Чтение текста${target ? ' из «' + truncate(target, 40) + '»' : ''}`;
  },
  
  get_attribute: (action) => {
    const attr = action.attribute || '?';
    const target = action.selector || action.target || '';
    return `🔍 Получение атрибута «${attr}»${target ? ' из «' + truncate(target, 30) + '»' : ''}`;
  },
  
  evaluate: (action) => {
    const code = action.code || action.expression || '';
    return `⚡ Выполнить JS: ${truncate(code, 60)}`;
  },
  
  drag: (action) => {
    return `✋ Перетаскивание (${action.fromX || '?'},${action.fromY || '?'}) → (${action.toX || '?'},${action.toY || '?'})`;
  },
  
  done: (action) => {
    const answer = action.answer || action.result || 'Успешно';
    return `✅ Задача завершена: ${truncate(answer, 80)}`;
  },
  
  fail: (action) => {
    const reason = action.reason || action.error || 'Не удалось';
    return `❌ Ошибка: ${truncate(reason, 80)}`;
  },
};

const KEY_NAMES = {
  'Enter': 'Enter ↵',
  'Backspace': 'Backspace ⌫',
  'Tab': 'Tab ⇥',
  'Escape': 'Esc',
  'Delete': 'Delete ⌦',
  'ArrowUp': '↑ Стрелка вверх',
  'ArrowDown': '↓ Стрелка вниз',
  'ArrowLeft': '← Стрелка влево',
  'ArrowRight': '→ Стрелка вправо',
  'Space': 'Пробел',
  'Home': 'Home',
  'End': 'End',
  'PageUp': 'Page Up',
  'PageDown': 'Page Down',
};

const SCROLL_DIRS = {
  'down': 'вниз',
  'up': 'вверх',
  'left': 'влево',
  'right': 'вправо',
};

function truncate(str, max) {
  if (!str) return '';
  str = String(str);
  return str.length > max ? str.slice(0, max) + '…' : str;
}

/**
 * Main formatter: converts action object to human-readable string with emoji.
 * @param {Object} action - Raw action object from AI model
 * @returns {string} Human-readable description
 */
export function formatActionHuman(action) {
  if (!action) return '⚙️ Неизвестное действие';
  
  const tool = action.tool || action.action || action.type || '';
  
  // Try specific formatter
  const formatter = ACTION_FORMATTERS[tool];
  if (formatter) {
    try {
      return formatter(action);
    } catch (e) {
      // Fallback if formatter crashes
    }
  }
  
  // Fallback for unknown actions
  const reason = action.reason || action.description || '';
  if (reason) {
    return `⚙️ ${truncate(tool, 20)}: ${truncate(reason, 60)}`;
  }
  return `⚙️ Действие: ${truncate(tool, 30) || 'неизвестно'}`;
}

/**
 * Format observation result into a friendly message.
 * @param {Object} obs - Raw observation object
 * @returns {string} Human-readable observation
 */
export function formatObservationHuman(obs) {
  if (!obs) return '';
  
  const ok = obs.ok !== false;
  const prefix = ok ? '✅' : '❌';
  
  // Common observation types
  if (obs.type === 'screenshot') {
    return `${prefix} Скриншот получен`;
  }
  if (obs.type === 'text_content' || obs.type === 'text') {
    const text = obs.text || obs.content || '';
    return `${prefix} Текст: ${truncate(text, 100)}`;
  }
  if (obs.type === 'navigation') {
    const url = obs.url || '';
    return `${prefix} Страница загружена: ${truncate(url, 60)}`;
  }
  if (obs.type === 'element_found') {
    return `${prefix} Элемент найден`;
  }
  if (obs.type === 'element_not_found') {
    return `${prefix} Элемент не найден`;
  }
  if (obs.error) {
    return `${prefix} Ошибка: ${truncate(obs.error, 100)}`;
  }
  if (obs.message) {
    return `${prefix} ${truncate(obs.message, 100)}`;
  }
  
  // Generic
  return ok ? '✅ Действие выполнено' : '❌ Действие не выполнено';
}

/**
 * Format model thinking/reasoning into displayable text.
 * @param {string} thought - Raw thought text from model
 * @returns {string} Cleaned thought text
 */
export function formatThought(thought) {
  if (!thought) return '';
  // Clean up any raw JSON or technical artifacts
  let text = String(thought);
  // Remove any leading/trailing whitespace
  text = text.trim();
  return text;
}
