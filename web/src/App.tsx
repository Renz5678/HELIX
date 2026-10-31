import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import {
  Dna,
  FileCode2,
  FolderOpen,
  Save,
  Play,
  Activity,
  Settings2,
  ChevronDown,
  ChevronRight,
  Files,
  BookOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  CheckCircle2,
  AlertCircle,
  Terminal,
  Search,
  Database,
  Zap,
} from "lucide-react";
import { presets } from "./presets";
import { EngineClient } from "./services/engine";
import {
  loadWorkspace,
  saveWorkspace,
  validateDataset,
  download,
} from "./services/data";
import { byteOffsetToPosition } from "./services/positions";
import { register } from "./editor/language";
import type {
  Analysis,
  Dataset,
  Diagnostic,
  Evaluation,
} from "./services/types";
import DataPlayground from "./components/DataPlayground";
import grammar from "../../docs/grammar.md?raw";
(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};
loader.config({ monaco });
const initial = loadWorkspace();
const tabs = [
  "Problems",
  "Tokens",
  "Evaluation Results",
  "Output",
  "Grammar",
] as const;
type Tab = (typeof tabs)[number];
export default function App() {
  const [workspace, setWorkspace] = useState(initial.workspace),
    [storageWarning, setStorageWarning] = useState(initial.warning ?? "");
  const [state, setState] = useState("Loading engine"),
    [engineError, setEngineError] = useState(""),
    [analysis, setAnalysis] = useState<Analysis | null>(null),
    [evaluation, setEvaluation] = useState<Evaluation | null>(null),
    [tab, setTab] = useState<Tab>("Problems"),
    [settings, setSettings] = useState(false),
    [showData, setShowData] = useState(true),
    [showSidebar, setShowSidebar] = useState(()=>window.innerWidth>900),
    [cursor, setCursor] = useState({ lineNumber: 1, column: 1 }),
    [tokenSearch, setTokenSearch] = useState(""),
    [logs, setLogs] = useState<string[]>([]),
    [draftErrors, setDraftErrors] = useState<Record<string, string>>({}),
    [evalRevision, setEvalRevision] = useState(-1),
    [ready, setReady] = useState(false);
  const [dataFocus,setDataFocus]=useState<{tableName:string;rowIndex:number;columnName:string}>();
  const engine = useRef<EngineClient | null>(null),
    editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null),
    completion = useRef<monaco.IDisposable | null>(null),
    cursorListener = useRef<monaco.IDisposable | null>(null),
    revision = useRef(0),
    analysisId = useRef(0),
    baseline = useRef(workspace.source),
    fileInput = useRef<HTMLInputElement>(null),
    current = useRef(workspace);
  current.current = workspace;
  const dataErrors = validateDataset(workspace.dataset),
    errors = [...dataErrors, ...Object.values(draftErrors)];
  const diagnostics: Diagnostic[] = [
    ...(analysis?.diagnostics ?? []),
    ...(evaluation && evalRevision === revision.current
      ? evaluation.diagnostics
      : []),
  ];
  const dirty = workspace.source !== baseline.current,
    stale = evaluation !== null && evalRevision !== revision.current;
  function log(message: string) {
    setLogs((old) =>
      [`${new Date().toLocaleTimeString()}  ${message}`, ...old].slice(0, 100),
    );
  }
  function connect() {
    engine.current?.dispose();
    setReady(false);
    setState("Loading engine");
    setEngineError("");
    const client = new EngineClient();
    engine.current = client;
    void client.ready
      .then(() => {
        if (engine.current !== client) return;
        setReady(true);
        setState("Ready");
        log("C11 / WebAssembly engine initialized");
      })
      .catch((e) => {
        if (engine.current !== client) return;
        setState("Engine Error");
        setEngineError(String(e));
      });
  }
  useEffect(() => {
    connect();
    return () => {
      engine.current?.dispose();
      completion.current?.dispose();
      cursorListener.current?.dispose();
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      const warning = saveWorkspace(workspace);
      setStorageWarning(warning);
    }, 300);
    return () => clearTimeout(timer);
  }, [workspace]);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  const analyze = useCallback(async () => {
    if (!engine.current || !ready) return;
    const id = ++analysisId.current,
      source = current.current.source;
    setState("Analyzing");
    const start = performance.now();
    try {
      const result = await engine.current.request("analyze", source);
      if (id !== analysisId.current || source !== current.current.source)
        return;
      setAnalysis(result);
      setState(result.success ? "Valid" : "Invalid");
      log(
        `Analysis ${result.success ? "passed" : "failed"} · ${result.tokenCount} tokens · ${(performance.now() - start).toFixed(1)} ms`,
      );
    } catch (e) {
      if (String(e).includes("Superseded") || id !== analysisId.current) return;
      setState("Engine Error");
      setEngineError(String(e));
    }
  }, [ready]);
  useEffect(() => {
    if (workspace.autoAnalyze && ready) {
      const timer = setTimeout(() => void analyze(), 350);
      return () => clearTimeout(timer);
    }
  }, [workspace.source, workspace.autoAnalyze, ready, analyze]);
  useEffect(() => {
    const model = editor.current?.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      "helix",
      diagnostics
        .filter((d) => d.startOffset !== undefined)
        .map((d) => {
          const start = byteOffsetToPosition(workspace.source, d.startOffset!),
            end = byteOffsetToPosition(
              workspace.source,
              d.endOffset ?? d.startOffset! + 1,
            );
          return {
            startLineNumber: start.lineNumber,
            startColumn: start.column,
            endLineNumber: end.lineNumber,
            endColumn: Math.max(
              end.column,
              start.lineNumber === end.lineNumber ? start.column + 1 : 1,
            ),
            severity:
              d.severity === "error"
                ? monaco.MarkerSeverity.Error
                : monaco.MarkerSeverity.Warning,
            message: d.message,
            code: d.code,
          };
        }),
    );
  }, [analysis, evaluation, workspace.source, evalRevision]);
  function sourceChanged(source: string) {
    revision.current++;
    analysisId.current++;
    setAnalysis(null);
    setWorkspace((w) => ({ ...w, source }));
    setState(ready ? "Ready" : state);
  }
  function setDataset(dataset: Dataset) {
    revision.current++;
    if(ready)setState("Ready");
    setWorkspace((w) => ({ ...w, dataset }));
  }
  const setDraftError = useCallback(
    (id: string, error: string) =>
      setDraftErrors((old) => {
        if (old[id] === error || (!old[id] && !error)) return old;
        const next = { ...old };
        if (error) next[id] = error;
        else delete next[id];
        return next;
      }),
    [],
  );
  async function evaluate() {
    if (!engine.current || !ready || errors.length) return;
    const rev = revision.current,
      source = workspace.source,
      data = structuredClone(workspace.dataset);
    setState("Evaluating");
    setTab("Evaluation Results");
    const start = performance.now();
    try {
      const result = await engine.current.request("evaluate", source, data);
      if (rev !== revision.current) {setState(ready?"Ready":"Loading engine");return;}
      setEvaluation(result);
      setEvalRevision(rev);
      setState(result.success ? "Valid" : "Invalid");
      log(
        `Evaluation ${result.success ? "completed" : "failed"} · ${result.results.length} patient results · ${(performance.now() - start).toFixed(1)} ms`,
      );
    } catch (e) {
      setState("Engine Error");
      setEngineError(String(e));
    }
  }
  function navigate(d: Diagnostic) {
    if (d.startOffset === undefined) {
      setShowData(true);
      if(d.tableName&&d.rowIndex!==undefined&&d.columnName)setDataFocus({tableName:d.tableName,rowIndex:d.rowIndex,columnName:d.columnName});
      return;
    }
    const position = byteOffsetToPosition(workspace.source, d.startOffset);
    editor.current?.setPosition(position);
    editor.current?.revealPositionInCenter(position);
    editor.current?.focus();
  }
  function replaceFile(
    source: string,
    filename: string,
    dataset = workspace.dataset,
  ) {
    if (dirty && !confirm("Discard unsaved source changes?")) return;
    revision.current++;
    analysisId.current++;
    baseline.current = source;
    setWorkspace((w) => ({
      ...w,
      source,
      filename,
      dataset: structuredClone(dataset),
    }));
    setAnalysis(null);
    setEvaluation(null);
    setDraftErrors({});
    if(window.innerWidth<=900)setShowSidebar(false);
    setTab("Problems");
    log(`Opened ${filename}`);
  }
  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  return (
    <div className="studio">
      <header className="app-header">
        <button
          className="brand"
          aria-label="Toggle explorer"
          onClick={() => setShowSidebar(!showSidebar)}
        >
          <Dna size={28} />
          <span>
            <b>HELIX</b> Studio
          </span>
          <span className="version">1.0</span>
        </button>
        <div className="header-file">
          <FileCode2 size={14} />
          {workspace.filename}
          {dirty && (
            <span title="Unsaved source changes" className="dirty-dot" />
          )}
        </div>
        <nav aria-label="File and engine actions">
          <button
            title="New file"
            onClick={() =>
              replaceFile(
                "rule NewRule:\n    source glucose_data\nend\n",
                "untitled.helix",
              )
            }
          >
            <Plus size={15} />
            <span>New</span>
          </button>
          <button aria-label="Open" onClick={() => fileInput.current?.click()}>
            <FolderOpen size={15} />
            <span>Open</span>
          </button>
          <button
            aria-label="Save"
            onClick={() => {
              download(workspace.filename, workspace.source);
              baseline.current = workspace.source;
              setWorkspace((w) => ({ ...w }));
              log("Source downloaded");
            }}
          >
            <Save size={15} />
            <span>Save</span>
          </button>
          <span className="toolbar-divider" />
          <button
            className="primary"
            disabled={!ready}
            onClick={() => void analyze()}
          >
            <Activity size={15} />
            Analyze
          </button>
          <button
            className="evaluate"
            disabled={!ready || !!errors.length}
            title={errors[0] ?? "Evaluate rules using the table snapshot"}
            onClick={() => void evaluate()}
          >
            <Play size={14} fill="currentColor" />
            Evaluate
          </button>
          <button
            aria-label="Settings"
            aria-expanded={settings}
            onClick={() => setSettings(!settings)}
          >
            <Settings2 size={17} />
          </button>
        </nav>
        <input
          ref={fileInput}
          hidden
          type="file"
          accept=".helix,.txt"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file)
              replaceFile(
                (await file.text()).replace(/\r\n?/g, "\n"),
                file.name,
              );
            e.target.value = "";
          }}
        />
        {settings && (
          <div className="settings-popover">
            <h3>Editor settings</h3>
            <label>
              <input
                type="checkbox"
                checked={workspace.autoAnalyze}
                onChange={(e) =>
                  setWorkspace((w) => ({ ...w, autoAnalyze: e.target.checked }))
                }
              />
              Automatic analysis · 350 ms
            </label>
            <label>
              Font size{" "}
              <input
                aria-label="Editor font size"
                type="number"
                min="10"
                max="24"
                value={workspace.fontSize}
                onChange={(e) =>
                  setWorkspace((w) => ({
                    ...w,
                    fontSize: Math.min(24, Math.max(10, +e.target.value)),
                  }))
                }
              />
            </label>
            <p>Your workspace is stored in this browser.</p>
          </div>
        )}
      </header>
      {storageWarning && (
        <div className="warning-strip" role="status">
          {storageWarning}
        </div>
      )}
      {engineError && (
        <div className="error-strip" role="alert">
          {engineError}
          <button onClick={connect}>Retry engine</button>
        </div>
      )}
      <div
        className={`workspace ${showSidebar ? "" : "sidebar-hidden"} ${showData ? "" : "data-hidden"}`}
      >
        {showSidebar && (
          <aside className="sidebar">
            <div className="section-heading">
              <div>
                <Files size={15} />
                <strong>Explorer</strong>
              </div>
              <button
                className="icon-button"
                aria-label="Collapse explorer"
                onClick={() => setShowSidebar(false)}
              >
                <ChevronDown size={14} />
              </button>
            </div>
            <div className="explorer-title">
              <ChevronDown size={12} />
              Current file
            </div>
            <button
              className="file-item"
              onClick={() => editor.current?.focus()}
            >
              <FileCode2 size={15} />
              {workspace.filename}
            </button>
            <div className="explorer-title">
              <ChevronDown size={12} />
              Example programs
            </div>
            <div className="examples">
              {presets.map((preset, i) => (
                <button
                  key={preset.name}
                  className={
                    workspace.filename === preset.filename ? "selected" : ""
                  }
                  onClick={() =>
                    replaceFile(preset.source, preset.filename, preset.dataset)
                  }
                >
                  <span className="example-number">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span>
                    <strong>{preset.name}</strong>
                    <small>{preset.description}</small>
                  </span>
                  <ChevronRight size={12} />
                </button>
              ))}
            </div>
            <div className="sidebar-bottom">
              <div className="quick-stats">
                <span>
                  Tokens<strong>{analysis?.tokenCount ?? "—"}</strong>
                </span>
                <span>
                  Problems
                  <strong className={errorCount ? "error-text" : ""}>
                    {errorCount}
                  </strong>
                </span>
              </div>
              <button
                className="reference-button"
                onClick={() => setTab("Grammar")}
              >
                <BookOpen size={15} />
                Language reference
                <ChevronRight size={13} />
              </button>
              <div className="engine-note">
                <Zap size={14} />
                <span>
                  One language. One engine.
                  <small>ISO C11 compiled to WebAssembly</small>
                </span>
              </div>
            </div>
          </aside>
        )}
        <main className="editor-column">
          <div className="editor-tabs">
            <div className="active-file">
              <FileCode2 size={14} />
              {workspace.filename}
              {dirty && <span className="dirty-dot" />}
            </div>
            <span className="editor-path">examples / {workspace.filename}</span>
            <button
              aria-label={
                showData ? "Hide Data Playground" : "Show Data Playground"
              }
              onClick={() => setShowData(!showData)}
            >
              {showData ? (
                <PanelRightClose size={16} />
              ) : (
                <PanelRightOpen size={16} />
              )}
            </button>
          </div>
          <div className="editor-breadcrumb">
            HELIX <ChevronRight size={11} />
            Rules <ChevronRight size={11} />
            <span>{workspace.filename.replace(".helix", "")}</span>
            <span className="language-tag">.helix</span>
          </div>
          <div className="code-editor">
            <Editor
              language="helix"
              theme="helix-dark"
              value={workspace.source}
              beforeMount={(m) => {
                completion.current?.dispose();
                completion.current = register(m, () =>
                  current.current.dataset.tables.map((t) => t.name),
                );
              }}
              onMount={(e) => {
                editor.current = e;
                cursorListener.current = e.onDidChangeCursorPosition((event) =>
                  setCursor(event.position),
                );
              }}
              onChange={(value) => {
                if (value !== undefined && value !== workspace.source)
                  sourceChanged(value);
              }}
              options={{
                fontSize: workspace.fontSize,
                fontFamily: '"JetBrains Mono", "Cascadia Code", monospace',
                minimap: { enabled: false },
                padding: { top: 14, bottom: 14 },
                lineNumbersMinChars: 3,
                scrollBeyondLastLine: false,
                automaticLayout: true,
                wordWrap: "on",
                renderLineHighlight: "line",
                tabSize: 4,
                overviewRulerBorder: false,
              }}
              loading={<div className="empty-state">Loading editor…</div>}
            />
          </div>
          <section
            className="bottom-panel"
            aria-label="Analysis and evaluation panels"
          >
            <div className="panel-tabs" role="tablist">
              {tabs.map((t) => (
                <button
                  key={t}
                  role="tab"
                  id={`tab-${t.replaceAll(' ','-')}`}
                  aria-controls="inspection-panel"
                  tabIndex={tab===t?0:-1}
                  onKeyDown={event=>{
                    const at=tabs.indexOf(t);let next=at;
                    if(event.key==='ArrowRight')next=(at+1)%tabs.length;
                    else if(event.key==='ArrowLeft')next=(at+tabs.length-1)%tabs.length;
                    else if(event.key==='Home')next=0;
                    else if(event.key==='End')next=tabs.length-1;
                    else return;
                    event.preventDefault();setTab(tabs[next]);
                    document.getElementById(`tab-${tabs[next].replaceAll(' ','-')}`)?.focus();
                  }}
                  aria-selected={tab === t}
                  className={tab === t ? "active" : ""}
                  onClick={() => setTab(t)}
                >
                  {t}
                  {t === "Problems" && (
                    <span className={`count ${errorCount ? "has-errors" : ""}`}>
                      {diagnostics.length}
                    </span>
                  )}
                  {t === "Evaluation Results" && evaluation && (
                    <span className="count">{evaluation.results.length}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="panel-content" id="inspection-panel" role="tabpanel" aria-labelledby={`tab-${tab.replaceAll(' ','-')}`}>
              {tab === "Problems" &&
                (diagnostics.length ? (
                  <div className="problem-list">
                    {diagnostics.map((d, i) => (
                      <button
                        key={i}
                        className="problem-row"
                        onClick={() => navigate(d)}
                      >
                        <AlertCircle size={14} />
                        <span className="small-tag">{d.category}</span>
                        <span>{d.message}</span>
                        <code>
                          {d.line ? `Ln ${d.line}, Col ${d.column}` : d.code}
                        </code>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <CheckCircle2 size={23} />
                    <strong>
                      {analysis?.success
                        ? "No problems found"
                        : "Ready for analysis"}
                    </strong>
                    <p>
                      {analysis?.success
                        ? "Your HELIX syntax is valid. Evaluation checks bindings and data."
                        : "Analyze your program to see C-engine diagnostics."}
                    </p>
                  </div>
                ))}
              {tab === "Tokens" && (
                <>
                  <div className="token-toolbar">
                    <Search size={14} />
                    <input
                      aria-label="Search tokens"
                      placeholder="Filter lexeme, type or category…"
                      value={tokenSearch}
                      onChange={(e) => setTokenSearch(e.target.value)}
                    />
                    <span>{analysis?.tokenCount ?? 0} tokens</span>
                  </div>
                  <div className="token-scroll">
                    <table className="token-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Lexeme</th>
                          <th>Token type</th>
                          <th>Line</th>
                          <th>Column</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analysis?.tokens
                          .filter((t) =>
                            `${t.lexeme} ${t.type} ${t.category}`
                              .toLowerCase()
                              .includes(tokenSearch.toLowerCase()),
                          )
                          .map((t) => (
                            <tr
                              key={t.index}
                              onClick={() =>
                                navigate({
                                  severity: "info",
                                  category: "token",
                                  code: t.type,
                                  message: t.lexeme,
                                  startOffset: t.startOffset,
                                })
                              }
                            >
                              <td>{t.index}</td>
                              <td>
                                <code>{t.lexeme || "EOF"}</code>
                              </td>
                              <td className="muted">{t.type}</td>
                              <td>{t.line}</td>
                              <td>{t.column}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              {tab === "Evaluation Results" && (
                <>
                  <div className="simulation-disclaimer">
                    Simulated Rule Output — Not for Clinical Use
                  </div>
                  {stale && (
                    <div className="warning-strip">
                      Results are from an earlier source or data snapshot.
                      Evaluate again.
                    </div>
                  )}
                  {evaluation ? (
                    <>
                      <div className="evaluation-summary">
                        <strong>
                          {evaluation.results.length} patient results
                        </strong>
                        <span>{evaluation.evaluationTime}</span>
                        <span>
                          {evaluation.success
                            ? "Evaluation complete"
                            : "Evaluation has errors"}
                        </span>
                      </div>
                      {evaluation.diagnostics.map((d, i) => (
                        <button
                          key={i}
                          className="problem-row"
                          onClick={() => navigate(d)}
                        >
                          <AlertCircle size={14} />
                          {d.message}
                        </button>
                      ))}
                      {evaluation.results.map((r) => (
                        <details
                          className="patient-result"
                          key={`${r.ruleId}/${r.patientId}`}
                          open
                        >
                          <summary>
                            <span className="patient-id">{r.patientId}</span>
                            <span>{r.ruleName}</span>
                            <span className="result-badges">
                              {r.conditions.map((c) => (
                                <b
                                  key={c.conditionId}
                                  className={`outcome ${c.outcome.toLowerCase()}`}
                                >
                                  {c.outcome}
                                </b>
                              ))}
                            </span>
                          </summary>
                          {r.conditions.map((c) => (
                            <div
                              className="condition-trace"
                              key={c.conditionId}
                            >
                              <button
                                className="condition-text"
                                onClick={() =>
                                  navigate({
                                    severity: "info",
                                    category: "condition",
                                    code: c.conditionId,
                                    message: c.conditionText,
                                    startOffset: c.startOffset,
                                  })
                                }
                              >
                                {c.conditionText}
                              </button>
                              {c.resolvedValues.map((v, i) => (
                                <div className="resolved-value" key={i}>
                                  <code>{v.expression}</code>
                                  <b>
                                    {v.value === null
                                      ? "MISSING"
                                      : String(v.value)}
                                  </b>
                                  <span>
                                    {v.table}.{v.column} ·{" "}
                                    {v.rowIndex === null
                                      ? "no eligible row"
                                      : `row ${v.rowIndex + 1}`}
                                  </span>
                                  {v.reason && <small>{v.reason}</small>}
                                </div>
                              ))}
                            </div>
                          ))}
                          {r.actions.map((a, i) => (
                            <div
                              key={i}
                              className={`action-event ${a.kind} ${a.severity?.toLowerCase() ?? ""}`}
                            >
                              {a.kind === "alert" ? (
                                <>
                                  <AlertCircle size={14} />
                                  <strong>{a.severity}</strong>
                                  <span>{a.message}</span>
                                  {!!a.payload?.length && (
                                    <code>{JSON.stringify(a.payload)}</code>
                                  )}
                                </>
                              ) : (
                                <>
                                  <span>Simulated suppression</span>
                                  <code>
                                    {a.durationMs
                                      ? `${a.durationMs / 60000} minutes`
                                      : a.reason}
                                  </code>
                                </>
                              )}
                            </div>
                          ))}
                          {!r.actions.length && (
                            <p className="no-action">No action triggered</p>
                          )}
                        </details>
                      ))}
                    </>
                  ) : (
                    <div className="empty-state">
                      <Play size={22} />
                      <strong>Evaluate against your data</strong>
                      <p>
                        Run rules for each patient at the selected timestamp.
                      </p>
                    </div>
                  )}
                </>
              )}
              {tab === "Output" && (
                <div className="output-log">
                  <div>
                    <Terminal size={14} /> Engine output
                  </div>
                  {logs.length ? (
                    logs.map((line, i) => <p key={i}>{line}</p>)
                  ) : (
                    <p>No execution output yet.</p>
                  )}
                </div>
              )}
              {tab === "Grammar" && (
                <div className="grammar-reference">
                  <div className="grammar-links">
                    {[
                      "Reserved Words",
                      "Expressions",
                      "Declarations",
                      "Actions",
                    ].map((s) => (
                      <button
                        key={s}
                        onClick={() => {
                          const area = document.querySelector(".grammar-text");
                          if (area) {
                            const match =
                              s === "Reserved Words"
                                ? "Reserved Words"
                                : s === "Expressions"
                                  ? "expression"
                                  : s === "Declarations"
                                    ? "Declarations"
                                    : "Actions";
                            const at = grammar.indexOf(match);
                            area.scrollTop = Math.max(
                              0,
                              grammar.slice(0, at).split("\n").length * 18 - 40,
                            );
                          }
                        }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                  <pre className="grammar-text">{grammar}</pre>
                </div>
              )}
            </div>
          </section>
        </main>
        {showData && (
          <DataPlayground
            dataset={workspace.dataset}
            setDataset={setDataset}
            setDraftError={setDraftError}
          focusCell={dataFocus}
          />
        )}
      </div>
      {errors.length > 0 && (
        <div className="data-validation" role="alert">
          <Database size={14} />
          <strong>Dataset needs attention:</strong>
          <span>
            {errors[0]}
            {errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}
          </span>
        </div>
      )}
      <footer className="status-bar">
        <span>
          <span
            className={`status-dot ${state === "Engine Error" ? "failed" : ""}`}
          />
          {state}
        </span>
        <span>
          {errorCount ? <AlertCircle size={12} /> : <CheckCircle2 size={12} />}{" "}
          {errorCount} errors
        </span>
        <span className="status-spacer" />
        <span>
          Ln {cursor.lineNumber}, Col {cursor.column}
        </span>
        <span>UTF-8</span>
        <span>HELIX DSL</span>
        <span className="engine-status">
          <Zap size={12} />
          {ready ? "C11 / WASM Engine Active" : "Engine unavailable"}
        </span>
      </footer>
    </div>
  );
}
