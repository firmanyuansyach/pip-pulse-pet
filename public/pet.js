// pet.js — Pip, a tiny companion who lives on your signals.
//
// Pip's behaviour is driven entirely by the normalized signal frames the
// server sends (live SmartSpectra data, or the labelled demo simulator):
//   - expressions: Pip mirrors your dominant expression (debounced so it
//     doesn't flicker), smiles back, startles at surprise, comforts sadness.
//   - pulse: Pip's heart — and its whole body — beat at your measured BPM.
//   - breathing: Pip's belly rises and falls with your breathing trace.
//   - blinking: when you blink, Pip blinks.
//   - "Calm Together": as your breathing rate stays slow, Pip's eyelids
//     droop stage by stage until it falls asleep. Speed up and it wakes.
//
// No medical meaning is attached to any of this; it is a mirror and a toy.

const MOUTHS = {
  HAPPY: 'M -20 4 Q 0 24 20 4',
  NEUTRAL: 'M -11 8 Q 0 13 11 8',
  SURPRISE: null, // uses the "o" ellipse instead
  SAD: 'M -13 16 Q 0 5 13 16',
  ANGRY: 'M -13 11 Q -6 8 0 11 Q 6 14 13 11',
  FEAR: 'M -9 12 Q -4 9 0 12 Q 4 15 9 12',
  DISGUST: 'M -12 12 Q 2 15 13 7',
  CONTEMPT: 'M -12 11 Q 2 13 13 6',
  UNSPECIFIED: 'M -11 8 Q 0 13 11 8',
};

const CALM_TARGET_BPM = 11; // breaths/min at or below which Pip gets sleepier
const CALM_WAKE_BPM = 14; // at or above which Pip perks back up
const CALM_FULL_MS = 45000; // sustained calm breathing to fall fully asleep

export class Pip {
  constructor(svg) {
    this.el = {
      body: svg.querySelector('#pip-body-group'),
      belly: svg.querySelector('#pip-belly'),
      heart: svg.querySelector('#pip-heart'),
      eyeL: svg.querySelector('#eye-l'),
      eyeR: svg.querySelector('#eye-r'),
      lidL: svg.querySelector('#lid-l'),
      lidR: svg.querySelector('#lid-r'),
      browL: svg.querySelector('#brow-l'),
      browR: svg.querySelector('#brow-r'),
      mouth: svg.querySelector('#pip-mouth'),
      mouthO: svg.querySelector('#pip-mouth-o'),
      cheekL: svg.querySelector('#cheek-l'),
      cheekR: svg.querySelector('#cheek-r'),
      zzz: svg.querySelector('#pip-zzz'),
      sprout: svg.querySelector('#pip-sprout'),
      glow: svg.querySelector('#pip-glow'),
    };
    this.expression = 'NEUTRAL';
    this.candidate = 'NEUTRAL';
    this.candidateSince = 0;
    this.blinkUntil = 0;
    this.nextAutoBlink = 0;
    this.wasBlinking = false;
    this.beatPhase = 0;
    this.beatEnvelope = 0;
    this.bpm = null;
    this.bpmSeenAt = 0;
    this.traceSmooth = 0;
    this.traceMin = -0.2;
    this.traceMax = 0.2;
    this.calmMode = false;
    this.calmProgress = 0;
    this.asleep = false;
    this.surpriseStartleAt = 0;
  }

  setCalmMode(on) {
    this.calmMode = on;
    if (!on) {
      this.calmProgress = 0;
      this.asleep = false;
    }
  }

  /** Feed the latest signal frame (may be called at network cadence). */
  ingest(frame, now) {
    if (!frame) return;
    const expr = frame.expression;
    if (expr && expr.dominant && expr.confidence >= 40) {
      if (expr.dominant !== this.candidate) {
        this.candidate = expr.dominant;
        this.candidateSince = now;
      }
    }
    if (frame.pulse && frame.pulse.value >= 40 && frame.pulse.value <= 110 && (frame.pulse.confidence ?? 0) >= 25) {
      this.bpm = frame.pulse.value;
      this.bpmSeenAt = now;
    }
    if (frame.blinking && !this.wasBlinking) {
      this.blinkUntil = now + 150; // mirror your blink
    }
    this.wasBlinking = !!frame.blinking;
    this.latest = frame;
  }

