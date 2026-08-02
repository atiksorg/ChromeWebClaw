// vision_tools.js — Universal Vision-First action execution layer.
//
// All actions use NORMALIZED coordinates (0–1000) from the AI model,
// which are scaled to the actual viewport dimensions before dispatching
// via CDP (Chrome DevTools Protocol) trusted events.
//
// This eliminates the need for CSS selectors entirely — the AI "sees"
// the screenshot and clicks/types at what it sees.
//
// Toolset:
//   click_at       — Click at normalized (x, y)
//   type_at        — Click at (x, y), clear field, type text
//   press_key      — Keyboard key press
//   scroll         — Scroll at (x, y) in a direction
//   hover_at       — Hover at (x, y)
//   select_at      — Select dropdown option at (x, y)
//   checkbox_at    — Toggle checkbox/radio at (x, y)
//   navigate       — Navigate to URL
//   back           — History back
//   wait           — Wait N seconds
//   done           — Task complete
//   fail           — Task failed

import { runtime, sleep, broadcast } from './bus.js';
import {
  cdpClick, cdpType, cdpPressKey, cdpHover, cdpSend,
  waitPageReady, captureScreenshot
} from './cdp.js';
import { sendToAgentTab } from './agent_tab.js';

// ============================================================
// COORDINATE NORMALIZATION
// ============================================================

/**
 * The AI model returns coordinates in a normalized 0–1000 space.
 * We need to scale them to actual viewport pixel coordinates.
 *
 * Screenshot dimensions (what the model sees) may differ from
 * the CDP viewport (what receives events). We handle DPR scaling too.
 *
 * @param {number} nx — normalized X (0–1000)
 * @param {number} ny — normalized Y (0–1000)
 * @param {{ width: number, height: number }} viewport — actual viewport size
 * @returns {{ x: number, y: number }}
 */
export function normalizeCoords(nx, ny, viewport) {
  const w = viewport?.width || 1280;
  const h = viewport?.height || 800;
  const x = Math.round((nx / 1000) * w);
  const y = Math.round((ny / 1000) * h);
  return {
    x: Math.max(0, Math.min(w - 1, x)),
    y: Math.max(0, Math.min(h - 1, y))
  };
}

/**
 * Get the current viewport dimensions.
 * Uses CDP Browser.getWindowForTarget or falls back to settings.
 */
export async function getViewportSize() {
  try {
    // Try CDP first — most accurate
    if (runtime.cdpAttached && runtime.cdpTarget) {
      const result = await cdpSend('Runtime.evaluate', {
        expression: 'JSON.stringify({width: window.innerWidth, height: window.innerHeight})',
        returnByValue: true
      });
      if (result?.result?.value) {
        const parsed = JSON.parse(result.result.value);
        return { width: parsed.width, height: parsed.height };
      }
    }
  } catch (_) {}

  // Fallback to settings
  try {
    const { getSettings } = await import('./settings.js');
    const settings = await getSettings();
    return {
      width: settings.agent_viewport_width || 1280,
      height: settings.agent_viewport_height || 800
    };
  } catch (_) {}

  return { width: 1280, height: 800 };
}

// ============================================================
// VISION TOOLS — each returns { ok, ... } observation
// ============================================================

/**
 * Click at normalized coordinates.
 * Always uses CDP for trusted events (isTrusted: true).
 */
export async function toolClickAt(nx, ny, clickCount = 1) {
  const viewport = await getViewportSize();
  const { x, y } = normalizeCoords(nx, ny, viewport);

  try {
    // Focus agent tab so CDP events reach the page
    try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}

    // Adjust for iframe offset in iframe mode
    let fx = x, fy = y;
    if (!runtime.isDirectTab) {
      try {
        const iframePos = await sendToAgentTab({ kind: 'get_iframe_position' });
        if (iframePos?.ok) {
          fx += iframePos.x;
          fy += iframePos.y;
        }
      } catch (_) {}
    }

    for (let i = 0; i < clickCount; i++) {
      await cdpClick(fx, fy);
      if (i < clickCount - 1) await sleep(100);
    }

    return { ok: true, tool: 'click_at', normalized: { x: nx, y: ny }, actual: { x: fx, y: fy }, clickCount };
  } catch (e) {
    return { ok: false, tool: 'click_at', error: e.message, normalized: { x: nx, y: ny } };
  }
}

/**
 * Type text at normalized coordinates.
 * Click to focus → Clear field (Ctrl+A, Delete) → Insert text.
 * Handles any Unicode: Cyrillic, CJK, emoji, etc.
 */
