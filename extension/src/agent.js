// agent.js — runs in the dedicated agent tab page (chrome-extension://...).
// Owns: the iframe that loads the target site, address bar, status text.
// Talks to the service worker via runtime messages with a stable channel id.
//
// v3.0: Floating overlay bar, fixed viewport dimensions for predictable AI screenshots,
//       auto-hide bar on inactivity.

const $ = (id) => document.getElementById(id);
const frame = $('frame');
const urlEl = $('url');
const goBtn = $('go');
const reloadBtn = $('reload');
const dot = $('dot');
const status = $('status');
const bar = $('bar');
const hideBarBtn = $('hide-bar');
const debugInfo = $('debug-info');

// Stable channel id for this tab — service worker uses it to find us.
const CHANNEL = 'agent_tab_' + Math.random().toString(36).slice(2, 10);
window.__VISION_AGENT_CHANNEL__ = CHANNEL;

// Viewport dimensions for the iframe — sent to background for normalization.
// These match typical laptop/desktop viewport so the AI model sees predictable aspect ratio.
const VIEWPORT_W = 1280;
const VIEWPORT_H = 800;

function setStatus(text, mode) {
  status.textContent = text;
  dot.classList.remove('running', 'paused', 'waiting', 'error');
  if (mode) dot.classList.add(mode);
}

function go() {
  let u = urlEl.value.trim();
  if (!u) return;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  urlEl.value = u;
  frame.src = u;
}

goBtn.addEventListener('click', go);
urlEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
reloadBtn.addEventListener('click', () => {
  try { frame.contentWindow.location.reload(); } catch (_) { /* cross-origin */ }
});

// Bar visibility management
let barHideTimer = null;
let barManuallyHidden = false;

function scheduleBarHide() {
  clearTimeout(barHideTimer);
  barHideTimer = setTimeout(() => {
    if (!barManuallyHidden) {
      bar.classList.add('auto-hide');
    }
  }, 3000);
}

function showBar() {
  bar.classList.remove('auto-hide');
  scheduleBarHide();
}

hideBarBtn.addEventListener('click', () => {
  barManuallyHidden = !barManuallyHidden;
  if (barManuallyHidden) {
    bar.classList.add('auto-hide');
    hideBarBtn.textContent = '▢';
    hideBarBtn.title = 'Show bar permanently';
  } else {
    bar.classList.remove('auto-hide');
    hideBarBtn.textContent = '━';
    hideBarBtn.title = 'Hide bar (hover top edge to reveal)';
    scheduleBarHide();
  }
});

bar.addEventListener('mouseenter', () => { clearTimeout(barHideTimer); });
bar.addEventListener('mouseleave', () => {
  if (!barManuallyHidden) scheduleBarHide();
});

// Initialize URL from the previous session (if any)
chrome.storage.local.get(['agent_url'], (v) => {
  if (v.agent_url) {
    urlEl.value = v.agent_url;
    frame.src = v.agent_url;
  }
});

frame.addEventListener('load', () => {
  try {
    const u = frame.contentWindow.location.href;
    if (u && u !== 'about:blank') {
      urlEl.value = u;
      chrome.storage.local.set({ agent_url: u });
    }
  } catch (_) { /* cross-origin — keep typed url */ }
});

// Update debug info with current viewport
function updateDebugInfo() {
  debugInfo.textContent = `viewport: ${VIEWPORT_W}x${VIEWPORT_H} | ` +
    `window: ${window.innerWidth}x${window.innerHeight} | ` +
    `iframe: ${frame.offsetWidth}x${frame.offsetHeight}`;
}
updateDebugInfo();
window.addEventListener('resize', updateDebugInfo);

// Listen for service worker
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.channel !== CHANNEL) return;
  switch (msg.kind) {
    case 'set_url':
      urlEl.value = msg.url;
      frame.src = msg.url;
      sendResponse({ ok: true });
      break;
    case 'reload_frame':
      try { frame.contentWindow.location.reload(); } catch (_) {}
      sendResponse({ ok: true });
      break;
    case 'get_url':
      try { sendResponse({ ok: true, url: frame.contentWindow.location.href }); }
      catch (_) { sendResponse({ ok: false, url: urlEl.value }); }
      break;
    case 'status':
      setStatus(msg.text, msg.mode);
      sendResponse({ ok: true });
      break;
    case 'get_viewport':
      sendResponse({
        ok: true,
        viewport: { w: VIEWPORT_W, h: VIEWPORT_H },
        window: { w: window.innerWidth, h: window.innerHeight },
        iframe: { w: frame.offsetWidth, h: frame.offsetHeight }
      });
      break;
    case 'get_iframe_position': {
      // Return the iframe's position in the agent tab viewport (for CDP coordinate adjustment)
      const rect = frame.getBoundingClientRect();
      sendResponse({ ok: true, x: Math.round(rect.left), y: Math.round(rect.top) });
      break;
    }
    case 'set_agent_mode':
      // When agent is active, hide all overlays so CDP mouse/keyboard events
      // pass through to the iframe without being intercepted by #bar or #hover-zone
      if (msg.active) {
        document.body.classList.add('agent-active');
      } else {
        document.body.classList.remove('agent-active');
      }
      sendResponse({ ok: true });
      break;
    default:
      sendResponse({ ok: false, error: 'unknown_kind' });
  }
  return true;
});

// Announce ourselves to the service worker on load
chrome.runtime.sendMessage({
  kind: 'agent_tab_ready',
  channel: CHANNEL,
  viewport: { w: VIEWPORT_W, h: VIEWPORT_H }
}).catch(() => {});

setStatus('ready', null);
scheduleBarHide();
