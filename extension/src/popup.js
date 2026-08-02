// popup.js — popup UI logic for WebClaw
import { formatActionHuman, formatObservationHuman, formatThought } from './format_helper.js';

const $ = (id) => document.getElementById(id);
const taskEl = $('task');
const contextEl = $('context');
const urlEl = $('url');
const stepcapEl = $('stepcap');
const dryEl = $('dry');
const startBtn = $('start');
const stopBtn = $('stop');
const pauseBtn = $('pause');
const exportHtmlBtn = $('export-html');
const exportApiBtn = $('export-api');
const optionsBtn = $('options');
const logsBtn = $('logs');
const monitorBtn = $('monitor');
const dot = $('dot');
const meta = $('meta');
const log = $('log');

// AI Thought Card elements
const aiThoughtCard = $('ai-thought-card');
const aiThoughtText = $('ai-thought-text');
const aiActionText = $('ai-action-text');

// Phase indicator elements
const phaseIndicator = $('phase-indicator');
const phasePlan = $('phase-plan');
const phaseExtract = $('phase-extract');
const phaseFilter = $('phase-filter');
const phaseConfirm = $('phase-confirm');
const phaseExecute = $('phase-execute');

// Batch progress elements
const batchProgress = $('batch-progress');
const batchStatus = $('batch-status');
const batchBar = $('batch-bar');
const batchOk = $('batch-ok');
const batchFail = $('batch-fail');
const batchSkip = $('batch-skip');
const batchPending = $('batch-pending');

// Confirmation panel elements
const confirmPanel = $('confirm-panel');
const confirmTitle = $('confirm-title');
const confirmList = $('confirm-list');
const confirmApprove = $('confirm-approve');
const confirmReject = $('confirm-reject');
const confirmActions = $('confirm-actions');
const confirmPauseActions = $('confirm-pause-actions');
const confirmContinue = $('confirm-continue');

let running = false;
let paused = false;
let stepCount = 0;
let totalTokens = 0;
let modelName = '—';
let configSource = 'local';
let sessionData = []; // For export
let currentPhase = 'idle';

function appendLog(line, cls) {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = line;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  while (log.children.length > 200) log.removeChild(log.firstChild);
  
  // Store for export
  sessionData.push({
    time: new Date().toISOString(),
    text: line,
    type: cls || 'info'
  });
}

function refresh() {
  dot.className = 'dot ' + (running ? (paused ? 'paused' : 'working') : 'idle');
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  pauseBtn.disabled = !running;
  pauseBtn.textContent = paused ? '▶ Продолжить' : '⏸ Пауза';
  const src = configSource === 'remote' ? 'Gist' : 'локал.';
  const phaseText = currentPhase !== 'idle' ? ` · ${currentPhase}` : '';
  const tokensText = totalTokens > 0 ? ` · 🪙 ${totalTokens.toLocaleString()} tok` : '';
  meta.textContent = `Шагов: ${stepCount} · Модель: ${modelName} · ${src} · ${running ? (paused ? 'пауза' : 'работает') : 'ожидание'}${phaseText}${tokensText}`;
}

// Phase indicator management
const PHASE_ORDER = ['planning', 'extracting', 'filtering', 'confirming', 'executing'];

function updatePhaseIndicator(phase) {
  currentPhase = phase;
  if (!running || phase === 'idle' || phase === 'done') {
    phaseIndicator.classList.remove('active');
    return;
  }
  phaseIndicator.classList.add('active');
  const phases = [phasePlan, phaseExtract, phaseFilter, phaseConfirm, phaseExecute];
  const currentIdx = PHASE_ORDER.indexOf(phase);
  phases.forEach((el, i) => {
    el.classList.remove('done', 'current');
    if (i < currentIdx) el.classList.add('done');
    else if (i === currentIdx) el.classList.add('current');
  });
  refresh();
}

// Batch progress management
function updateBatchProgress(current, total, succeeded, failed, skipped) {
  batchProgress.classList.add('active');
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  batchBar.style.width = pct + '%';
  batchStatus.textContent = `Обработка ${current}/${total}...`;
  batchOk.textContent = succeeded || 0;
  batchFail.textContent = failed || 0;
  batchSkip.textContent = skipped || 0;
  batchPending.textContent = Math.max(0, (total || 0) - (current || 0));
}

