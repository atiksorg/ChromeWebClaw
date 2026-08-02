// sidepanel.js — Agent Monitor Side Panel
//
// Rich timeline view showing:
//   - AI thinking/reasoning per step
//   - Actions taken with visual badges
//   - Observations/results
//   - Screenshot thumbnails (click to expand)
//   - Model call timing
//   - Token usage sparkline
//   - Phase tracking
//   - Controls: pause/stop

import { formatActionHuman, formatObservationHuman, formatThought } from './format_helper.js';

const $ = (id) => document.getElementById(id);

// DOM refs
const dot = $('dot');
const statStep = $('stat-step');
const statTokens = $('stat-tokens');
const statThinking = $('stat-thinking');
const statThinkingTime = $('stat-thinking-time');
const taskDisplay = $('task-display');
const btnPause = $('btn-pause');
const btnStop = $('btn-stop');
const tokenChart = $('token-chart');
const timeline = $('timeline');
const emptyState = $('empty-state');
const lightbox = $('lightbox');
const lightboxImg = $('lightbox-img');

// ============================================================
// HELPERS
// ============================================================

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// State
let steps = new Map(); // step number → step data object
let running = false;
let paused = false;
let stepCount = 0;
let totalTokens = 0;
let currentPhase = 'idle';
let task = '';
let activeFilter = 'all';
let tokenHistory = []; // [{step, tokens}]
let thinkingStartTime = 0;
let thinkingTimer = null;

// ============================================================
// STATE HELPERS
// ============================================================

function getOrCreateStep(stepNum) {
  if (!steps.has(stepNum)) {
    steps.set(stepNum, {
      num: stepNum,
      thought: '',
      action: null,
      observation: null,
      screenshotUrl: null,
      modelDuration: 0,
      tokensUsed: 0,
      error: null,
      logLines: [],
      timestamp: new Date(),
      phase: currentPhase
    });
  }
  return steps.get(stepNum);
}

// ============================================================
// RENDERING
// ============================================================

function updateStats() {
  statStep.textContent = stepCount;
  statTokens.textContent = totalTokens > 0 ? totalTokens.toLocaleString() : '0';
  dot.className = 'dot ' + (running ? (paused ? 'paused' : 'working') : 'idle');

  // Thinking timer
  if (thinkingStartTime > 0) {
    statThinking.style.display = '';
    const elapsed = Math.round((Date.now() - thinkingStartTime) / 1000);
    statThinkingTime.textContent = elapsed + 'с';
  } else {
    statThinking.style.display = 'none';
  }
}

function updateControls() {
  if (running) {
    btnPause.style.display = '';
    btnStop.style.display = '';
    btnPause.textContent = paused ? '▶ Продолжить' : '⏸ Пауза';
  } else {
    btnPause.style.display = 'none';
    btnStop.style.display = 'none';
  }
}

function updateTaskDisplay() {
  if (task) {
    taskDisplay.textContent = task;
    taskDisplay.style.color = '#e6e8eb';
  } else {
    taskDisplay.textContent = 'Нет активной задачи';
    taskDisplay.style.color = '#6b7280';
  }
}

function updateTokenChart() {
  if (tokenHistory.length === 0) return;
  const maxTokens = Math.max(...tokenHistory.map(t => t.tokens), 1);

  tokenChart.innerHTML = '';
  const recent = tokenHistory.slice(-40); // last 40 steps
  for (const entry of recent) {
    const bar = document.createElement('div');
    bar.className = 'token-bar';
    const pct = Math.max(5, Math.round((entry.tokens / maxTokens) * 100));
    bar.style.height = pct + '%';
    bar.title = `Шаг ${entry.step}: ${entry.tokens} токенов`;
    tokenChart.appendChild(bar);
  }
}