export async function toolTypeAt(nx, ny, text, clearFirst = true) {
  const viewport = await getViewportSize();
  const { x, y } = normalizeCoords(nx, ny, viewport);

  try {
    try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}

    let fx = x, fy = y;
    if (!runtime.isDirectTab) {
      try {
        const iframePos = await sendToAgentTab({ kind: 'get_iframe_position' });
        if (iframePos?.ok) {
          fx += iframePos.x;
          fy += iframePos.y;
        }
      } catch (_) {}
    }

    // Click to focus the input field
    await cdpClick(fx, fy);
    await sleep(100);

    if (clearFirst) {
      // Select all (Ctrl+A)
      await cdpSend('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'a', code: 'KeyA',
        windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
        modifiers: 2 // Ctrl
      });
      await cdpSend('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'a', code: 'KeyA',
        windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
        modifiers: 2
      });
      await sleep(50);

      // Delete selected text
      await cdpSend('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Delete', code: 'Delete',
        windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46
      });
      await cdpSend('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Delete', code: 'Delete',
        windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46
      });
      await sleep(50);
    }

    // Type text using Input.insertText (handles all Unicode)
    await cdpType(text || '');

    return { ok: true, tool: 'type_at', normalized: { x: nx, y: ny }, length: (text || '').length, cleared: clearFirst };
  } catch (e) {
    return { ok: false, tool: 'type_at', error: e.message, normalized: { x: nx, y: ny } };
  }
}

/**
 * Press a keyboard key.
 */
export async function toolPressKey(key) {
  try {
    try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}
    await cdpPressKey(key);
    return { ok: true, tool: 'press_key', key };
  } catch (e) {
    return { ok: false, tool: 'press_key', error: e.message, key };
  }
}

/**
 * Scroll at normalized coordinates in a direction.
 * Uses CDP mouseWheel which is the most reliable scroll method.
 */
export async function toolScroll(direction, amount = 300, nx = 500, ny = 500) {
  const viewport = await getViewportSize();
  const { x, y } = normalizeCoords(nx, ny, viewport);

  const deltaY = direction === 'up' ? -Math.abs(amount) :
                 direction === 'down' ? Math.abs(amount) :
                 direction === 'top' ? -10000 :
                 direction === 'bottom' ? 10000 : 0;

  try {
    try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}

    let fx = x, fy = y;
    if (!runtime.isDirectTab) {
      try {
        const iframePos = await sendToAgentTab({ kind: 'get_iframe_position' });
        if (iframePos?.ok) {
          fx += iframePos.x;
          fy += iframePos.y;
        }
      } catch (_) {}
    }

    if (direction === 'top') {
      await cdpSend('Runtime.evaluate', { expression: 'window.scrollTo(0, 0)' });
    } else if (direction === 'bottom') {
      await cdpSend('Runtime.evaluate', { expression: 'window.scrollTo(0, document.documentElement.scrollHeight)' });
    } else {
      await cdpSend('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: fx, y: fy,
        deltaX: 0, deltaY
      });
    }

    return { ok: true, tool: 'scroll', direction, amount, normalized: { x: nx, y: ny } };
  } catch (e) {
    return { ok: false, tool: 'scroll', error: e.message, direction };
  }
}

/**
 * Hover at normalized coordinates.
 * Triggers :hover CSS, reveals dropdown menus, tooltips, etc.
 */
export async function toolHoverAt(nx, ny) {
  const viewport = await getViewportSize();
  const { x, y } = normalizeCoords(nx, ny, viewport);

  try {
    try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}

    let fx = x, fy = y;
    if (!runtime.isDirectTab) {
      try {
        const iframePos = await sendToAgentTab({ kind: 'get_iframe_position' });
        if (iframePos?.ok) {
          fx += iframePos.x;
          fy += iframePos.y;
        }
      } catch (_) {}
    }

    await cdpHover(fx, fy);
    return { ok: true, tool: 'hover_at', normalized: { x: nx, y: ny }, actual: { x: fx, y: fy } };
  } catch (e) {
    return { ok: false, tool: 'hover_at', error: e.message, normalized: { x: nx, y: ny } };
  }
}

/**
 * Select a dropdown option at normalized coordinates.
 * Clicks on the select element to open it, then uses CDP to select the value.
 *
 * For native <select> elements, we use DOM manipulation via content script.
 * For custom dropdowns (div-based), the AI should click_at the visible option.
 */
