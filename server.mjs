// server.mjs — Pip's local server.
//
// Serves the browser UI, receives webcam frames from the page over a
// WebSocket, feeds them to the Presage SmartSpectra SDK (custom-input mode),
// and streams normalized signals back to the page. Also hosts the clearly
// labelled demo mode (simulated signals) that needs no camera and no key,
// and a recorded check-in mode that measures a pre-recorded video file
// (sdk.useFile) through the exact same pipeline — see the README.
//
// Privacy posture (see README + the DEV post's Consent and Data Handling):
//   - The API key is read from a local .env file and never leaves this machine
//     except inside the SDK's own authenticated requests to Presage.
//   - Camera frames are processed in memory by the SDK on this machine.
//     This server records nothing, stores nothing, and has no database.
//   - SmartSpectra SDK telemetry is DISABLED by default here
//     (enableTelemetry: false). Set SMARTSPECTRA_TELEMETRY=true in .env to
//     opt in; the UI discloses the current setting before consent.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { normalizeMetrics } from './lib/normalize.mjs';
import { SignalSimulator } from './lib/simulator.mjs';

try {
  process.loadEnvFile(new URL('./.env', import.meta.url));
} catch {
  // No .env file — live mode will report the missing key; demo mode works.
}

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.SMARTSPECTRA_API_KEY?.trim() || null;
const TELEMETRY = /^(1|true|yes)$/i.test(process.env.SMARTSPECTRA_TELEMETRY || '');
// Local alias used at the SDK constructor call sites (same pattern as
// video-test.mjs).
const SS_KEY = API_KEY;

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
};

// ---------------------------------------------------------------------------
// Recorded check-in: a pre-recorded face video the SDK measures with
// useFile() instead of a live camera stream — for devices whose camera
// link cannot hold the steady frame rate the SDK's vitals need.
// Resolution order: $PIP_VIDEO_FILE, ./checkin-video.avi, ./face-video.avi.
// The file itself is personal data: it is only ever read by the SDK on
// this machine, never served over HTTP, and never uploaded by Pip.
// ---------------------------------------------------------------------------

const PROJECT_DIR = fileURLToPath(new URL('./', import.meta.url));

function resolveCheckinVideo() {
  const fromEnv = process.env.PIP_VIDEO_FILE?.trim();
  if (fromEnv) {
    const p = isAbsolute(fromEnv) ? fromEnv : join(PROJECT_DIR, fromEnv);
    if (existsSync(p)) return p;
    console.warn('[pip] PIP_VIDEO_FILE is set but no file exists there — falling back to the default names');
  }
  for (const name of ['checkin-video.avi', 'face-video.avi']) {
    const p = join(PROJECT_DIR, name);
    if (existsSync(p)) return p;
  }
  return null;
}

const CHECKIN_VIDEO_PATH = resolveCheckinVideo();
const CHECKIN_DISPLAY_AVAILABLE = existsSync(join(PUBLIC_DIR, 'checkin-display.mp4'));

// Load the SDK lazily-tolerantly: if the native runtime is unavailable on
// this machine, demo mode must still work and live mode must say why.
let sdkModule = null;
let sdkLoadError = null;
try {
  sdkModule = await import('@smartspectra/node-sdk');
} catch (err) {
  sdkLoadError = err;
  console.warn(`[pip] SmartSpectra SDK failed to load: ${err.message}`);
}

// ---------------------------------------------------------------------------
// SDK sessions: one SmartSpectra measurement session per connection. The
// base class owns the metric-bundle ladder, the metrics/validation/error
// wiring, and teardown; subclasses only differ in where frames come from —
// LiveSession is fed browser camera frames, VideoSession reads a recorded
// check-in file. Both push through the same normalize + broadcast path.
// ---------------------------------------------------------------------------

const BUNDLE_LADDER = sdkModule
  ? [
      {
        name: 'expressions + pulse + breathing',
        signals: ['expression', 'pulse', 'breathing'],
        metrics: [...sdkModule.breathingMetrics, ...sdkModule.cardioMetrics, ...sdkModule.faceMetrics],
      },
      {
        name: 'pulse + breathing',
        signals: ['pulse', 'breathing'],
        metrics: [...sdkModule.breathingMetrics, ...sdkModule.cardioMetrics],
      },
      { name: 'breathing', signals: ['breathing'], metrics: [...sdkModule.breathingMetrics] },
    ]
  : [];