function hideBatchProgress() {
  batchProgress.classList.remove('active');
}

// Confirmation panel management
function showConfirmation(items, goal, isIrreversible) {
  confirmPanel.classList.add('active');
  confirmTitle.textContent = isIrreversible
    ? `⚠ Подтверждение НЕОБРАТИМОГО действия: ${goal || 'пакетное действие'}`
    : `⚠ Подтверждение пакетного действия: ${goal || ''}`;
  confirmList.innerHTML = items.slice(0, 20).map(item =>
    `<div>• ${item.title || item.id}${item.url ? ' — ' + item.url.slice(0, 60) : ''}</div>`
  ).join('');
  if (items.length > 20) {
    confirmList.innerHTML += `<div>... и ещё ${items.length - 20}</div>`;
  }
  // Show Confirm/Cancel buttons, hide Continue
  confirmActions.style.display = '';
  confirmPauseActions.style.display = 'none';
}

function showPausedForConfirmation(items, goal) {
  confirmPanel.classList.add('active');
  confirmTitle.textContent = `⏸ Пауза — ожидаем вашего подтверждения`;
  confirmList.innerHTML = items.slice(0, 20).map(item =>
    `<div>• ${item.title || item.id}${item.url ? ' — ' + item.url.slice(0, 60) : ''}</div>`
  ).join('');
  if (items.length > 20) {
    confirmList.innerHTML += `<div>... и ещё ${items.length - 20}</div>`;
  }
  // Hide Confirm/Cancel, show Continue
  confirmActions.style.display = 'none';
  confirmPauseActions.style.display = '';
}

function hideConfirmation() {
  confirmPanel.classList.remove('active');
}

// Confirmation button handlers
confirmApprove.addEventListener('click', async () => {
  hideConfirmation();
  appendLog('✓ Пакет подтверждён пользователем', 'ok');
  await chrome.runtime.sendMessage({ kind: 'confirm_batch' });
});

confirmReject.addEventListener('click', async () => {
  hideConfirmation();
  appendLog('✗ Пакет отменён пользователем', 'err');
  await chrome.runtime.sendMessage({ kind: 'stop' });
});

confirmContinue.addEventListener('click', async () => {
  hideConfirmation();
  paused = false;
  refresh();
  appendLog('▶ Продолжаем пакетное выполнение...', 'ok');
  await chrome.runtime.sendMessage({ kind: 'resume' });
});

async function loadSettings() {
  const v = await chrome.storage.sync.get({
    model: 'xiaomi/mimo-v2.5', step_cap: 200, remote_config_url: ''
  });
  modelName = v.model || 'xiaomi/mimo-v2.5';
  stepcapEl.value = v.step_cap || 200;
  configSource = v.remote_config_url ? 'remote' : 'local';
  // Restore last task/context for convenience
  const last = await chrome.storage.local.get({ last_task: '', last_context: '', last_url: '' });
  taskEl.value = last.last_task || '';
  contextEl.value = last.last_context || '';

  // Auto-fill URL from the current active tab if the field is empty
  if (!last.last_url) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
        urlEl.value = tab.url;
      }
    } catch (_) {}
  } else {
    urlEl.value = last.last_url;
  }

  refresh();
}

/**
 * Request current status + buffered logs from background and update the UI.
 * This allows popup to restore full state after being closed and re-opened.
 */
async function syncWithBackground() {
  try {
    const resp = await chrome.runtime.sendMessage({ kind: 'get_status_and_logs' });
    if (!resp) return;

    // Restore status
    const st = resp.status || {};
    if (st.running) {
      running = true;
      paused = st.paused || false;
      stepCount = st.step || 0;
      totalTokens = st.totalTokensUsed || 0;
      if (st.phase && st.phase !== 'idle') {
        updatePhaseIndicator(st.phase);
      }
      refresh();
    }

    // Replay buffered logs
    if (Array.isArray(resp.logBuffer)) {
      for (const evt of resp.logBuffer) {
        replayBufferedEvent(evt);
      }
    }
  } catch (_) {
    // background not available yet — that's fine
  }
}

/**
 * Replay a single buffered event into the popup UI (same logic as onMessage listener).
 */
