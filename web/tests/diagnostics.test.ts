import { describe, it, expect } from "vitest";
import type { Analysis, Dataset, Diagnostic, Evaluation } from "../src/services/types";
import {
  combineDiagnosticEntries,
  getDatasetEditDiagnosticPatch,
  isEvaluationStale,
  resolveMarkerSync,
  shouldApplyModelMarkers,
  shouldScheduleDatasetValidation,
} from "../src/services/diagnostics";

const semanticDiag: Diagnostic = {
  severity: "error",
  category: "semantic",
  code: "SOURCE_NOT_FOUND",
  message: "Source table is not mapped: 'glucse_data'",
  startOffset: 30,
  endOffset: 41,
  line: 2,
  column: 12,
};

const syntaxDiag: Diagnostic = {
  severity: "error",
  category: "syntax",
  code: "SYNTAX_ERROR",
  message: "Expected ':'",
  startOffset: 10,
  endOffset: 11,
  line: 1,
  column: 11,
};

function makeAnalysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    schemaVersion: 1,
    success: true,
    tokenCount: 12,
    lexicalErrorCount: 0,
    syntaxErrorCount: 0,
    warningCount: 0,
    tokens: [],
    diagnostics: [],
    summary: "ok",
    ...overrides,
  };
}

function makeEvaluation(diagnostics: Diagnostic[] = []): Evaluation {
  return {
    schemaVersion: 1,
    success: diagnostics.every((d) => d.severity !== "error"),
    analysisSuccess: true,
    evaluationTime: "2026-10-31T12:00:00Z",
    results: [],
    diagnostics,
  };
}

describe("warm marker stability (Scenario 1)", () => {
  it("skips setModelMarkers when analysis succeeds cleanly for S2 while semanticDiagnostics is still from S1 and validate(S2) is pending", () => {
    const s1 = "rule R:\n    source glucse_data\nend rule";
    const s2 = "# added line\nrule R:\n    source glucse_data\nend rule";
    const analysis = makeAnalysis({ success: true, diagnostics: [] });

    expect(
      shouldApplyModelMarkers({
        analysis,
        analysisSource: s2,
        semanticDiagnostics: [semanticDiag],
        semanticSource: s1,
        canValidate: true,
      }),
    ).toBe(false);

    const sync = resolveMarkerSync({
      analysis,
      analysisSource: s2,
      semanticDiagnostics: [semanticDiag],
      semanticSource: s1,
      evaluation: null,
      evalSource: "",
      evalRevision: -1,
      revision: 1,
      canValidate: true,
    });
    expect(sync).toEqual({ apply: false });
  });

  it("applies markers once validate(S2) resolves (semanticSource === analysisSource)", () => {
    const s2 = "# added line\nrule R:\n    source glucse_data\nend rule";
    const shiftedSemanticDiag: Diagnostic = {
      ...semanticDiag,
      startOffset: 43,
      endOffset: 54,
      line: 3,
    };
    const analysis = makeAnalysis({ success: true, diagnostics: [] });

    const sync = resolveMarkerSync({
      analysis,
      analysisSource: s2,
      semanticDiagnostics: [shiftedSemanticDiag],
      semanticSource: s2,
      evaluation: null,
      evalSource: "",
      evalRevision: -1,
      revision: 1,
      canValidate: true,
    });
    expect(sync.apply).toBe(true);
    if (sync.apply) {
      expect(sync.entries).toEqual([{ d: shiftedSemanticDiag, source: s2 }]);
    }
  });

  it("applies markers when analysis has syntax errors or when analysis is cleared (null / replaceFile)", () => {
    const s1 = "rule R:\n    source glucse_data\nend rule";
    const s2 = "rule R\n    source glucse_data\nend rule";

    const syntaxSync = resolveMarkerSync({
      analysis: makeAnalysis({
        success: false,
        syntaxErrorCount: 1,
        diagnostics: [syntaxDiag],
      }),
      analysisSource: s2,
      semanticDiagnostics: [],
      semanticSource: "",
      evaluation: null,
      evalSource: "",
      evalRevision: -1,
      revision: 2,
      canValidate: true,
    });
    expect(syntaxSync.apply).toBe(true);
    if (syntaxSync.apply) {
      expect(syntaxSync.entries).toEqual([{ d: syntaxDiag, source: s2 }]);
    }

    const clearedSync = resolveMarkerSync({
      analysis: null,
      analysisSource: "",
      semanticDiagnostics: [],
      semanticSource: "",
      evaluation: null,
      evalSource: "",
      evalRevision: -1,
      revision: 3,
      canValidate: true,
    });
    expect(clearedSync).toEqual({ apply: true, entries: [] });

    // Also applies if dataset cannot validate (canValidate === false)
    expect(
      shouldApplyModelMarkers({
        analysis: makeAnalysis({ success: true, diagnostics: [] }),
        analysisSource: s2,
        semanticDiagnostics: [semanticDiag],
        semanticSource: s1,
        canValidate: false,
      }),
    ).toBe(true);
  });
});