  /** Advance animations; call from requestAnimationFrame. */
  tick(now, dtMs) {
    const dt = Math.min(100, dtMs);
    const frame = this.latest;

    // --- expression debounce (500 ms persistence) ---
    if (this.candidate !== this.expression && now - this.candidateSince > 500) {
      this.expression = this.candidate;
    }

    // --- Calm Together progress ---
    const br = frame?.breathing;
    if (this.calmMode && br && br.stable && typeof br.value === 'number') {
      if (br.value <= CALM_TARGET_BPM) this.calmProgress += dt / CALM_FULL_MS;
      else if (br.value >= CALM_WAKE_BPM) this.calmProgress -= dt / (CALM_FULL_MS * 0.5);
      this.calmProgress = Math.max(0, Math.min(1, this.calmProgress));
    }
    // A strong surprise startles a sleeping Pip awake.
    if (this.asleep && this.expression === 'SURPRISE' && (frame?.expression?.confidence ?? 0) >= 75) {
      this.calmProgress = Math.max(0, this.calmProgress - 0.45);
      this.surpriseStartleAt = now;
    }
    this.asleep = this.calmMode && this.calmProgress >= 1;

    // --- heartbeat ---
    const bpmFresh = this.bpm && now - this.bpmSeenAt < 6000;
    if (bpmFresh) {
      this.beatPhase += (dt / 1000) * (this.bpm / 60);
      if (this.beatPhase >= 1) {
        this.beatPhase -= 1;
        this.beatEnvelope = 1;
      }
    }
    this.beatEnvelope = Math.max(0, this.beatEnvelope - dt / 260);
    const thump = this.beatEnvelope * this.beatEnvelope;

    // --- breathing belly (trace with simple auto-gain; rate-based fallback) ---
    let trace = frame?.breathing?.trace;
    if (typeof trace !== 'number') {
      const rate = br?.value ?? 12;
      trace = Math.sin((now / 1000) * 2 * Math.PI * (rate / 60)) * 0.8;
    } else {
      this.traceMin = Math.min(this.traceMin * 0.999 + trace * 0.001, trace);
      this.traceMax = Math.max(this.traceMax * 0.999 + trace * 0.001, trace);
      const span = Math.max(0.05, this.traceMax - this.traceMin);
      trace = ((trace - this.traceMin) / span) * 2 - 1;
    }
    this.traceSmooth += (trace - this.traceSmooth) * Math.min(1, dt / 90);

    // --- autonomous blink ---
    if (now >= this.nextAutoBlink) {
      this.blinkUntil = Math.max(this.blinkUntil, now + 140);
      this.nextAutoBlink = now + 2600 + Math.random() * 3200;
    }
    const blinkingNow = now < this.blinkUntil;

    this.render({ now, thump, blinkingNow });
  }