function isConfigFailure(code, err) {
  const cf = sdkModule?.SmartSpectraErrorCode?.kConfigurationFailed;
  if (cf !== undefined && code === cf) return true;
  const text = `${code ?? ''} ${err?.message ?? err ?? ''}`;
  return /configuration/i.test(text);
}

class SdkSession {
  constructor(send) {
    this.send = send;
    this.source = 'live'; // subclasses override ('video')
    this.sdk = null;
    this.bundleIndex = 0;
    this.gotMetrics = false;
    this.stopping = false;
    this.framesFed = 0;
    this.framesRejected = 0;
  }

  async start() {
    if (!API_KEY) {
      this.send({
        type: 'error',
        code: 'no_api_key',
        message:
          'No SmartSpectra API key is configured on this server. Add SMARTSPECTRA_API_KEY to the .env file next to server.mjs and restart — or use demo mode, which needs no key.',
        retryable: false,
      });
      return false;
    }
    if (!sdkModule) {
      this.send({
        type: 'error',
        code: 'sdk_unavailable',
        message: `The SmartSpectra SDK could not be loaded on this machine: ${sdkLoadError?.message ?? 'unknown error'}`,
        retryable: false,
      });
      return false;
    }
    return this.startWithBundle(0);
  }

  async startWithBundle(index) {
    this.bundleIndex = index;
    const bundle = BUNDLE_LADDER[index];
    const { SmartSpectraSDK, decodeMetrics } = sdkModule;

    const sdk = new SmartSpectraSDK({
      apiKey: SS_KEY,
      requestedMetrics: bundle.metrics,
      enableTelemetry: TELEMETRY,
    });
    this.sdk = sdk;
    this.gotMetrics = false;

    sdk.on('metrics', (buf) => {
      if (!this.gotMetrics) console.log('[pip] first metrics event received from the SDK');
      this.gotMetrics = true;
      this.metricsEvents = (this.metricsEvents ?? 0) + 1;
      let decoded = null;
      try {
        decoded = decodeMetrics(buf);
      } catch {
        decoded = null;
      }
      const frame = normalizeMetrics(decoded);
      if (this.metricsEvents <= 3 || this.metricsEvents % 30 === 0) {
        const n = (a) => (Array.isArray(a) ? a.length : 0);
        console.log(
          `[pip] metrics #${this.metricsEvents}: raw samples pulse=${n(decoded?.cardio?.pulseRate)} ` +
            `breathing=${n(decoded?.breathing?.rate)} expression=${n(decoded?.face?.expression)} ` +
            `landmarks=${n(decoded?.face?.landmarks)} -> page: pulse=${frame?.pulse?.value ?? '-'} ` +
            `breathing=${frame?.breathing?.value ?? '-'} expression=${frame?.expression?.dominant ?? '-'}`,
        );
      }
      if (frame) {
        this.send({ type: 'metrics', source: this.source, activeSignals: bundle.signals, data: frame });
      }
    });

    sdk.on('validationStatus', (code, _ts, hint) => {
      if (hint) {
        console.log(`[pip] SDK validation: code=${code} hint="${String(hint)}"`);
        this.send({ type: 'validation', hint: String(hint) });
      }
    });

    sdk.on('error', (code, message, retryable) => {
      void this.handleError(code, message, retryable);
    });

    try {
      this.configureInput(sdk);
      sdk.start();
    } catch (err) {
      await this.handleError(err?.code, err?.message ?? String(err), false);
      return false;
    }
    this.afterStart?.();

    console.log(`[pip] ${this.source} session started — bundle: ${bundle.name}`);
    this.send({ type: 'status', state: 'measuring', activeSignals: bundle.signals, bundle: bundle.name });
    return true;
  }

