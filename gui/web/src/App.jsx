import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TopBar from './components/TopBar.jsx';
import Editor from './components/Editor.jsx';
import FileExplorer from './components/FileExplorer.jsx';
import TerminologyPanel from './components/TerminologyPanel.jsx';
import TimelinePanel from './components/TimelinePanel.jsx';
import Sandbox from './components/Sandbox.jsx';
import { TokensView, AstView, DiagnosticsView, ConsoleView } from './components/PanelViews.jsx';
import { analyze, fetchLibrary, readFile, fsOp } from './lib/api.js';
import { buildAst } from './lib/ast.js';
import { computeMeta } from './lib/meta.js';
import { terminologyDiagnostics } from './lib/terminology.js';
import { SAMPLES, SAMPLE_LABELS } from './lib/samples.js';
import { exportJson, exportYaml } from './lib/export.js';

const PANELS = [
  {
    id: 'explorer', title: 'Module Explorer',
    icon: <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />,
  },
  {
    id: 'terminology', title: 'Terminology Browser (LOINC / SNOMED-CT / RxNorm)',
    icon: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  },
  {
    id: 'timeline', title: 'Temporal & Suppression Timeline Simulator',
    icon: <><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>,
  },
];

const TAB_VIEWS = [
  { id: 'tokens', label: 'Tokens' },
  { id: 'ast', label: 'AST' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'console', label: 'Console' },
];

