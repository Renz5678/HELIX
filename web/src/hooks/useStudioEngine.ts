import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import { EngineClient } from "../services/engine";
import { validateDataset } from "../services/data";
import { byteOffsetToPosition } from "../services/positions";
import {
  combineDiagnosticEntries,
  getDatasetEditDiagnosticPatch,
  isEvaluationStale,
  isWithinBackgroundValidateLimit,
  resolveMarkerSync,
  shouldScheduleDatasetValidation,
  type DiagnosticEntry,
} from "../services/diagnostics";
import type {
  Analysis,
  Dataset,
  Diagnostic,
  Evaluation,
  Workspace,
} from "../services/types";

export function applyModelMarkers(
  model: monaco.editor.ITextModel,
  entries: DiagnosticEntry[],
) {
  monaco.editor.setModelMarkers(
    model,
    "helix",
    entries
      .filter(({ d }) => d.startOffset !== undefined)
      .map(({ d, source }) => {
        const start = byteOffsetToPosition(source, d.startOffset!),
          end = byteOffsetToPosition(
            source,
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
              : d.severity === "warning"
                ? monaco.MarkerSeverity.Warning
                : monaco.MarkerSeverity.Info,
          message: d.message,
          code: d.code,
        };
      }),
  );
}

export function useStudioEngine({
  workspace,
  draftErrors,
  editorRef,
  onEvaluationStart,
}: {
  workspace: Workspace;
  draftErrors: Record<string, string>;
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  onEvaluationStart: () => void;
}) {
  const [state, setState] = useState("Loading engine"),
    [engineError, setEngineError] = useState(""),
    [analysis, setAnalysis] = useState<Analysis | null>(null),
    [analysisSource, setAnalysisSource] = useState(""),
    [semanticDiagnostics, setSemanticDiagnostics] = useState<Diagnostic[]>([]),
    [semanticSource, setSemanticSource] = useState(""),
    [evaluation, setEvaluation] = useState<Evaluation | null>(null),
    [evalSource, setEvalSource] = useState(""),
    [logs, setLogs] = useState<string[]>([]),
    [evalRevision, setEvalRevision] = useState(-1),
    [ready, setReady] = useState(false);

  const engine = useRef<EngineClient | null>(null),
    revision = useRef(0),
    analysisId = useRef(0),
    validateId = useRef(0),
    current = useRef(workspace),
    draftErrorsRef = useRef(draftErrors),
    semanticSourceRef = useRef(semanticSource),
    lastValidatedDatasetRef = useRef<Dataset | null>(null);

  current.current = workspace;
  draftErrorsRef.current = draftErrors;
  semanticSourceRef.current = semanticSource;

  const dataErrors = useMemo(
    () => validateDataset(workspace.dataset),
    [workspace.dataset],
  );
  const dataErrorsRef = useRef(dataErrors);
  dataErrorsRef.current = dataErrors;

  const errors = useMemo(
    () => [...dataErrors, ...Object.values(draftErrors)],
    [dataErrors, draftErrors],
  );

  const isCurrentEval = evaluation !== null && evalRevision === revision.current;
  const diagnosticEntries = useMemo(
    () =>
      combineDiagnosticEntries(
        analysis,
        analysisSource,
        semanticDiagnostics,
        semanticSource,
        evaluation,
        evalSource,
        isCurrentEval,
      ),
    [
      analysis,
      analysisSource,
      semanticDiagnostics,
      semanticSource,
      evaluation,
      evalSource,
      isCurrentEval,
    ],
  );
  const diagnostics = useMemo(
    () => diagnosticEntries.map((entry) => entry.d),
    [diagnosticEntries],
  );
  const errorCount = useMemo(
    () => diagnostics.filter((d) => d.severity === "error").length,
    [diagnostics],
  );
  const latestDiagnosticEntriesRef = useRef(diagnosticEntries);
  latestDiagnosticEntriesRef.current = diagnosticEntries;

  const stale = isEvaluationStale(evaluation, evalRevision, revision.current);

  const log = useCallback((message: string) => {
    setLogs((old) =>
      [`${new Date().toLocaleTimeString()}  ${message}`, ...old].slice(0, 100),
    );
  }, []);

  const connect = useCallback(() => {
    engine.current?.dispose();
    lastValidatedDatasetRef.current = null;
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
  }, [log]);

  useEffect(() => {
    connect();
    return () => {
      engine.current?.dispose();
    };
  }, [connect]);

  const validate = useCallback(
    async (sourceSnapshot?: string) => {
      if (!engine.current || !ready) return;
      const source = sourceSnapshot ?? current.current.source;
      const dataset = current.current.dataset;
      if (
        dataErrorsRef.current.length > 0 ||
        Object.keys(draftErrorsRef.current).length > 0 ||
        !isWithinBackgroundValidateLimit(dataset)
      ) {
        lastValidatedDatasetRef.current = null;
        if (semanticSourceRef.current !== source) {
          setSemanticDiagnostics([]);
          setSemanticSource("");
        }
        return;
      }
      lastValidatedDatasetRef.current = dataset;
      const id = ++validateId.current;
      try {
        const result = await engine.current.request(
          "validate",
          source,
          structuredClone(dataset),
        );
        if (
          id !== validateId.current ||
          source !== current.current.source ||
          dataset !== current.current.dataset
        ) {
          return;
        }
        setSemanticDiagnostics(
          result.diagnostics.filter((d) => d.severity !== "info"),
        );
        setSemanticSource(source);
      } catch (e) {
        if (String(e).includes("Superseded") || id !== validateId.current)
          return;
        if (lastValidatedDatasetRef.current === dataset) {
          lastValidatedDatasetRef.current = null;
        }
        setSemanticDiagnostics([]);
        setSemanticSource("");
        setState("Engine Error");
        setEngineError(String(e));
      }
    },
    [ready],
  );

  const analyze = useCallback(async () => {
    if (!engine.current || !ready) return;
    const id = ++analysisId.current,
      source = current.current.source;
    setState("Analyzing");
    const start = performance.now();
    try {
      const result = await engine.current.request("analyze", source);
      if (id !== analysisId.current || source !== current.current.source) return;
      setAnalysis(result);
      setAnalysisSource(source);
      setState(result.success ? "Valid" : "Invalid");
      log(
        `Analysis ${result.success ? "passed" : "failed"} · ${result.tokenCount} tokens · ${(performance.now() - start).toFixed(1)} ms`,
      );
      if (
        result.success &&
        dataErrorsRef.current.length === 0 &&
        Object.keys(draftErrorsRef.current).length === 0 &&
        isWithinBackgroundValidateLimit(current.current.dataset)
      ) {
        void validate(source);
      } else {
        validateId.current++;
        lastValidatedDatasetRef.current = null;
        setSemanticDiagnostics([]);
        setSemanticSource("");
      }
    } catch (e) {
      if (String(e).includes("Superseded") || id !== analysisId.current) return;
      setState("Engine Error");
      setEngineError(String(e));
    }
  }, [ready, validate, log]);

  useEffect(() => {
    if (workspace.autoAnalyze && ready) {
      const timer = setTimeout(() => void analyze(), 180);
      return () => clearTimeout(timer);
    }
  }, [workspace.source, workspace.autoAnalyze, ready, analyze]);

  useEffect(() => {
    if (
      shouldScheduleDatasetValidation({
        autoAnalyze: workspace.autoAnalyze,
        ready,
        analysisSuccess: analysis?.success,
        errorCount: errors.length,
        dataset: workspace.dataset,
        lastValidatedDataset: lastValidatedDatasetRef.current,
      })
    ) {
      const timer = setTimeout(() => void validate(), 180);
      return () => clearTimeout(timer);
    }
  }, [
    workspace.dataset,
    workspace.autoAnalyze,
    ready,
    analysis?.success,
    errors.length,
    validate,
  ]);

  useEffect(() => {
    const editorModel = editorRef.current?.getModel();
    if (!editorModel) return;
    const sync = resolveMarkerSync({
      analysis,
      analysisSource,
      semanticDiagnostics,
      semanticSource,
      evaluation,
      evalSource,
      evalRevision,
      revision: revision.current,
      canValidate:
        dataErrors.length === 0 &&
        Object.keys(draftErrors).length === 0 &&
        isWithinBackgroundValidateLimit(workspace.dataset),
    });
    if (sync.apply) {
      applyModelMarkers(editorModel, sync.entries);
    }
  }, [
    analysis,
    analysisSource,
    semanticDiagnostics,
    semanticSource,
    evaluation,
    evalSource,
    evalRevision,
    dataErrors.length,
    draftErrors,
    workspace.dataset,
    editorRef,
  ]);

  const onSourceChanged = useCallback(() => {
    revision.current++;
    analysisId.current++;
    validateId.current++;
    if (!current.current.autoAnalyze) {
      lastValidatedDatasetRef.current = null;
      setAnalysis(null);
      setAnalysisSource("");
      setSemanticDiagnostics([]);
      setSemanticSource("");
      setEvalRevision(-1);
    }
    setState((old) => (ready ? "Ready" : old));
  }, [ready]);

  const onDatasetChanged = useCallback(
    (dataset: Dataset) => {
      revision.current++;
      validateId.current++;
      const patch = getDatasetEditDiagnosticPatch(current.current.autoAnalyze);
      setEvalRevision(patch.evalRevision);
      if (
        patch.clearSemantic ||
        validateDataset(dataset).length > 0 ||
        !isWithinBackgroundValidateLimit(dataset)
      ) {
        lastValidatedDatasetRef.current = null;
        setSemanticDiagnostics([]);
        setSemanticSource("");
      }
      if (ready) setState("Ready");
    },
    [ready],
  );

  const onFileReplaced = useCallback(() => {
    revision.current++;
    analysisId.current++;
    validateId.current++;
    lastValidatedDatasetRef.current = null;
    setAnalysis(null);
    setAnalysisSource("");
    setSemanticDiagnostics([]);
    setSemanticSource("");
    setEvaluation(null);
    setEvalSource("");
    setEvalRevision(-1);
    const editorModel = editorRef.current?.getModel();
    if (editorModel) monaco.editor.setModelMarkers(editorModel, "helix", []);
  }, [editorRef]);

  const evaluate = useCallback(async () => {
    if (!engine.current || !ready || errors.length) return;
    const rev = revision.current,
      source = workspace.source,
      data = structuredClone(workspace.dataset);
    setState("Evaluating");
    onEvaluationStart();
    const start = performance.now();
    try {
      const result = await engine.current.request("evaluate", source, data);
      if (rev !== revision.current) {
        setState(ready ? "Ready" : "Loading engine");
        return;
      }
      setEvaluation(result);
      setEvalSource(source);
      setEvalRevision(rev);
      setState(result.success ? "Valid" : "Invalid");
      log(
        `Evaluation ${result.success ? "completed" : "failed"} · ${result.results.length} patient results · ${(performance.now() - start).toFixed(1)} ms`,
      );
    } catch (e) {
      setState("Engine Error");
      setEngineError(String(e));
    }
  }, [ready, errors.length, workspace.source, workspace.dataset, onEvaluationStart, log]);

  const syncMountedMarkers = useCallback(
    (model: monaco.editor.ITextModel) => {
      applyModelMarkers(model, latestDiagnosticEntriesRef.current);
    },
    [],
  );

  return {
    state,
    engineError,
    ready,
    analysis,
    analysisSource,
    evaluation,
    evalSource,
    logs,
    revision,
    errors,
    diagnosticEntries,
    diagnostics,
    errorCount,
    stale,
    log,
    connect,
    analyze,
    evaluate,
    onSourceChanged,
    onDatasetChanged,
    onFileReplaced,
    syncMountedMarkers,
  };
}
