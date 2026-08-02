// content.js — runs in the page context (isolated world is fine; we use DOM only)
// Provides: click, type, scroll, hover, wait, getPageInfo, getSnapshot
//
// v3.0: Shadow DOM traversal, multi-strategy selectors, full input lifecycle,
//       improved visibility detection, iframe coordinate aggregation.

(function () {

  // ============================================================
  // §1  COORDINATE & VISIBILITY HELPERS
  // ============================================================

  /** Absolute rect of element in the CURRENT viewport (accounts for scroll inside iframe). */
  function rect(el) {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
      visible: r.width > 0 && r.height > 0 &&
        r.bottom > 0 && r.right > 0 &&
        r.top < window.innerHeight && r.left < window.innerWidth
    };
  }

  /** Deep visibility check: style + occlusion via elementFromPoint. */
  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;

    const cs = window.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;

    // aria-hidden="true" — treat as invisible to automation
    if (el.getAttribute('aria-hidden') === 'true') return false;

    // Disabled elements: still visible but mark separately
    // (we include them so the model can see them, but tag them)

    // Occlusion check: is the element actually visible at its center point?
    try {
      const centerX = r.left + r.width / 2;
      const centerY = r.top + r.height / 2;
      // Clamp to viewport
      const px = Math.max(0, Math.min(window.innerWidth - 1, centerX));
      const py = Math.max(0, Math.min(window.innerHeight - 1, centerY));
      const topEl = document.elementFromPoint(px, py);
      if (topEl && topEl !== el && !el.contains(topEl) && !topEl.contains(el)) {
        // Check if the top element is just a transparent overlay
        const topCs = window.getComputedStyle(topEl);
        if (topCs.pointerEvents !== 'none') {
          return false; // element is occluded
        }
      }
    } catch (_) { /* elementFromPoint may fail on some edge cases */ }

    return true;
  }

  function isClickable(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return true;
    if (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link') return true;
    if (el.onclick) return true;
    const cs = window.getComputedStyle(el);
    if (cs.cursor === 'pointer') return true;
    return false;
  }

  // ============================================================
  // §2  MULTI-STRATEGY SELECTOR BUILDER
  // ============================================================

  /**
   * Build a unique CSS selector for `el` using a weighted priority cascade:
   *   1. #id (if unique)
   *   2. Unique data-* attributes (data-testid, data-qa, etc.)
   *   3. ARIA role + aria-label combo
   *   4. Name attribute (for form elements)
   *   5. Text-based selector (for buttons/links with short unique text)
   *   6. nth-of-type chain (fallback)
   */
  function buildSelector(el, root) {
    if (!el) return null;
    root = root || document;

    // 1. #id — if unique in the root
    if (el.id) {
      const sel = '#' + CSS.escape(el.id);
      if (root.querySelectorAll(sel).length === 1) return sel;
    }

    // 2. Data-attributes
    for (const attr of ['data-testid', 'data-test', 'data-id', 'data-qa', 'data-cy']) {
      const v = el.getAttribute(attr);
      if (v && v.length < 80) {
        const sel = `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(v).replace(/"/g, '\\"')}"]`;
        if (root.querySelectorAll(sel).length === 1) return sel;
      }
    }

    // 3. ARIA role + aria-label combo
    const role = el.getAttribute('role');
    const ariaLabel = el.getAttribute('aria-label');
    if (role && ariaLabel && ariaLabel.length < 80) {
      const sel = `[role="${CSS.escape(role)}"][aria-label="${CSS.escape(ariaLabel).replace(/"/g, '\\"')}"]`;
      if (root.querySelectorAll(sel).length === 1) return sel;
    }
    // aria-label alone
    if (ariaLabel && ariaLabel.length < 80) {
      const sel = `[aria-label="${CSS.escape(ariaLabel).replace(/"/g, '\\"')}"]`;
      if (root.querySelectorAll(sel).length === 1) return sel;
    }

    // 4. Name attribute (form elements)
    const nameAttr = el.getAttribute('name');
    if (nameAttr && nameAttr.length < 60) {
      const sel = `${el.tagName.toLowerCase()}[name="${CSS.escape(nameAttr).replace(/"/g, '\\"')}"]`;
      if (root.querySelectorAll(sel).length === 1) return sel;
    }

    // 5. Text-based shortcut (for short unique text on buttons/links)
    const tag = el.tagName;
    if (['A', 'BUTTON', 'LABEL', 'SPAN'].includes(tag)) {
      const txt = (el.textContent || '').trim();
      if (txt.length > 0 && txt.length < 50) {
        // Try text-based XPath-style via CSS :has-text() polyfill — not natively supported,
        // so we skip this for pure CSS and fall through to chain.
        // (XPATH is handled separately in the prompt)
      }
    }

    // 6. nth-of-type chain (fallback)
    const parts = [];
    let cur = el;
    let scope = root;
    while (cur && cur.nodeType === 1 && cur !== (scope === document ? document.body : scope) && parts.length < 6) {
      let part = cur.tagName.toLowerCase();

      // If cur has an ID, use it as anchor and stop
      if (cur.id && scope.querySelectorAll('#' + CSS.escape(cur.id)).length === 1) {
        parts.unshift('#' + CSS.escape(cur.id));
        break;
      }

      const parent = cur.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (sameTag.length > 1) {
          const idx = sameTag.indexOf(cur) + 1;
          part += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(part);
      // try shortcut
      const candidate = parts.join(' > ');
      try {
        if (scope.querySelectorAll(candidate).length === 1) return candidate;
      } catch (_) {}
      cur = cur.parentElement;
    }
    return parts.join(' > ') || null;
  }

  // ============================================================
  // §3  SHADOW DOM & IFRAME RECURSIVE TRAVERSAL
  // ============================================================

  /** Collect interactive elements from a root (document or shadow root), recursing into shadow DOMs. */
  function collectElements(root, offsetX, offsetY, maxElements, seen) {
    const out = [];
    if (!root) return out;

    // Selector for interactive elements
    const interactiveSelector =
      'a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], ' +
      '[role="radio"], [role="tab"], [role="menuitem"], [role="switch"], [onclick], ' +
      '[contenteditable="true"], h1, h2, h3, label, summary, details > summary, ' +
      '[data-testid], [data-test], [data-id], [data-qa]';

    let elements;
    try {
      elements = Array.from(root.querySelectorAll(interactiveSelector));
    } catch (_) {
      return out;
    }

    for (const el of elements) {
      if (out.length + (seen?.size || 0) >= maxElements) break;

      const sel = buildSelector(el, root);
      if (!sel) continue;
      if (seen && seen.has(sel)) continue;
      if (!isVisible(el)) continue;
      if (seen) seen.add(sel);

      out.push(elementToDescriptor(el, offsetX, offsetY));
    }

    // Recurse into open shadow roots
    const allEls = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of allEls) {
      if (out.length + (seen?.size || 0) >= maxElements) break;
      if (el.shadowRoot) {
        const shadowEls = collectElements(el.shadowRoot, offsetX, offsetY, maxElements, seen);
        out.push(...shadowEls);
      }
    }

    return out;
  }

  // ============================================================
  // §4  ELEMENT DESCRIPTION
  // ============================================================

  function elementToDescriptor(el, offsetX, offsetY) {
    if (!el) return null;
    const r = rect(el);
    // Apply offset (for iframe aggregation)
    const adjustedR = {
      x: r.x + (offsetX || 0),
      y: r.y + (offsetY || 0),
      w: r.w,
      h: r.h,
      visible: r.visible
    };

    const text = (el.innerText || el.textContent || el.value || el.placeholder || '').trim().slice(0, 200);
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: el.className && typeof el.className === 'string' ? el.className.slice(0, 120) : null,
      text,
      role: el.getAttribute('role'),
      aria: el.getAttribute('aria-label'),
      href: el.getAttribute('href'),
      type: el.getAttribute('type'),
      name: el.getAttribute('name'),
      placeholder: el.getAttribute('placeholder'),
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' || false,
      selector: buildSelector(el),
      rect: adjustedR
    };
  }

  // ============================================================
  // §5  SNAPSHOT (main entry point)
  // ============================================================

  /**
   * Build a snapshot of all interactive elements.
   * Walks Shadow DOM, and optionally recurses into iframes
   * (coordinating with background.js for multi-frame aggregation).
   */
  function getSnapshot({ maxElements = 120 } = {}) {
    const viewportH = window.innerHeight;
    const seen = new Set();
    const elements = collectElements(document, 0, 0, maxElements, seen);

    // Also try to collect from same-origin iframes (cross-origin handled by background)
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      if (elements.length >= maxElements) break;
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!iframeDoc) continue; // cross-origin
        const iframeRect = iframe.getBoundingClientRect();
        const offsetX = Math.round(iframeRect.left);
        const offsetY = Math.round(iframeRect.top);
        const iframeEls = collectElements(iframeDoc, offsetX, offsetY, maxElements, seen);
        elements.push(...iframeEls);
      } catch (_) { /* cross-origin, skip */ }
    }

    return {
      url: location.href,
      title: document.title,
      viewport: {
        w: window.innerWidth,
        h: viewportH,
        scrollY: Math.round(window.scrollY),
        scrollMax: document.documentElement.scrollHeight,
        dpr: window.devicePixelRatio || 1
      },
      elements: elements.slice(0, maxElements)
    };
  }

  // ============================================================
  // §6  CLICK (with enhanced event dispatching)
  // ============================================================

  function clickElement(selector) {
    const el = document.querySelector(selector);
    if (!el) return { ok: false, error: 'element_not_found', selector };

    el.scrollIntoView({ block: 'center', inline: 'center' });
    // Brief pause for scroll animation
    const r = rect(el);
    const opts = {
      bubbles: true, cancelable: true, view: window,
      clientX: r.x, clientY: r.y,
      button: 0, buttons: 1
    };

    // Full mouse event sequence (mimics real browser click)
    el.dispatchEvent(new PointerEvent('pointerover', opts));
    el.dispatchEvent(new PointerEvent('pointerenter', opts));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mouseenter', opts));
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.focus();
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new PointerEvent('pointerout', opts));
    el.dispatchEvent(new PointerEvent('pointerleave', opts));
    el.dispatchEvent(new MouseEvent('click', opts));

    // Fallback: programmatic click for frameworks that listen on .click()
    try { el.click(); } catch (_) {}

    return {
      ok: true,
      selector,
      text: (el.innerText || el.textContent || '').trim().slice(0, 200),
      coords: { x: r.x, y: r.y }
    };
  }

  // ============================================================
  // §7  TYPE TEXT (full input lifecycle for React/Vue/Angular)
  // ============================================================

  function typeText(selector, text) {
    const el = document.querySelector(selector);
    if (!el) return { ok: false, error: 'element_not_found', selector };

    el.scrollIntoView({ block: 'center', inline: 'center' });

    // 1. Focus
    el.focus();
    el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    // 2. Clear existing value
    const proto = el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    // Select all + delete (sends proper keyboard events for frameworks)
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keypress', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true, cancelable: true }));

    // Set value via native setter so React/Angular detect it
    if (nativeSetter) {
      nativeSetter.call(el, '');
    } else {
      el.value = '';
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));

    // 3. Type each character (simulates keydown → keypress → input → keyup)
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true, cancelable: true }));

      // Append character via native setter
      if (nativeSetter) {
        nativeSetter.call(el, text.slice(0, i + 1));
      } else {
        el.value = text.slice(0, i + 1);
      }
      el.dispatchEvent(new InputEvent('input', {
        data: char, inputType: 'insertText', bubbles: true, cancelable: true
      }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true, cancelable: true }));
    }

    // 4. Final change event (for non-React forms)
    el.dispatchEvent(new Event('change', { bubbles: true }));

    // 5. Blur
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

    return { ok: true, selector, length: text.length };
  }

  // ============================================================
  // §8  SCROLL
  // ============================================================

  function scrollPage(direction, amount) {
    const a = amount || Math.round(window.innerHeight * 0.8);
    let dy = 0;
    if (direction === 'down') dy = a;
    else if (direction === 'up') dy = -a;
    else if (direction === 'top') window.scrollTo(0, 0);
    else if (direction === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight);
    if (dy) window.scrollBy(0, dy);
    return {
      ok: true,
      scrollY: Math.round(window.scrollY),
      scrollMax: document.documentElement.scrollHeight
    };
  }

  // ============================================================
  // §9  WAIT FOR ELEMENT
  // ============================================================

  function waitFor(selector, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const el = document.querySelector(selector);
        if (el && isVisible(el)) return resolve({ ok: true, selector });
        if (Date.now() - start > timeoutMs) return resolve({ ok: false, error: 'timeout', selector });
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  // ============================================================
  // §10  KEY PRESS
  // ============================================================

  function pressKey(selector, key) {
    const el = selector ? document.querySelector(selector) : document.activeElement;
    if (!el) return { ok: false, error: 'element_not_found', selector };
    el.focus();

    // Full keyboard event cycle
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keypress', { key, bubbles: true, cancelable: true }));

    // Handle special keys that should trigger default behavior
    if (key === 'Enter') {
      const form = el.closest('form');
      if (form) {
        const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
        if (submitBtn) submitBtn.click();
        else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    }

    el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
    return { ok: true, selector, key };
  }

  // ============================================================
  // §11  PAGE INFO & EXTRACT
  // ============================================================

  function getPageInfo() {
    return {
      url: location.href,
      title: document.title,
      bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 4000)
    };
  }

  function extract(selector, as) {
    const el = selector ? document.querySelector(selector) : document.body;
    if (!el) return { ok: false, error: 'element_not_found', selector };
    if (as === 'html') return { ok: true, value: (el.outerHTML || '').slice(0, 8000) };
    return { ok: true, value: (el.innerText || el.textContent || '').trim().slice(0, 4000) };
  }

  function historyAction(direction) {
    if (direction === 'back') history.back();
    else if (direction === 'forward') history.forward();
    return { ok: true, direction };
  }

  // ============================================================
  // §12  CDP-compatible click/type (returns coords for background CDP dispatch)
  // ============================================================

  /** Resolve element center coordinates for CDP mouse dispatch. */
  function getElementCoords(selector) {
    const el = document.querySelector(selector);
    if (!el) return { ok: false, error: 'element_not_found', selector };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = rect(el);
    return { ok: true, selector, x: r.x, y: r.y, w: r.w, h: r.h };
  }

  // ============================================================
  // §13  WAIT FOR COMPLETION (local polling engine, no AI calls)
  // ============================================================

  /**
   * Local polling engine for long-running processes.
   * Uses MutationObserver + periodic DOM checks — zero AI calls during wait.
   *
   * Supported condition types:
   *   - selector_disappear: wait for element to vanish from DOM or become invisible
   *   - selector_appear: wait for element to appear and become visible
   *   - progress: watch numeric attribute (e.g. aria-valuenow) approaching target
   *   - text_appear: wait for text string to appear anywhere in body
   *   - url_change: wait for URL to contain a substring
   *   - network_idle: not checked here (handled in background.js via CDP)
   *
   * @param {Object} condition - { type, selector?, attribute?, target?, text?, contains? }
   * @param {number} timeoutMs - Maximum wait time
   * @returns {Promise<{ok, ...}>}
   */
  function waitForCompletion(condition, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      // Adaptive polling intervals: starts fast, slows down over time
      const INTERVALS = [500, 500, 1000, 1000, 2000, 2000, 3000, 5000];
      let pollIndex = 0;
      let settled = false;
      let observer = null;
      let pollTimer = null;
      let progressStallCount = 0;
      let lastProgressValue = null;

      const elapsed = () => Date.now() - start;
      const currentInterval = () => INTERVALS[Math.min(pollIndex, INTERVALS.length - 1)];

      function cleanup() {
        if (settled) return;
        settled = true;
        if (observer) { try { observer.disconnect(); } catch (_) {} }
        if (pollTimer) { clearTimeout(pollTimer); }
      }

      function succeed(detail) {
        cleanup();
        resolve({ ok: true, elapsed: elapsed(), ...detail });
      }

      function fail(reason) {
        cleanup();
        resolve({ ok: false, error: reason, elapsed: elapsed() });
      }

      // --- Error text detection (short-circuit) ---
      const ERROR_TEXTS = ['error', 'failed', 'failure', 'ошибка', 'не удалось', 'something went wrong', 'try again'];

      function checkForErrors() {
        try {
          // Check for common error indicator elements first (more reliable than body text scan)
          const errorEls = document.querySelectorAll(
            '[role="alert"], .error, .alert-danger, .alert-error, .error-message, .toast-error'
          );
          for (const el of errorEls) {
            if (isVisible(el)) {
              const txt = (el.innerText || '').toLowerCase();
              for (const err of ERROR_TEXTS) {
                if (txt.includes(err)) {
                  return el.innerText.trim().slice(0, 300);
                }
              }
            }
          }
        } catch (_) {}
        return null;
      }

      // --- Condition-specific check functions ---

      function checkSelectorDisappear() {
        const el = document.querySelector(condition.selector);
        if (!el || !isVisible(el)) {
          succeed({ reason: 'selector_disappeared', selector: condition.selector });
          return true;
        }
        return false;
      }

      function checkSelectorAppear() {
        const el = document.querySelector(condition.selector);
        if (el && isVisible(el)) {
          succeed({ reason: 'selector_appeared', selector: condition.selector });
          return true;
        }
        return false;
      }

      function checkProgress() {
        const el = document.querySelector(condition.selector);
        if (!el) return false;
        const value = parseFloat(el.getAttribute(condition.attribute || 'aria-valuenow'));
        const target = parseFloat(condition.target || 100);
        if (isNaN(value)) return false;
        if (value >= target) {
          succeed({ reason: 'progress_complete', value, target });
          return true;
        }
        // Stall detection: if value hasn't changed in 10 polls, report
        if (lastProgressValue !== null && value === lastProgressValue) {
          progressStallCount++;
          if (progressStallCount > 10) {
            succeed({ reason: 'progress_stalled', value, target, stalled: true });
            return true;
          }
        } else {
          progressStallCount = 0;
        }
        lastProgressValue = value;
        return false;
      }

      function checkTextAppear() {
        try {
          const bodyText = document.body.innerText || '';
          if (bodyText.includes(condition.text)) {
            succeed({ reason: 'text_appeared', text: condition.text });
            return true;
          }
        } catch (_) {}
        return false;
      }

      function checkUrlChange() {
        if (location.href.includes(condition.contains || '')) {
          succeed({ reason: 'url_changed', url: location.href });
          return true;
        }
        return false;
      }

      // --- Select the right check function ---
      const checkFn = {
        'selector_disappear': checkSelectorDisappear,
        'selector_appear': checkSelectorAppear,
        'progress': checkProgress,
        'text_appear': checkTextAppear,
        'url_change': checkUrlChange
      }[condition.type];

      if (!checkFn) {
        fail('unknown_condition_type: ' + condition.type);
        return;
      }

      // --- MutationObserver setup (for DOM-changing conditions) ---
      if (['selector_disappear', 'selector_appear', 'progress', 'text_appear'].includes(condition.type)) {
        try {
          observer = new MutationObserver(() => {
            if (settled) return;
            // Debounce: wait a tick for DOM to settle
            setTimeout(() => {
              if (!settled) {
                const error = checkForErrors();
                if (error) { fail('page_error: ' + error); return; }
                checkFn();
              }
            }, 100);
          });
          observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
            attributes: condition.type === 'progress',
            attributeFilter: condition.type === 'progress' ? [condition.attribute || 'aria-valuenow'] : undefined,
            characterData: condition.type === 'text_appear'
          });
        } catch (_) {}
      }

      // --- Polling loop (fallback + primary for url_change) ---
      function poll() {
        if (settled) return;
        if (elapsed() >= timeoutMs) {
          fail('wait_timeout');
          return;
        }

        const error = checkForErrors();
        if (error) { fail('page_error: ' + error); return; }

        checkFn();
        if (settled) return;

        pollIndex++;
        pollTimer = setTimeout(poll, currentInterval());
      }

      // Initial check (immediate)
      const error = checkForErrors();
      if (error) { fail('page_error: ' + error); return; }
      checkFn();
      if (settled) return;

      // Start polling
      pollTimer = setTimeout(poll, currentInterval());
    });
  }

  // ============================================================
  // §14  MESSAGE LISTENER
  // ============================================================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    let result;
    try {
      switch (msg.action) {
        case 'snapshot':
          result = getSnapshot(msg.options || {});
          break;
        case 'click':
          result = clickElement(msg.selector);
          break;
        case 'type':
          result = typeText(msg.selector, msg.text || '');
          break;
        case 'scroll':
          result = scrollPage(msg.direction, msg.amount);
          break;
        case 'wait':
          waitFor(msg.selector, msg.timeoutMs || 5000).then(sendResponse);
          return true;
        case 'pressKey':
          result = pressKey(msg.selector, msg.key);
          break;
        case 'pageInfo':
          result = getPageInfo();
          break;
        case 'extract':
          result = extract(msg.selector, msg.as);
          break;
        case 'history':
          result = historyAction(msg.direction);
          break;
        case 'getCoords':
          result = getElementCoords(msg.selector);
          break;
        case 'wait_for_completion':
          waitForCompletion(msg.condition, msg.timeoutMs || 120000).then(sendResponse);
          return true;
        default:
          result = { ok: false, error: 'unknown_action', action: msg.action };
      }
    } catch (e) {
      result = { ok: false, error: String(e && e.message || e) };
    }
    sendResponse(result);
    return true; // async ok
  });
})();
