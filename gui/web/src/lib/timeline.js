/*
 * Temporal & suppression timeline simulator.
 *
 * Derives the rule's temporal contract from the source text:
 *   - monitored terminology code (LOINC/SNOMED/RxNorm call)
 *   - trigger comparison (operator + threshold, resolving `let` variables)
 *   - suppression window (`suppress: within N <unit>`)
 *
 * then replays a mock event stream to show when alerts fire and when
 * the suppression window blocks duplicates.
 */

const UNIT_MIN = { minute: 1, minutes: 1, min: 1, m: 1, hour: 60, hours: 60, hr: 60, day: 1440, days: 1440 };

/** Pull `let name := value` bindings out of the source. */
export function parseLets(code) {
  const lets = {};
  const re = /\blet\s+([A-Za-z_]\w*)\s*:?=\s*("[^"]*"|-?\d+\.?\d*)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const raw = m[2];
    lets[m[1]] = raw.startsWith('"') ? raw.slice(1, -1) : Number(raw);
  }
  return lets;
}

/** Pull `bind name = Source.field` bindings out of the source. */
export function parseBinds(code) {
  const binds = {};
  const re = /\bbind\s+([A-Za-z_]\w*)\s*[:=]?=\s*([A-Za-z_][\w.]*)/g;
  let m;
  while ((m = re.exec(code)) !== null) binds[m[1]] = m[2];
  return binds;
}

/** First terminology call in the source, if any. */
export function primaryTerminology(code) {
  const m = code.match(/\b(LOINC|SNOMED|RxNorm)\s*\(\s*"([^"]*)"\s*\)/);
  return m ? { system: m[1], code: m[2] } : null;
}

/** Suppression window in minutes (0 when absent). */
export function parseSuppressMinutes(code) {
  const m = code.match(/\bsuppress\s*:\s*within\s+(\d+(?:\.\d+)?)\s*([A-Za-z]+)/);
  if (!m) return 0;
  const unit = UNIT_MIN[m[2].toLowerCase()];
  return unit ? Math.round(parseFloat(m[1]) * unit) : 0;
}

/**
 * Trigger condition: operator + RHS from the first `when` clause.
 * RHS identifiers are resolved through the `let` table.
 * @returns {{op: string, threshold: number, raw: string} | null}
 */
export function parseTrigger(code) {
  const lets = parseLets(code);
  const whenIdx = code.search(/\bwhen\b/);
  if (whenIdx < 0) return null;
  const clause = code.slice(whenIdx);
  const m = clause.match(/(>=|<=|==|!=|>|<)\s*([A-Za-z_]\w*|-?\d+\.?\d*)/);
  if (!m) return null;
  let rhs = m[2];
  let threshold;
  if (Object.prototype.hasOwnProperty.call(lets, rhs)) threshold = Number(lets[rhs]);
  else if (/^-?\d/.test(rhs)) threshold = Number(rhs);
  else return null;
  if (Number.isNaN(threshold)) return null;
  return { op: m[1], threshold, raw: rhs };
}

/** The full temporal contract of a rule, for the simulator header. */
export function ruleParams(code) {
  const trig = parseTrigger(code);
  return {
    terminology: primaryTerminology(code),
    op: trig ? trig.op : null,
    threshold: trig ? trig.threshold : null,
    triggerVar: trig ? trig.raw : null,
    suppressMinutes: parseSuppressMinutes(code),
    lets: parseLets(code),
    binds: parseBinds(code),
  };
}

function compare(value, op, threshold) {
  switch (op) {
    case '>': return value > threshold;
    case '>=': return value >= threshold;
    case '<': return value < threshold;
    case '<=': return value <= threshold;
    case '==': return value === threshold;
    case '!=': return value !== threshold;
    default: return false;
  }
}

/**
 * Replay events through the rule's temporal contract.
 * @param {Array<{t:number, code:string, value:number}>} events minutes + observation
 * @param {ReturnType<typeof ruleParams>} params
 * @returns {{results: Array, log: Array<{level:string, text:string}>, fired: number, suppressed: number}}
 */
export function simulateTimeline(events, params) {
  const log = [];
  const results = [];
  const sorted = [...events].sort((a, b) => a.t - b.t);
  let lastFired = -Infinity;
  let fired = 0;
  let suppressed = 0;

  log.push({
    level: 'dim',
    text: params.terminology
      ? `monitoring ${params.terminology.code} (${params.terminology.system})`
      : 'no terminology binding — matching all events',
  });
  log.push({
    level: 'dim',
    text: params.op
      ? `trigger: value ${params.op} ${params.threshold}`
      : 'no trigger parsed — every event fires',
  });
  log.push({
    level: 'dim',
    text: params.suppressMinutes > 0
      ? `suppression window: ${params.suppressMinutes} min`
      : 'no suppression window',
  });

  for (const ev of sorted) {
    const codeMatch = !params.terminology || ev.code === params.terminology.code;
    const valueMatch = params.op === null || compare(ev.value, params.op, params.threshold);

    if (!codeMatch) {
      results.push({ ...ev, status: 'nomatch', reason: `code ${ev.code} is not the monitored code` });
      log.push({ level: 'info', text: `t+${ev.t}m  ${ev.code}=${ev.value} — different code, ignored` });
      continue;
    }
    if (!valueMatch) {
      results.push({ ...ev, status: 'nomatch', reason: `${ev.value} does not satisfy ${params.op} ${params.threshold}` });
      log.push({ level: 'info', text: `t+${ev.t}m  ${ev.code}=${ev.value} — below threshold, no alert` });
      continue;
    }
    if (ev.t - lastFired < params.suppressMinutes) {
      const wait = params.suppressMinutes - (ev.t - lastFired);
      suppressed++;
      results.push({ ...ev, status: 'suppressed', reason: `duplicate within suppression window (${wait}m left)` });
      log.push({ level: 'warn', text: `t+${ev.t}m  ALERT SUPPRESSED — ${ev.code}=${ev.value}, window blocks for ${wait} more min` });
      continue;
    }
    fired++;
    lastFired = ev.t;
    results.push({ ...ev, status: 'fired', reason: 'condition met, outside suppression window' });
    log.push({ level: 'err', text: `t+${ev.t}m  ALERT FIRED — ${ev.code}=${ev.value}` });
  }

  log.push({ level: 'dim', text: `— ${fired} fired, ${suppressed} suppressed, ${sorted.length} total —` });
  return { results, log, fired, suppressed };
}

/** Sensible starter stream when the panel opens. */
export function defaultEvents(params) {
  const code = params.terminology ? params.terminology.code : '2339-0';
  const base = params.threshold !== null ? params.threshold : 180;
  return [
    { t: 0, code, value: Math.round(base * 0.8) },
    { t: 30, code, value: base + 40 },
    { t: 90, code, value: base + 70 },
    { t: 150, code, value: base + 95 },
    { t: 300, code, value: base + 120 },
    { t: 400, code, value: base + 60 },
  ];
}
