// server.mjs — Pip's local server.
//
// Serves the browser UI, receives webcam frames from the page over a
// WebSocket, feeds them to the Presage SmartSpectra SDK (custom-input mode),
// and streams normalized signals back to the page. Also hosts the clearly
// labelled demo mode (simulated signals) that needs no camera and no key.
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
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
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

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

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
// Live session: one SmartSpectra measurement session fed by browser frames.
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

class LiveSession {
  constructor(send) {
    this.send = send;
    this.sdk = null;
    this.bundleIndex = 0;
    this.gotMetrics = false;
    this.stopping = false;
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
    const { SmartSpectraSDK, FrameTransform, decodeMetrics } = sdkModule;

    const sdk = new SmartSpectraSDK({
      apiKey: API_KEY,
      requestedMetrics: bundle.metrics,
      enableTelemetry: TELEMETRY,
    });
    this.sdk = sdk;
    this.gotMetrics = false;

    sdk.on('metrics', (buf) => {
      this.gotMetrics = true;
      let decoded = null;
      try {
        decoded = decodeMetrics(buf);
      } catch {
        decoded = null;
      }
      const frame = normalizeMetrics(decoded);
      if (frame) {
        this.send({ type: 'metrics', source: 'live', activeSignals: bundle.signals, data: frame });
      }
    });

    sdk.on('validationStatus', (code, _ts, hint) => {
      if (hint) this.send({ type: 'validation', hint: String(hint) });
    });

    sdk.on('error', (code, message, retryable) => {
      void this.handleError(code, message, retryable);
    });

    try {
      sdk.useCustomInput(FrameTransform.kNone);
      sdk.start();
    } catch (err) {
      await this.handleError(err?.code, err?.message ?? String(err), false);
      return false;
    }

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

  handleFrame(buf) {
    if (!this.sdk || this.stopping) return;
    if (buf.length < 8) return;
    const width = buf.readUInt32LE(0);
    const height = buf.readUInt32LE(4);
    if (width < 16 || width > 1920 || height < 16 || height > 1080) return;
    const pixels = buf.subarray(8);
    if (pixels.length < width * height * 4) return;
    const tsUs = Number(process.hrtime.bigint() / 1000n); // monotonic µs (per SDK docs)
    try {
      this.sdk.sendFrame(pixels, width, height, width * 4, sdkModule.PixelFormat.kRGBA, tsUs);
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
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
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

  send({ type: 'hello', liveAvailable: !!API_KEY && !!sdkModule, telemetry: TELEMETRY });

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
      if (live || sim) return;
      live = new LiveSession(send);
      const ok = await live.start();
      if (!ok) live = null;
    } else if (msg.type === 'start' && msg.mode === 'demo') {
      if (live || sim) return;
      sim = new SignalSimulator((frame) => send({ type: 'metrics', source: 'demo', activeSignals: ['expression', 'pulse', 'breathing'], data: frame }));
      sim.start();
      send({ type: 'status', state: 'measuring', activeSignals: ['expression', 'pulse', 'breathing'], bundle: 'simulated signals' });
    } else if (msg.type === 'scenario' && sim) {
      sim.setScenario(String(msg.name || 'rest'));
    } else if (msg.type === 'stop') {
      await live?.stop();
      live = null;
      sim?.stop();
      sim = null;
      send({ type: 'status', state: 'stopped' });
    }
  });

  ws.on('close', async () => {
    await live?.stop();
    sim?.stop();
    live = null;
    sim = null;
  });
});

httpServer.listen(PORT, () => {
  console.log(`[pip] Pip is awake at http://localhost:${PORT}`);
  console.log(`[pip] live mode: ${API_KEY ? (sdkModule ? 'ready (API key found)' : 'SDK failed to load') : 'no API key configured — demo mode only'}`);
  console.log(`[pip] SmartSpectra telemetry: ${TELEMETRY ? 'ENABLED (opted in via .env)' : 'disabled'}`);
});
