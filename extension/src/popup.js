// popup.js — popup UI logic for WebClaw

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
const dot = $('dot');
const meta = $('meta');
const log = $('log');

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
  pauseBtn.textContent = paused ? '▶ Resume' : '⏸ Pause';
  const src = configSource === 'remote' ? 'Gist' : 'local';
  const phaseText = currentPhase !== 'idle' ? ` · ${currentPhase}` : '';
  const tokensText = totalTokens > 0 ? ` · 🪙 ${totalTokens.toLocaleString()} tok` : '';
  meta.textContent = `Steps: ${stepCount} · Model: ${modelName} · ${src} · ${running ? (paused ? 'paused' : 'working') : 'idle'}${phaseText}${tokensText}`;
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
  batchStatus.textContent = `Processing ${current}/${total}...`;
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
    ? `⚠ Confirm IRREVERSIBLE action: ${goal || 'batch action'}`
    : `⚠ Confirm batch action: ${goal || ''}`;
  confirmList.innerHTML = items.slice(0, 20).map(item =>
    `<div>• ${item.title || item.id}${item.url ? ' — ' + item.url.slice(0, 60) : ''}</div>`
  ).join('');
  if (items.length > 20) {
    confirmList.innerHTML += `<div>... and ${items.length - 20} more</div>`;
  }
  // Show Confirm/Cancel buttons, hide Continue
  confirmActions.style.display = '';
  confirmPauseActions.style.display = 'none';
}

function showPausedForConfirmation(items, goal) {
  confirmPanel.classList.add('active');
  confirmTitle.textContent = `⏸ Paused — waiting for your approval`;
  confirmList.innerHTML = items.slice(0, 20).map(item =>
    `<div>• ${item.title || item.id}${item.url ? ' — ' + item.url.slice(0, 60) : ''}</div>`
  ).join('');
  if (items.length > 20) {
    confirmList.innerHTML += `<div>... and ${items.length - 20} more</div>`;
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
  appendLog('✓ Batch confirmed by user', 'ok');
  await chrome.runtime.sendMessage({ kind: 'confirm_batch' });
});

confirmReject.addEventListener('click', async () => {
  hideConfirmation();
  appendLog('✗ Batch cancelled by user', 'err');
  await chrome.runtime.sendMessage({ kind: 'stop' });
});

confirmContinue.addEventListener('click', async () => {
  hideConfirmation();
  paused = false;
  refresh();
  appendLog('▶ Continuing batch after pause...', 'ok');
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
  urlEl.value = last.last_url || '';
  refresh();
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
      
      appendLog(`⚡ Preset loaded: ${task.slice(0, 40)}...`);
    });
  });
}

// Export HTML report with persistent screenshot URLs
exportHtmlBtn.addEventListener('click', async () => {
  appendLog('⏳ Generating HTML report...');
  const r = await chrome.runtime.sendMessage({ kind: 'export_html_report' });
  if (r?.ok) {
    appendLog('📥 HTML report downloaded', 'ok');
  } else {
    appendLog('Export failed: ' + (r?.error || 'no session data'), 'err');
  }
});

// Export raw API log (CURL + responses)
exportApiBtn.addEventListener('click', async () => {
  appendLog('⏳ Generating API log...');
  const r = await chrome.runtime.sendMessage({ kind: 'export_api_log' });
  if (r?.ok) {
    appendLog('📡 API log downloaded', 'ok');
  } else {
    appendLog('Export failed: ' + (r?.error || 'no session data'), 'err');
  }
});

startBtn.addEventListener('click', async () => {
  const task = taskEl.value.trim();
  if (!task) { appendLog('Enter a task', 'err'); return; }
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
  appendLog('▶ Started' + (dryRun ? ' [DRY-RUN]' : '') + ': ' + task);

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
    appendLog('Failed to start: ' + err, 'err');
    if (err === 'missing_settings') {
      appendLog('Open Settings and fill in token / email / model', 'err');
    }
  }
});

stopBtn.addEventListener('click', async () => {
  appendLog('⏹ Stopping...');
  await chrome.runtime.sendMessage({ kind: 'stop' });
});

pauseBtn.addEventListener('click', async () => {
  if (paused) {
    await chrome.runtime.sendMessage({ kind: 'resume' });
    paused = false;
    appendLog('▶ Resumed');
  } else {
    await chrome.runtime.sendMessage({ kind: 'pause' });
    paused = true;
    appendLog('⏸ Paused');
  }
  refresh();
});

optionsBtn.addEventListener('click', () => chrome.runtime.sendMessage({ kind: 'openOptions' }));
logsBtn.addEventListener('click', () => chrome.runtime.sendMessage({ kind: 'openLogs' }));

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.kind !== 'agent_event') return;
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
      appendLog(`#${msg.step} ${JSON.stringify(msg.action)}`, 'act');
      break;
    case 'observation':
      appendLog(`#${msg.step} → ${JSON.stringify(msg.observation).slice(0, 200)}`);
      break;
    case 'phase_changed':
      updatePhaseIndicator(msg.phase);
      appendLog(`Phase: ${msg.phase}`);
      break;
    case 'plan_ready':
      if (msg.plan?.type === 'batch') {
        appendLog(`📋 Batch plan: ${msg.plan.goal || 'no goal'}`, 'act');
        if (msg.plan.requiresConfirmation) {
          appendLog('⚠ This plan requires your confirmation', '');
        }
      } else {
        appendLog('📋 Simple mode (no batch planning needed)');
      }
      break;
    case 'batch_started':
      appendLog(`🔄 Batch started: ${msg.total} items`, 'act');
      break;
    case 'batch_progress':
      updateBatchProgress(msg.current, msg.total, msg.succeeded, msg.failed, msg.skipped);
      break;
    case 'batch_finished':
      hideBatchProgress();
      if (msg.report) {
        const r = msg.report;
        appendLog(`📊 Batch complete: ${r.succeeded || 0}/${r.total || 0} ok, ${r.failed || 0} failed, ${r.skipped || 0} skipped`, r.ok ? 'ok' : 'err');
      }
      break;
    case 'confirmation_required':
      showConfirmation(msg.items || [], msg.goal || '', msg.isIrreversible || false);
      appendLog(`⚠ Confirmation required: ${(msg.items || []).length} items`, '');
      break;
    case 'paused_for_confirmation':
      paused = true;
      refresh();
      showPausedForConfirmation(msg.items || []);
      appendLog('⏸ Paused — waiting for your approval', '');
      break;
    case 'resumed_after_interrupt':
      running = true;
      paused = false;
      stepCount = msg.step || 0;
      refresh();
      appendLog(`⚡ Resumed after SW interruption at step ${msg.step} (phase: ${msg.phase}, loop: ${msg.loopType})`, 'act');
      break;
    case 'finished':
      running = false;
      paused = false;
      stepCount = msg.steps || stepCount;
      hideBatchProgress();
      updatePhaseIndicator('done');
      refresh();
      appendLog(msg.ok ? ('✔ ' + (msg.answer || 'Done')) : ('✖ ' + (msg.reason || 'Stopped')),
                 msg.ok ? 'ok' : 'err');
      break;
  }
});

// Initialize
initPresets();
loadSettings();
