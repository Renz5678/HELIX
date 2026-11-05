import { useMemo, useState } from 'react';
import { countNodes } from '../lib/ast.js';

/* ---------------- Tokens view ---------------- */

const KIND_CLASS = {
  keyword: 'kind-keyword', identifier: 'kind-identifier', number: 'kind-number',
  string: 'kind-string', operator: 'kind-operator', delimiter: 'kind-delimiter',
  error: 'kind-error', eof: 'kind-eof', comment: 'kind-comment', whitespace: 'kind-whitespace',
};

export function TokensView({ tokens, onJump }) {
  const [filter, setFilter] = useState('');
  const visible = useMemo(() => {
    const q = filter.toLowerCase();
    if (!q) return tokens;
    return tokens.filter(
      (t) => t.lexeme.toLowerCase().includes(q) || t.kind.includes(q) || t.type.toLowerCase().includes(q)
    );
  }, [tokens, filter]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/5 px-2.5 py-1.5">
        <input
          className="field w-52 text-[11.5px]"
          placeholder="Filter tokens..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
          aria-label="Filter tokens"
        />
        <span className="font-mono text-[11px] text-helix-muted">{visible.length} / {tokens.length} tokens</span>
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse font-mono text-[11.5px]">
          <thead className="sticky top-0 bg-helix-surface2">
            <tr className="text-left text-[10px] uppercase tracking-wider text-helix-muted">
              <th className="border-b border-cyan-400/15 px-2.5 py-[7px] font-ui font-semibold">#</th>
              <th className="border-b border-cyan-400/15 px-2.5 py-[7px] font-ui font-semibold">Line:Col</th>
              <th className="border-b border-cyan-400/15 px-2.5 py-[7px] font-ui font-semibold">Type</th>
              <th className="border-b border-cyan-400/15 px-2.5 py-[7px] font-ui font-semibold">Kind</th>
              <th className="border-b border-cyan-400/15 px-2.5 py-[7px] font-ui font-semibold">Lexeme</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((t) => {
              const idx = tokens.indexOf(t);
              return (
                <tr
                  key={idx}
                  className="cursor-pointer hover:bg-cyan-400/5"
                  onClick={() => onJump(t.line, t.column)}
                  title={`Jump to ${t.line}:${t.column}`}
                >
                  <td className="border-b border-white/[0.03] px-2.5 py-1 text-helix-muted">{idx + 1}</td>
                  <td className="border-b border-white/[0.03] px-2.5 py-1 text-helix-muted">{t.line}:{t.column}</td>
                  <td className={`border-b border-white/[0.03] px-2.5 py-1 font-semibold ${KIND_CLASS[t.kind] || ''}`}>{t.type}</td>
                  <td className={`border-b border-white/[0.03] px-2.5 py-1 ${KIND_CLASS[t.kind] || ''}`}>
                    {t.kind}{t.error && <span className="ml-1 font-bold text-helix-err">✖</span>}
                  </td>
                  <td className="max-w-72 overflow-hidden text-ellipsis whitespace-nowrap border-b border-white/[0.03] px-2.5 py-1 text-helix-text">"{t.lexeme}"</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {visible.length === 0 && <div className="p-6 text-center text-xs text-helix-dim">No tokens match the filter.</div>}
      </div>
    </div>
  );
}

/* ---------------- AST view ---------------- */

function AstNode({ node, depth = 0 }) {
  const [open, setOpen] = useState(depth < 4);
  const hasKids = node.children && node.children.length > 0;
  return (
    <div className={`n-${node.kind}`}>
      <div
        className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-[3px] hover:bg-cyan-400/5"
        onClick={() => hasKids && setOpen(!open)}
        title={node.line ? `Jump to ${node.line}:${node.column}` : undefined}
      >
        <span className={`w-3.5 shrink-0 text-[9px] text-helix-dim ${hasKids ? 'cursor-pointer hover:text-helix-cyan' : 'invisible'}`}>
          {hasKids ? (open ? '▾' : '▸') : '•'}
        </span>
        <span className="ast-label font-bold">{node.kind}</span>
        {node.detail && <span className="max-w-md overflow-hidden text-ellipsis whitespace-nowrap text-helix-muted">{node.detail}</span>}
        {node.error && <span className="text-[10px] text-helix-err">error</span>}
        {node.line && <span className="text-[10px] text-[#3d4a63]">:{node.line}:{node.column}</span>}
      </div>
      {hasKids && open && (
        <div className="ast-children">
          {node.children.map((c, i) => <AstNode key={i} node={c} depth={depth + 1} />)}
        </div>
      )}
    </div>
  );
}

export function AstView({ ast }) {
  if (!ast || !ast.program.children.length) {
    return (
      <div className="p-6 text-center text-xs leading-relaxed text-helix-dim">
        No AST — the module has fatal syntax errors.<br />Fix the diagnostics to visualize the tree.
      </div>
    );
  }
  const n = countNodes(ast.program);
  return (
    <div className="p-3.5 font-mono text-xs">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-helix-dim">{n} nodes{ast.failed ? ` · partial: ${ast.failed}` : ''}</div>
      <AstNode node={ast.program} />
    </div>
  );
}

/* ---------------- Diagnostics view ---------------- */

function DiagIcon({ severity }) {
  return severity === 'warning' ? (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
  ) : (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
  );
}

export function DiagnosticsView({ report, code, diagnostics, onJump }) {
  if (!report) {
    return <div className="p-6 text-center text-xs text-helix-dim">Nothing to analyze yet.</div>;
  }
  const stats = report.stats;
  const errors = diagnostics.filter((d) => d.severity !== 'warning').length;
  const warnings = diagnostics.length - errors;
  const valid = stats.valid && errors === 0;
  const lines = code.split('\n');

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-cyan-400/15 px-4 py-3">
        <div
          className={`flex items-center gap-2.5 rounded-lg px-4 py-2 text-[13px] font-bold uppercase tracking-wider ${
            valid ? 'border border-emerald-400/40 bg-emerald-400/10 text-helix-ok' : 'border border-rose-500/40 bg-rose-500/10 text-helix-err'
          }`}
        >
          {valid ? (
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
          )}
          {valid ? 'Valid' : 'Invalid'}
        </div>
        <div className="flex flex-wrap gap-4 font-mono text-[11px] text-helix-muted">
          <span>lexical errors <b className="text-helix-text">{stats.lexicalErrors}</b></span>
          <span>syntax errors <b className="text-helix-text">{stats.syntaxErrors}</b></span>
          <span>warnings <b className="text-helix-text">{warnings}</b></span>
          <span>tokens <b className="text-helix-text">{stats.tokens}</b></span>
          <span>rules <b className="text-helix-text">{stats.rules}</b></span>
          <span>{stats.lines} lines / {stats.bytes} bytes</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {diagnostics.length === 0 ? (
          <div className="p-6 text-center text-xs leading-relaxed text-helix-dim">
            <svg viewBox="0 0 24 24" className="mx-auto mb-2.5 h-8 w-8 opacity-40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
            No diagnostics — the module compiles clean.<br />Lexical analysis and parsing both succeeded.
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {diagnostics.map((d, i) => {
              const src = lines[d.line - 1];
              const col = Math.max(1, Math.min(d.column || 1, (src?.length ?? 0) + 1));
              return (
                <div
                  key={i}
                  className={`flex cursor-pointer gap-2.5 rounded-md border-l-[3px] bg-helix-deep px-2.5 py-2 transition-colors hover:bg-cyan-400/5 ${
                    d.severity === 'warning' ? 'border-l-helix-warn' : 'border-l-helix-err'
                  }`}
                  onClick={() => onJump(d.line, d.column || 1)}
                >
                  <span className={`mt-px shrink-0 ${d.severity === 'warning' ? 'text-helix-warn' : 'text-helix-err'}`}>
                    <DiagIcon severity={d.severity} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] leading-snug text-helix-text">{d.message}</div>
                    <div className="mt-0.5 text-[11px] text-helix-muted">
                      {d.source === 'terminology' ? 'terminology · ' : ''}{d.severity} · line {d.line}, column {d.column || 1}
                    </div>
                    {src !== undefined && (
                      <pre className="mt-1.5 overflow-x-auto rounded bg-black/30 px-2 py-1 font-mono text-[11px] text-helix-muted">
                        {src}
                        {'\n'}<span className="font-bold text-helix-err">{' '.repeat(col - 1)}^</span>
                      </pre>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Console view ---------------- */

export function ConsoleView({ lines }) {
  if (!lines.length) {
    return <div className="p-6 text-center text-xs text-helix-dim">Console is quiet — actions will log here.</div>;
  }
  const cls = { ok: 'text-helix-ok', err: 'text-helix-err', warn: 'text-helix-warn', info: 'text-helix-muted', cyan: 'text-helix-cyan', dim: 'text-helix-dim' };
  return (
    <div className="p-3.5 font-mono text-[11.5px] leading-[1.8]">
      {lines.map((l, i) => (
        <div key={i}>
          <span className="text-helix-dim">[{l.time}]</span>{' '}
          <span className={cls[l.level] || 'text-helix-dim'}>{l.text}</span>
        </div>
      ))}
    </div>
  );
}
