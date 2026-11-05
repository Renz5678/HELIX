/* Header: brand + ECG pulse, rule title, clinical meta badges, actions. */

const ECG = (
  <svg viewBox="0 0 130 24" width="130" height="24" aria-hidden="true">
    <polyline
      className="ecg-line ecg-anim"
      points="0,12 20,12 26,12 30,4 34,20 38,12 52,12 56,12 60,7 64,17 68,12 88,12 94,12 98,3 102,21 106,12 130,12"
    />
    <circle className="ecg-dot" r="2" cx="0" cy="12">
      <animate attributeName="cx" from="0" to="130" dur="2.6s" repeatCount="indefinite" />
      <animate
        attributeName="cy"
        values="12;12;4;20;12;12;7;17;12;12;3;21;12;12"
        keyTimes="0;0.15;0.23;0.26;0.29;0.43;0.47;0.49;0.52;0.68;0.75;0.78;0.81;1"
        dur="2.6s"
        repeatCount="indefinite"
      />
    </circle>
  </svg>
);

function Icon({ d, children }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children || <path d={d} />}
    </svg>
  );
}

export default function TopBar({ meta, onToggleSidebar, onExportJson, onExportYaml, onAnalyze, invalid }) {
  const urgencyClass =
    meta.urgency === 'HIGH' ? 'border-rose-500/50 text-rose-400'
    : meta.urgency === 'MEDIUM' ? 'border-amber-400/40 text-amber-300'
    : 'border-emerald-400/30 text-emerald-300';

  return (
    <header className="relative z-30 flex h-[46px] shrink-0 items-center gap-3.5 border-b border-cyan-400/15 bg-gradient-to-b from-[#0d1424] to-[#0a0f1c] px-3.5 after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-gradient-to-r after:from-transparent after:via-cyan-400/50 after:to-transparent">
      <button
        className="btn btn-icon"
        onClick={onToggleSidebar}
        title="Toggle explorer sidebar (Ctrl+B)"
        aria-label="Toggle sidebar"
      >
        <Icon><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /></Icon>
      </button>

      <div className="flex items-center gap-2.5">
        <div>
          <div
            className="text-[16px] font-bold tracking-[3px] text-transparent"
            style={{ backgroundImage: 'linear-gradient(135deg,#00F2FE,#4FACFE)', WebkitBackgroundClip: 'text', backgroundClip: 'text' }}
          >
            HELIX
          </div>
          <div className="text-[10px] uppercase tracking-[1.5px] text-helix-dim">Clinical Rule IDE</div>
        </div>
        {ECG}
      </div>

      <div className="meta-badges flex gap-1.5">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-400/15 bg-helix-surface px-2.5 py-[3px] text-[10.5px] tracking-wide text-helix-muted" title="Terminology bindings detected">
          TERM <b className="font-semibold text-helix-cyan">{meta.terminologyCount}</b>
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-400/15 bg-helix-surface px-2.5 py-[3px] text-[10.5px] tracking-wide text-helix-muted" title="Inferred trigger event">
          TRIGGER <b className="font-semibold text-helix-cyan">{meta.trigger}</b>
        </span>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[10.5px] tracking-wide ${urgencyClass}`} title="Inferred alert urgency" style={{ background: '#0D1322' }}>
          URGENCY <b className="font-semibold">{meta.urgency}</b>
        </span>
      </div>

      <div className="flex-1" />

      <button className="btn" onClick={onExportJson} title="Export analysis report as JSON">
        <Icon><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></Icon>
        JSON
      </button>
      <button className="btn" onClick={onExportYaml} title="Export Arden-style summary (YAML)">
        <Icon><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></Icon>
        YAML
      </button>
      <button className="btn btn-primary" onClick={onAnalyze} title="Analyze now (Ctrl+Enter)">
        <Icon><polygon points="5 3 19 12 5 21 5 3" /></Icon>
        Analyze
      </button>
    </header>
  );
}
