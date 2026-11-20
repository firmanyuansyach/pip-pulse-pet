// app.js — Pip's browser side: consent gate, camera capture, WebSocket
// transport to the local server, and the signal readouts.
//
// Nothing in this file runs a camera or sends a frame before the person
// has read the consent gate and clicked one of its buttons.

import { Pip } from './pet.js';

const $ = (id) => document.getElementById(id);
const pip = new Pip($('pip-svg'));

const state = {
  ws: null,
  mode: null, // 'live' | 'demo'
  stream: null,
  pumpTimer: null,
  latestFrame: null,
  lastTickAt: performance.now(),
};

const FRAME_W = 640;
const FRAME_H = 480;
const FRAME_EVERY_MS = 66; // ~15 fps is plenty for vitals, kind to CPUs

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function connect() {
  const ws = new WebSocket(`ws://${location.host}/signals`);
  state.ws = ws;

  ws.addEventListener('message', (ev) => {
    if (typeof ev.data !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'hello') onHello(msg);
    else if (msg.type === 'metrics') {
      state.latestFrame = msg.data;
      pip.ingest(msg.data, performance.now());
    } else if (msg.type === 'validation') {
      showHint(msg.hint);
    } else if (msg.type === 'status' && msg.state === 'measuring') {
      onMeasuring(msg);
    } else if (msg.type === 'error') {
      endSession(`Something stopped the measurement: ${msg.message}`);
    }
  });

  ws.addEventListener('close', () => {
    if (state.mode) endSession('The connection to Pip\u2019s local server was lost. Nothing was saved; you can start again whenever you like.');
  });
}

function send(obj) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Consent + session lifecycle
// ---------------------------------------------------------------------------

function onHello(msg) {
  $('telemetry-line').innerHTML = msg.telemetry
    ? '<strong>SDK telemetry:</strong> ON in this install (chosen by whoever runs the server). With telemetry on, the SmartSpectra SDK sends Presage aggregate session summaries and device-readiness diagnostic reports — it never attaches video frames or your measured values. Details are in the project README.'
    : '<strong>SDK telemetry:</strong> OFF in this install (Pip\u2019s default). The SmartSpectra SDK sends no session summaries or diagnostic reports to Presage.';
  if (!msg.liveAvailable) {
    $('consent-live').disabled = true;
    const note = $('live-unavailable');
    note.textContent =
      'Live mode is not available on this server right now (no SmartSpectra API key configured, or the SDK failed to load). Demo mode below works completely — and live mode takes one free key from physiology.presagetech.com in a local .env file.';
    note.classList.remove('hidden');
  }
}

async function startLive() {
  hideError();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: FRAME_W }, height: { ideal: FRAME_H }, facingMode: 'user' },
      audio: false,
    });
  } catch (err) {
    showError(`The camera could not be started (${err.name}). Check the browser's camera permission for this page, or explore demo mode instead — Pip behaves the same there.`);
    return;
  }
  state.stream = stream;
  state.mode = 'live';
  $('preview').srcObject = stream;
  $('consent-gate').classList.add('hidden');
  $('scenario-card').classList.add('hidden');
  $('camera-card').classList.remove('hidden');
  $('stop-btn').disabled = false;
  send({ type: 'start', mode: 'live' });
  startPump();
}

function startDemo() {
  hideError();
  state.mode = 'demo';
  $('consent-gate').classList.add('hidden');
  $('camera-card').classList.add('hidden');
  $('scenario-card').classList.remove('hidden');
  $('stop-btn').disabled = false;
  send({ type: 'start', mode: 'demo' });
}

function onMeasuring(msg) {
  const badge = $('source-badge');
  badge.classList.remove('hidden', 'live', 'demo');
  if (state.mode === 'demo') {
    badge.textContent = 'DEMO MODE — SIMULATED SIGNALS';
    badge.classList.add('demo');
  } else {
    badge.textContent = `● LIVE — ${msg.bundle ?? 'SmartSpectra'}`;
    badge.classList.add('live');
  }
}

