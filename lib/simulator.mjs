// simulator.mjs — a clearly-labelled simulated signal source that produces
// exactly the same normalized frames as the live SmartSpectra path
// (see lib/normalize.mjs). It exists so anyone can explore Pip's full
// behaviour without a camera or an API key, and so the app can be tested
// headless. It never pretends to be real data: every frame it produces is
// wrapped by the server with source: "demo" and the UI shows a persistent
// DEMO MODE banner while it runs.

const TICK_MS = 100; // 10 Hz

function ease(current, target, rate, dt) {
  const step = rate * dt;
  if (current < target) return Math.min(target, current + step);
  return Math.max(target, current - step);
}

export class SignalSimulator {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.timer = null;
    this.startedAt = 0;
    this.lastTick = 0;

    // Current (smoothed) values.
    this.pulse = 66;
    this.breathingRate = 13;
    this.expression = 'NEUTRAL';
    this.expressionConfidence = 78;

    // Targets set by the active scenario.
    this.pulseTarget = 68;
    this.breathingTarget = 13;

    this.scenario = 'rest';
    this.scenarioUntil = 0; // ms epoch; 0 = holds indefinitely
    this.breathPhase = 0; // radians
    this.nextBlinkAt = 0;
    this.blinkUntil = 0;
    this.nextSmileBlipAt = 0;
  }

  start() {
    this.startedAt = Date.now();
    this.lastTick = this.startedAt;
    this.nextBlinkAt = this.startedAt + 2500;
    this.nextSmileBlipAt = this.startedAt + 9000;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setScenario(name) {
    const now = Date.now();
    this.scenario = name;
    switch (name) {
      case 'smile':
        this.expression = 'HAPPY';
        this.expressionConfidence = 86;
        this.scenarioUntil = now + 6000;
        break;
      case 'surprise':
        this.expression = 'SURPRISE';
        this.expressionConfidence = 82;
        this.scenarioUntil = now + 3000;
        break;
      case 'sad':
        this.expression = 'SAD';
        this.expressionConfidence = 72;
        this.scenarioUntil = now + 6000;
        break;
      case 'breathe-slow':
        this.breathingTarget = 7.5;
        this.pulseTarget = 61;
        this.scenarioUntil = 0;
        break;
      case 'breathe-fast':
        this.breathingTarget = 19;
        this.pulseTarget = 88;
        this.scenarioUntil = 0;
        break;
      case 'rest':
      default:
        this.breathingTarget = 13;
        this.pulseTarget = 68;
        this.expression = 'NEUTRAL';
        this.expressionConfidence = 78;
        this.scenarioUntil = 0;
        break;
    }
  }

  tick() {
    const now = Date.now();
    const dt = Math.min(0.5, (now - this.lastTick) / 1000);
    this.lastTick = now;
    const elapsed = (now - this.startedAt) / 1000;

    // Timed expression scenarios fall back to "rest" behaviour when over.
    if (this.scenarioUntil && now > this.scenarioUntil) {
      this.scenarioUntil = 0;
      this.expression = 'NEUTRAL';
      this.expressionConfidence = 78;
      if (this.scenario === 'smile' || this.scenario === 'surprise' || this.scenario === 'sad') {
        this.scenario = 'rest';
      }
    }

    // In rest, throw in an occasional spontaneous smile so Pip feels alive.
    if (this.scenario === 'rest' && now >= this.nextSmileBlipAt) {
      this.expression = 'HAPPY';
      this.expressionConfidence = 74;
      this.scenarioUntil = now + 2600;
      this.nextSmileBlipAt = now + 16000 + Math.random() * 12000;
    }

    // Ease vitals toward targets, with a little organic wander.
    const wander = Math.sin(elapsed / 7) * 1.2 + Math.sin(elapsed / 3.1) * 0.6;
    this.pulse = ease(this.pulse, this.pulseTarget + wander, 6, dt);
    this.breathingRate = ease(this.breathingRate, this.breathingTarget, 0.55, dt);

    // Breathing trace: a smooth sinusoid at the current rate.
    this.breathPhase += 2 * Math.PI * (this.breathingRate / 60) * dt;
    const trace = Math.sin(this.breathPhase);

    // Blinking: a short detected pulse every few seconds.
    if (now >= this.nextBlinkAt) {
      this.blinkUntil = now + 160;
      this.nextBlinkAt = now + 2800 + Math.random() * 2400;
    }
    const blinking = now < this.blinkUntil;

    // Confidence ramps in like the real SDK's warm-up (compressed for demo).
    const pulseConf = Math.min(92, 30 + elapsed * 9);
    const breathConf = Math.min(88, 12 + elapsed * 7);

    // HRV appears after a short window in demo (the real SDK needs ~60 s).
    const hrv =
      elapsed > 12
        ? {
            rmssd: this.breathingTarget < 10 ? 58 : this.breathingTarget > 16 ? 27 : 44,
            meanNn: Math.round(60000 / this.pulse),
            sdnn: this.breathingTarget < 10 ? 64 : 48,
            confidence: 72,
            stable: true,
          }
        : null;

    const scores = { NEUTRAL: 12, HAPPY: 4, SAD: 3, SURPRISE: 2, ANGRY: 1, FEAR: 1, DISGUST: 1, CONTEMPT: 1 };
    scores[this.expression] = this.expressionConfidence;
    scores.NEUTRAL = this.expression === 'NEUTRAL' ? this.expressionConfidence : 12;

    this.onFrame({
      pulse: { value: Math.round(this.pulse * 10) / 10, confidence: Math.round(pulseConf), stable: pulseConf > 45 },
      breathing: {
        value: Math.round(this.breathingRate * 10) / 10,
        rate: Math.round(this.breathingRate * 10) / 10,
        confidence: Math.round(breathConf),
        stable: breathConf > 45,
        trace: Math.round(trace * 1000) / 1000,
      },
      expression: { dominant: this.expression, confidence: this.expressionConfidence, scores, stable: true },
      blinking,
      talking: false,
      hrv,
    });
  }
}
