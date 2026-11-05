import { useMemo, useState } from 'react';
import { searchTerms, SYSTEMS } from '../lib/terminology.js';

/* Searchable LOINC / SNOMED-CT / RxNorm browser; click inserts at caret. */
export default function TerminologyPanel({ onInsert, usedCodes }) {
  const [q, setQ] = useState('');
  const results = useMemo(() => searchTerms(q).slice(0, 60), [q]);

  return (
    <>
      <div className="shrink-0 border-b border-cyan-400/15 px-2.5 py-2">
        <div className="text-[10.5px] font-bold uppercase tracking-[1.5px] text-helix-muted">Terminology</div>
      </div>
      <input
        className="field mx-2.5 my-2 w-[calc(100%-20px)] text-[12.5px]"
        placeholder="Search code or description..."
        value={q}
        onChange={(e) => setQ(e.target.value)}
        spellCheck={false}
        aria-label="Search terminology"
      />
      <div className="flex-1 overflow-y-auto">
        {results.map((c) => {
          const used = usedCodes.has(c.code);
          return (
            <div
              key={c.system + c.code}
              className="cursor-pointer border-l-2 border-transparent px-3 py-[7px] transition-colors hover:border-l-helix-cyan hover:bg-cyan-400/5"
              onClick={() => onInsert(c)}
              title="Click to insert into the editor"
            >
              <div className="font-mono text-xs text-helix-cyan">
                {c.code}
                <span className={`term-sys ml-1.5 rounded px-1.5 py-px align-middle text-[9px] tracking-wider ${SYSTEMS[c.system].cls === 'loinc' ? 'bg-cyan-400/10 text-helix-cyan' : SYSTEMS[c.system].cls === 'snomed' ? 'bg-emerald-400/10 text-helix-ok' : 'bg-fuchsia-400/10 text-tok-operator'}`}>
                  {SYSTEMS[c.system].label}
                </span>
                {used && <span className="ml-1.5 text-[9px] text-helix-ok">in use</span>}
                {c.deprecated && <span className="ml-1.5 text-[9px] text-amber-400">deprecated</span>}
              </div>
              <div className="mt-0.5 text-[11px] text-helix-muted">{c.description}</div>
            </div>
          );
        })}
        {results.length === 0 && (
          <div className="p-4 text-center text-xs text-helix-dim">No codes match “{q}”.</div>
        )}
      </div>
      <div className="shrink-0 border-t border-cyan-400/15 px-3 py-2.5 text-[10.5px] leading-relaxed text-helix-dim">
        Click a code to insert at the cursor. Hover codes in the editor to resolve descriptions. Unknown codes raise a <b className="text-amber-400">warning</b> in Diagnostics.
      </div>
    </>
  );
}