function startPump() {
  const video = $('preview');
  const canvas = document.createElement('canvas');
  canvas.width = FRAME_W;
  canvas.height = FRAME_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  state.pumpTimer = setInterval(() => {
    if (!state.stream || video.readyState < 2 || state.ws?.readyState !== WebSocket.OPEN) return;
    ctx.drawImage(video, 0, 0, FRAME_W, FRAME_H);
    const img = ctx.getImageData(0, 0, FRAME_W, FRAME_H);
    const out = new ArrayBuffer(8 + img.data.length);
    const view = new DataView(out);
    view.setUint32(0, FRAME_W, true);
    view.setUint32(4, FRAME_H, true);
    new Uint8Array(out, 8).set(img.data);
    state.ws.send(out);
  }, FRAME_EVERY_MS);
}

function endSession(message) {
  if (state.pumpTimer) clearInterval(state.pumpTimer);
  state.pumpTimer = null;
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
  }
  if (state.mode) send({ type: 'stop' });
  state.mode = null;
  state.latestFrame = null;
  $('preview').srcObject = null;
  $('stop-btn').disabled = true;
  $('source-badge').classList.add('hidden');
  $('scenario-card').classList.add('hidden');
  $('camera-card').classList.remove('hidden');
  $('consent-gate').classList.remove('hidden');
  if (message) {
    const note = $('live-unavailable');
    note.textContent = message;
    note.classList.remove('hidden');
  }
  resetSignalCards();
}

// ---------------------------------------------------------------------------
// Readouts + hints + errors
// ---------------------------------------------------------------------------

let hintTimer = null;
function showHint(hint) {
  const el = $('validation-hint');
  el.textContent = `📷 Camera hint from the SDK: ${hint}`;
  el.classList.remove('hidden');
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(() => el.classList.add('hidden'), 7000);
}

function showError(text) {
  const el = $('error-banner');
  el.textContent = text;
  el.classList.remove('hidden');
}
function hideError() {
  $('error-banner').classList.add('hidden');
}

function dot(el, sample) {
  el.className = 'dot' + (sample?.stable ? ' ok' : sample && (sample.confidence ?? 0) >= 40 ? ' mid' : '');
}

function fmt(v, digits = 0) {
  return typeof v === 'number' ? v.toFixed(digits) : '—';
}

function updateSignalCards() {
  const f = state.latestFrame;
  $('sig-pulse').textContent = f?.pulse ? fmt(f.pulse.value) : '—';
  dot($('dot-pulse'), f?.pulse);
  $('sig-breathing').textContent = f?.breathing ? fmt(f.breathing.value, 1) : '—';
  dot($('dot-breathing'), f?.breathing);
  if (f?.expression) {
    const name = f.expression.dominant.charAt(0) + f.expression.dominant.slice(1).toLowerCase();
    $('sig-expression').textContent = `${name} (${Math.round(f.expression.confidence)}%)`;
    dot($('dot-expression'), f.expression);
  } else {
    $('sig-expression').textContent = '—';
    dot($('dot-expression'), null);
  }
  if (f?.hrv?.rmssd != null) {
    $('sig-hrv').textContent = `${fmt(f.hrv.rmssd)} ms`;
    $('sig-hrv-note').textContent = 'from your last 60 s of pulse — informational only';
  } else {
    $('sig-hrv').textContent = '—';
    $('sig-hrv-note').textContent = 'collecting… needs ~60 s of pulse';
  }
}

function resetSignalCards() {
  state.latestFrame = null;
  updateSignalCards();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

$('consent-live').addEventListener('click', startLive);
$('consent-demo').addEventListener('click', startDemo);
$('stop-btn').addEventListener('click', () => endSession());
$('calm-toggle').addEventListener('change', (ev) => {
  pip.setCalmMode(ev.target.checked);
  $('calm-meter-wrap').classList.toggle('hidden', !ev.target.checked);
});
for (const btn of document.querySelectorAll('[data-scenario]')) {
  btn.addEventListener('click', () => send({ type: 'scenario', name: btn.dataset.scenario }));
}

setInterval(updateSignalCards, 250);

function loop(now) {
  const dt = now - state.lastTickAt;
  state.lastTickAt = now;
  pip.tick(now, dt);
  const mood = pip.mood();
  if ($('mood-line').textContent !== mood.label) $('mood-line').textContent = mood.label;
  if (pip.calmMode) {
    const pct = Math.round(pip.calmProgress * 100);
    $('calm-meter-fill').style.width = `${pct}%`;
    $('calm-meter-label').textContent = pip.asleep ? '🌙 Pip is asleep' : `🌙 ${pct}% to sleep`;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

connect();