function renderStep(stepData) {
  const num = stepData.num;
  const existingEl = document.getElementById(`step-${num}`);

  // Build step card HTML with human-readable formatting
  const hasError = !!stepData.error;
  const humanAction = stepData.action ? formatActionHuman(stepData.action) : (stepData.thought ? '💭 Рассуждение' : '⏳ В процессе');
  const actionType = stepData.action?.action || (stepData.thought ? 'thinking' : 'unknown');
  const actionClass = ['click', 'type', 'scroll', 'navigate', 'done', 'fail', 'wait'].includes(actionType)
    ? actionType : (actionType === 'thinking' ? 'thinking' : 'other');

  const time = stepData.timestamp.toLocaleTimeString();

  let html = `
    <div class="step-header" onclick="toggleStep(${num})">
      <span class="step-num">#${num}</span>
      <span class="step-action-badge ${actionClass}">${escapeHtml(humanAction.slice(0, 50))}</span>
      ${stepData.modelDuration > 0 ? `<span class="step-duration">${(stepData.modelDuration / 1000).toFixed(1)}с</span>` : ''}
      ${stepData.tokensUsed > 0 ? `<span style="font-size:10px;color:#6b7280">🪙${stepData.tokensUsed}</span>` : ''}
      <span class="step-time">${time}</span>
    </div>
    <div class="step-body" id="step-body-${num}">`;

  // Thought block with beautiful styling
  if (stepData.thought) {
    html += `
      <div class="thought-block">
        <div class="thought-title">💭 Ход мыслей ИИ:</div>
        <div class="thought-content">${escapeHtml(formatThought(stepData.thought))}</div>
      </div>`;
  }

  // Human-readable action summary
  if (stepData.action) {
    html += `
      <div class="observation-badge ${hasError ? 'err' : 'ok'}">
        ${escapeHtml(humanAction)}
      </div>`;
    
    // Raw JSON hidden in details spoiler
    const actionJson = JSON.stringify(stepData.action, null, 2);
    html += `
      <details class="detail">
        <summary class="detail-label" style="cursor:pointer">📋 Технические детали</summary>
        <pre>${escapeHtml(actionJson)}</pre>
      </details>`;
  }

  // Observation result
  if (stepData.observation) {
    const obsOk = stepData.observation.ok !== false;
    const humanObs = formatObservationHuman(stepData.observation);
    html += `
      <div class="observation-badge ${obsOk ? 'ok' : 'err'}">
        ${escapeHtml(humanObs)}
      </div>`;
  }

  // Error
  if (stepData.error) {
    html += `<div class="observation-badge err">❌ ${escapeHtml(stepData.error)}</div>`;
  }

  // Log lines
  if (stepData.logLines.length > 0) {
    html += `
      <details class="detail">
        <summary class="detail-label" style="cursor:pointer">📋 Логи шага (${stepData.logLines.length})</summary>
        <pre>${stepData.logLines.map(l => escapeHtml(l)).join('\n')}</pre>
      </details>`;
  }

  // Screenshot thumbnail
  if (stepData.screenshotUrl) {
    html += `
      <div class="screenshot-thumb" onclick="openLightbox('${escapeHtml(stepData.screenshotUrl)}')">
        <img src="${escapeHtml(stepData.screenshotUrl)}" alt="Step ${num}" loading="lazy" />
      </div>`;
  }

  html += '</div>';

  // Apply filter visibility
  const isVisible = isStepVisible(stepData);

  if (existingEl) {
    existingEl.innerHTML = html;
    existingEl.className = `step-card${hasError ? ' has-error' : ''}`;
    existingEl.style.display = isVisible ? '' : 'none';
  } else {
    const card = document.createElement('div');
    card.id = `step-${num}`;
    card.className = `step-card${hasError ? ' has-error' : ''}`;
    card.innerHTML = html;
    card.style.display = isVisible ? '' : 'none';
    timeline.appendChild(card);

    // Hide empty state
    if (emptyState) emptyState.style.display = 'none';

    // Auto-expand last 2 steps
    const body = card.querySelector('.step-body');
    if (body && steps.size <= 3) {
      body.classList.add('open');
    }

    // Auto-scroll to latest
    timeline.scrollTop = timeline.scrollHeight;
  }
}

function isStepVisible(stepData) {
  if (activeFilter === 'all') return true;
  if (activeFilter === 'thought') return !!stepData.thought;
  if (activeFilter === 'action') return !!stepData.action && stepData.action.action !== 'thinking';
  if (activeFilter === 'error') return !!stepData.error;
  return true;
}

function applyFilter(filter) {
  activeFilter = filter;
  // Update filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  // Show/hide steps
  for (const [num, stepData] of steps) {
    const el = document.getElementById(`step-${num}`);
    if (el) {
      el.style.display = isStepVisible(stepData) ? '' : 'none';
    }
  }
}

// ============================================================
// GLOBAL FUNCTIONS (called from HTML onclick)
// ============================================================

window.toggleStep = function(num) {
  const body = document.getElementById(`step-body-${num}`);
  if (body) body.classList.toggle('open');
};

