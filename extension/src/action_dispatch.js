// action_dispatch.js — Action execution layer.
//
// Maps high-level actions (from the AI model) to low-level operations:
// CDP events, content script calls, tab navigation, etc.
//
// Extracted from background.js's performAction() function.

import { runtime, sleep, broadcast, setIconMode } from './bus.js';
import { cdpClick, cdpType, cdpPressKey, cdpHover, cdpSend, waitPageReady, captureScreenshot } from './cdp.js';
import { ensureContentScript, callFrame, sendToAgentTab, getSnapshot } from './agent_tab.js';
import { getSettings } from './settings.js';
import { sanitizeCssSelector } from './prompt_builder.js';

// ============================================================
// ACTION DISPATCH
// ============================================================

export async function performAction(action) {
  await ensureContentScript();
  const settings = await getSettings();
  const useCdp = settings.cdp_input_mode !== false; // default: false

  switch (action.action) {
    case 'navigate': {
      const u = action.url;
      if (!u) return { ok: false, error: 'no_url' };
      if (runtime.isDirectTab) {
        // Direct tab: navigate the tab directly
        await chrome.tabs.update(runtime.agentTabId, { url: u });
        await sleep(500);
      } else {
        await sendToAgentTab({ kind: 'set_url', url: u });
      }
      // wait for navigation
      const start = Date.now();
      while (Date.now() - start < 10000) {
        await sleep(300);
        if (runtime.isDirectTab) {
          try {
            const tab = await chrome.tabs.get(runtime.agentTabId);
            if (tab && tab.url && tab.url !== 'about:blank') break;
          } catch (_) {}
        } else {
          const r = await sendToAgentTab({ kind: 'get_url' });
          if (r && r.url && r.url !== 'about:blank' && r.url !== u) break;
          if (r && r.url === u) break;
        }
      }
      // Wait for page readiness after navigation
      try { await waitPageReady(); } catch (_) {}
      return { ok: true, url: u };
    }

    case 'back': {
      return await callFrame({ action: 'history', direction: 'back' });
    }

    case 'extract': {
      return await callFrame({ action: 'extract', selector: action.selector, as: action.as || 'text' });
    }

    case 'wait_url': {
      const start = Date.now();
      while (Date.now() - start < (action.timeoutMs || 8000)) {
        let currentUrl = '';
        if (runtime.isDirectTab) {
          try {
            const tab = await chrome.tabs.get(runtime.agentTabId);
            currentUrl = tab?.url || '';
          } catch (_) {}
        } else {
          const r = await sendToAgentTab({ kind: 'get_url' });
          currentUrl = r?.url || '';
        }
        if (currentUrl && currentUrl.includes(action.contains || '')) return { ok: true, url: currentUrl };
        await sleep(300);
      }
      return { ok: false, error: 'url_timeout' };
    }

    case 'click': {
      // Sanitize selector (strip Playwright-only pseudo-classes like :has-text())
      const clickSanitized = sanitizeCssSelector(action.selector);
      if (clickSanitized.sanitized) {
        broadcast({ kind: 'log', text: `⚠ Selector sanitized: "${clickSanitized.original}" → "${clickSanitized.selector}"` });
        action.selector = clickSanitized.selector;
      }
      if (useCdp) {
        try {
          // Ensure agent tab is focused so CDP events reach the iframe
          try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}
          // Get element coordinates from content script
          const coords = await callFrame({ action: 'getCoords', selector: action.selector });
          if (coords?.ok) {
            // Adjust coordinates for iframe offset on the parent page
            let x = coords.x;
            let y = coords.y;
            if (!runtime.isDirectTab) {
              // Get iframe position in the agent tab (only needed in iframe mode)
              const iframePos = await sendToAgentTab({ kind: 'get_iframe_position' });
              if (iframePos?.ok) {
                x += iframePos.x;
                y += iframePos.y;
              }
            }
            await cdpClick(x, y);
            return { ok: true, selector: action.selector, cdp: true, coords: { x, y } };
          }
        } catch (e) {
          broadcast({ kind: 'log', level: 'error', text: 'CDP click failed, falling back: ' + e.message });
        }
      }
      // Fallback to content script click
      return await callFrame({ action: 'click', selector: action.selector });
    }

    case 'type': {
      // Sanitize selector
      const typeSanitized = sanitizeCssSelector(action.selector);
      if (typeSanitized.sanitized) {
        broadcast({ kind: 'log', text: `⚠ Selector sanitized: "${typeSanitized.original}" → "${typeSanitized.selector}"` });
        action.selector = typeSanitized.selector;
      }
      if (useCdp) {
        try {
          // Ensure agent tab is focused so CDP events reach the iframe
          try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}
          // Focus the element first via content script
          const coords = await callFrame({ action: 'getCoords', selector: action.selector });
          if (coords?.ok) {
            let x = coords.x;
            let y = coords.y;
            if (!runtime.isDirectTab) {
              const iframePos = await sendToAgentTab({ kind: 'get_iframe_position' });
              if (iframePos?.ok) {
                x += iframePos.x;
                y += iframePos.y;
              }
            }
            // Click to focus
            await cdpClick(x, y);
            await sleep(100);
            // Clear field (Ctrl+A, then Delete)
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
            await cdpSend('Input.dispatchKeyEvent', {
              type: 'keyDown', key: 'Delete', code: 'Delete',
              windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46
            });
            await cdpSend('Input.dispatchKeyEvent', {
              type: 'keyUp', key: 'Delete', code: 'Delete',
              windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46
            });
            await sleep(50);
            // Type text using Input.insertText (correctly handles all Unicode: Cyrillic, emoji, etc.)
            await cdpType(action.text || '');
            return { ok: true, selector: action.selector, cdp: true, length: (action.text || '').length };
          }
        } catch (e) {
          broadcast({ kind: 'log', level: 'error', text: 'CDP type failed, falling back: ' + e.message });
        }
      }
      // Fallback to content script type
      return await callFrame({ action: 'type', selector: action.selector, text: action.text || '' });
    }

    case 'scroll': {
      if (useCdp) {
        try {
          const amount = action.amount || 300;
          const deltaY = action.direction === 'up' ? -amount :
                         action.direction === 'down' ? amount : 0;
          if (deltaY) {
            await cdpSend('Input.dispatchMouseEvent', {
              type: 'mouseWheel', x: 640, y: 400,
              deltaX: 0, deltaY
            });
            return { ok: true, direction: action.direction, cdp: true };
          }
        } catch (e) {
          broadcast({ kind: 'log', level: 'error', text: 'CDP scroll failed, falling back: ' + e.message });
        }
      }
      return await callFrame(payloadFor(action));
    }

    case 'pressKey': {
      if (useCdp) {
        try {
          await cdpPressKey(action.key);
          return { ok: true, key: action.key, cdp: true };
        } catch (e) {
          broadcast({ kind: 'log', level: 'error', text: 'CDP pressKey failed, falling back: ' + e.message });
        }
      }
      return await callFrame(payloadFor(action));
    }

    case 'wait':
    case 'pageInfo':
      return await callFrame(payloadFor(action));

    case 'wait_for_completion': {
      const timeout = action.timeoutMs || 120000;
      broadcast({ kind: 'log', text: `wait_for_completion: ${JSON.stringify(action.condition).slice(0,200)}, timeout=${timeout}ms` });
      broadcast({ kind: 'waiting_started', condition: action.condition, timeoutMs: timeout });
      await setIconMode('waiting');
      try {
        const result = await callFrame({
          action: 'wait_for_completion',
          condition: action.condition,
          timeoutMs: timeout
        });
        broadcast({ kind: 'waiting_finished', result });
        await setIconMode('working');
        return result || { ok: false, error: 'no_response' };
      } catch (e) {
        broadcast({ kind: 'waiting_finished', result: { ok: false, error: e.message } });
        await setIconMode('working');
        return { ok: false, error: e.message };
      }
    }

    case 'click_coords': {
      if (useCdp) {
        try {
          // Ensure agent tab is focused so CDP events reach the iframe
          try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}
          let x = action.x;
          let y = action.y;
          // Adjust for iframe offset in iframe mode
          if (!runtime.isDirectTab) {
            const iframePos = await sendToAgentTab({ kind: 'get_iframe_position' });
            if (iframePos?.ok) {
              x += iframePos.x;
              y += iframePos.y;
            }
          }
          await cdpClick(x, y);
          return { ok: true, x, y, cdp: true };
        } catch (e) {
          broadcast({ kind: 'log', level: 'error', text: 'CDP click_coords failed, falling back: ' + e.message });
        }
      }
      // Fallback to content script click at coordinates
      return await callFrame({ action: 'clickCoords', x: action.x, y: action.y });
    }

    case 'hover': {
      // Sanitize selector
      const hoverSanitized = sanitizeCssSelector(action.selector);
      if (hoverSanitized.sanitized) {
        broadcast({ kind: 'log', text: `⚠ Selector sanitized: "${hoverSanitized.original}" → "${hoverSanitized.selector}"` });
        action.selector = hoverSanitized.selector;
      }
      if (useCdp) {
        try {
          try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}
          const coords = await callFrame({ action: 'getCoords', selector: action.selector });
          if (coords?.ok) {
            let x = coords.x;
            let y = coords.y;
            if (!runtime.isDirectTab) {
              const iframePos = await sendToAgentTab({ kind: 'get_iframe_position' });
              if (iframePos?.ok) {
                x += iframePos.x;
                y += iframePos.y;
              }
            }
            await cdpHover(x, y);
            return { ok: true, selector: action.selector, cdp: true, coords: { x, y } };
          }
        } catch (e) {
          broadcast({ kind: 'log', level: 'error', text: 'CDP hover failed, falling back: ' + e.message });
        }
      }
      // Fallback to content script hover
      return await callFrame({ action: 'hover', selector: action.selector });
    }

    case 'select_option': {
      const selectSanitized = sanitizeCssSelector(action.selector);
      if (selectSanitized.sanitized) {
        broadcast({ kind: 'log', text: `⚠ Selector sanitized: "${selectSanitized.original}" → "${selectSanitized.selector}"` });
        action.selector = selectSanitized.selector;
      }
      return await callFrame({ action: 'selectOption', selector: action.selector, value: action.value });
    }

    case 'upload_file': {
      const uploadSanitized = sanitizeCssSelector(action.selector);
      if (uploadSanitized.sanitized) {
        broadcast({ kind: 'log', text: `⚠ Selector sanitized: "${uploadSanitized.original}" → "${uploadSanitized.selector}"` });
        action.selector = uploadSanitized.selector;
      }
      return await callFrame({ action: 'uploadFile', selector: action.selector, dataUrl: action.dataUrl, fileName: action.fileName });
    }

    case 'request_screenshot': {
      broadcast({ kind: 'infra', text: '📸 Агент запросил свежий скриншот...' });
      try {
        const freshScreenshot = await captureScreenshot();
        if (freshScreenshot) {
          broadcast({ kind: 'screenshot_captured', step: runtime.step, hasImage: true, requestedByModel: true });
          broadcast({ kind: 'infra', text: '📸 Свежий скриншот получен' });
          return { ok: true, screenshot: freshScreenshot };
        }
        return { ok: false, error: 'screenshot_empty' };
      } catch (e) {
        broadcast({ kind: 'log', level: 'error', text: 'request_screenshot failed: ' + e.message });
        return { ok: false, error: e.message };
      }
    }

    case 'done':
    case 'fail':
      return { ok: true, terminal: true };

    default:
      return { ok: false, error: 'unknown_action', action: action.action };
  }
}

export function payloadFor(action) {
  switch (action.action) {
    case 'click':    return { action: 'click', selector: action.selector };
    case 'type':     return { action: 'type', selector: action.selector, text: action.text || '' };
    case 'scroll':   return { action: 'scroll', direction: action.direction, amount: action.amount };
    case 'wait':     return { action: 'wait', selector: action.selector, timeoutMs: action.timeoutMs || 5000 };
    case 'pressKey': return { action: 'pressKey', selector: action.selector, key: action.key };
    case 'pageInfo': return { action: 'pageInfo' };
  }
  return {};
}
