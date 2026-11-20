// video-runner.mjs — child-process worker for Pip's recorded check-in mode.
//
// server.mjs spawns this script when the page asks to play a recorded
// check-in. It runs the SmartSpectra SDK's file mode (sdk.useFile) in its
// OWN process, using the exact call sequence that is proven to work with
// this SDK: construct -> register handlers -> useFile -> start() -> a
// short settle window -> waitUntilComplete() (a blocking native call
// during which metric callbacks fire) -> destroy().
//
// Why a child process: waitUntilComplete() blocks the calling thread for
// the whole read. Inside the server process that froze the event loop
// before the graph could start, and no metrics ever flowed. Isolated
// here, the sequence behaves exactly like the standalone video tester.
//
// Protocol: stdout carries ONLY JSON lines, one per event:
//   {"kind":"metrics","frame":{...}}   normalized frame (lib/normalize)
//   {"kind":"hint","code":n,"hint":"..."}
//   {"kind":"error","code":...,"message":"..."}
//   {"kind":"done","metricsEvents":n}
// All diagnostics go to stderr. Usage: node video-runner.mjs <video-file>

import { writeSync } from 'node:fs';
import { normalizeMetrics } from './lib/normalize.mjs';

try {
  process.loadEnvFile(new URL('./.env', import.meta.url));
} catch { /* no .env — handled below */ }

const SS_KEY = process.env.SMARTSPECTRA_API_KEY;
const TELEMETRY = process.env.SMARTSPECTRA_TELEMETRY === 'true';
const videoPath = process.argv[2];

const emit = (obj) => {
  try { writeSync(1, `${JSON.stringify(obj)}\n`); } catch { /* parent gone */ }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!SS_KEY) {
  emit({ kind: 'error', code: 'no_api_key', message: 'No SmartSpectra API key configured (.env missing next to the server).' });
  process.exit(1);
}
if (!videoPath) {
  emit({ kind: 'error', code: 'no_video_file', message: 'video-runner started without a video file argument.' });
  process.exit(1);
}

let sdkModule;
try {
  sdkModule = await import('@smartspectra/node-sdk');
} catch (err) {
  emit({ kind: 'error', code: 'sdk_unavailable', message: `SmartSpectra SDK failed to load: ${err?.message ?? err}` });
  process.exit(1);
}
const { SmartSpectraSDK, decodeMetrics } = sdkModule;
const ALL_METRICS = [...sdkModule.breathingMetrics, ...sdkModule.cardioMetrics, ...sdkModule.faceMetrics];

let metricsEvents = 0;
let inputFailed = false;
let lastHint = '';

const sdk = new SmartSpectraSDK({
  apiKey: SS_KEY,
  requestedMetrics: ALL_METRICS,
  enableTelemetry: TELEMETRY,
});

sdk.on('metrics', (buf) => {
  metricsEvents += 1;
  let decoded = null;
  try { decoded = decodeMetrics(buf); } catch { /* keep null */ }
  const frame = normalizeMetrics(decoded);
  if (frame) emit({ kind: 'metrics', frame });
});

sdk.on('validationStatus', (code, _ts, hint) => {
  if (hint && hint !== lastHint) {
    lastHint = hint;
    emit({ kind: 'hint', code, hint: String(hint) });
  }
});

sdk.on('error', (code, message) => {
  const text = String(message ?? '');
  // Input failures are fatal (the file cannot be read at all) — mirror
  // the standalone tester: report and let the probe window end the run.
  if (/input is unavailable|failed to open|cannot start/i.test(text)) {
    inputFailed = true;
    emit({ kind: 'error', code: String(code ?? 'sdk_error'), message: text });
    return;
  }
  // The end-of-file "not in a valid state" housekeeping error after a
  // complete read is not a failure — waitUntilComplete reports the end.
  if (metricsEvents > 0 && /not in a valid state/i.test(text)) return;
  // Everything else is non-fatal until proven otherwise (the tester
  // logged errors and kept measuring): pass it up as a note.
  emit({ kind: 'note', code: String(code ?? 'sdk_error'), message: text });
});

console.error(`[pip-video] opening: ${videoPath}`);
try {
  sdk.useFile(videoPath);
  sdk.start();
} catch (err) {
  emit({ kind: 'error', code: 'start_failed', message: String(err?.message ?? err) });
  process.exit(1);
}

// The cannot-open failure fires within ~1 s; give it 4 s to surface
// (same probe window as the proven standalone tester).
await sleep(4000);
if (inputFailed) {
  try { await sdk.destroy(); } catch { /* ignore */ }
  process.exit(2);
}

// Blocking native read: metrics callbacks fire while this waits.
sdk.waitUntilComplete(240000);
await sleep(1500); // let queued events flush
try { await sdk.destroy(); } catch { /* ignore */ }

emit({ kind: 'done', metricsEvents });
process.exit(0);