  render({ now, thump, blinkingNow }) {
    const e = this.el;
    const expr = this.asleep ? 'NEUTRAL' : this.expression;
    const droop = this.asleep ? 1 : this.calmMode ? this.calmProgress * 0.75 : 0;

    // Body: heartbeat thump + gentle breathing swell.
    const bodyScale = 1 + thump * 0.022 + this.traceSmooth * 0.008;
    e.body.setAttribute('transform', `translate(160 168) scale(${bodyScale.toFixed(4)}) translate(-160 -168)`);
    e.belly.setAttribute('transform', `translate(160 196) scale(1 ${(1 + this.traceSmooth * 0.10).toFixed(4)}) translate(-160 -196)`);
    e.glow.setAttribute('opacity', (0.25 + thump * 0.5).toFixed(3));

    // Heart: beats at your BPM; softens while Pip sleeps.
    const heartScale = (1 + thump * 0.38) * (this.asleep ? 0.85 : 1);
    e.heart.setAttribute('transform', `translate(160 158) scale(${heartScale.toFixed(4)}) translate(-160 -158)`);
    e.heart.setAttribute('opacity', this.bpm ? '1' : '0.25');

    // Eyes: expression shape + eyelid droop + blink.
    const eyeScaleY = blinkingNow || this.asleep ? 0.08 : expr === 'SURPRISE' ? 1.22 : 1;
    const eyeScaleX = expr === 'HAPPY' && !this.asleep ? 1.05 : 1;
    for (const eye of [e.eyeL, e.eyeR]) {
      const cx = eye.dataset.cx;
      eye.setAttribute('transform', `translate(${cx} 128) scale(${eyeScaleX} ${eyeScaleY.toFixed(3)}) translate(-${cx} -128)`);
    }
    const lidH = this.asleep || blinkingNow ? 15 : droop * 11 + (expr === 'SAD' ? 4.5 : expr === 'HAPPY' ? 2.5 : 0);
    e.lidL.setAttribute('height', lidH.toFixed(1));
    e.lidR.setAttribute('height', lidH.toFixed(1));

    // Brows: surprise raises, anger tilts in, sadness tilts up-in.
    const browY = expr === 'SURPRISE' ? -7 : expr === 'FEAR' ? -5 : 0;
    const browRot = expr === 'ANGRY' ? 18 : expr === 'SAD' ? -14 : 0;
    e.browL.setAttribute('transform', `translate(128 ${104 + browY}) rotate(${browRot})`);
    e.browR.setAttribute('transform', `translate(192 ${104 + browY}) rotate(${-browRot})`);

    // Mouth.
    if (this.asleep) {
      e.mouth.setAttribute('d', 'M -5 11 Q 0 14 5 11');
      e.mouthO.setAttribute('opacity', '0');
    } else if (expr === 'SURPRISE') {
      e.mouth.setAttribute('d', 'M -11 8 Q 0 13 11 8');
      e.mouthO.setAttribute('opacity', '1');
    } else {
      e.mouth.setAttribute('d', MOUTHS[expr] ?? MOUTHS.NEUTRAL);
      e.mouthO.setAttribute('opacity', '0');
    }
    e.mouth.setAttribute('transform', 'translate(160 148)');

    // Cheeks bloom when you're happy.
    const cheek = expr === 'HAPPY' && !this.asleep ? 0.75 : 0.18;
    e.cheekL.setAttribute('opacity', cheek);
    e.cheekR.setAttribute('opacity', cheek);

    // Sleep dressing.
    e.zzz.setAttribute('opacity', this.asleep ? ((now / 900) % 1 > 0.25 ? '1' : '0.55') : '0');
    e.sprout.setAttribute('transform', `translate(160 44) rotate(${(this.traceSmooth * 4).toFixed(2)})`);
  }

  /** Snapshot for the status line ("Pip is sleepy — 62% to sleep"). */
  mood() {
    if (this.asleep) return { key: 'asleep', label: 'Pip is asleep. You did that — gently.' };
    if (this.calmMode && this.calmProgress > 0.55) return { key: 'sleepy', label: `Pip is very sleepy — ${Math.round(this.calmProgress * 100)}% of the way to sleep.` };
    if (this.calmMode && this.calmProgress > 0.15) return { key: 'drowsy', label: `Pip is getting drowsy — ${Math.round(this.calmProgress * 100)}% of the way to sleep. Keep breathing slowly.` };
    switch (this.expression) {
      case 'HAPPY': return { key: 'happy', label: 'You smiled — Pip smiled back.' };
      case 'SURPRISE': return { key: 'surprise', label: 'You surprised Pip!' };
      case 'SAD': return { key: 'sad', label: 'Pip noticed you seem sad, and leaned in. No advice, just company.' };
      case 'ANGRY': return { key: 'angry', label: 'Pip is giving you a moment.' };
      case 'FEAR': return { key: 'fear', label: 'Pip startled with you.' };
      default: return { key: 'calm', label: this.bpm ? 'Pip is living on your heartbeat.' : 'Pip is waiting to meet your signals…' };
    }
  }
}