describe("dataset edit stale evaluation markers (Scenario 2)", () => {
  it("resets evalRevision to -1 on dataset edit and drops stale evaluation markers in both manual and auto modes", () => {
    const s1 = "rule R:\n    source glucse_data\nend rule";
    const evalResult = makeEvaluation([semanticDiag]);
    const analysis = makeAnalysis({ success: true, diagnostics: [] });

    // Before dataset edit: evaluation active at revision 4
    const activeEntries = combineDiagnosticEntries(
      analysis,
      s1,
      [],
      "",
      evalResult,
      s1,
      true,
    );
    expect(activeEntries).toEqual([{ d: semanticDiag, source: s1 }]);

    // Manual mode dataset edit: resets evalRevision to -1 and clears semanticDiagnostics
    const manualPatch = getDatasetEditDiagnosticPatch(false);
    expect(manualPatch).toEqual({ evalRevision: -1, clearSemantic: true });

    const manualRevisionAfterEdit = 5;
    const manualSync = resolveMarkerSync({
      analysis,
      analysisSource: s1,
      semanticDiagnostics: manualPatch.clearSemantic ? [] : [semanticDiag],
      semanticSource: manualPatch.clearSemantic ? "" : s1,
      evaluation: evalResult,
      evalSource: s1,
      evalRevision: manualPatch.evalRevision,
      revision: manualRevisionAfterEdit,
      canValidate: true,
    });
    expect(manualSync).toEqual({ apply: true, entries: [] });
    // Stale banner remains active when evaluation !== null and evalRevision (-1) !== revision (5)
    expect(
      isEvaluationStale(
        evalResult,
        manualPatch.evalRevision,
        manualRevisionAfterEdit,
      ),
    ).toBe(true);

    // Auto mode dataset edit: resets evalRevision to -1 (dropping evaluation-only markers) while keeping warm semanticDiagnostics
    const autoPatch = getDatasetEditDiagnosticPatch(true);
    expect(autoPatch).toEqual({ evalRevision: -1, clearSemantic: false });

    const autoSync = resolveMarkerSync({
      analysis,
      analysisSource: s1,
      semanticDiagnostics: [semanticDiag],
      semanticSource: s1,
      evaluation: evalResult,
      evalSource: s1,
      evalRevision: autoPatch.evalRevision,
      revision: manualRevisionAfterEdit,
      canValidate: true,
    });
    expect(autoSync).toEqual({
      apply: true,
      entries: [{ d: semanticDiag, source: s1 }],
    });
  });

  it("avoids redundant validate() on initial load and syntax recovery while scheduling on real dataset edits", () => {
    const ds0 = {
      schemaVersion: 1,
      evaluationTime: "2026-10-31T12:00:00Z",
      Bindings: {},
      tables: [],
    } satisfies Dataset;
    const ds1 = { ...ds0 };

    // Initial load / syntax recovery: analyze() already called validate() on ds0
    expect(
      shouldScheduleDatasetValidation({
        autoAnalyze: true,
        ready: true,
        analysisSuccess: true,
        errorCount: 0,
        dataset: ds0,
        lastValidatedDataset: ds0,
      }),
    ).toBe(false);

    // Dataset mutated to a new reference -> should schedule validate()
    expect(
      shouldScheduleDatasetValidation({
        autoAnalyze: true,
        ready: true,
        analysisSuccess: true,
        errorCount: 0,
        dataset: ds1,
        lastValidatedDataset: ds0,
      }),
    ).toBe(true);

    // Draft errors block validation until cleared
    expect(
      shouldScheduleDatasetValidation({
        autoAnalyze: true,
        ready: true,
        analysisSuccess: true,
        errorCount: 1,
        dataset: ds1,
        lastValidatedDataset: ds0,
      }),
    ).toBe(false);
    expect(
      shouldScheduleDatasetValidation({
        autoAnalyze: true,
        ready: true,
        analysisSuccess: true,
        errorCount: 0,
        dataset: ds1,
        lastValidatedDataset: null,
      }),
    ).toBe(true);
  });
});