  async handleError(code, message, retryable) {
    if (this.stopping) return;
    // A configuration failure before any metrics arrived usually means the
    // API key's plan doesn't cover one of the requested bundles. Step down
    // the ladder once per bundle instead of dying (documented behaviour in
    // the SDK's own migration notes: retry with a smaller bundle).
    if (!this.gotMetrics && isConfigFailure(code) && this.bundleIndex < BUNDLE_LADDER.length - 1) {
      const next = this.bundleIndex + 1;
      console.warn(`[pip] bundle ${this.bundleIndex} rejected (${message}); retrying with ${BUNDLE_LADDER[next].name}`);
      await this.teardownSdk();
      await this.startWithBundle(next);
      return;
    }
    const authHint = /auth|403|forbidden/i.test(`${code} ${message}`)
      ? ' If your key looks correct, this can be a free-tier key activation issue — the Presage Discord (linked from physiology.presagetech.com) is the fastest fix.'
      : '';
    this.send({ type: 'error', code: String(code ?? 'sdk_error'), message: `${message}${authHint}`, retryable: !!retryable });
    await this.teardownSdk();
  }

  // Subclasses point the SDK at their frame source before start().
  configureInput(_sdk) {
    throw new Error('configureInput not implemented');
  }

  // Only the live subclass ever receives frames (the WS layer routes
  // binary messages to it alone); video sessions accept no frames at all.
  handleFrame(buf) {
    if (!this.sdk || this.stopping) return;
    if (buf.length < 8) return;
    const width = buf.readUInt32LE(0);
    const height = buf.readUInt32LE(4);
    if (width < 16 || width > 1920 || height < 16 || height > 1080) return;
    const pixels = buf.subarray(8);
    if (pixels.length < width * height * 3) return; // frames arrive packed as RGB
    const tsUs = Number(process.hrtime.bigint() / 1000n); // monotonic µs (per SDK docs)
    try {
      const accepted = this.sdk.sendFrame(pixels, width, height, width * 3, sdkModule.PixelFormat.kRGB, tsUs);
      this.framesFed += 1;
      if (accepted === false) this.framesRejected += 1;
      const nowMs = Date.now();
      if (this.lastFpsLogAt && nowMs - this.lastFpsLogAt >= 5000) {
        const fps = ((this.framesFed - this.lastFpsCount) / ((nowMs - this.lastFpsLogAt) / 1000)).toFixed(1);
        console.log(
          `[pip] frames fed: ${this.framesFed} (rejected: ${this.framesRejected}, ~${fps} fps), metrics received: ${this.gotMetrics}`,
        );
        this.lastFpsLogAt = nowMs;
        this.lastFpsCount = this.framesFed;
      } else if (!this.lastFpsLogAt) {
        this.lastFpsLogAt = nowMs;
        this.lastFpsCount = this.framesFed;
      }
    } catch {
      // A frame racing a stop() is expected occasionally; drop it.
    }
  }

  async teardownSdk() {
    const sdk = this.sdk;
    this.sdk = null;
    if (sdk) {
      try {
        await sdk.stopAsync();
      } catch { /* already stopped */ }
      try {
        await sdk.destroy();
      } catch { /* already destroyed */ }
    }
  }

  async stop() {
    this.stopping = true;
    await this.teardownSdk();
  }
}

class LiveSession extends SdkSession {
  configureInput(sdk) {
    sdk.useCustomInput(sdkModule.FrameTransform.kNone);
  }
}

// ---------------------------------------------------------------------------
// Recorded check-in session: the same metric pipeline, fed by a video file
// instead of camera frames. The SDK read runs in a CHILD PROCESS
// (video-runner.mjs) because the SDK's waitUntilComplete() blocks the
// calling thread for the whole read — in-process it froze this server's
// event loop before the graph could start and no metrics ever flowed.
// The child uses the exact call sequence proven by the standalone tester
// and streams normalized frames back as JSON lines. When the file ends,
// the page is told ('video-ended') so it can show the complete state.
// ---------------------------------------------------------------------------

class VideoSession {
  constructor(send, videoPath, onEnded) {
    this.send = send;
    this.source = 'video';
    this.videoPath = videoPath;
    this.onEnded = onEnded;
    this.child = null;
    this.gotMetrics = false;
    this.metricsEvents = 0;
    this.stopping = false;
    this.ended = false;
    this.watchdog = null;
  }