function replayBufferedEvent(msg) {
  switch (msg.kind) {
    case 'started':
      running = true;
      stepCount = 0;
      refresh();
      appendLog(`▶ Задача запущена: ${msg.task || ''}`);
      break;
    case 'step_start':
      stepCount = msg.step;
      refresh();
      break;
    case 'tokens_update':
      totalTokens = msg.totalTokensUsed || (totalTokens + (msg.tokensUsed || 0));
      refresh();
      break;
    case 'log':
      appendLog(msg.text, msg.level === 'error' ? 'err' : '');
      break;
    case 'action':
      appendLog(`#${msg.step} ${formatActionHuman(msg.action)}`, 'act');
      if (aiActionText) {
        aiActionText.textContent = formatActionHuman(msg.action);
        aiActionText.classList.remove('hidden');
      }
      break;
    case 'observation':
      appendLog(`#${msg.step} → ${formatObservationHuman(msg.observation)}`);
      break;
    case 'agent_thought':
      appendLog(`💭 #${msg.step}: ${formatThought(msg.thought)}`, 'act');
      if (aiThoughtCard) {
        aiThoughtCard.classList.remove('hidden');
        aiThoughtText.textContent = formatThought(msg.thought);
      }
      break;
    case 'model_call_start':
      appendLog(`⏳ #${msg.step}: модель думает...`);
      break;
    case 'model_call_end':
      if (msg.error) {
        appendLog(`❌ #${msg.step}: ошибка модели: ${msg.error}`, 'err');
      } else {
        appendLog(`✓ #${msg.step}: ответ за ${(msg.duration / 1000).toFixed(1)}с${msg.tokensUsed ? ' · 🪙' + msg.tokensUsed : ''}`);
      }
      break;
    case 'api_call':
      appendLog(`📡 ${msg.provider || 'API'} ${msg.method || 'POST'} ${(msg.url || '').slice(0, 50)} → ${msg.responseStatus || '?'}${msg.error ? ' ERR' : ''} (${msg.durationMs}ms)`, msg.error ? 'err' : '');
      break;
    case 'phase_changed':
      updatePhaseIndicator(msg.phase);
      appendLog(`Фаза: ${msg.phase}`);
      break;
    case 'plan_ready':
      if (msg.plan?.type === 'batch') {
        appendLog(`📋 Пакетный план: ${msg.plan.goal || 'без цели'}`, 'act');
      } else {
        appendLog('📋 Простой режим (пакетное планирование не требуется)');
      }
      break;
    case 'batch_started':
      appendLog(`🔄 Пакет начат: ${msg.total} элементов`, 'act');
      break;
    case 'batch_progress':
      updateBatchProgress(msg.current, msg.total, msg.succeeded, msg.failed, msg.skipped);
      break;
    case 'batch_finished':
      hideBatchProgress();
      if (msg.report) {
        const r = msg.report;
        appendLog(`📊 Пакет завершён: ${r.succeeded || 0}/${r.total || 0} ок`, r.ok ? 'ok' : 'err');
      }
      break;
    case 'confirmation_required':
      showConfirmation(msg.items || [], msg.goal || '', msg.isIrreversible || false);
      break;
    case 'paused_for_confirmation':
      paused = true;
      refresh();
      showPausedForConfirmation(msg.items || []);
      appendLog('⏸ Пауза — ожидаем подтверждения', '');
      break;
    case 'resumed_after_interrupt':
      running = true;
      paused = false;
      stepCount = msg.step || 0;
      refresh();
      appendLog(`⚡ Возобновлено на шаге ${msg.step}`, 'act');
      break;
    case 'finished':
      running = false;
      paused = false;
      stepCount = msg.steps || stepCount;
      hideBatchProgress();
      updatePhaseIndicator('done');
      refresh();
      appendLog(msg.ok ? ('✔ ' + (msg.answer || 'Готово')) : ('✖ ' + (msg.reason || 'Остановлено')),
                 msg.ok ? 'ok' : 'err');
      break;
  }
}

