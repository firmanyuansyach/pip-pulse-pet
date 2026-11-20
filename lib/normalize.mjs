// normalize.mjs — convert a decoded SmartSpectra metrics payload into the
// small, stable JSON shape Pip's browser UI consumes.
//
// Field paths follow the official Node.js metrics guide
// (https://smartspectra.presagetech.com/docs/nodejs/metrics):
//   metrics.breathing.rate / .upperTrace / .lowerTrace
//   metrics.cardio.pulseRate / .arterialPressureTrace / .hrv
//   metrics.face.expression / .blinking / .talking / .landmarks
// Every sample is a MeasurementWithConfidence { value, stable, confidence, timestamp }
// (confidence is a percentage, 0-100), an Hrv { rmssd, meanNn, sdnn, baevsky,
// confidence, stable }, a DetectionStatus { detected, stable }, or an
// Expression { stable, scores: [{ type, confidence }] }.

const EXPRESSION_NAMES = {
  0: 'UNSPECIFIED',
  1: 'ANGRY',
  2: 'CONTEMPT',
  3: 'DISGUST',
  4: 'FEAR',
  5: 'HAPPY',
  6: 'NEUTRAL',
  7: 'SAD',
  8: 'SURPRISE',
};

function last(arr) {
  return Array.isArray(arr) && arr.length > 0 ? arr[arr.length - 1] : null;
}

function sample(m) {
  if (!m || typeof m.value !== 'number') return null;
  return {
    value: m.value,
    confidence: typeof m.confidence === 'number' ? m.confidence : null,
    stable: m.stable === true,
  };
}

function expressionName(type) {
  if (typeof type === 'string') return type.toUpperCase();
  if (typeof type === 'number') return EXPRESSION_NAMES[type] ?? 'UNSPECIFIED';
  return 'UNSPECIFIED';
}

/**
 * @param {object} metrics decoded payload from decodeMetrics()
 * @returns {object|null} normalized frame, or null if nothing usable arrived
 */
export function normalizeMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object' || Buffer.isBuffer(metrics)) return null;

  const breathing = metrics.breathing ?? {};
  const cardio = metrics.cardio ?? {};
  const face = metrics.face ?? {};

  const pulseSample = sample(last(cardio.pulseRate) ?? last(cardio.pulse?.rate));
  const breathRate = sample(last(breathing.rate));
  const upperTrace = last(breathing.upperTrace);
  const lowerTrace = last(breathing.lowerTrace);
  const hrvRaw = last(cardio.hrv);

  let expression = null;
  const exprRaw = last(face.expression);
  if (exprRaw && Array.isArray(exprRaw.scores) && exprRaw.scores.length > 0) {
    const scores = {};
    let dominant = null;
    let best = -1;
    for (const s of exprRaw.scores) {
      const name = expressionName(s?.type);
      const conf = typeof s?.confidence === 'number' ? s.confidence : 0;
      if (name === 'UNSPECIFIED') continue;
      scores[name] = conf;
      if (conf > best) {
        best = conf;
        dominant = name;
      }
    }
    if (dominant) {
      expression = { dominant, confidence: best, scores, stable: exprRaw.stable === true };
    }
  }

  const blinkRaw = last(face.blinking);
  const talkRaw = last(face.talking);

  return {
    pulse: pulseSample,
    breathing: breathRate
      ? {
          ...breathRate,
          trace:
            typeof upperTrace?.value === 'number'
              ? upperTrace.value
              : typeof lowerTrace?.value === 'number'
                ? lowerTrace.value
                : null,
        }
      : null,
    expression,
    blinking: blinkRaw ? blinkRaw.detected === true : null,
    talking: talkRaw ? talkRaw.detected === true : null,
    hrv: hrvRaw
      ? {
          rmssd: typeof hrvRaw.rmssd === 'number' ? hrvRaw.rmssd : null,
          meanNn: typeof hrvRaw.meanNn === 'number' ? hrvRaw.meanNn : null,
          sdnn: typeof hrvRaw.sdnn === 'number' ? hrvRaw.sdnn : null,
          confidence: typeof hrvRaw.confidence === 'number' ? hrvRaw.confidence : null,
          stable: hrvRaw.stable === true,
        }
      : null,
  };
}
