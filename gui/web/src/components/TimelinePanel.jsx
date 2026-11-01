import { useMemo, useState } from 'react';
import { ruleParams, simulateTimeline, defaultEvents } from '../lib/timeline.js';

/*
 * Temporal & suppression timeline simulator.
 * Derives the rule's temporal contract from the source, lets the user
 * build a mock event stream, and renders alerts vs. suppression windows.
 */
export default function TimelinePanel({ code }) {
  const params = useMemo(() => ruleParams(code), [code]);
  const [events, setEvents] = useState(() => defaultEvents(ruleParams(code)));
  const [results, setResults] = useState(null); // {results, log, fired, suppressed}

  const [form, setForm] = useState({
    code: params.terminology?.code || '2339-0',
    value: params.threshold !== null ? params.threshold + 40 : 250,
    t: 60,
  });

  function addEvent() {
    const t = Number(form.t);
    const value = Number(form.value);
    if (Number.isNaN(t) || Number.isNaN(value) || !form.code) return;
    setEvents((evs) => [...evs, { t, code: form.code.trim(), value }].sort((a, b) => a.t - b.t));
    setResults(null);
  }

  function run() {
    setResults(simulateTimeline(events, params));
  }

  const maxT = Math.max(60, ...events.map((e) => e.t));
  const STATUS = {
    fired: { color: '#F87171', label: 'alert fired' },
    suppressed: { color: '#6B7280', label: 'suppressed' },
    nomatch: { color: '#00F2FE', label: 'no match' },
  };

  return (
    <>
      <div className="shrink-0 border-b border-cyan-400/15 px-2.5 py-2">
        <div className="text-[10.5px] font-bold uppercase tracking-[1.5px] text-helix-muted">Timeline Simulator</div>
      </div>

      {/* rule contract summary */}
      <div className="shrink-0 border-b border-cyan-400/15 bg-helix-deep px-3 py-2 font-mono text-[10.5px] leading-relaxed text-helix-muted">
        <div>
          monitor: <span className="text-helix-cyan">{params.terminology ? `${params.terminology.system} ${params.terminology.code}` : 'any code'}</span>
        </div>
        <div>
          trigger: <span className="text-tok-clinical">{params.op ? `value ${params.op} ${params.threshold}` : 'not parsed'}</span>
        </div>
        <div>
          suppress: <span className="text-helix-warn">{params.suppressMinutes > 0 ? `${params.suppressMinutes} min` : 'none'}</span>
        </div>
      </div>

      {/* add-event form */}
      <div className="grid shrink-0 gap-1.5 border-b border-cyan-400/15 p-2.5" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <input
          className="field"
          placeholder="code"
          value={form.code}
          onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
          aria-label="Event code"
        />
        <input
          className="field"
          placeholder="value"
          value={form.value}
          onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
          aria-label="Event value"
        />
        <select className="field cursor-pointer" value={form.t} onChange={(e) => setForm((f) => ({ ...f, t: e.target.value }))} aria-label="Event time">
          {[0, 30, 60, 120, 180, 240, 300, 360, 480].map((t) => (
            <option key={t} value={t}>t = {t} min</option>
          ))}
        </select>
        <button className="btn justify-center" onClick={addEvent}>+ Add Event</button>
        <button className="btn col-span-2 btn-primary justify-center" onClick={run}>
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3" /></svg>
          Run Timeline
        </button>
        <button className="btn btn-danger col-span-2 justify-center" onClick={() => { setEvents([]); setResults(null); }}>Clear Events</button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* legend */}
        <div className="flex gap-2.5 px-2.5 pt-2 text-[10px] text-helix-muted">
          {Object.entries(STATUS).map(([k, v]) => (
            <span key={k} className="inline-flex items-center gap-1">
              <i className="inline-block h-2 w-2 rounded-full" style={{ background: v.color }} />
              {v.label}
            </span>
          ))}
        </div>

        {/* timeline canvas */}
        <div className="overflow-x-auto px-2.5 py-2">
          {events.length === 0 ? (
            <div className="py-6 text-center text-xs text-helix-dim">No events — add some above.</div>
          ) : (
            <svg width="100%" viewBox={`0 0 260 ${Math.max(46, results ? results.results.length * 18 + 30 : events.length * 18 + 30)}`} preserveAspectRatio="none" style={{ minHeight: 60 }} role="img" aria-label="Event timeline">
              {/* axis */}
              <line x1="8" y1="14" x2="252" y2="14" stroke="#1c2740" strokeWidth="1" />
              {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                <g key={f}>
                  <line x1={8 + f * 244} y1="11" x2={8 + f * 244} y2="17" stroke="#1c2740" />
                  <text x={8 + f * 244} y="8" fill="#3d4a63" fontSize="5" textAnchor="middle">{Math.round(f * maxT)}m</text>
                </g>
              ))}
              {/* suppression windows (after fired alerts) */}
              {results &&
                results.results
                  .filter((r) => r.status === 'fired' && params.suppressMinutes > 0)
                  .map((r, i) => {
                    const x1 = 8 + (r.t / maxT) * 244;
                    const x2 = 8 + (Math.min(r.t + params.suppressMinutes, maxT) / maxT) * 244;
                    return <rect key={'sw' + i} x={x1} y="16" width={Math.max(1, x2 - x1)} height="999" fill="rgba(107,114,128,0.12)" />;
                  })}
              {/* event markers */}
              {(results ? results.results : events).map((ev, i) => {
                const x = 8 + (ev.t / maxT) * 244;
                const y = 26 + i * 18;
                const status = results ? ev.status : 'pending';
                const color = results ? STATUS[ev.status].color : '#4FACFE';
                return (
                  <g key={i}>
                    <line x1={x} y1="14" x2={x} y2={y} stroke={color} strokeWidth="0.6" strokeDasharray="1.5 1.5" opacity="0.6" />
                    <circle cx={x} cy={y} r="3.4" fill={color} style={{ filter: status === 'fired' ? 'drop-shadow(0 0 2px #F87171)' : 'none' }} />
                    <text x={x + 6} y={y + 1.8} fill="#9CA3AF" fontSize="5.5" fontFamily="monospace">
                      {ev.code}={ev.value} @{ev.t}m
                    </text>
                    {results && (
                      <text x="252" y={y + 1.8} fontSize="5" fontFamily="monospace" textAnchor="end" fill={color}>
                        {ev.status}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        {/* run log */}
        {results && (
          <div className="px-2.5 pb-2.5 font-mono text-[10.5px] leading-[1.75]">
            {results.log.map((l, i) => (
              <div
                key={i}
                className={
                  l.level === 'err' ? 'text-helix-err'
                  : l.level === 'warn' ? 'text-helix-warn'
                  : l.level === 'ok' ? 'text-helix-ok'
                  : l.level === 'dim' ? 'text-helix-dim'
                  : 'text-helix-muted'
                }
              >
                {l.text}
              </div>
            ))}
            <div className="mt-1.5 rounded-md border border-cyan-400/15 bg-helix-deep p-2 text-center text-[10px] text-helix-muted">
              {results.fired} fired · {results.suppressed} suppressed · {results.results.length} total
            </div>
          </div>
        )}
      </div>
    </>
  );
}
