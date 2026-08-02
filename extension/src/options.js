// options.js — settings page logic

import { getSettings, setSettings, clearSettings } from './settings.js';
import { probeRemoteConfig } from './remote_config.js';
import { testProvider } from './providers.js';

const $ = (id) => document.getElementById(id);
const providerEl = $('provider');
const apiBaseUrlEl = $('api_base_url');
const apiKeyEl = $('api_key');
const tokenEl = $('auth_token');
const emailEl = $('user_email');
const modelEl = $('model');
const modelCustomEl = $('model_custom');
const tempEl = $('temperature');
const reasonEl = $('reasoning');
const stepEl = $('step_cap');
const ctxEl = $('user_context');
const remoteEl = $('remote_config_url');
const fetchRemoteBtn = $('fetch_remote');
const showGistBtn = $('show_gist_format');
const gistTpl = $('gist_template');
const saveBtn = $('save');
const testBtn = $('test');
const statusEl = $('status');
// v3.0 elements
const cdpInputEl = $('cdp_input_mode');
const iframeBypassEl = $('iframe_bypass_enabled');
const spaNetIdleEl = $('spa_network_idle_ms');
const spaDomStableEl = $('spa_dom_stable_ms');
const viewportWidthEl = $('agent_viewport_width');
const viewportHeightEl = $('agent_viewport_height');
// v4.0 batch elements
const actionDelayEl = $('action_delay_ms');
const maxActionsEl = $('max_actions_per_session');
const autonomyModeEl = $('autonomy_mode');

const KNOWN = new Set([
  'xiaomi/mimo-v2.5',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'anthropic/claude-3.5-sonnet',
  'anthropic/claude-3.7-sonnet',
  'google/gemini-2.0-flash',
  'google/gemini-2.5-pro',
  'meta-llama/llama-3.2-90b-vision-instruct'
]);

function effectiveModel() {
  if (modelEl.value === '__custom__') return (modelCustomEl.value || '').trim();
  return modelEl.value;
}

function applyModelToUI(model) {
  if (KNOWN.has(model)) {
    modelEl.value = model;
    modelCustomEl.style.display = 'none';
  } else if (model) {
    modelEl.value = '__custom__';
    modelCustomEl.style.display = '';
    modelCustomEl.value = model;
  }
}

modelEl.addEventListener('change', () => {
  modelCustomEl.style.display = modelEl.value === '__custom__' ? '' : 'none';
});

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (cls ? ' ' + cls : '');
}

async function load() {
  const s = await getSettings();
  tokenEl.value = s.auth_token || '';
  emailEl.value = s.user_email || '';
  providerEl.value = s.provider || 'protalk';
  apiBaseUrlEl.value = s.api_base_url || '';
  apiKeyEl.value = s.api_key || '';
  applyModelToUI(s.model || 'xiaomi/mimo-v2.5');
  tempEl.value = s.temperature ?? 0.2;
  reasonEl.value = s.reasoning || 'low';
  stepEl.value = s.step_cap || 200;
  ctxEl.value = s.user_context || '';
  remoteEl.value = s.remote_config_url || '';
  // v3.0
  cdpInputEl.checked = s.cdp_input_mode !== false;
  iframeBypassEl.checked = s.iframe_bypass_enabled !== false;
  spaNetIdleEl.value = s.spa_network_idle_ms || 500;
  spaDomStableEl.value = s.spa_dom_stable_ms || 300;
  viewportWidthEl.value = s.agent_viewport_width || 1280;
  viewportHeightEl.value = s.agent_viewport_height || 800;
  // v4.0 batch
  actionDelayEl.value = s.action_delay_ms || 2000;
  maxActionsEl.value = s.max_actions_per_session || 50;
  autonomyModeEl.value = s.autonomy_mode || 'full';
}