window.openLightbox = function(src) {
  lightboxImg.src = src;
  lightbox.classList.add('active');
};

// ============================================================
// EVENT HANDLING
// ============================================================

function handleEvent(msg) {
  switch (msg.kind) {
    case 'started':
      running = true;
      paused = false;
      stepCount = 0;
      totalTokens = 0;
      task = msg.task || '';
      steps.clear();
      tokenHistory = [];
      // Clear timeline
      timeline.innerHTML = '';
      if (emptyState) {
        timeline.appendChild(emptyState);
        emptyState.style.display = '';
      }
      updateStats();
      updateControls();
      updateTaskDisplay();
      break;

    case 'step_start':
      stepCount = msg.step;
      getOrCreateStep(msg.step).timestamp = new Date(msg.ts || Date.now());
      updateStats();
      break;

    case 'agent_thought': {
      const step = getOrCreateStep(msg.step);
      step.thought = msg.thought || '';
      renderStep(step);
      break;
    }

    case 'model_call_start':
      thinkingStartTime = Date.now();
      if (thinkingTimer) clearInterval(thinkingTimer);
      thinkingTimer = setInterval(updateStats, 500);
      updateStats();
      break;

    case 'model_call_end': {
      thinkingStartTime = 0;
      if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
      const step = getOrCreateStep(msg.step);
      step.modelDuration = msg.duration || 0;
      step.tokensUsed = msg.tokensUsed || 0;
      if (step.tokensUsed > 0) {
        tokenHistory.push({ step: msg.step, tokens: step.tokensUsed });
        updateTokenChart();
      }
      if (msg.error) {
        step.error = msg.error;
      }
      renderStep(step);
      updateStats();
      break;
    }

    case 'api_call': {
      const targetStep = stepCount > 0 ? stepCount : 0;
      if (targetStep > 0) {
        const step = getOrCreateStep(targetStep);
        step.logLines.push(`📡 ${msg.provider || 'API'} ${(msg.url || '').slice(0, 50)} → ${msg.responseStatus || '?'} (${msg.durationMs}ms)`);
        const body = document.getElementById(`step-body-${targetStep}`);
        if (body && body.classList.contains('open')) renderStep(step);
      }
      break;
    }

    case 'tokens_update':
      totalTokens = msg.totalTokensUsed || 0;
      updateStats();
      break;

    case 'log': {
      // Associate log with current step
      const targetStep = stepCount > 0 ? stepCount : 0;
      if (targetStep > 0) {
        const step = getOrCreateStep(targetStep);
        step.logLines.push(msg.text || '');
        // Keep last 20 lines per step
        if (step.logLines.length > 20) step.logLines.shift();
        // Don't re-render the full step for every log line (too noisy)
        // Only update if the step body is open
        const body = document.getElementById(`step-body-${targetStep}`);
        if (body && body.classList.contains('open')) {
          renderStep(step);
        }
      }
      break;
    }

    case 'action': {
      const step = getOrCreateStep(msg.step);
      step.action = msg.action || null;
      renderStep(step);
      break;
    }

    case 'observation': {
      const step = getOrCreateStep(msg.step);
      step.observation = msg.observation || null;
      renderStep(step);
      break;
    }

    case 'phase_changed':
      currentPhase = msg.phase || 'idle';
      updateStats();
      break;

    case 'plan_ready':
      // Show plan summary as a special card at the top
      if (emptyState) emptyState.style.display = 'none';
      const planCard = document.createElement('div');
      planCard.className = 'step-card';
      planCard.style.borderColor = '#312e81';
      const planType = msg.plan?.type === 'batch' ? '📦 Batch' : '📋 Simple';
      const planGoal = msg.plan?.goal || msg.plan?.reason || '';
      planCard.innerHTML = `
        <div class="step-header">
          <span class="step-action-badge thinking">ПЛАН</span>
          <span style="flex:1;font-size:12px;color:#c4b5fd">${escapeHtml(planType)}${planGoal ? ': ' + escapeHtml(planGoal.slice(0, 100)) : ''}</span>
        </div>`;
      timeline.appendChild(planCard);
      break;

    case 'batch_started':
    case 'batch_progress':
      // Update progress in task display
      if (msg.total) {
        taskDisplay.textContent = `${task} — ${msg.current || 0}/${msg.total}`;
      }
      break;

    case 'paused_for_confirmation':
      paused = true;
      updateStats();
      updateControls();
      break;

    case 'confirmation_required':
      // Show confirmation info
      const confCard = document.createElement('div');
      confCard.className = 'step-card';
      confCard.style.borderColor = '#ca8a04';
      confCard.innerHTML = `
        <div class="step-header">
          <span class="step-action-badge thinking">⚠ ПОДТВЕРЖДЕНИЕ</span>
          <span style="flex:1;font-size:12px;color:#facc15">${(msg.items || []).length} элементов</span>
        </div>`;
      timeline.appendChild(confCard);
      break;

    case 'finished':
      running = false;
      paused = false;
      thinkingStartTime = 0;
      if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
      stepCount = msg.steps || stepCount;
      updateStats();
      updateControls();

      // Show finish card
      const finCard = document.createElement('div');
      finCard.className = 'step-card';
      finCard.style.borderColor = msg.ok ? '#16a34a' : '#dc2626';
      const finEmoji = msg.ok ? '✅' : '❌';
      const finText = msg.ok ? (msg.answer || 'Готово') : (msg.reason || 'Остановлено');
      finCard.innerHTML = `
        <div class="step-header">
          <span>${finEmoji}</span>
          <span style="flex:1;font-size:12px;color:${msg.ok ? '#86efac' : '#fca5a5'}">${escapeHtml(finText.slice(0, 150))}</span>
        </div>`;
      timeline.appendChild(finCard);
      timeline.scrollTop = timeline.scrollHeight;
      break;

    case 'resumed_after_interrupt':
      running = true;
      paused = false;
      stepCount = msg.step || 0;
      currentPhase = msg.phase || 'idle';
      updateStats();
      updateControls();
      break;

    // ---- Infrastructure events (screenshot, snapshot, page readiness) ----
    case 'infra':
    case 'screenshot_captured':
    case 'snapshot_ready':
    case 'selector_sanitized': {
      // Show as a compact infra line in the current step's log
      const infraStep = stepCount > 0 ? stepCount : 0;
      if (infraStep > 0) {
        const step = getOrCreateStep(infraStep);
        let line = '';
        if (msg.kind === 'infra') {
          line = msg.text || '';
        } else if (msg.kind === 'screenshot_captured') {
          line = msg.requestedByModel ? '📸 Скриншот запрошен моделью' : '📸 Скриншот получен';
        } else if (msg.kind === 'snapshot_ready') {
          line = `🔍 DOM: ${msg.elementCount || 0} элементов`;
        } else if (msg.kind === 'selector_sanitized') {
          line = `⚠ Селектор: "${msg.original}" → "${msg.cleaned}"`;
        }
        if (line) {
          step.logLines.push(line);
          // Keep last 20 lines
          if (step.logLines.length > 20) step.logLines.shift();
          const body = document.getElementById(`step-body-${infraStep}`);
          if (body && body.classList.contains('open')) renderStep(step);
        }
      }
      break;
    }
  }
}

