import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/editor/edcore.main.js";
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
  Database,
  Zap,
} from "lucide-react";
import { presets } from "./presets";
import { loadWorkspace, saveWorkspace, download } from "./services/data";
import { byteOffsetToPosition } from "./services/positions";
import { registerHelixLanguage } from "./editor/language";
import { HelixIntelliSense } from "./editor/intellisense/engine";
import type { HelixLanguageHost } from "./editor/intellisense/types";
import type { Dataset, Diagnostic } from "./services/types";
import DataPlayground from "./components/DataPlayground";
import InspectionPanel, {
  type InspectionTab,
} from "./components/InspectionPanel";
import { useStudioEngine } from "./hooks/useStudioEngine";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};
loader.config({ monaco });
const initial = loadWorkspace();

export default function App() {
  const [workspace, setWorkspace] = useState(initial.workspace),
    [storageWarning, setStorageWarning] = useState(initial.warning ?? ""),
    [tab, setTab] = useState<InspectionTab>("Problems"),
    [settings, setSettings] = useState(false),
    [showData, setShowData] = useState(true),
    [showSidebar, setShowSidebar] = useState(() => window.innerWidth > 900),
    [cursor, setCursor] = useState({ lineNumber: 1, column: 1 }),
    [draftErrors, setDraftErrors] = useState<Record<string, string>>({}),
    [fileEpoch, setFileEpoch] = useState(0),
    [dataFocus, setDataFocus] = useState<{
      tableName: string;
      rowIndex: number;
      columnName: string;
    }>();

  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null),
    completion = useRef<monaco.IDisposable | null>(null),
    cursorListener = useRef<monaco.IDisposable | null>(null),
    intellisenseRef = useRef<HelixIntelliSense | null>(null),
    baseline = useRef(workspace.source),
    fileInput = useRef<HTMLInputElement>(null),
    current = useRef(workspace);

  if (!intellisenseRef.current) {
    intellisenseRef.current = new HelixIntelliSense();
  }
  const intellisense = intellisenseRef.current;
  current.current = workspace;

  const openEvaluationTab = useCallback(() => setTab("Evaluation Results"), []);

  const studio = useStudioEngine({
    workspace,
    draftErrors,
    editorRef: editor,
    onEvaluationStart: openEvaluationTab,
  });

  const dirty = workspace.source !== baseline.current;
  const model = editor.current?.getModel();
  const activeRule = useMemo(
    () =>
      intellisense.getActiveRuleName(
        model ? model.uri.toString() : "helix://studio/editor",
        model ? model.getVersionId() : studio.revision.current,
        workspace.source,
        workspace.dataset,
        cursor,
      ),
    [intellisense, model, studio.revision, workspace.source, workspace.dataset, cursor],
  );

  useEffect(() => {
    return () => {
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

  function sourceChanged(source: string) {
    studio.onSourceChanged();
    setWorkspace((w) => ({ ...w, source }));
  }

  function setDataset(dataset: Dataset) {
    studio.onDatasetChanged(dataset);
    setWorkspace((w) => ({ ...w, dataset }));
  }

  const setDraftError = useCallback((id: string, error: string) => {
    setDraftErrors((old) => {
      if (old[id] === error || (!old[id] && !error)) return old;
      const next = { ...old };
      if (error) next[id] = error;
      else delete next[id];
      return next;
    });
  }, []);

  function navigate(d: Diagnostic, snapshotSource = workspace.source) {
    if (d.startOffset === undefined) {
      setShowData(true);
      if (d.tableName && d.rowIndex !== undefined && d.columnName)
        setDataFocus({
          tableName: d.tableName,
          rowIndex: d.rowIndex,
          columnName: d.columnName,
        });
      return;
    }
    const position = byteOffsetToPosition(snapshotSource, d.startOffset);
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
    baseline.current = source;
    studio.onFileReplaced();
    setWorkspace((w) => ({
      ...w,
      source,
      filename,
      dataset: structuredClone(dataset),
    }));
    setDraftErrors({});
    setFileEpoch((n) => n + 1);
    if (window.innerWidth <= 900) setShowSidebar(false);
    setTab("Problems");
    studio.log(`Opened ${filename}`);
  }

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
                "rule NewRule:\n    source glucose_data\nend rule\n",
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
              studio.log("Source downloaded");
            }}
          >
            <Save size={15} />
            <span>Save</span>
          </button>
          <span className="toolbar-divider" />
          <button
            className="primary"
            disabled={!studio.ready}
            onClick={() => void studio.analyze()}
          >
            <Activity size={15} />
            Analyze
          </button>
          <button
            className="evaluate"
            disabled={!studio.ready || !!studio.errors.length}
            title={
              studio.errors[0] ?? "Evaluate rules using the table snapshot"
            }
            onClick={() => void studio.evaluate()}
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
              Automatic analysis · 180 ms
            </label>
            <label>
              <input
                type="checkbox"
                checked={workspace.inlinePredictions ?? true}
                onChange={(e) =>
                  setWorkspace((w) => ({
                    ...w,
                    inlinePredictions: e.target.checked,
                  }))
                }
              />
              Inline predictions (ghost text)
            </label>
            <label>
              <input
                type="checkbox"
                checked={workspace.autoSuggest ?? true}
                onChange={(e) =>
                  setWorkspace((w) => ({
                    ...w,
                    autoSuggest: e.target.checked,
                  }))
                }
              />
              Auto-trigger suggestions
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
      {studio.engineError && (
        <div className="error-strip" role="alert">
          {studio.engineError}
          <button onClick={studio.connect}>Retry engine</button>
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
                  Tokens<strong>{studio.analysis?.tokenCount ?? "—"}</strong>
                </span>
                <span>
                  Problems
                  <strong className={studio.errorCount ? "error-text" : ""}>
                    {studio.errorCount}
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
            {activeRule && (
              <>
                <ChevronRight size={11} />
                <span className="breadcrumb-rule">{activeRule}</span>
              </>
            )}
            <span className="language-tag">.helix</span>
          </div>
          <div className="code-editor">
            <Editor
              language="helix"
              theme="helix-dark"
              value={workspace.source}
              beforeMount={(m) => {
                completion.current?.dispose();
                const host: HelixLanguageHost = {
                  getDataset: () => current.current.dataset,
                  getSettings: () => ({
                    inlinePredictions:
                      current.current.inlinePredictions ?? true,
                    autoSuggest: current.current.autoSuggest ?? true,
                  }),
                  getFilename: () => current.current.filename,
                };
                completion.current = registerHelixLanguage(
                  m,
                  host,
                  intellisense,
                );
              }}
              onMount={(e) => {
                editor.current = e;
                cursorListener.current?.dispose();
                cursorListener.current = e.onDidChangeCursorPosition((event) =>
                  setCursor(event.position),
                );
                const mountedModel = e.getModel();
                if (mountedModel) {
                  studio.syncMountedMarkers(mountedModel);
                }
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
                inlineSuggest: { enabled: workspace.inlinePredictions ?? true },
                quickSuggestions:
                  (workspace.autoSuggest ?? true)
                    ? { other: "on", comments: "off", strings: "on" }
                    : false,
                suggestOnTriggerCharacters: workspace.autoSuggest ?? true,
                parameterHints: { enabled: true },
                lightbulb: {
                  enabled: monaco.editor.ShowLightbulbIconMode.On,
                },
                suggest: { preview: true, showStatusBar: true },
              }}
              loading={<div className="empty-state">Loading editor…</div>}
            />
          </div>
          <InspectionPanel
            tab={tab}
            setTab={setTab}
            diagnosticEntries={studio.diagnosticEntries}
            diagnosticsCount={studio.diagnostics.length}
            errorCount={studio.errorCount}
            analysis={studio.analysis}
            analysisSource={studio.analysisSource}
            evaluation={studio.evaluation}
            evalSource={studio.evalSource}
            stale={studio.stale}
            logs={studio.logs}
            navigate={navigate}
          />
        </main>
        {showData && (
          <DataPlayground
            key={fileEpoch}
            dataset={workspace.dataset}
            setDataset={setDataset}
            setDraftError={setDraftError}
            focusCell={dataFocus}
          />
        )}
      </div>
      {studio.errors.length > 0 && (
        <div className="data-validation" role="alert">
          <Database size={14} />
          <strong>Dataset needs attention:</strong>
          <span>
            {studio.errors[0]}
            {studio.errors.length > 1
              ? ` (+${studio.errors.length - 1} more)`
              : ""}
          </span>
        </div>
      )}
      <footer className="status-bar">
        <span>
          <span
            className={`status-dot ${studio.state === "Engine Error" ? "failed" : ""}`}
          />
          {studio.state}
        </span>
        <span>
          {studio.errorCount ? (
            <AlertCircle size={12} />
          ) : (
            <CheckCircle2 size={12} />
          )}{" "}
          {studio.errorCount} errors
        </span>
        <span className="status-spacer" />
        <span>
          Ln {cursor.lineNumber}, Col {cursor.column}
        </span>
        <span>UTF-8</span>
        <span>HELIX DSL</span>
        <span className="engine-status">
          <Zap size={12} />
          {studio.ready ? "C11 / WASM Engine Active" : "Engine unavailable"}
        </span>
      </footer>
    </div>
  );
}
