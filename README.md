# Pip — the pet that lives on your signals

**Smile, and Pip smiles back. Its heart beats at *your* pulse. Slow your breathing, and Pip falls asleep.**

Pip is a tiny digital companion powered by the [Presage SmartSpectra SDK](https://smartspectra.presagetech.com). It watches (with your explicit consent) through your webcam and *lives on* three live signals at once:

- **Your expressions** — Pip mirrors them. Smile and Pip beams back; look surprised and Pip startles; look sad and Pip leans in, quietly. When you blink, Pip blinks.
- **Your pulse** — Pip's heart, and its whole round body, beat at your measured BPM.
- **Your breathing** — Pip's belly rises and falls with your breathing trace.

And in **Calm Together** mode, Pip turns those signals into a tiny shared ritual: keep your breathing slow and steady, and Pip's eyelids droop stage by stage until it falls asleep in your heartbeat. Speed up, and it wakes. It's a mindful micro-break for people who live at a desk — a pet you calm by calming yourself.

Pip is a toy and a mirror. It is **not** a medical device, makes no diagnosis, and offers no treatment advice.

Built for the [DEV Presage SmartSpectra SDK Challenge](https://dev.to/challenges/presage-2026-11-04).

---

## Setup

You need:

- **Node.js 20+** (Node 24 LTS recommended) on Linux (glibc ≥ 2.35), macOS (Apple Silicon), or Windows (x64)
- A webcam
- A free **SmartSpectra API key** from the Presage developer portal: <https://physiology.presagetech.com> (register, then create a key — the free tier includes trial credits, so Pip only measures while you ask it to)

```bash
git clone <this-repo> pip-pulse-pet
cd pip-pulse-pet
npm install
cp .env.example .env   # then paste your key into .env as SMARTSPECTRA_API_KEY=...
npm start
```

Open **<http://localhost:3000>** in your browser (localhost counts as a secure context, so the camera permission works). Read the consent gate, agree, and meet Pip.

> **No key yet?** Choose **Demo mode** on the consent screen. It runs the complete experience on clearly labelled *simulated* signals — no camera, no key, no credits — with a "puppeteer" panel to steer the imaginary person Pip sees. It's the fastest way to see everything Pip does.

### Verify your install

```bash
npm run smoke
```

This boots the server headlessly and checks the page, the no-key error path, and the full demo-mode signal flow end to end (10 checks).

---

## How it works

```
Browser (public/)                     Node server (server.mjs)
┌─────────────────────────┐  frames   ┌────────────────────────────────┐
│ getUserMedia → canvas   │ ────────► │ SmartSpectraSDK (custom input) │
│ Pip (SVG) + readouts    │ ◄──────── │ decodeMetrics → normalize      │
└─────────────────────────┘  signals  └────────────────────────────────┘
        consent gate first — nothing captures before you agree
```

- The page captures webcam frames (640×480 RGBA) and streams them over a local WebSocket to the server.
- The server feeds them to `@smartspectra/node-sdk` via its documented custom-input path (`useCustomInput()` / `sendFrame()`), requesting three metric bundles: `breathingMetrics`, `cardioMetrics`, and `faceMetrics` (expressions, blinking, talking, landmarks).
- Each `metrics` event is decoded with `decodeMetrics`, reduced by `lib/normalize.mjs` to the few values Pip needs, and pushed back to the page, where `public/pet.js` turns them into behaviour.
- If a bundle is rejected at start (`kConfigurationFailed` — e.g. a key whose plan doesn't cover it), the server steps down a documented ladder — full bundle → pulse + breathing → breathing — and tells the UI exactly which signals are live.
- The SDK's own `validationStatus` hints (lighting, distance, movement) are surfaced in the UI verbatim, so you can fix your setup instead of wondering.

### Signal → behaviour map

| Live signal | What Pip does |
|---|---|
| Expression: happiness | Smiles back, cheeks bloom |
| Expression: surprise | Eyes widen, brows jump — and can startle a sleeping Pip awake |
| Expression: sadness | Droops, leans in, keeps you company (never gives advice) |
| Blinking | Blinks when you blink |
| Pulse rate | Heart + body thump at your BPM; glow breathes with each beat |
| Breathing trace | Belly rises and falls with your chest |
| Breathing rate (Calm Together) | Sustained ≤ ~11 breaths/min → eyelids droop → sleep; ≥ ~14 → wakes |
| HRV (RMSSD) | Shown in the readout after ~60 s of pulse, labelled informational |

Expression changes are debounced (~0.5 s of persistence) so Pip doesn't flicker, and numbers are only trusted in the UI when the SDK marks them stable.

---

## Privacy & data handling

Pip was designed so the honest answer to "what do you keep?" is **nothing**.

- **Consent first.** The camera cannot start until you read a plain-language notice and click *I agree*. Stopping (button, tab close) ends capture immediately.
- **No storage.** No video is recorded, no screenshots are taken, no measurements are written to disk, and there is no account or database. Session state lives in memory only.
- **Where processing happens.** Frames are processed by the SmartSpectra SDK's native runtime on your own machine. The SDK contacts Presage to authenticate your API key; Pip's server adds no uploads of its own.
- **SDK telemetry — off by default.** The SmartSpectra SDK has its own telemetry, which Presage documents as *on* by default: when enabled, the SDK sends aggregate measurement-session summaries (SDK version, platform, session outcome, frame-throughput counts, validation-warning counts, a timestamp) and full device-readiness diagnostic reports (device model, OS, requested metrics, camera info, and free-text diagnostics). Per Presage's [SDK Telemetry & Privacy](https://presagetech.com/docs/smartspectra-sdk/telemetry-and-privacy) page, telemetry never attaches raw video frames or measured physiological values; reports are authenticated, so they can be associated with the SDK account, and Presage currently configures no automatic expiration for them. **Pip sets `enableTelemetry: false`**, so none of this is sent. If you *want* it on (e.g. to help Presage diagnose a device issue), set `SMARTSPECTRA_TELEMETRY=true` in `.env` — the consent screen discloses the current setting before you agree to anything.
- **API key.** Lives only in your local `.env` (gitignored, see `.env.example`). It is sent only inside the SDK's own authenticated requests.
- **No AI services.** Pip calls no LLM or third-party AI. The only "intelligence" is the SDK's on-device models and a few hundred lines of pet logic.

SmartSpectra metrics are offered for general wellness and informational purposes only; they have not been cleared by the FDA and may not be used for medical diagnosis or treatment. Pip follows the same line: play and self-awareness, never health decisions.

---

## Troubleshooting

- **"kAuthenticationFailed" / HTTP 403 with a brand-new free key.** Known free-tier quirk: keys can be rejected before activation completes. Double-check the key in `.env` (no quotes, no spaces), wait a few minutes, and if it persists, the Presage Discord (linked from the developer portal) is the fastest fix — mention the 403 and your account email.
- **Session starts but no numbers appear.** You need your face *and* upper chest visible, still, and well lit (front light, not a window behind you). Watch for the yellow camera-hint banner — it's the SDK's own guidance. Breathing confidence needs up to ~30 s of stillness; HRV needs ~60 s of pulse.
- **"The native runtime package … is not installed."** Your platform isn't one of `darwin-arm64`, `linux-x64`, `linux-arm64`, `win32-x64`, or the install was partial — re-run `npm install`.
- **Camera busy / black preview.** Another app may hold the webcam; close it and reload. The preview is mirrored like a bathroom mirror; the SDK receives the unmirrored frames.

## Project structure

```
server.mjs            HTTP + WebSocket server, SmartSpectra session lifecycle
lib/normalize.mjs     decoded SDK payload → the small JSON shape the UI uses
lib/simulator.mjs     labelled simulated signals for demo mode
public/index.html     consent gate, Pip's stage, readouts
public/pet.js         Pip's behaviour state machine (expressions, heartbeat,
                      breathing belly, blink mirroring, Calm Together sleep)
public/app.js         transport, camera pump, UI wiring
scripts/smoke-test.mjs  headless end-to-end checks (npm run smoke)
```

## License

MIT — see [LICENSE](LICENSE). Pip's code is original; the SmartSpectra SDK is Presage's and is governed by its own terms.