// ============================================================
// INIT
// ============================================================

// Listen for real-time events
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg._agentEvent) return;
  handleEvent(msg);
});

// Request current state + buffer on load
async function init() {
  try {
    const resp = await chrome.runtime.sendMessage({ kind: 'get_status_and_logs' });
    if (!resp) return;

    // Restore status
    const st = resp.status || {};
    running = st.running || false;
    paused = st.paused || false;
    stepCount = st.step || 0;
    totalTokens = st.totalTokensUsed || 0;
    task = st.task || '';
    currentPhase = st.phase || 'idle';

    updateStats();
    updateControls();
    updateTaskDisplay();

    // Replay buffered events
    if (Array.isArray(resp.logBuffer)) {
      for (const evt of resp.logBuffer) {
        handleEvent(evt);
      }
    }
  } catch (_) {
    // background not available
  }
}

// Controls
btnPause.addEventListener('click', async () => {
  if (paused) {
    await chrome.runtime.sendMessage({ kind: 'resume' });
    paused = false;
  } else {
    await chrome.runtime.sendMessage({ kind: 'pause' });
    paused = true;
  }
  updateStats();
  updateControls();
});

btnStop.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ kind: 'stop' });
});

// Filters
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    applyFilter(btn.dataset.filter);
  });
});

// Lightbox close
lightbox.addEventListener('click', () => {
  lightbox.classList.remove('active');
});

// Auto-scroll toggle: if user scrolls up, stop auto-scrolling
let autoScroll = true;
timeline.addEventListener('scroll', () => {
  const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 50;
  autoScroll = atBottom;
});

// Start
init();
