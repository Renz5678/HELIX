import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { highlight, lineOfOffset, offsetOf } from '../lib/highlighter.js';
import { searchTerms, termAtOffset, SYSTEMS } from '../lib/terminology.js';

/*
 * Source editor: transparent textarea over a highlighted <pre>, synced
 * gutter with error markers, find/replace, terminology autocomplete
 * (LOINC/SNOMED/RxNorm) and hover tooltips that resolve code -> description.
 */
export default function Editor({
  code,
  onChange,
  diagnostics,
  jumpRequest,
  onCursor,
  findOpen,
  onCloseFind,
  editorRef,
}) {
  const taRef = useRef(null);
  const hlRef = useRef(null);
  const gutterRef = useRef(null);
  const acRef = useRef(null);

  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [find, setFind] = useState({ query: '', replace: '', hits: [], idx: 0 });
  const [ac, setAc] = useState(null);       // {query, start, items, sel}
  const [hover, setHover] = useState(null); // {x, y, call}

  const errLines = useMemo(() => {
    const m = new Map();
    for (const d of diagnostics) m.set(d.line, d.severity === 'warning' ? 'warn' : 'err');
    return m;
  }, [diagnostics]);

  const highlightHtml = useMemo(() => highlight(code), [code]);

  /* ---- imperative API exposed to the parent (tabs, tree clicks) ---- */
  useEffect(() => {
    if (!editorRef) return;
    editorRef.current = {
      focus: () => taRef.current?.focus(),
      jumpTo(line, col) {
        const ta = taRef.current;
        if (!ta) return;
        const off = offsetOf(ta.value, line, col || 1);
        ta.focus();
        ta.setSelectionRange(off, off);
        ta.scrollTop = Math.max(0, (line - 6) * 22);
        sync();
      },
      insert(text) {
        const ta = taRef.current;
        if (!ta) return;
        const s = ta.selectionStart;
        const e = ta.selectionEnd;
        const next = ta.value.slice(0, s) + text + ta.value.slice(e);
        onChange(next);
        requestAnimationFrame(() => {
          ta.setSelectionRange(s + text.length, s + text.length);
          ta.focus();
        });
      },
    };
  }, [editorRef, onChange]);

  /* ---- external jump requests (token rows, diagnostics, AST nodes) ---- */
  useEffect(() => {
    if (jumpRequest) editorRef.current?.jumpTo(jumpRequest.line, jumpRequest.column);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpRequest]);

  function sync() {
    const ta = taRef.current;
    if (!ta) return;
    if (hlRef.current) {
      hlRef.current.scrollTop = ta.scrollTop;
      hlRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  }

  const reportCursor = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const line = lineOfOffset(ta.value, pos);
    const lineStart = ta.value.lastIndexOf('\n', pos - 1) + 1;
    const col = pos - lineStart + 1;
    setCursor({ line, col });
    onCursor?.({ line, col, offset: pos });
  }, [onCursor]);

  /* ---- find / replace ---- */
  useEffect(() => {
    if (!find.query) { setFind((f) => ({ ...f, hits: [], idx: 0 })); return; }
    const hits = [];
    const lower = code.toLowerCase();
    const q = find.query.toLowerCase();
    let i = 0;
    while ((i = lower.indexOf(q, i)) !== -1) { hits.push(i); i += q.length; }
    setFind((f) => ({ ...f, hits, idx: hits.length ? Math.min(f.idx, hits.length - 1) : 0 }));
  }, [find.query, code]); // eslint-disable-line react-hooks/exhaustive-deps

  function gotoHit(delta) {
    if (!find.hits.length) return;
    const idx = (find.idx + delta + find.hits.length) % find.hits.length;
    setFind((f) => ({ ...f, idx }));
    const off = find.hits[idx];
    const ta = taRef.current;
    ta.focus();
    ta.setSelectionRange(off, off + find.query.length);
    ta.scrollTop = Math.max(0, (lineOfOffset(ta.value, off) - 6) * 22);
    sync();
    reportCursor();
  }

  function replaceOne() {
    const ta = taRef.current;
    if (!ta || !find.hits.length) return;
    const off = find.hits[find.idx];
    const next = code.slice(0, off) + find.replace + code.slice(off + find.query.length);
    onChange(next);
  }

  function replaceAll() {
    if (!find.query) return;
    const re = new RegExp(find.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    onChange(code.replace(re, find.replace));
  }

  /* ---- terminology autocomplete ---- */
  const AC_RE = /\b(LOINC|SNOMED|RxNorm)\(\s*"?([A-Za-z0-9.\-]*)$/;

  function updateAutocomplete(ta) {
    const before = ta.value.slice(0, ta.selectionStart);
    const m = before.match(AC_RE);
    if (!m) { setAc(null); return; }
    const items = searchTerms(m[2]).slice(0, 8);
    setAc({
      sys: m[1],
      query: m[2],
      start: ta.selectionStart - m[2].length - 1, // position of the opening quote
      items,
      sel: 0,
    });
  }

  function acceptAc(item) {
    const ta = taRef.current;
    if (!ta || !ac) return;
    const caret = ta.selectionStart;
    const head = ta.value.slice(0, ac.start);
    const tail = ta.value.slice(caret);
    const next = `${head}"${item.code}")${tail}`;
    onChange(next);
    setAc(null);
    requestAnimationFrame(() => {
      const p = head.length + item.code.length + 3;
      ta.setSelectionRange(p, p);
      ta.focus();
    });
  }

  function onEditorInput(e) {
    onChange(e.target.value);
    updateAutocomplete(e.target);
    reportCursor();
  }

  function onEditorKeyDown(e) {
    if (ac && ac.items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setAc((a) => ({ ...a, sel: (a.sel + 1) % a.items.length })); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setAc((a) => ({ ...a, sel: (a.sel - 1 + a.items.length) % a.items.length })); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptAc(ac.items[ac.sel]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setAc(null); return; }
    }
    if (findOpen && e.key === 'Enter') {
      e.preventDefault();
      gotoHit(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.target;
      const s = ta.selectionStart;
      const next = ta.value.slice(0, s) + '    ' + ta.value.slice(ta.selectionEnd);
      onChange(next);
      requestAnimationFrame(() => ta.setSelectionRange(s + 4, s + 4));
    }
  }

  /* ---- hover tooltips for terminology calls ---- */
  function onMouseMove(e) {
    const ta = taRef.current;
    if (!ta) return;
    const rect = ta.getBoundingClientRect();
    const lineHeight = 22;
    const padY = 12, padX = 16;
    const y = e.clientY - rect.top + ta.scrollTop - padY;
    const line = Math.floor(y / lineHeight);
    const lines = ta.value.split('\n');
    if (line < 0 || line >= lines.length) { setHover(null); return; }
    /* approximate column: mono font, char width derived from metrics */
    const charW = ta.scrollWidth > rect.width
      ? (ta.scrollWidth - padX * 2) / Math.max(1, lines[line]?.length || 1)
      : measureCharWidth(ta);
    const x = e.clientX - rect.left + ta.scrollLeft - padX;
    const col = Math.max(0, Math.floor(x / charW));
    const offset = offsetOf(ta.value, line + 1, col + 1);
    const call = termAtOffset(ta.value, offset);
    if (call && call.code) {
      setHover({ x: e.clientX, y: e.clientY, call });
    } else if (hover) {
      setHover(null);
    }
  }

  const charWRef = useRef(0);
  function measureCharWidth(ta) {
    if (charWRef.current) return charWRef.current;
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-family:var(--font-mono);font-size:13.5px';
    probe.textContent = '0'.repeat(50);
    document.body.appendChild(probe);
    charWRef.current = probe.getBoundingClientRect().width / 50 || 8;
    probe.remove();
    return charWRef.current;
  }

  const lineCount = Math.max(1, code.split('\n').length);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ---------- find / replace bar ---------- */}
      {findOpen && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-cyan-400/15 bg-helix-surface2 px-3 py-1.5">
          <input
            className="field w-44"
            placeholder="Find"
            autoFocus
            value={find.query}
            onChange={(e) => setFind((f) => ({ ...f, query: e.target.value }))}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); gotoHit(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') onCloseFind(); }}
            aria-label="Find"
          />
          <input
            className="field w-44"
            placeholder="Replace"
            value={find.replace}
            onChange={(e) => setFind((f) => ({ ...f, replace: e.target.value }))}
            aria-label="Replace"
          />
          <span className="min-w-14 font-mono text-[11px] text-helix-muted">
            {find.hits.length ? find.idx + 1 : 0} / {find.hits.length}
          </span>
          <button className="btn btn-icon" title="Previous (Shift+Enter)" onClick={() => gotoHit(-1)} aria-label="Previous match">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15" /></svg>
          </button>
          <button className="btn btn-icon" title="Next (Enter)" onClick={() => gotoHit(1)} aria-label="Next match">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          <button className="btn" onClick={replaceOne} title="Replace current">Replace</button>
          <button className="btn" onClick={replaceAll} title="Replace all">All</button>
          <button className="btn btn-icon" title="Close (Esc)" onClick={onCloseFind} aria-label="Close find">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
      )}

      {/* ---------- editor stack ---------- */}
      <div className="flex min-h-0 flex-1 bg-helix-deep">
        <div ref={gutterRef} className="w-[46px] shrink-0 overflow-hidden border-r border-cyan-400/7 bg-[#080c15] pt-3 text-right font-mono text-[13.5px] leading-[22px] text-[#3d4a63] select-none">
          {Array.from({ length: lineCount }, (_, i) => {
            const ln = i + 1;
            const st = errLines.get(ln);
            const cls = ln === cursor.line ? 'text-helix-cyan font-bold' : st === 'err' ? 'font-bold text-helix-err' : st === 'warn' ? 'text-helix-warn' : '';
            return (
              <div key={ln} className={`relative pr-3 ${cls}`}>
                {(st === 'err' || st === 'warn') && (
                  <span
                    className="absolute left-1 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full"
                    style={{ background: st === 'err' ? '#F87171' : '#FBBF24', boxShadow: `0 0 6px ${st === 'err' ? '#F87171' : '#FBBF24'}` }}
                  />
                )}
                {ln}
              </div>
            );
          })}
        </div>

        <div className="editor-scroll" onMouseMove={onMouseMove} onMouseLeave={() => setHover(null)}>
          <pre ref={hlRef} className="hl-layer" aria-hidden="true" dangerouslySetInnerHTML={{ __html: highlightHtml }} />
          <textarea
            ref={taRef}
            className="ta"
            value={code}
            spellCheck={false}
            wrap="off"
            placeholder="# Open a module from the explorer, load a sample, or start typing HELIX..."
            aria-label="HELIX source editor"
            onChange={onEditorInput}
            onKeyDown={onEditorKeyDown}
            onScroll={sync}
            onClick={reportCursor}
            onKeyUp={reportCursor}
            onSelect={reportCursor}
          />

          {/* terminology autocomplete */}
          {ac && ac.items.length > 0 && (
            <div
              ref={acRef}
              className="absolute z-[120] min-w-80 max-w-[460px] overflow-hidden rounded-lg border border-cyan-400/35 bg-helix-surface2 shadow-[0_12px_40px_rgba(0,0,0,0.65)]"
              style={{
                top: `${(cursor.line - 1) * 22 + 40}px`,
                left: '16px',
              }}
              role="listbox"
            >
              {ac.items.map((item, i) => (
                <div
                  key={item.system + item.code}
                  className={`flex cursor-pointer items-baseline gap-2 px-2.5 py-1.5 text-xs ${i === ac.sel ? 'bg-cyan-400/15' : 'hover:bg-cyan-400/10'}`}
                  onMouseEnter={() => setAc((a) => ({ ...a, sel: i }))}
                  onMouseDown={(e) => { e.preventDefault(); acceptAc(item); }}
                  role="option"
                  aria-selected={i === ac.sel}
                >
                  <span className="font-mono text-helix-cyan">{item.code}</span>
                  <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-helix-muted">{item.description}</span>
                  <span className="text-[9px] tracking-wide text-helix-dim">{SYSTEMS[item.system].label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ---------- hover tooltip ---------- */}
      {hover && (
        <div
          className="pointer-events-none fixed z-[150] max-w-sm rounded-lg border border-cyan-400/35 bg-helix-surface2 px-3 py-2 shadow-[0_10px_30px_rgba(0,0,0,0.6)] text-xs"
          style={{ left: Math.min(hover.x + 14, window.innerWidth - 400), top: hover.y + 18 }}
          role="tooltip"
        >
          <div className="font-mono text-helix-cyan">
            {hover.call.system}("{hover.call.code}")
          </div>
          {hover.call.term ? (
            <>
              <div className="mt-1 leading-snug text-helix-text">{hover.call.term.description}</div>
              <div className="mt-1 text-[10px] tracking-wide text-helix-dim">
                {SYSTEMS[hover.call.system].label} · {SYSTEMS[hover.call.system].uri}
                {hover.call.term.deprecated && <span className="ml-2 text-amber-400">⚠ deprecated</span>}
              </div>
            </>
          ) : (
            <div className="mt-1 text-amber-400">⚠ code not found in terminology service</div>
          )}
        </div>
      )}
    </div>
  );
}