  async start() {
    if (!API_KEY) {
      this.send({
        type: 'error',
        code: 'no_api_key',
        message:
          'No SmartSpectra API key is configured on this server. Add SMARTSPECTRA_API_KEY to the .env file next to server.mjs and restart — or use demo mode, which needs no key.',
        retryable: false,
      });
      return false;
    }
    if (!sdkModule) {
      this.send({
        type: 'error',
        code: 'sdk_unavailable',
        message: `The SmartSpectra SDK could not be loaded on this machine: ${sdkLoadError?.message ?? 'unknown error'}`,
        retryable: false,
      });
      return false;
    }
    const runnerPath = join(PROJECT_DIR, 'video-runner.mjs');
    let child;
    try {
      child = spawn(process.execPath, [runnerPath, this.videoPath], { cwd: PROJECT_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.send({ type: 'error', code: 'video_spawn_failed', message: `Could not start the check-in reader: ${err?.message ?? err}`, retryable: false });
      return false;
    }
    this.child = child;
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) this.handleLine(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(`[pip-video] ${chunk}`);
    });
    child.on('error', (err) => {
      if (this.stopping || this.ended) return;
      this.finishWithError('video_spawn_failed', `The check-in reader failed to run: ${err?.message ?? err}`);
    });
    child.on('exit', () => {
      if (this.stopping || this.ended) return;
      if (this.gotMetrics) this.finishOk();
      else this.finishWithError('video_no_readings', 'The recorded check-in ended before any readings arrived. The SDK could not measure this file.');
    });
    // Watchdog: the bundled check-in is ~1 minute and the proven
    // standalone read finished within ~5 minutes. Never let a stuck
    // reader process linger.
    this.watchdog = setTimeout(() => {
      if (this.stopping || this.ended) return;
      if (this.gotMetrics) this.finishOk();
      else this.finishWithError('video_timeout', 'The recorded check-in read took too long and was stopped.');
    }, 7 * 60 * 1000);
    console.log(`[pip] video session started — reader process for ${this.videoPath.split(/[\\/]/).pop()}`);
    this.send({ type: 'status', state: 'measuring', activeSignals: ['expression', 'pulse', 'breathing'], bundle: 'recorded check-in' });
    return true;
  }

  handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.kind === 'metrics' && msg.frame) {
      if (!this.gotMetrics) console.log('[pip] first metrics event received from the check-in reader');
      this.gotMetrics = true;
      this.metricsEvents += 1;
      if (this.metricsEvents <= 3 || this.metricsEvents % 30 === 0) {
        console.log(
          `[pip] video metrics #${this.metricsEvents}: pulse=${msg.frame?.pulse?.value ?? '-'} ` +
            `breathing=${msg.frame?.breathing?.value ?? '-'} expression=${msg.frame?.expression?.dominant ?? '-'}`,
        );
      }
      this.send({ type: 'metrics', source: 'video', activeSignals: ['expression', 'pulse', 'breathing'], data: msg.frame });
    } else if (msg.kind === 'hint' && msg.hint) {
      console.log(`[pip] SDK validation (video): code=${msg.code} hint="${msg.hint}"`);
      this.send({ type: 'validation', hint: String(msg.hint) });
    } else if (msg.kind === 'note') {
      console.log(`[pip] SDK note (video): code=${msg.code} "${msg.message}"`);
    } else if (msg.kind === 'error') {
      const text = String(msg.message ?? '');
      if (/input is unavailable|failed to open|cannot start/i.test(text)) {
        this.finishWithError(
          'video_unopenable',
          `The recorded check-in file could not be opened by the SmartSpectra SDK (${text}). An MJPEG AVI works best — see the README's recorded check-in section.`,
        );
      } else {
        this.finishWithError(String(msg.code ?? 'sdk_error'), text);
      }
    } else if (msg.kind === 'done') {
      if (this.gotMetrics) this.finishOk();
      else this.finishWithError('video_no_readings', 'The recorded check-in produced no readings.');
    }
  }

  finishOk() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.watchdog);
    console.log('[pip] recorded check-in finished — telling the page');
    this.send({ type: 'status', state: 'video-ended', activeSignals: ['expression', 'pulse', 'breathing'] });
    void this.stopChild().then(() => this.onEnded?.());
  }

  finishWithError(code, message) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.watchdog);
    this.send({ type: 'error', code, message, retryable: false });
    void this.stopChild().then(() => this.onEnded?.());
  }

  async stopChild() {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      try {
        child.kill();
      } catch { /* already gone */ }
      await new Promise((r) => {
        const t = setTimeout(r, 2000);
        child.once('exit', () => {
          clearTimeout(t);
          r();
        });
      });
    }
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.watchdog);
    await this.stopChild();
  }
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket plumbing
// ---------------------------------------------------------------------------

const httpServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, liveAvailable: !!API_KEY && !!sdkModule, telemetry: TELEMETRY }));
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const filePath = normalize(join(PUBLIC_DIR, rel));
    if (!filePath.startsWith(PUBLIC_DIR)) throw new Error('bad path');
    const body = await readFile(filePath);
    const type = MIME[extname(filePath)] ?? 'application/octet-stream';
    // Basic Range support: Chrome's media stack asks for byte ranges when
    // playing the check-in display clip and can refuse a plain 200.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && body.length > 0) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      if (start <= end) {
        res.writeHead(206, {
          'content-type': type,
          'content-range': `bytes ${start}-${end}/${body.length}`,
          'accept-ranges': 'bytes',
          'content-length': end - start + 1,
          'cache-control': 'no-store',
        });
        res.end(body.subarray(start, end + 1));
        return;
      }
    }
    res.writeHead(200, {
      'content-type': type,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store', // the phone must never run a stale app.js after an update
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

const wss = new WebSocketServer({ server: httpServer, path: '/signals' });

wss.on('connection', (ws) => {
  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };
  let live = null;
  let sim = null;
  let video = null;

  send({
    type: 'hello',
    liveAvailable: !!API_KEY && !!sdkModule,
    telemetry: TELEMETRY,
    videoAvailable: !!CHECKIN_VIDEO_PATH,
    videoDisplayAvailable: CHECKIN_DISPLAY_AVAILABLE,
  });

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      live?.handleFrame(Buffer.isBuffer(data) ? data : Buffer.from(data));
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'start' && msg.mode === 'live') {
      if (live || sim || video) return;
      live = new LiveSession(send);
      const ok = await live.start();
      if (!ok) live = null;
    } else if (msg.type === 'start-video') {
      if (live || sim || video) return;
      if (!CHECKIN_VIDEO_PATH) {
        send({
          type: 'error',
          code: 'no_video_file',
          message:
            'No recorded check-in file is available on this server. Put an MJPEG AVI at checkin-video.avi next to server.mjs (or set PIP_VIDEO_FILE) and restart the server.',
          retryable: false,
        });
        return;
      }
      video = new VideoSession(send, CHECKIN_VIDEO_PATH, () => { video = null; });
      const ok = await video.start();
      if (!ok) video = null;
    } else if (msg.type === 'start' && msg.mode === 'demo') {
      if (live || sim || video) return;
      sim = new SignalSimulator((frame) => send({ type: 'metrics', source: 'demo', activeSignals: ['expression', 'pulse', 'breathing'], data: frame }));
      sim.start();
      send({ type: 'status', state: 'measuring', activeSignals: ['expression', 'pulse', 'breathing'], bundle: 'simulated signals' });
    } else if (msg.type === 'scenario' && sim) {
      sim.setScenario(String(msg.name || 'rest'));
    } else if (msg.type === 'stop') {
      await live?.stop();
      live = null;
      await video?.stop();
      video = null;
      sim?.stop();
      sim = null;
      send({ type: 'status', state: 'stopped' });
    }
  });

  ws.on('close', async () => {
    await live?.stop();
    await video?.stop();
    sim?.stop();
    live = null;
    video = null;
    sim = null;
  });
});

httpServer.listen(PORT, () => {
  console.log(`[pip] Pip is awake at http://localhost:${PORT}`);
  console.log(`[pip] live mode: ${API_KEY ? (sdkModule ? 'ready (API key found)' : 'SDK failed to load') : 'no API key configured — demo mode only'}`);
  console.log(`[pip] SmartSpectra telemetry: ${TELEMETRY ? 'ENABLED (opted in via .env)' : 'disabled'}`);
  console.log(
    `[pip] recorded check-in: ${CHECKIN_VIDEO_PATH ? `available (${CHECKIN_VIDEO_PATH.split(/[\\/]/).pop()})` : 'no file found (set PIP_VIDEO_FILE or add checkin-video.avi)'}`,
  );
});
