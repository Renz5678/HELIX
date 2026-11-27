import { describe, expect, it } from "vitest";
import sepsisData from "../../../examples/data/sepsis.json";
import { HelixIntelliSense } from "../../src/editor/intellisense/engine";
import { analyzeCursorContext } from "../../src/editor/intellisense/context";
import { indexDocument } from "../../src/editor/intellisense/document-index";
import { getDatasetSchemaIndex } from "../../src/editor/intellisense/schema";
import {
  BACKGROUND_VALIDATE_MAX_ROWS,
  shouldScheduleDatasetValidation,
} from "../../src/services/diagnostics";
import { byteOffsetToPosition } from "../../src/services/positions";
import type { Dataset } from "../../src/services/types";

const sepsisDs = sepsisData as Dataset;

function makeBooleanDataset(): Dataset {
  return {
    schemaVersion: 1,
    evaluationTime: "2025-01-15T12:00:00Z",
    Bindings: {
      "Labs.glucose": { table: "flags_tbl", column: "is_critical" },
      plain_flag: { table: "flags_tbl", column: "is_critical" },
    },
    tables: [
      {
        name: "flags_tbl",
        patientIdColumn: "patient_id",
        timestampColumn: "timestamp",
        defaultValueColumn: "is_critical",
        columns: [
          { name: "patient_id", type: "String" },
          { name: "timestamp", type: "DateTime" },
          { name: "is_critical", type: "Boolean" },
        ],
        rows: [
          {
            patient_id: "P1",
            timestamp: "2025-01-15T11:00:00Z",
            is_critical: true,
          },
        ],
      },
    ],
  };
}