// Preset Tasks functionality
function initPresets() {
  const presetBtns = document.querySelectorAll('.preset-btn');
  presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const task = btn.dataset.task;
      const context = btn.dataset.context || '';
      taskEl.value = task;
      contextEl.value = context;
      
      // Visual feedback
      btn.style.background = '#16a34a';
      btn.style.borderColor = '#16a34a';
      setTimeout(() => {
        btn.style.background = '';
        btn.style.borderColor = '';
      }, 300);
      
      appendLog(`⚡ Шаблон загружен: ${task.slice(0, 40)}...`);
    });
  });
}

// Export HTML report with persistent screenshot URLs
exportHtmlBtn.addEventListener('click', async () => {
  appendLog('⏳ Генерация HTML-отчёта...');
  const r = await chrome.runtime.sendMessage({ kind: 'export_html_report' });
  if (r?.ok) {
    appendLog('📥 HTML-отчёт скачан', 'ok');
  } else {
    appendLog('Ошибка экспорта: ' + (r?.error || 'нет данных сессии'), 'err');
  }
});

// Export raw API log (CURL + responses)
exportApiBtn.addEventListener('click', async () => {
  appendLog('⏳ Генерация API-лога...');
  const r = await chrome.runtime.sendMessage({ kind: 'export_api_log' });
  if (r?.ok) {
    appendLog('📡 API-лог скачан', 'ok');
  } else {
    appendLog('Ошибка экспорта: ' + (r?.error || 'нет данных сессии'), 'err');
  }
});

startBtn.addEventListener('click', async () => {
  const task = taskEl.value.trim();
  if (!task) { appendLog('Введите задачу', 'err'); return; }
  const stepCap = Math.max(1, Math.min(2000, parseInt(stepcapEl.value, 10) || 200));
  const context = contextEl.value.trim();
  const initialUrl = urlEl.value.trim() || null;
  const dryRun = !!dryEl.checked;

  await chrome.storage.local.set({
    last_task: task, last_context: context, last_url: initialUrl || ''
  });
  await chrome.storage.sync.set({ step_cap: stepCap });

  stepCount = 0;
  totalTokens = 0;
  sessionData = [];
  running = true;
  paused = false;
  refresh();
  appendLog('▶ Запущено' + (dryRun ? ' [ТЕСТ]' : '') + ': ' + task);

  // Fire-and-forget: background responds immediately with {ok: true, started: true}
  // and continues the agent loop in the background. All subsequent events come via broadcast.
  const r = await chrome.runtime.sendMessage({
    kind: 'start',
    task,
    context,
    initialUrl,
    options: { stepCap, dryRun }
  });
  if (!r || !r.ok) {
    running = false;
    refresh();
    const err = r?.error || 'unknown';
    appendLog('Ошибка запуска: ' + err, 'err');
    if (err === 'missing_settings') {
      appendLog('Откройте Настройки и заполните токен / email / модель', 'err');
    }
  }
});

stopBtn.addEventListener('click', async () => {
  appendLog('⏹ Остановка...');
  await chrome.runtime.sendMessage({ kind: 'stop' });
});

pauseBtn.addEventListener('click', async () => {
  if (paused) {
    await chrome.runtime.sendMessage({ kind: 'resume' });
    paused = false;
    appendLog('▶ Продолжено');
  } else {
    await chrome.runtime.sendMessage({ kind: 'pause' });
    paused = true;
    appendLog('⏸ Приостановлено');
  }
  refresh();
});

