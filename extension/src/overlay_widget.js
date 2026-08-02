// overlay_widget.js — Floating overlay widget on all pages
//
// Shows a floating widget in the bottom-right corner that displays:
// - Agent status (running / paused / finished / idle)
// - Current phase (planning / extracting / filtering / confirming / executing)
// - Step counter + token usage
// - AI reasoning/thinking
// - Current action being executed
// - Observation/result of the last action
// - Infrastructure messages (screenshot, DOM snapshot, etc.)
//
// Clicking the widget opens the monitoring page (sidepanel.html).
// This runs as a content script on ALL pages (injected via manifest.json).

(function () {
  // ============================================================
  // STATE
  // ============================================================

  let agentRunning = false;
  let agentPaused = false;
  let currentStep = 0;
  let currentPhase = 'idle';
  let totalTokens = 0;
  let tokenLimit = 0;
  let modelName = '';
  let currentThought = '';
  let currentAction = '';
  let currentObservation = '';
  let lastInfraText = '';
  let modelThinking = false; // true while model is processing

  // ============================================================
  // CREATE DOM
  // ============================================================

  const overlay = document.createElement('div');
  overlay.id = 'webclaw-overlay';
  overlay.innerHTML = `
    <div class="webclaw-widget" id="webclaw-widget">
      <div class="webclaw-header" id="webclaw-header">
        <span class="webclaw-logo">🦞</span>
        <span class="webclaw-status" id="webclaw-status">Ожидание</span>
        <span class="webclaw-model" id="webclaw-model"></span>
        <span class="webclaw-step" id="webclaw-step"></span>
      </div>
      <div class="webclaw-body" id="webclaw-body">
        <!-- Phase + meta info -->
        <div class="webclaw-meta" id="webclaw-meta" style="display:none">
          <div class="webclaw-phase-row">
            <span class="webclaw-phase-badge" id="webclaw-phase-badge"></span>
            <span class="webclaw-tokens" id="webclaw-tokens"></span>
          </div>
          <div class="webclaw-phase-bar">
            <div class="webclaw-phase-dot" data-phase="planning"></div>
            <div class="webclaw-phase-dot" data-phase="extracting"></div>
            <div class="webclaw-phase-dot" data-phase="filtering"></div>
            <div class="webclaw-phase-dot" data-phase="confirming"></div>
            <div class="webclaw-phase-dot" data-phase="executing"></div>
          </div>
        </div>
        <!-- Infrastructure status -->
        <div class="webclaw-infra" id="webclaw-infra" style="display:none">
          <div class="webclaw-infra-text" id="webclaw-infra-text"></div>
        </div>
        <!-- Model thinking indicator -->
        <div class="webclaw-thinking" id="webclaw-thinking" style="display:none">
          <div class="webclaw-thinking-dots">
            <span></span><span></span><span></span>
          </div>
          <span class="webclaw-thinking-text">Модель думает...</span>
        </div>
        <!-- AI Thought -->
        <div class="webclaw-thought" id="webclaw-thought" style="display:none">
          <div class="webclaw-thought-label">💭 ИИ рассуждает:</div>
          <div class="webclaw-thought-text" id="webclaw-thought-text"></div>
        </div>
        <!-- Action -->
        <div class="webclaw-action" id="webclaw-action" style="display:none">
          <div class="webclaw-action-label">🎯 Действие:</div>
          <div class="webclaw-action-text" id="webclaw-action-text"></div>
        </div>
        <!-- Observation -->
        <div class="webclaw-observation" id="webclaw-observation" style="display:none">
          <div class="webclaw-observation-label">📊 Результат:</div>
          <div class="webclaw-observation-text" id="webclaw-observation-text"></div>
        </div>
        <!-- Empty state (shown when agent is idle) -->
        <div class="webclaw-empty" id="webclaw-empty">
          <div class="webclaw-empty-icon">🦞</div>
          <div class="webclaw-empty-text">Агент не запущен</div>
          <div class="webclaw-empty-hint">Запустите задачу из popup</div>
        </div>
      </div>
      <div class="webclaw-footer" id="webclaw-footer">
        <span class="webclaw-footer-text">Нажмите для мониторинга</span>
      </div>
    </div>
  `;

  // ============================================================
  // STYLES
  // ============================================================

  const style = document.createElement('style');
  style.textContent = `
    #webclaw-overlay {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 9999999;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      pointer-events: none;
    }
    #webclaw-widget {
      width: 320px;
      background: rgba(17, 20, 27, 0.95);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid #2a2f3a;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      pointer-events: auto;
      overflow: hidden;
      transition: all 0.3s ease;
    }
    #webclaw-widget:hover {
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    }
    .webclaw-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      background: #151820;
      border-bottom: 1px solid #1f2330;
      cursor: pointer;
    }
    .webclaw-logo {
      font-size: 18px;
    }
    .webclaw-status {
      flex: 1;
      font-size: 12px;
      color: #9aa3af;
      font-weight: 500;
    }
    .webclaw-status.running { color: #4ade80; }
    .webclaw-status.paused  { color: #facc15; }
    .webclaw-status.error   { color: #f87171; }
    .webclaw-status.done    { color: #60a5fa; }
    .webclaw-model {
      font-size: 9px;
      color: #8b5cf6;
      background: rgba(139, 92, 246, 0.1);
      padding: 1px 6px;
      border-radius: 3px;
      max-width: 100px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .webclaw-step {
      font-size: 11px;
      color: #6b7280;
      font-variant-numeric: tabular-nums;
    }
    .webclaw-body {
      padding: 12px 14px;
      max-height: 360px;
      overflow-y: auto;
    }

    /* Meta (phase + tokens) */
    .webclaw-meta {
      margin-bottom: 10px;
    }
    .webclaw-phase-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;
    }
    .webclaw-phase-badge {
      font-size: 10px;
      font-weight: 600;
      color: #38bdf8;
      background: rgba(56, 189, 248, 0.12);
      padding: 2px 8px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .webclaw-tokens {
      font-size: 10px;
      color: #facc15;
      font-variant-numeric: tabular-nums;
      font-weight: 600;
    }
    .webclaw-phase-bar {
      display: flex;
      gap: 3px;
    }
    .webclaw-phase-dot {
      flex: 1;
      height: 3px;
      border-radius: 2px;
      background: #1f2330;
      transition: background 0.3s;
    }
    .webclaw-phase-dot.done    { background: #16a34a; }
    .webclaw-phase-dot.current { background: #38bdf8; animation: wc-pulse 1.5s ease-in-out infinite; }
    @keyframes wc-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    /* Infrastructure */
    .webclaw-infra {
      margin-bottom: 8px;
      padding: 4px 0;
    }
    .webclaw-infra-text {
      font-size: 11px;
      color: #6b7280;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Model thinking indicator */
    .webclaw-thinking {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      padding: 6px 0;
    }
    .webclaw-thinking-dots {
      display: flex;
      gap: 3px;
    }
    .webclaw-thinking-dots span {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: #6366f1;
      animation: wc-dot-pulse 1.2s ease-in-out infinite;
    }
    .webclaw-thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
    .webclaw-thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes wc-dot-pulse {
      0%, 100% { opacity: 0.3; transform: scale(0.8); }
      50% { opacity: 1; transform: scale(1.2); }
    }
    .webclaw-thinking-text {
      font-size: 11px;
      color: #a5b4fc;
      font-weight: 500;
    }

    /* Thought / Action / Observation */
    .webclaw-thought,
    .webclaw-action,
    .webclaw-observation {
      margin-bottom: 10px;
    }
    .webclaw-thought-label,
    .webclaw-action-label,
    .webclaw-observation-label {
      font-size: 10px;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .webclaw-thought-text {
      font-size: 12px;
      color: #c4b5fd;
      font-style: italic;
      line-height: 1.4;
      max-height: 80px;
      overflow-y: auto;
    }
    .webclaw-action-text {
      font-size: 12px;
      color: #93c5fd;
      font-weight: 500;
    }
    .webclaw-observation-text {
      font-size: 12px;
      color: #86efac;
    }
    .webclaw-observation-text.error {
      color: #fca5a5;
    }

    /* Empty state */
    .webclaw-empty {
      text-align: center;
      padding: 20px 14px;
    }
    .webclaw-empty-icon {
      font-size: 32px;
      margin-bottom: 8px;
    }
    .webclaw-empty-text {
      font-size: 13px;
      color: #e6e8eb;
      margin-bottom: 4px;
    }
    .webclaw-empty-hint {
      font-size: 11px;
      color: #6b7280;
    }

    /* Footer */
    .webclaw-footer {
      padding: 8px 14px;
      background: #11141b;
      border-top: 1px solid #1f2330;
      cursor: pointer;
      text-align: center;
    }
    .webclaw-footer-text {
      font-size: 10px;
      color: #6b7280;
    }
    .webclaw-footer:hover .webclaw-footer-text {
      color: #9aa3af;
    }
  `;

  document.head.appendChild(style);
  document.body.appendChild(overlay);

  // ============================================================
  // DOM REFERENCES
  // ============================================================

  const $ = (id) => document.getElementById(id);
  const statusEl     = $('webclaw-status');
  const modelEl      = $('webclaw-model');
  const stepEl       = $('webclaw-step');
  const metaEl       = $('webclaw-meta');
  const phaseBadge   = $('webclaw-phase-badge');
  const tokensEl     = $('webclaw-tokens');
  const infraEl      = $('webclaw-infra');
  const infraText    = $('webclaw-infra-text');
  const thinkingEl   = $('webclaw-thinking');
  const thoughtEl    = $('webclaw-thought');
  const thoughtText  = $('webclaw-thought-text');
  const actionEl     = $('webclaw-action');
  const actionText   = $('webclaw-action-text');
  const obsEl        = $('webclaw-observation');
  const obsText      = $('webclaw-observation-text');
  const emptyEl      = $('webclaw-empty');
  const phaseDots    = document.querySelectorAll('.webclaw-phase-dot');

  // ============================================================
  // PHASE HELPERS
  // ============================================================

  const PHASE_ORDER = ['planning', 'extracting', 'filtering', 'confirming', 'executing'];
  const PHASE_LABELS = {
    planning:    '📋 Планирование',
    extracting:  '🔍 Извлечение',
    filtering:   '🔎 Фильтрация',
    confirming:  '⚠️ Подтверждение',
    executing:   '⚡ Выполнение',
    done:        '✔ Завершено',
    idle:        ''
  };

  function updatePhaseBar(phase) {
    const idx = PHASE_ORDER.indexOf(phase);
    phaseDots.forEach((dot, i) => {
      dot.classList.remove('done', 'current');
      if (idx < 0) return; // idle or unknown
      if (i < idx) dot.classList.add('done');
      else if (i === idx) dot.classList.add('current');
    });
  }

  // ============================================================
  // UI UPDATE FUNCTIONS
  // ============================================================

  function showEmpty() {
    emptyEl.style.display = '';
    metaEl.style.display = 'none';
    infraEl.style.display = 'none';
    thinkingEl.style.display = 'none';
    thoughtEl.style.display = 'none';
    actionEl.style.display = 'none';
    obsEl.style.display = 'none';
  }

  function hideEmpty() {
    emptyEl.style.display = 'none';
    metaEl.style.display = '';
  }

  function updateStatus(text, mode) {
    statusEl.textContent = text;
    statusEl.className = 'webclaw-status ' + (mode || '');
  }

  function updateStep(step) {
    stepEl.textContent = step > 0 ? `Шаг ${step}` : '';
  }

  function updateModel(name) {
    if (name) {
      // Show short model name (e.g., "gpt-4o" from "openai/gpt-4o")
      const short = name.includes('/') ? name.split('/').pop() : name;
      modelEl.textContent = short.slice(0, 20);
      modelEl.title = name; // full name on hover
      modelEl.style.display = '';
    } else {
      modelEl.style.display = 'none';
    }
  }

  function updateTokens() {
    if (totalTokens > 0) {
      const limit = tokenLimit > 0 ? ` / ${Math.round(tokenLimit / 1000)}k` : '';
      tokensEl.textContent = `🪙 ${totalTokens.toLocaleString()}${limit}`;
    } else {
      tokensEl.textContent = '';
    }
  }

  function updatePhase(phase) {
    currentPhase = phase;
    const label = PHASE_LABELS[phase] || phase || '';
    if (label) {
      phaseBadge.textContent = label;
      phaseBadge.style.display = '';
    } else {
      phaseBadge.style.display = 'none';
    }
    updatePhaseBar(phase);
  }

  function updateInfra(text) {
    if (text) {
      lastInfraText = text;
      infraText.textContent = text;
      infraEl.style.display = '';
      // Auto-hide infra after 4 seconds (it's transient)
      clearTimeout(updateInfra._timer);
      updateInfra._timer = setTimeout(() => {
        infraEl.style.display = 'none';
      }, 4000);
    } else {
      infraEl.style.display = 'none';
    }
  }

  function updateThinking(isThinking) {
    modelThinking = isThinking;
    thinkingEl.style.display = isThinking ? '' : 'none';
  }

  function updateThought(text) {
    if (text) {
      thoughtText.textContent = text;
      thoughtEl.style.display = '';
    } else {
      thoughtEl.style.display = 'none';
    }
  }

  function updateAction(text) {
    if (text) {
      actionText.textContent = text;
      actionEl.style.display = '';
    } else {
      actionEl.style.display = 'none';
    }
  }

  function updateObservation(text, isError) {
    if (text) {
      obsText.textContent = text;
      obsText.classList.toggle('error', !!isError);
      obsEl.style.display = '';
    } else {
      obsEl.style.display = 'none';
    }
  }

  // ============================================================
  // RESET to idle state
  // ============================================================

  function resetToIdle() {
    agentRunning = false;
    agentPaused = false;
    currentStep = 0;
    currentPhase = 'idle';
    totalTokens = 0;
    modelName = '';
    currentThought = '';
    currentAction = '';
    currentObservation = '';
    lastInfraText = '';
    modelThinking = false;

    updateStatus('Ожидание', '');
    updateStep(0);
    updateModel('');
    updatePhase('idle');
    updateTokens();
    updateThinking(false);
    updateThought('');
    updateAction('');
    updateObservation('');
    updateInfra('');
    showEmpty();
  }

  // ============================================================
  // FORMAT HELPERS (inline, no imports needed for content script)
  // ============================================================

  function formatAction(action) {
    if (!action) return '';
    const a = typeof action === 'string' ? (() => { try { return JSON.parse(action); } catch (_) { return { action: action }; } })() : action;
    const tool = a.tool || a.action || '?';
    const params = [];
    if (a.selector) params.push(a.selector);
    if (a.text) params.push(`"${a.text.slice(0, 40)}"`);
    if (a.direction) params.push(a.direction);
    if (a.url) params.push(a.url.slice(0, 50));
    if (a.x !== undefined && a.y !== undefined) params.push(`(${a.x},${a.y})`);
    if (a.key) params.push(a.key);
    if (a.value) params.push(a.value);
    if (a.amount) params.push(`${a.amount}px`);
    const paramStr = params.length > 0 ? ': ' + params.join(', ') : '';
    return `${tool}${paramStr}`;
  }

  function formatObservation(obs) {
    if (!obs) return '';
    const o = typeof obs === 'string' ? (() => { try { return JSON.parse(obs); } catch (_) { return { ok: obs }; } })() : obs;
    if (o.ok === false || o.error) return `❌ ${o.error || 'ошибка'}`;
    if (o.ok === true) {
      if (o.text) return `✅ "${o.text.slice(0, 50)}"`;
      if (o.value) return `✅ ${String(o.value).slice(0, 60)}`;
      if (o.scrollY !== undefined) return `✅ scrollY=${o.scrollY}`;
      if (o.selected) return `✅ ${o.selected}`;
      if (o.fileName) return `✅ ${o.fileName}`;
      return '✅ OK';
    }
    return JSON.stringify(o).slice(0, 80);
  }

  // ============================================================
  // MESSAGE LISTENER
  // ============================================================

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg._agentEvent) return;

    switch (msg.kind) {

      // ---- Agent lifecycle ----

      case 'started':
        agentRunning = true;
        agentPaused = false;
        currentStep = 0;
        currentPhase = 'idle';
        totalTokens = 0;
        modelName = msg.model || '';
        tokenLimit = msg.tokenLimit || 0;
        modelThinking = false;
        hideEmpty();
        updateStatus('Работает', 'running');
        updateModel(modelName);
        updateStep(0);
        updateTokens();
        updatePhase('idle');
        updateThinking(false);
        updateThought('');
        updateAction('');
        updateObservation('');
        break;

      case 'finished':
        agentRunning = false;
        agentPaused = false;
        modelThinking = false;
        updateThinking(false);
        if (msg.ok) {
          updateStatus('✔ Готово', 'done');
        } else {
          updateStatus('✖ Остановлено', 'error');
        }
        updatePhase('done');
        // Keep the last thought/action/observation visible for a longer time
        // Then after 15 seconds, reset to idle
        clearTimeout(resetToIdle._finishTimer);
        resetToIdle._finishTimer = setTimeout(() => {
          resetToIdle();
        }, 15000);
        break;

      // ---- Pause / Resume ----

      case 'paused':
        agentPaused = true;
        updateStatus('⏸ Пауза', 'paused');
        break;

      case 'resume':
        agentPaused = false;
        updateStatus('Работает', 'running');
        break;

      // ---- Step progress ----

      case 'step_start':
        currentStep = msg.step;
        updateStep(msg.step);
        // Do NOT clear thought/action/observation here — they persist from
        // the previous step until new ones arrive. This prevents flickering
        // between steps.
        break;

      // ---- Phase changes ----

      case 'phase_changed':
        updatePhase(msg.phase);
        break;

      // ---- Plan ----

      case 'plan_ready':
        if (msg.plan?.type === 'batch') {
          updateInfra(`📋 Пакетный план: ${msg.plan.goal || ''}`);
        } else {
          updateInfra('📋 Простой режим');
        }
        break;

      // ---- Model calls ----

      case 'model_call_start':
        updateThinking(true);
        updateInfra('🧠 Модель думает...');
        break;

      case 'model_call_end':
        updateThinking(false);
        if (msg.error) {
          updateInfra(`❌ Ошибка модели: ${msg.error}`);
        } else {
          const dur = msg.duration ? `${(msg.duration / 1000).toFixed(1)}с` : '';
          const tok = msg.tokensUsed ? ` · 🪙${msg.tokensUsed}` : '';
          updateInfra(`✅ Ответ за ${dur}${tok}`);
        }
        break;

      // ---- Tokens ----

      case 'tokens_update':
        totalTokens = msg.totalTokensUsed || totalTokens;
        updateTokens();
        break;

      // ---- AI Thought ----

      case 'agent_thought':
        currentThought = msg.thought || '';
        updateThought(currentThought);
        break;

      // ---- Action ----

      case 'action':
        currentAction = msg.action ? formatAction(msg.action) : '';
        updateAction(currentAction);
        break;

      // ---- Observation ----

      case 'observation':
        if (msg.observation) {
          const isError = msg.observation.ok === false || !!msg.observation.error;
          currentObservation = formatObservation(msg.observation);
          updateObservation(currentObservation, isError);
        }
        break;

      // ---- Infrastructure messages ----

      case 'infra':
        updateInfra(msg.text || '');
        break;

      case 'screenshot_captured':
        // Brief flash — handled by infra text
        break;

      case 'snapshot_ready':
        // Brief flash — handled by infra text
        break;

      // ---- Batch progress ----

      case 'batch_started':
        updateInfra(`🔄 Пакет: ${msg.total} элементов`);
        break;

      case 'batch_progress':
        if (msg.total) {
          const pct = Math.round(((msg.current || 0) / msg.total) * 100);
          updateInfra(`🔄 ${msg.current}/${msg.total} (${pct}%) ✅${msg.succeeded || 0} ❌${msg.failed || 0}`);
        }
        break;

      case 'batch_finished':
        if (msg.report) {
          const r = msg.report;
          updateInfra(`📊 Пакет: ${r.succeeded || 0}/${r.total || 0} ок`);
        }
        break;

      // ---- Confirmation ----

      case 'confirmation_required':
        updateInfra(`⚠ Требуется подтверждение: ${(msg.items || []).length} элементов`);
        break;

      case 'paused_for_confirmation':
        agentPaused = true;
        updateStatus('⏸ Подтверждение', 'paused');
        updateInfra('⏸ Ожидаем вашего подтверждения');
        break;

      // ---- Resume after SW restart ----

      case 'resumed_after_interrupt':
        agentRunning = true;
        agentPaused = false;
        currentStep = msg.step || 0;
        hideEmpty();
        updateStatus('⚡ Возобновлено', 'running');
        updateStep(currentStep);
        if (msg.phase) updatePhase(msg.phase);
        // Restore model name from message or previously stored value
        if (msg.model) modelName = msg.model;
        if (modelName) updateModel(modelName);
        break;

      // ---- API call logging ----

      case 'api_call':
        // Don't show in overlay — too noisy
        break;

      // ---- Selector sanitized ----

      case 'selector_sanitized':
        // Don't show in overlay
        break;

      // ---- Log messages (from background) ----

      case 'log':
        // Show error logs briefly in infra
        if (msg.level === 'error') {
          updateInfra(`❌ ${msg.text || ''}`);
        }
        break;
    }

    return true;
  });

  // ============================================================
  // CLICK HANDLERS (open monitoring page)
  // ============================================================

  const header = $('webclaw-header');
  const footer = $('webclaw-footer');

  function openMonitoringPage() {
    // Content scripts cannot use chrome.tabs.create or chrome.sidePanel.open directly.
    // Send a message to the background script to open the monitoring page.
    chrome.runtime.sendMessage({ kind: 'openSidePanel' }).catch(() => {
      // Fallback: try the logs page via background
      chrome.runtime.sendMessage({ kind: 'openLogs' }).catch(() => {});
    });
  }

  if (header) header.addEventListener('click', openMonitoringPage);
  if (footer) footer.addEventListener('click', openMonitoringPage);

  // ============================================================
  // INIT: check if agent is already running (for pages loaded after agent started)
  // ============================================================

  (async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ kind: 'status' });
      if (resp && resp.running) {
        agentRunning = true;
        agentPaused = resp.paused || false;
        currentStep = resp.step || 0;
        currentPhase = resp.phase || 'idle';
        if (resp.totalTokensUsed) totalTokens = resp.totalTokensUsed;
        hideEmpty();
        updateStatus(agentPaused ? '⏸ Пауза' : 'Работает', agentPaused ? 'paused' : 'running');
        updateStep(currentStep);
        updatePhase(currentPhase);
        updateTokens();
      }
      // Also fetch log buffer to restore last known state (thoughts, actions, tokens)
      try {
        const logsResp = await chrome.runtime.sendMessage({ kind: 'get_status_and_logs' });
        if (logsResp) {
          if (logsResp.status?.totalTokensUsed) {
            totalTokens = logsResp.status.totalTokensUsed;
            updateTokens();
          }
          // Replay recent events to restore widget state
          const buffer = logsResp.logBuffer || [];
          for (const evt of buffer.slice(-20)) { // last 20 events
            if (evt.kind === 'agent_thought' && evt.thought) {
              currentThought = evt.thought;
              updateThought(currentThought);
            } else if (evt.kind === 'action' && evt.action) {
              currentAction = formatAction(evt.action);
              updateAction(currentAction);
            } else if (evt.kind === 'observation' && evt.observation) {
              const isError = evt.observation.ok === false || !!evt.observation.error;
              currentObservation = formatObservation(evt.observation);
              updateObservation(currentObservation, isError);
            } else if (evt.kind === 'tokens_update' && evt.totalTokensUsed) {
              totalTokens = evt.totalTokensUsed;
              updateTokens();
            }
          }
        }
      } catch (_) {}
    } catch (_) {
      // background not available — that's fine, widget stays in idle state
    }
  })();

})();