saveBtn.addEventListener('click', async () => {
  const model = effectiveModel();
  const prov = providerEl.value;
  const isOllama = prov === 'ollama';
  // Ollama needs no auth; others need model + auth
  if (!model) { setStatus('Выберите модель', 'err'); return; }
  if (!isOllama && !tokenEl.value.trim() && !apiKeyEl.value.trim()) {
    setStatus('Заполните Auth Token или API Key', 'err'); return;
  }
  await setSettings({
    auth_token: tokenEl.value.trim(),
    user_email: emailEl.value.trim(),
    model,
    provider: prov,
    api_base_url: apiBaseUrlEl.value.trim(),
    api_key: apiKeyEl.value.trim(),
    temperature: parseFloat(tempEl.value) || 0.2,
    reasoning: reasonEl.value,
    step_cap: Math.max(1, Math.min(2000, parseInt(stepEl.value, 10) || 200)),
    user_context: ctxEl.value,
    remote_config_url: remoteEl.value.trim(),
    // v3.0
    cdp_input_mode: cdpInputEl.checked,
    iframe_bypass_enabled: iframeBypassEl.checked,
    spa_network_idle_ms: parseInt(spaNetIdleEl.value, 10) || 500,
    spa_dom_stable_ms: parseInt(spaDomStableEl.value, 10) || 300,
    agent_viewport_width: parseInt(viewportWidthEl.value, 10) || 1280,
    agent_viewport_height: parseInt(viewportHeightEl.value, 10) || 800,
    // v4.0 batch
    action_delay_ms: parseInt(actionDelayEl.value, 10) || 2000,
    max_actions_per_session: parseInt(maxActionsEl.value, 10) || 50,
    autonomy_mode: autonomyModeEl.value
  });
  setStatus('Сохранено ✓', 'ok');
});

showGistBtn.addEventListener('click', () => {
  gistTpl.style.display = gistTpl.style.display === 'none' ? 'block' : 'none';
});

fetchRemoteBtn.addEventListener('click', async () => {
  const url = remoteEl.value.trim();
  if (!url) { setStatus('Введите URL', 'err'); return; }
  setStatus('Загружаю конфиг...');
  const r = await probeRemoteConfig(url);
  if (!r.ok) { setStatus('Не удалось загрузить: ' + r.error, 'err'); return; }
  const c = r.config;
  // Merge: remote fills empty fields only (we don't want to clobber what user has).
  // SECURITY: auth_token and api_key are NEVER imported from remote config
  if (!emailEl.value.trim() && c.user_email) emailEl.value = c.user_email;
  if (c.provider) providerEl.value = c.provider;
  if (!apiBaseUrlEl.value.trim() && c.api_base_url) apiBaseUrlEl.value = c.api_base_url;
  if (c.model) applyModelToUI(c.model);
  if (c.temperature != null) tempEl.value = c.temperature;
  if (c.reasoning) reasonEl.value = c.reasoning;
  if (c.step_cap != null) stepEl.value = c.step_cap;
  if (!ctxEl.value.trim() && c.user_context) ctxEl.value = c.user_context;
  // v3.0
  if (c.cdp_input_mode !== undefined) cdpInputEl.checked = !!c.cdp_input_mode;
  if (c.iframe_bypass_enabled !== undefined) iframeBypassEl.checked = !!c.iframe_bypass_enabled;
  if (c.spa_network_idle_ms != null) spaNetIdleEl.value = c.spa_network_idle_ms;
  if (c.spa_dom_stable_ms != null) spaDomStableEl.value = c.spa_dom_stable_ms;
  if (c.agent_viewport_width != null) viewportWidthEl.value = c.agent_viewport_width;
  if (c.agent_viewport_height != null) viewportHeightEl.value = c.agent_viewport_height;
  // v4.0 batch
  if (c.action_delay_ms != null) actionDelayEl.value = c.action_delay_ms;
  if (c.max_actions_per_session != null) maxActionsEl.value = c.max_actions_per_session;
  if (c.autonomy_mode) autonomyModeEl.value = c.autonomy_mode;
  setStatus('Конфиг загружен. Не забудь нажать «Сохранить».', 'ok');
});

testBtn.addEventListener('click', async () => {
  setStatus('Проверяю...');
  const model = effectiveModel();
  if (!model) { setStatus('Сначала выберите модель', 'err'); return; }
  // Build a temporary settings object from form values
  const testSettings = {
    provider: providerEl.value,
    auth_token: tokenEl.value.trim(),
    api_key: apiKeyEl.value.trim(),
    user_email: emailEl.value.trim(),
    api_base_url: apiBaseUrlEl.value.trim(),
    model,
    temperature: parseFloat(tempEl.value) || 0.2,
    reasoning: reasonEl.value
  };
  const r = await testProvider(testSettings);
  if (r.ok) {
    setStatus(`OK · ${r.provider}: ${r.reply}`, 'ok');
  } else {
    setStatus('Ошибка: ' + r.error, 'err');
  }
});

load();
