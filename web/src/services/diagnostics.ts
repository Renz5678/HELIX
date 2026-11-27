import type { Analysis, Dataset, Diagnostic, Evaluation } from "./types";

// shortcut: skip 180ms full-row WASM validate above 1,000 rows; upgrade if C11 adds metadata-only semantic check
export const BACKGROUND_VALIDATE_MAX_ROWS = 1000;

export function countDatasetRows(dataset: Dataset): number {
  let total = 0;
  for (const table of dataset.tables) {
    total += table.rows.length;
  }
  return total;
}

export function isWithinBackgroundValidateLimit(dataset: Dataset): boolean {
  return countDatasetRows(dataset) <= BACKGROUND_VALIDATE_MAX_ROWS;
}

export interface DiagnosticEntry {
  d: Diagnostic;
  source: string;
}

export interface MarkerSyncInput {
  analysis: Analysis | null;
  analysisSource: string;
  semanticDiagnostics: Diagnostic[];
  semanticSource: string;
  evaluation: Evaluation | null;
  evalSource: string;
  evalRevision: number;
  revision: number;
  canValidate: boolean;
}

/**
 * Combines analysis diagnostics with active evaluation or background semantic
 * diagnostics, attaching each item to its source snapshot and deduplicating.
 */
export function combineDiagnosticEntries(
  analysis: Analysis | null,
  analysisSource: string,
  semanticDiagnostics: Diagnostic[],
  semanticSource: string,
  evaluation: Evaluation | null,
  evalSource: string,
  useEvaluation: boolean,
): DiagnosticEntry[] {
  const analysisEntries: DiagnosticEntry[] = (analysis?.diagnostics ?? []).map(
    (d) => ({ d, source: analysisSource }),
  );
  const analysisMessages = new Set(analysisEntries.map((e) => e.d.message));
  const semanticEntries: DiagnosticEntry[] =
    useEvaluation && evaluation
      ? evaluation.diagnostics
          .filter(
            (d) =>
              !(
                d.code === "ANALYSIS_ERROR" &&
                analysis &&
                !analysis.success &&
                analysisMessages.has(d.message)
              ),
          )
          .map((d) => ({ d, source: evalSource }))
      : semanticDiagnostics.map((d) => ({ d, source: semanticSource }));

  const seen = new Set<string>();
  const out: DiagnosticEntry[] = [];
  for (const entry of [...analysisEntries, ...semanticEntries]) {
    const key = `${entry.d.code}:${entry.d.startOffset ?? ""}:${entry.d.endOffset ?? ""}:${entry.d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * Returns false when `analyze()` just succeeded cleanly for a new source while
 * warm semantic markers from an earlier source are still awaiting background
 * `validate()`, allowing Monaco to keep its natively shifted markers intact.
 */
export function shouldApplyModelMarkers(input: {
  analysis: Analysis | null;
  analysisSource: string;
  semanticDiagnostics: Diagnostic[];
  semanticSource: string;
  canValidate: boolean;
}): boolean {
  const {
    analysis,
    analysisSource,
    semanticDiagnostics,
    semanticSource,
    canValidate,
  } = input;
  if (
    canValidate &&
    analysis !== null &&
    analysis.success &&
    analysis.diagnostics.length === 0 &&
    semanticDiagnostics.length > 0 &&
    semanticSource !== analysisSource
  ) {
    return false;
  }
  return true;
}

/**
 * Resolves whether Monaco model markers should be updated and computes the
 * source-mapped diagnostic entries to apply.
 */
export function resolveMarkerSync(
  input: MarkerSyncInput,
): { apply: false } | { apply: true; entries: DiagnosticEntry[] } {
  if (!shouldApplyModelMarkers(input)) {
    return { apply: false };
  }
  return {
    apply: true,
    entries: combineDiagnosticEntries(
      input.analysis,
      input.analysisSource,
      input.semanticDiagnostics,
      input.semanticSource,
      input.evaluation,
      input.evalSource,
      input.evaluation !== null && input.evalRevision === input.revision,
    ),
  };
}

/**
 * Computes diagnostic state resets required when the dataset changes.
 * Always resets `evalRevision` to `-1` (preserving `stale` banner) and clears
 * background semantic diagnostics in manual mode.
 */
export function getDatasetEditDiagnosticPatch(autoAnalyze: boolean): {
  evalRevision: -1;
  clearSemantic: boolean;
} {
  return {
    evalRevision: -1,
    clearSemantic: !autoAnalyze,
  };
}

/**
 * Returns true when an evaluation exists from an earlier source or dataset revision.
 */
export function isEvaluationStale(
  evaluation: Evaluation | null,
  evalRevision: number,
  currentRevision: number,
): boolean {
  return evaluation !== null && evalRevision !== currentRevision;
}

/**
 * Returns true when the dataset-change effect should schedule background
 * `validate()`, avoiding redundant validation right after `analyze()` already
 * started validation for the same dataset reference.
 */
export function shouldScheduleDatasetValidation(input: {
  autoAnalyze: boolean;
  ready: boolean;
  analysisSuccess: boolean | undefined;
  errorCount: number;
  dataset: Dataset;
  lastValidatedDataset: Dataset | null;
}): boolean {
  return Boolean(
    input.autoAnalyze &&
      input.ready &&
      input.analysisSuccess &&
      input.errorCount === 0 &&
      isWithinBackgroundValidateLimit(input.dataset) &&
      input.dataset !== input.lastValidatedDataset,
  );
}