optionsBtn.addEventListener('click', () => {
  try {
    chrome.runtime.openOptionsPage();
  } catch (_) {
    // Fallback: open options.html directly
    window.open(chrome.runtime.getURL('src/options.html'), '_blank');
  }
});
logsBtn.addEventListener('click', () => {
  window.open(chrome.runtime.getURL('src/logs.html'), '_blank');
});
monitorBtn.addEventListener('click', async () => {
  try {
    // Open Side Panel via chrome.sidePanel API (Chrome 114+)
    if (chrome.sidePanel) {
      await chrome.sidePanel.open({ windowId: undefined });
    } else {
      // Fallback: open sidepanel.html in a new tab
      window.open(chrome.runtime.getURL('src/sidepanel.html'), '_blank');
    }
  } catch (_) {
    window.open(chrome.runtime.getURL('src/sidepanel.html'), '_blank');
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg._agentEvent) return;
  switch (msg.kind) {
    case 'step_start':
      stepCount = msg.step;
      refresh();
      break;
    case 'tokens_update':
      totalTokens = msg.totalTokensUsed || (totalTokens + (msg.tokensUsed || 0));
      refresh();
      break;
    case 'log':
      appendLog(msg.text, msg.level === 'error' ? 'err' : '');
      break;
    case 'action':
      appendLog(`#${msg.step} ${formatActionHuman(msg.action)}`, 'act');
      if (aiActionText) {
        aiActionText.textContent = formatActionHuman(msg.action);
        aiActionText.classList.remove('hidden');
      }
      break;
    case 'observation':
      appendLog(`#${msg.step} → ${formatObservationHuman(msg.observation)}`);
      break;
    case 'agent_thought':
      appendLog(`💭 #${msg.step}: ${formatThought(msg.thought)}`, 'act');
      if (aiThoughtCard) {
        aiThoughtCard.classList.remove('hidden');
        aiThoughtText.textContent = formatThought(msg.thought);
      }
      break;
    case 'model_call_start':
      appendLog(`⏳ #${msg.step}: модель думает...`);
      break;
    case 'model_call_end':
      if (msg.error) {
        appendLog(`❌ #${msg.step}: ошибка модели: ${msg.error}`, 'err');
      } else {
        appendLog(`✓ #${msg.step}: ответ за ${(msg.duration / 1000).toFixed(1)}с${msg.tokensUsed ? ' · 🪙' + msg.tokensUsed : ''}`);
      }
      break;
    case 'api_call':
      appendLog(`📡 ${msg.provider || 'API'} ${msg.method || 'POST'} ${(msg.url || '').slice(0, 50)} → ${msg.responseStatus || '?'}${msg.error ? ' ERR' : ''} (${msg.durationMs}ms)`, msg.error ? 'err' : '');
      break;
    case 'phase_changed':
      updatePhaseIndicator(msg.phase);
      appendLog(`Фаза: ${msg.phase}`);
      break;
    case 'plan_ready':
      if (msg.plan?.type === 'batch') {
        appendLog(`📋 Пакетный план: ${msg.plan.goal || 'без цели'}`, 'act');
        if (msg.plan.requiresConfirmation) {
          appendLog('⚠ Этот план требует вашего подтверждения', '');
        }
      } else {
        appendLog('📋 Простой режим (пакетное планирование не требуется)');
      }
      break;
    case 'batch_started':
      appendLog(`🔄 Пакет начат: ${msg.total} элементов`, 'act');
      break;
    case 'batch_progress':
      updateBatchProgress(msg.current, msg.total, msg.succeeded, msg.failed, msg.skipped);
      break;
    case 'batch_finished':
      hideBatchProgress();
      if (msg.report) {
        const r = msg.report;
        appendLog(`📊 Пакет завершён: ${r.succeeded || 0}/${r.total || 0} ок, ${r.failed || 0} ошибок, ${r.skipped || 0} пропущено`, r.ok ? 'ok' : 'err');
      }
      break;
    case 'confirmation_required':
      showConfirmation(msg.items || [], msg.goal || '', msg.isIrreversible || false);
      appendLog(`⚠ Требуется подтверждение: ${(msg.items || []).length} элементов`, '');
      break;
    case 'paused_for_confirmation':
      paused = true;
      refresh();
      showPausedForConfirmation(msg.items || []);
      appendLog('⏸ Пауза — ожидаем вашего подтверждения', '');
      break;
    case 'resumed_after_interrupt':
      running = true;
      paused = false;
      stepCount = msg.step || 0;
      refresh();
      appendLog(`⚡ Возобновлено после перезагрузки SW на шаге ${msg.step} (фаза: ${msg.phase}, режим: ${msg.loopType})`, 'act');
      break;
    case 'finished':
      running = false;
      paused = false;
      stepCount = msg.steps || stepCount;
      hideBatchProgress();
      updatePhaseIndicator('done');
      refresh();
      appendLog(msg.ok ? ('✔ ' + (msg.answer || 'Готово')) : ('✖ ' + (msg.reason || 'Остановлено')),
                 msg.ok ? 'ok' : 'err');
      break;
  }
});

// Initialize
initPresets();
loadSettings().then(() => syncWithBackground());