describe("Audit regression fixes", () => {
  it("omits dotted bindings after `source` in completions and SOURCE_NOT_FOUND Quick Fixes", () => {
    const engine = new HelixIntelliSense();
    const ds = makeBooleanDataset();

    const comps = engine.provideCompletions(
      "file:///src-dot.helix",
      1,
      "rule R:\n    source \nend rule",
      ds,
      { lineNumber: 2, column: 12 },
    );
    const labels = comps.map((c) => c.label);
    expect(labels).toContain("flags_tbl");
    expect(labels).toContain("plain_flag");
    expect(labels).not.toContain("Labs.glucose");

    const fixes = engine.provideQuickFixes(
      "file:///src-fix.helix",
      1,
      "rule R:\n    source Labs_glucse\nend rule",
      ds,
      [
        {
          code: "SOURCE_NOT_FOUND",
          message: "Source table is not mapped",
          range: {
            startLineNumber: 2,
            startColumn: 12,
            endLineNumber: 2,
            endColumn: 23,
          },
        },
      ],
    );
    expect(fixes.some((f) => f.edit.text.includes("."))).toBe(false);
  });

  it("treats cursor before an existing `then:` as still inside the `when` condition", () => {
    const engine = new HelixIntelliSense();
    const src = [
      "rule R:",
      "    bind sbp = Vitals.systolic_bp end bind",
      "    let sbp_crit := 90",
      "    when sbp.",
      "    then:",
      '        alert: "low"',
      "    end when",
      "end rule",
    ].join("\n");

    const schema = getDatasetSchemaIndex(sepsisDs);
    const doc = indexDocument(src, schema);
    const ctx = analyzeCursorContext(doc, schema, { lineNumber: 4, column: 14 });
    expect(ctx.inWhen).toBe(true);
    expect(ctx.hasThen).toBe(false);

    const comps = engine.provideCompletions(
      "file:///edit-cond.helix",
      1,
      src,
      sepsisDs,
      { lineNumber: 4, column: 14 },
    );
    expect(comps.some((c) => c.label === "latest > sbp_crit")).toBe(true);

    const ghost = engine.provideInlinePrediction(
      "file:///edit-cond.helix",
      1,
      src,
      sepsisDs,
      { lineNumber: 4, column: 14 },
    );
    expect(ghost?.insertText).toBe("latest > sbp_crit");

    const withinSrc = [
      "rule R:",
      "    bind hr = Vitals.heart_rate end bind",
      "    when hr.latest > 120 within 15 minutes ",
      "    then:",
      '        alert: "high"',
      "    end when",
      "end rule",
    ].join("\n");
    const withinComps = engine.provideCompletions(
      "file:///edit-within.helix",
      1,
      withinSrc,
      sepsisDs,
      { lineNumber: 3, column: 44 },
    );
    const withinLabels = withinComps.map((c) => c.label);
    expect(withinLabels).toContain("and");
    expect(withinLabels).toContain("or");
    expect(withinLabels).not.toContain("then:");
  });

  it("emits boolean-safe `when / otherwise` snippet without `>`", () => {
    const engine = new HelixIntelliSense();
    const ds = makeBooleanDataset();
    const src = "rule R:\n    source flags_tbl\n    \nend rule";
    const comps = engine.provideCompletions(
      "file:///bool-when.helix",
      1,
      src,
      ds,
      { lineNumber: 3, column: 5 },
    );
    const whenItem = comps.find((c) => c.label === "when / otherwise");
    expect(whenItem).toBeDefined();
    expect(whenItem?.insertText).toContain("when ${1:flags_tbl.latest}:");
    expect(whenItem?.insertText).not.toContain(">");
  });

  it("inserts `end when` and `let` Quick Fixes inline on single-line rules instead of column 1", () => {
    const engine = new HelixIntelliSense();
    const singleEnd =
      'rule R: source Vitals when Vitals.latest > 100: then: alert: "x" end rule';
    const endRuleCol = singleEnd.indexOf("end rule") + 1;
    const endFixes = engine.provideQuickFixes(
      "file:///single-end.helix",
      1,
      singleEnd,
      sepsisDs,
      [
        {
          code: "SYNTAX_ERROR",
          message: "Expected 'end when' to terminate when block. Got 'end'",
          range: {
            startLineNumber: 1,
            startColumn: endRuleCol,
            endLineNumber: 1,
            endColumn: endRuleCol + 3,
          },
        },
      ],
    );
    expect(endFixes[0]?.edit.range.startColumn).toBe(endRuleCol);
    expect(endFixes[0]?.edit.text).toBe("end when ");

    const singleLet =
      'rule R: source Vitals when Vitals.latest > limt: then: alert: "x" end when end rule';
    const limtCol = singleLet.indexOf("limt") + 1;
    const whenCol = singleLet.indexOf("when") + 1;
    const letFixes = engine.provideQuickFixes(
      "file:///single-let.helix",
      1,
      singleLet,
      sepsisDs,
      [
        {
          code: "UNKNOWN_IDENTIFIER",
          message: "Unknown identifier",
          range: {
            startLineNumber: 1,
            startColumn: limtCol,
            endLineNumber: 1,
            endColumn: limtCol + 4,
          },
        },
      ],
    );
    const declareFix = letFixes.find((f) => f.title.includes("let limt"));
    expect(declareFix?.edit.range.startColumn).toBe(whenCol);
    expect(declareFix?.edit.text).toBe("let limt := 0 ");
  });

  it("shows column hover documentation when hovering a column on a local bind alias", () => {
    const engine = new HelixIntelliSense();
    const src = [
      "rule R:",
      "    bind v = Vitals end bind",
      "    when v.systolic_bp.latest < 90:",
      "    then:",
      '        alert: "low"',
      "    end when",
      "end rule",
    ].join("\n");
    const hover = engine.provideHover(
      "file:///alias-col.helix",
      1,
      src,
      sepsisDs,
      { lineNumber: 3, column: 15 },
    );
    expect(hover).not.toBeNull();
    expect(hover?.markdown).toContain("Vitals.systolic_bp");
    expect(hover?.markdown).toContain("Float");
  });

  it("converts UTF-8 byte offsets accurately across ASCII, multi-byte chars, and emoji", () => {
    // "a" (1) + "é" (2) + "中" (3) + "😀" (4 bytes, 2 UTF-16 code units) + "\n" (1) + "x" (1)
    const src = "aé中😀\nx";
    expect(byteOffsetToPosition(src, 0)).toEqual({ lineNumber: 1, column: 1 });
    expect(byteOffsetToPosition(src, 1)).toEqual({ lineNumber: 1, column: 2 });
    expect(byteOffsetToPosition(src, 3)).toEqual({ lineNumber: 1, column: 3 });
    expect(byteOffsetToPosition(src, 6)).toEqual({ lineNumber: 1, column: 4 });
    expect(byteOffsetToPosition(src, 10)).toEqual({ lineNumber: 1, column: 6 });
    expect(byteOffsetToPosition(src, 11)).toEqual({ lineNumber: 2, column: 1 });
    expect(byteOffsetToPosition(src, 12)).toEqual({ lineNumber: 2, column: 2 });
  });

  it("skips automatic background validation when dataset rows exceed the cap", () => {
    const bigRows = Array.from(
      { length: BACKGROUND_VALIDATE_MAX_ROWS + 1 },
      (_, i) => ({
        patient_id: `P${i}`,
        timestamp: "2025-01-15T11:00:00Z",
        value: 100,
      }),
    );
    const bigDataset: Dataset = {
      schemaVersion: 1,
      evaluationTime: "2025-01-15T12:00:00Z",
      Bindings: {},
      tables: [
        {
          name: "labs",
          patientIdColumn: "patient_id",
          timestampColumn: "timestamp",
          defaultValueColumn: "value",
          columns: [
            { name: "patient_id", type: "String" },
            { name: "timestamp", type: "DateTime" },
            { name: "value", type: "Float" },
          ],
          rows: bigRows,
        },
      ],
    };

    expect(
      shouldScheduleDatasetValidation({
        autoAnalyze: true,
        ready: true,
        analysisSuccess: true,
        errorCount: 0,
        dataset: bigDataset,
        lastValidatedDataset: null,
      }),
    ).toBe(false);

    expect(
      shouldScheduleDatasetValidation({
        autoAnalyze: true,
        ready: true,
        analysisSuccess: true,
        errorCount: 0,
        dataset: sepsisDs,
        lastValidatedDataset: null,
      }),
    ).toBe(true);
  });

  it("does not suggest generic `value` as a bind alias and ignores rule names in lhsHintName", () => {
    const engine = new HelixIntelliSense();
    const ds: Dataset = {
      schemaVersion: 1,
      evaluationTime: "2025-01-15T12:00:00Z",
      Bindings: {
        "Labs.glucose": { table: "glucose_data", column: "value" },
      },
      tables: [
        {
          name: "glucose_data",
          patientIdColumn: "patient_id",
          timestampColumn: "timestamp",
          defaultValueColumn: "value",
          columns: [
            { name: "patient_id", type: "String" },
            { name: "timestamp", type: "DateTime" },
            { name: "value", type: "Float" },
          ],
          rows: [
            {
              patient_id: "P1",
              timestamp: "2025-01-15T11:00:00Z",
              value: 200,
            },
          ],
        },
      ],
    };
    const bindNameComps = engine.provideCompletions(
      "file:///bind-alias.helix",
      1,
      "rule R:\n    bind \nend rule",
      ds,
      { lineNumber: 2, column: 10 },
    );
    expect(bindNameComps.map((c) => c.label)).not.toContain("value");
    expect(bindNameComps.map((c) => c.label)).toContain("glucose");
  });
});
