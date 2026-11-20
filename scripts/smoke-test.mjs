// smoke-test.mjs — headless end-to-end checks for Pip's server.
//
// Boots the real server on a scratch port WITHOUT an API key and verifies:
//   1. the UI page is served,
//   2. live mode refuses cleanly with a no_api_key error (no crash),
//   3. demo mode streams normalized frames carrying pulse, breathing and
//      expression data,
//   4. the demo "smile" scenario steers the simulated expression to HAPPY,
//   5. stop returns the session to a clean stopped state.
// Run with: npm run smoke

import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 3217;
const BASE = `http://localhost:${PORT}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Force the no-key path even if a real .env exists beside server.mjs:
// loadEnvFile never overwrites a variable that is already present, and
// server.mjs treats an empty key as "no key configured".
const env = { ...process.env, PORT: String(PORT), SMARTSPECTRA_API_KEY: '' };

const server = spawn('node', ['server.mjs'], { cwd: new URL('..', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

async function waitForBoot() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('server did not come up');
}

try {
  const health = await waitForBoot();
  check('server boots and answers /healthz', health.ok === true);
  check('healthz reports live mode unavailable without a key', health.liveAvailable === false);

  const page = await (await fetch(`${BASE}/`)).text();
  check('UI page is served', page.includes('Pip') && page.includes('consent-gate'));

  const ws = new WebSocket(`ws://localhost:${PORT}/signals`);
  const messages = [];
  let hello = null;
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      messages.push(msg);
      if (msg.type === 'hello') hello = msg;
    } catch { /* binary is not expected server→client */ }
  });
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  await sleep(150);
  check('websocket hello received', !!hello && hello.liveAvailable === false);

  // 1) Live mode without a key must fail cleanly.
  ws.send(JSON.stringify({ type: 'start', mode: 'live' }));
  await sleep(600);
  const noKey = messages.find((m) => m.type === 'error' && m.code === 'no_api_key');
  check('live start without a key returns a no_api_key error', !!noKey);

  // 2) Demo mode streams complete normalized frames.
  ws.send(JSON.stringify({ type: 'start', mode: 'demo' }));
  await sleep(2600);
  const frames = messages.filter((m) => m.type === 'metrics' && m.source === 'demo');
  check('demo mode streams metrics frames', frames.length >= 10, `${frames.length} frames in ~2.6 s`);
  const f = frames.at(-1)?.data ?? {};
  check(
    'frames carry pulse + breathing + expression',
    typeof f.pulse?.value === 'number' && typeof f.breathing?.value === 'number' && typeof f.expression?.dominant === 'string',
    `pulse=${f.pulse?.value} breathing=${f.breathing?.value} expression=${f.expression?.dominant}`,
  );
  check('frames carry a breathing trace for the belly animation', typeof f.breathing?.trace === 'number');

  // 3) Scenario steering works.
  ws.send(JSON.stringify({ type: 'scenario', name: 'smile' }));
  await sleep(900);
  const happy = messages.filter((m) => m.type === 'metrics').at(-1)?.data?.expression?.dominant;
  check('smile scenario steers expression to HAPPY', happy === 'HAPPY', `got ${happy}`);

  // 4) Stop is clean.
  ws.send(JSON.stringify({ type: 'stop' }));
  await sleep(300);
  const stopped = messages.some((m) => m.type === 'status' && m.state === 'stopped');
  check('stop returns a stopped status', stopped);
  ws.close();
} catch (err) {
  check('test run completed without exceptions', false, err.message);
} finally {
  server.kill('SIGINT');
  await sleep(300);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log('\n--- server log ---\n' + serverLog);
  process.exit(1);
}
