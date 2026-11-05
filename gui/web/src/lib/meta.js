/*
 * Rule metadata inference for the header badges and status bar:
 *   - terminology bindings count (LOINC/SNOMED/RxNorm calls)
 *   - inferred trigger event (schedule > terminology > vitals > evaluation)
 *   - inferred urgency from the alert level argument
 */

import { extractTerminologyCalls } from './terminology.js';

export function computeMeta(code) {
  const calls = extractTerminologyCalls(code);

  let trigger = 'ad-hoc';
  const sched = code.match(/\bschedule\s*:\s*(?:"([^"]*)"|([\w.]+))/);
  if (sched) trigger = 'sched ' + (sched[1] || sched[2]);
  else if (calls.length) trigger = 'lab result';
  else if (/\bbind\s+\w+\s*=\s*Vitals\./.test(code)) trigger = 'vitals';
  else if (/\bwhen\b/.test(code)) trigger = 'on evaluation';

  let urgency = 'LOW';
  const am = code.match(/\balert\s*:\s*"[^"]*"\s*,\s*"([A-Za-z ]+)"/);
  if (am) {
    const level = am[1].toUpperCase();
    if (level.includes('CRITICAL') || level.includes('STAT')) urgency = 'HIGH';
    else if (level.includes('WARNING') || level.includes('URGENT')) urgency = 'MEDIUM';
  }

  const ruleName = code.match(/\brule\s+([A-Za-z_]\w*)/);
  const intent = code.match(/\bintent\s*:\s*"([^"]*)"/);

  return {
    terminologyCount: calls.length,
    terminology: calls,
    trigger,
    urgency,
    ruleName: ruleName ? ruleName[1] : 'untitled_rule',
    intent: intent ? intent[1] : '',
  };
}
