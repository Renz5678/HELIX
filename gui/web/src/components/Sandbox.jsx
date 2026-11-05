import { useState } from 'react';
import { executeRule, defaultPayload } from '../lib/sandbox.js';

/*
 * FHIR Sandbox / Test Runner: mock patient context + HL7 FHIR R4 JSON
 * payload, executed against the active rule with step-by-step logs.
 */
export default function Sandbox({ code, tokens, onClose, onLog }) {
  const [payload, setPayload] = useState(() => JSON.stringify(defaultPayload(), null, 2));
  const [ctx, setCtx] = useState({ glucose: 268, creatinine: 1.9, temp: 38.6, hr: 118 });
  const [log, setLog] = useState([]);
  const [ran, setRan] = useState(false);

  /* Push the context values into the payload's Observations before running. */
  function syncContextIntoPayload() {
    try {
      const obj = JSON.parse(payload);
      const want = { '2339-0': Number(ctx.glucose), '2160-0': Number(ctx.creatinine), '8310-5': Number(ctx.temp), '8867-4': Number(ctx.hr) };
      const seen = new Set();
      const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(walk);
        if (n.resourceType === 'Observation') {
          const code0 = n.code?.coding?.[0]?.code;
          if (code0 in want && !seen.has(code0)) {
            seen.add(code0);
            if (!n.valueQuantity) n.valueQuantity = {};
            n.valueQuantity.value = want[code0];
          }
        }
        Object.values(n).forEach(walk);
      };
      walk(obj);
      return JSON.stringify(obj, null, 2);
    } catch {
      return payload;
    }
  }

  function execute() {
    const synced = syncContextIntoPayload();
    if (synced !== payload) setPayload(synced);
    const result = executeRule(code, tokens, synced);
    setLog(result.log);
    setRan(true);
    onLog?.(result.log);
    return result;
  }

  function reset() {
    setPayload(JSON.stringify(defaultPayload(), null, 2));
    setLog([]);
    setRan(false);
  }

  const logCls = { ok: 'text-helix-ok', err: 'text-helix-err', warn: 'text-helix-warn', info: 'text-helix-muted', dim: 'text-helix-dim' };

  return (
    <aside className="flex h-full w-[330px] shrink-0 flex-col overflow-hidden border-l border-cyan-400/15 bg-helix-surface">
      <div className="flex shrink-0 items-center gap-1 border-b border-cyan-400/15 px-2.5 py-2">
        <span className="flex-1 text-[10.5px] font-bold uppercase tracking-[1.5px] text-helix-muted">FHIR Sandbox</span>
        <button className="btn btn-icon" onClick={onClose} title="Close sandbox" aria-label="Close sandbox">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>

      {/* patient context */}
      <div className="shrink-0 border-b border-cyan-400/15 p-3">
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-helix-muted">
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
          Mock Patient Context
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {[
            ['glucose', 'Glucose mg/dL'],
            ['creatinine', 'Creatinine mg/dL'],
            ['temp', 'Temp °C'],
            ['hr', 'Heart rate'],
          ].map(([key, label]) => (
            <label key={key} className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] text-helix-dim">{label}</span>
              <input
                className="field text-tok-clinical"
                value={ctx[key]}
                inputMode="decimal"
                onChange={(e) => setCtx((c) => ({ ...c, [key]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      </div>

      {/* payload editor */}
      <div className="shrink-0 p-3 pb-0">
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-helix-muted">
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>
          FHIR R4 Payload
        </div>
        <textarea
          className="h-40 w-full resize-y rounded-md border border-cyan-400/15 bg-helix-deep p-2 font-mono text-[10.5px] leading-normal text-tok-ident outline-none focus:border-helix-cyan"
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          spellCheck={false}
          aria-label="FHIR JSON payload"
        />
      </div>

      {/* actions */}
      <div className="flex shrink-0 gap-2 p-3">
        <button className="btn btn-primary flex-1 justify-center" onClick={execute}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3" /></svg>
          Execute Rule
        </button>
        <button className="btn" onClick={reset} title="Reset payload">Reset</button>
      </div>

      {/* execution log */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 font-mono text-[10.5px] leading-[1.75]">
        {!ran && log.length === 0 && (
          <div className="text-helix-dim">Press “Execute Rule” to dry-run the active rule against this payload.</div>
        )}
        {log.map((l, i) => (
          <div key={i} className={logCls[l.level] || 'text-helix-dim'}>
            {l.text}
          </div>
        ))}
      </div>
    </aside>
  );
}