export async function toolSelectAt(nx, ny, value) {
  const viewport = await getViewportSize();
  const { x, y } = normalizeCoords(nx, ny, viewport);

  try {
    try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}

    // First, click on the select element to focus it
    let fx = x, fy = y;
    if (!runtime.isDirectTab) {
      try {
        const iframePos = await sendToAgentTab({ kind: 'get_iframe_position' });
        if (iframePos?.ok) {
          fx += iframePos.x;
          fy += iframePos.y;
        }
      } catch (_) {}
    }

    await cdpClick(fx, fy);
    await sleep(200);

    // Use CDP to set the value of the focused select element
    const script = `
      (function() {
        const el = document.activeElement;
        if (!el || el.tagName !== 'SELECT') return { ok: false, error: 'not_focused_on_select' };
        const option = Array.from(el.options).find(o =>
          o.value === ${JSON.stringify(value)} || o.textContent.trim() === ${JSON.stringify(value)}
        );
        if (!option) {
          const partial = Array.from(el.options).find(o =>
            o.value.includes(${JSON.stringify(value)}) || o.textContent.trim().includes(${JSON.stringify(value)})
          );
          if (!partial) return { ok: false, error: 'option_not_found', available: Array.from(el.options).slice(0, 10).map(o => ({ value: o.value, text: o.textContent.trim() })) };
          el.value = partial.value;
        } else {
          el.value = option.value;
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true, selected: el.value };
      })()
    `;

    const result = await cdpSend('Runtime.evaluate', {
      expression: script,
      returnByValue: true
    });

    const selectResult = result?.result?.value;
    if (selectResult?.ok) {
      return { ok: true, tool: 'select_at', normalized: { x: nx, y: ny }, selected: selectResult.selected };
    }

    // If the select wasn't focused properly, try a different approach:
    // click again and use the content script
    return { ok: false, tool: 'select_at', error: selectResult?.error || 'select_failed', value };
  } catch (e) {
    return { ok: false, tool: 'select_at', error: e.message, normalized: { x: nx, y: ny }, value };
  }
}

/**
 * Toggle a checkbox or radio button at normalized coordinates.
 * Simply clicks at the coordinates — the browser handles toggle state.
 */
export async function toolCheckboxAt(nx, ny) {
  // A checkbox toggle is just a click
  const result = await toolClickAt(nx, ny);
  return { ...result, tool: 'checkbox_at' };
}

/**
 * Navigate to a URL.
 */
export async function toolNavigate(url) {
  if (!url) return { ok: false, tool: 'navigate', error: 'no_url' };

  try {
    if (runtime.isDirectTab) {
      await chrome.tabs.update(runtime.agentTabId, { url });
    } else {
      await sendToAgentTab({ kind: 'set_url', url });
    }

    // Wait for navigation
    const start = Date.now();
    while (Date.now() - start < 10000) {
      await sleep(300);
      if (runtime.isDirectTab) {
        try {
          const tab = await chrome.tabs.get(runtime.agentTabId);
          if (tab?.url && tab.url !== 'about:blank') break;
        } catch (_) {}
      }
    }

    // Wait for page readiness
    try { await waitPageReady(); } catch (_) {}
    return { ok: true, tool: 'navigate', url };
  } catch (e) {
    return { ok: false, tool: 'navigate', error: e.message, url };
  }
}

/**
 * Go back in browser history.
 */
export async function toolBack() {
  try {
    if (runtime.isDirectTab) {
      await chrome.tabs.goBack(runtime.agentTabId);
    } else {
      // Use CDP to go back
      await cdpSend('Runtime.evaluate', { expression: 'history.back()' });
    }
    await sleep(1000);
    try { await waitPageReady(); } catch (_) {}
    return { ok: true, tool: 'back' };
  } catch (e) {
    return { ok: false, tool: 'back', error: e.message };
  }
}

/**
 * Wait for a specified number of seconds.
 */
export async function toolWait(seconds) {
  const ms = Math.min(Math.max(1, seconds || 1), 30) * 1000;
  await sleep(ms);
  return { ok: true, tool: 'wait', seconds: ms / 1000 };
}

// ============================================================
// MASTER DISPATCH — route a tool call to the right handler
// ============================================================

/**
 * Execute a vision tool call from the AI model.
 *
 * @param {Object} action — { tool, x?, y?, text?, key?, direction?, amount?, url?, seconds?, value?, clear?, click_count? }
 * @returns {Promise<Object>} observation
 */
export async function executeVisionTool(action) {
  if (!action || !action.tool) {
    return { ok: false, error: 'no_tool_specified' };
  }

  const tool = action.tool;

  switch (tool) {
    case 'click_at':
      return await toolClickAt(action.x, action.y, action.click_count || 1);

    case 'type_at':
      return await toolTypeAt(action.x, action.y, action.text || '', action.clear !== false);

    case 'press_key':
      return await toolPressKey(action.key);

    case 'scroll':
      return await toolScroll(
        action.direction || 'down',
        action.amount || 300,
        action.x ?? 500,
        action.y ?? 500
      );

    case 'hover_at':
      return await toolHoverAt(action.x, action.y);

    case 'select_at':
      return await toolSelectAt(action.x, action.y, action.value || '');

    case 'checkbox_at':
      return await toolCheckboxAt(action.x, action.y);

    case 'navigate':
      return await toolNavigate(action.url);

    case 'back':
      return await toolBack();

    case 'wait':
      return await toolWait(action.seconds || 3);

    case 'done':
      return { ok: true, tool: 'done', terminal: true, answer: action.answer || '' };

    case 'fail':
      return { ok: false, tool: 'fail', terminal: true, reason: action.reason || 'model reported failure' };

    default:
      return { ok: false, error: 'unknown_tool', tool };
  }
}