export default function App() {
  /* ---- document state ---- */
  const [code, setCode] = useState(SAMPLES.basic);
  const [report, setReport] = useState(null);
  const [ast, setAst] = useState(null);
  const [analyzeSeq, setAnalyzeSeq] = useState(0);
  const seqRef = useRef(0);

  /* ---- tabs ---- */
  const [tabs, setTabs] = useState([{ id: 'sample', path: null, name: 'sample_basic.helix', dirty: false, ro: true }]);
  const [activeTab, setActiveTab] = useState('sample');

  /* ---- chrome state ---- */
  const [sideOpen, setSideOpen] = useState(true);
  const [sidePanel, setSidePanel] = useState('explorer');
  const [bottomView, setBottomView] = useState('tokens');
  const [sandboxOpen, setSandboxOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [library, setLibrary] = useState([]);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [conn, setConn] = useState('online');
  const [toasts, setToasts] = useState([]);
  const [consoleLines, setConsoleLines] = useState([]);
  const [jumpRequest, setJumpRequest] = useState(null);
  const [sampleKey, setSampleKey] = useState('');

  const editorRef = useRef(null);
  const debounceRef = useRef(null);
  const toastIdRef = useRef(0);

  const meta = useMemo(() => computeMeta(code), [code]);
  const diagnostics = useMemo(() => {
    if (!report) return [];
    return [...report.diagnostics, ...terminologyDiagnostics(code)];
  }, [report, code]);

  /* ---- logging + toasts ---- */
  const log = useCallback((level, text) => {
    const time = new Date().toTimeString().slice(0, 8);
    setConsoleLines((ls) => [...ls, { time, level, text }].slice(-300));
  }, []);

  const toast = useCallback((text, kind = 'info') => {
    const id = ++toastIdRef.current;
    setToasts((ts) => [...ts, { id, text, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 3400);
  }, []);

  /* ---- analysis pipeline (debounced, stale-guarded) ---- */
  const runAnalysis = useCallback(async (source) => {
    const seq = ++seqRef.current;
    setAnalyzeSeq(seq);
    if (!source.trim()) {
      setReport(null); setAst(null);
      return;
    }
    try {
      const r = await analyze(source);
      if (seq !== seqRef.current) return;
      setReport(r);
      setAst(buildAst(r.tokens));
      setConn('online');
    } catch (err) {
      if (seq !== seqRef.current) return;
      setConn('offline');
      toast(`Analyzer unreachable (${err.message}). Is helix-server.exe running?`, 'error');
      log('err', `analysis failed: ${err.message}`);
    }
  }, [toast, log]);

  const scheduleAnalysis = useCallback((source) => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runAnalysis(source), 250);
  }, [runAnalysis]);

  useEffect(() => { runAnalysis(code); /* initial */ /* eslint-disable-next-line */ }, []);
  useEffect(() => { scheduleAnalysis(code); }, [code, scheduleAnalysis]);

  /* ---- library ---- */
  const refreshLibrary = useCallback(async () => {
    try {
      setLibrary(await fetchLibrary());
      setConn('online');
    } catch {
      setConn('offline');
    }
  }, []);
  useEffect(() => { refreshLibrary(); }, [refreshLibrary]);

  /* ---- tabs / files ---- */
  function openInTab({ path, name, dirty, ro }) {
    setTabs((ts) => {
      const existing = ts.find((t) => t.path === path && path !== null);
      if (existing) { setActiveTab(existing.id); return ts; }
      const id = path || 'scratch-' + Date.now();
      setActiveTab(id);
      return [...ts, { id, path, name, dirty, ro }];
    });
  }

  const openFile = useCallback(async (path, name, ro) => {
    try {
      const text = await readFile(path);
      setCode(text);
      setSampleKey('');
      openInTab({ path, name, dirty: false, ro: !!ro });
      log('info', `opened ${path}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }, [toast, log]);

  function closeTab(id) {
    setTabs((ts) => {
      const next = ts.filter((t) => t.id !== id);
      if (id === activeTab && next.length) {
        const target = next[next.length - 1];
        setActiveTab(target.id);
        if (target.path) {
          readFile(target.path).then(setCode).catch(() => {});
        }
      }
      if (!next.length) {
        setCode('');
        setActiveTab('');
      }
      return next;
    });
  }

  function switchTab(tab) {
    /* stash current buffer into the outgoing tab */
    setTabs((ts) => ts.map((t) => (t.id === activeTab ? { ...t, code } : t)));
    setActiveTab(tab.id);
    if (tab.path) {
      if (tab.code !== undefined) setCode(tab.code);
      else readFile(tab.path).then(setCode).catch((e) => toast(e.message, 'error'));
    } else if (tab.code !== undefined) {
      setCode(tab.code);
    }
  }

  async function saveActive() {
    const tab = tabs.find((t) => t.id === activeTab);
    if (!tab) return;
    try {
      let path = tab.path;
      if (!path || tab.ro) {
        const name = window.prompt('Save as (under workspace/):', tab.name.endsWith('.helix') ? tab.name : tab.name + '.helix');
        if (!name) return;
        const folder = window.prompt('Folder:', 'rules') || 'rules';
        path = `workspace/${folder.replace(/[^a-z0-9_\-]/gi, '')}/${name.replace(/[/\\]/g, '_')}`;
      }
      await fsOp({ op: 'write', path, body: code });
      setTabs((ts) => ts.map((t) => (t.id === activeTab ? { ...t, path, name: path.split('/').pop(), dirty: false, ro: false } : t)));
      toast(`Saved ${path}`, 'info');
      log('ok', `saved ${path}`);
      refreshLibrary();
    } catch (err) {
      toast(err.message, 'error');
      log('err', `save failed: ${err.message}`);
    }
  }

  function loadSample(key) {
    if (!key) return;
    setCode(SAMPLES[key]);
    setSampleKey(key);
    const name = 'sample_' + key + '.helix';
    setTabs((ts) => {
      const id = 'sample-' + key;
      const without = ts.filter((t) => t.id !== id && t.id !== activeTab);
      setActiveTab(id);
      return [...without, { id, path: null, name, dirty: false, ro: true }];
    });
    log('info', `loaded sample: ${SAMPLE_LABELS[key]}`);
  }

  /* ---- jump helper ---- */
  const jumpTo = useCallback((line, column) => {
    setJumpRequest({ line, column, n: Date.now() });
    editorRef.current?.focus();
  }, []);

  /* ---- keyboard shortcuts ---- */
  useEffect(() => {
    function onKey(e) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'Enter') { e.preventDefault(); clearTimeout(debounceRef.current); runAnalysis(code); }
      else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveActive(); }
      else if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); setFindOpen(true); }
      else if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); setSideOpen((s) => !s); }
      else if (mod && e.key.toLowerCase() === 'j') { e.preventDefault(); setSandboxOpen((s) => !s); }
      else if (e.key === 'Escape') { setFindOpen(false); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  /* ---- used terminology codes (panel "in use" markers) ---- */
  const usedCodes = useMemo(() => new Set(meta.terminology.map((t) => t.code)), [meta]);

  /* ---- render ---- */
  const activeTabObj = tabs.find((t) => t.id === activeTab);
  const errorCount = diagnostics.filter((d) => d.severity !== 'warning').length;

  return (
    <div className="relative z-10 flex h-full flex-col">
      <TopBar
        meta={meta}
        invalid={report && !report.stats.valid}
        onToggleSidebar={() => setSideOpen((s) => !s)}
        onExportJson={() => report && (exportJson(report, meta, code), log('ok', 'exported JSON report'))}
        onExportYaml={() => report && (exportYaml(report, meta, code), log('ok', 'exported YAML summary'))}
        onAnalyze={() => { clearTimeout(debounceRef.current); runAnalysis(code); }}
      />

      <div className="flex min-h-0 flex-1">
        {/* activity bar */}
        <nav className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-cyan-400/15 bg-helix-deep pt-2" aria-label="Tool panels">
          {PANELS.map((p) => (
            <button
              key={p.id}
              className={`relative flex h-[34px] w-[34px] items-center justify-center rounded-lg transition-colors ${
                sideOpen && sidePanel === p.id
                  ? 'bg-cyan-400/10 text-helix-cyan'
                  : 'text-helix-dim hover:bg-cyan-400/5 hover:text-helix-text'
              }`}
              title={p.title}
              aria-label={p.title}
              onClick={() => { if (sideOpen && sidePanel === p.id) setSideOpen(false); else { setSideOpen(true); setSidePanel(p.id); } }}
            >
              <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{p.icon}</svg>
              {sideOpen && sidePanel === p.id && <span className="absolute -left-[5px] top-1.5 bottom-1.5 w-0.5 rounded-sm bg-gradient-to-b from-helix-cyan to-helix-blue" />}
            </button>
          ))}
        </nav>

        {/* sidebar */}
        <aside className={`flex w-[252px] shrink-0 flex-col overflow-hidden border-r border-cyan-400/15 bg-helix-surface transition-all duration-200 ${sideOpen ? '' : 'w-0 border-r-0 opacity-0'}`}>
          <div className={`flex min-w-[252px] flex-1 flex-col overflow-hidden ${sideOpen ? '' : 'hidden'}`}>
            {sidePanel === 'explorer' && (
              <FileExplorer
                files={library}
                activePath={activeTabObj?.path}
                onOpen={openFile}
                onRefresh={refreshLibrary}
                onToast={toast}
              />
            )}
            {sidePanel === 'terminology' && (
              <TerminologyPanel
                usedCodes={usedCodes}
                onInsert={(c) => editorRef.current?.insert(`"${c.code}"`)}
              />
            )}
            {sidePanel === 'timeline' && <TimelinePanel code={code} />}
          </div>
        </aside>

        {/* workbench */}
        <main className="flex min-w-0 flex-1 flex-col">
          {/* tab strip */}
          <div className="flex h-[34px] shrink-0 items-stretch overflow-x-auto border-b border-cyan-400/15 bg-helix-deep" role="tablist" aria-label="Open modules">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={`flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-white/[0.04] border-b-2 px-3 font-mono text-xs select-none ${
                  t.id === activeTab
                    ? 'border-b-helix-cyan bg-helix-surface text-helix-cyan'
                    : 'border-b-transparent text-helix-dim hover:bg-cyan-400/5 hover:text-helix-text'
                }`}
                onClick={() => switchTab(t)}
                role="tab"
                aria-selected={t.id === activeTab}
              >
                {t.dirty && <span className="h-1.5 w-1.5 rounded-full bg-helix-warn" title="Unsaved changes" />}
                {t.name}
                {tabs.length > 1 && (
                  <span
                    className="flex rounded p-px opacity-50 hover:bg-rose-500/20 hover:opacity-100"
                    onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                    role="button"
                    aria-label={`Close ${t.name}`}
                  >
                    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </span>
                )}
              </div>
            ))}
          </div>

          {/* sample bar */}
          <div className="flex shrink-0 items-center gap-2 border-b border-cyan-400/15 bg-helix-surface px-3 py-1.5">
            <span className="text-[10px] uppercase tracking-[1.2px] text-helix-dim">Samples</span>
            <select
              className="field cursor-pointer text-xs"
              value={sampleKey}
              onChange={(e) => loadSample(e.target.value)}
              aria-label="Load sample rule"
            >
              <option value="">— load a sample —</option>
              {Object.entries(SAMPLE_LABELS).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
            <div className="flex-1" />
            <button className="btn" onClick={saveActive} title="Save active module (Ctrl+S)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></svg>
              Save
            </button>
            <button className="btn" onClick={() => setFindOpen((f) => !f)} title="Find / Replace (Ctrl+F)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              Find
            </button>
          </div>

          {/* editor */}
          <Editor
            code={code}
            onChange={setCode}
            diagnostics={diagnostics}
            jumpRequest={jumpRequest}
            onCursor={setCursor}
            findOpen={findOpen}
            onCloseFind={() => setFindOpen(false)}
            editorRef={editorRef}
          />

          {/* resizer */}
          <div
            className="h-1 shrink-0 cursor-row-resize bg-cyan-400/15 transition-colors hover:bg-helix-cyan"
            title="Drag to resize panels"
            onMouseDown={(e) => {
              e.preventDefault();
              const panel = e.currentTarget.parentElement.querySelector('[data-bottom-panel]');
              const startY = e.clientY;
              const startH = panel.getBoundingClientRect().height;
              const move = (ev) => {
                const h = Math.min(Math.max(startH - (ev.clientY - startY), 100), window.innerHeight - 260);
                panel.style.height = h + 'px';
              };
              const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
              window.addEventListener('mousemove', move);
              window.addEventListener('mouseup', up);
            }}
          />

          {/* bottom panel */}
          <section data-bottom-panel className="flex h-[260px] shrink-0 flex-col overflow-hidden border-t border-cyan-400/15 bg-helix-surface">
            <div className="flex h-[30px] shrink-0 items-center gap-0.5 border-b border-cyan-400/15 px-2">
              {TAB_VIEWS.map((v) => (
                <div
                  key={v.id}
                  className={`flex h-full cursor-pointer items-center gap-1.5 border-b-2 px-3 text-[11px] font-semibold uppercase tracking-wider select-none ${
                    bottomView === v.id ? 'border-b-helix-cyan text-helix-cyan' : 'border-b-transparent text-helix-dim hover:text-helix-text'
                  }`}
                  onClick={() => setBottomView(v.id)}
                  role="tab"
                  aria-selected={bottomView === v.id}
                >
                  {v.label}
                  {v.id === 'tokens' && (
                    <span className={`rounded-full px-1.5 py-px text-[9px] font-bold ${report?.stats.tokens ? 'bg-white/5 text-helix-muted' : 'bg-emerald-400/10 text-helix-ok'}`}>
                      {report?.stats.tokens || 0}
                    </span>
                  )}
                  {v.id === 'diagnostics' && (
                    <span className={`rounded-full px-1.5 py-px text-[9px] font-bold ${errorCount ? 'bg-rose-500/15 text-helix-err' : 'bg-emerald-400/10 text-helix-ok'}`}>
                      {diagnostics.length}
                    </span>
                  )}
                </div>
              ))}
              <div className="flex-1" />
              <button
                className={`btn btn-icon ${sandboxOpen ? 'border-helix-cyan bg-cyan-400/10' : ''}`}
                onClick={() => setSandboxOpen((s) => !s)}
                title="Toggle FHIR Sandbox (Ctrl+J)"
                aria-label="Toggle sandbox"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" /></svg>
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              {bottomView === 'tokens' && <TokensView tokens={report?.tokens || []} onJump={jumpTo} />}
              {bottomView === 'ast' && <div className="h-full overflow-auto"><AstView ast={ast} /></div>}
              {bottomView === 'diagnostics' && <DiagnosticsView report={report} code={code} diagnostics={diagnostics} onJump={jumpTo} />}
              {bottomView === 'console' && <div className="h-full overflow-auto"><ConsoleView lines={consoleLines} /></div>}
            </div>
          </section>
        </main>

        {/* sandbox */}
        {sandboxOpen && (
          <Sandbox code={code} tokens={report?.tokens || []} onClose={() => setSandboxOpen(false)} onLog={(entries) => {
            const time = new Date().toTimeString().slice(0, 8);
            setConsoleLines((ls) => [...ls, ...entries.map((e) => ({ time, level: e.level, text: e.text }))].slice(-300));
          }} />
        )}
      </div>

      {/* status bar */}
      <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-cyan-400/15 bg-helix-deep px-3 font-mono text-[11px] text-helix-muted">
        <span className="max-w-60 overflow-hidden text-ellipsis whitespace-nowrap" title={activeTabObj?.name}>
          {activeTabObj?.name || 'untitled.helix'}{activeTabObj?.dirty ? ' •' : ''}
        </span>
        <span>Ln {cursor.line}, Col {cursor.col}</span>
        {report && <span>{report.stats.tokens} tokens · {report.stats.rules} rule(s)</span>}
        <span className="flex-1" />
        <span style={{ color: meta.urgency === 'HIGH' ? '#F87171' : meta.urgency === 'MEDIUM' ? '#FBBF24' : '#00F2FE' }}>
          URGENCY: {meta.urgency}
        </span>
        <span className={`flex cursor-pointer items-center gap-1.5 ${conn === 'online' ? 'text-helix-ok' : 'text-helix-err'}`} onClick={refreshLibrary} role="status" aria-live="polite" title="Click to re-check">
          <span className={`h-1.5 w-1.5 rounded-full ${conn === 'online' ? 'bg-helix-ok shadow-[0_0_7px_#34D399]' : 'bg-helix-err shadow-[0_0_7px_#F87171] pulse'}`} />
          {conn === 'online' ? 'analyzer online' : 'analyzer offline'}
        </span>
      </footer>

      {/* toasts */}
      <div className="pointer-events-none fixed right-5 bottom-10 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`max-w-sm rounded-lg border bg-helix-surface2 px-4 py-2.5 text-xs shadow-[0_10px_34px_rgba(0,0,0,0.55)] ${
              t.kind === 'error' ? 'border-rose-500/50' : 'border-cyan-400/50'
            }`}
            role="status"
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
