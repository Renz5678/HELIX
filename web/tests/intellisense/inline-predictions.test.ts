import { describe, it, expect } from "vitest";
import glucoseData from "../../../examples/data/glucose.json";
import sepsisData from "../../../examples/data/sepsis.json";
import temporalData from "../../../examples/data/temporal.json";
import type { Dataset } from "../../src/services/types";
import { getDatasetSchemaIndex } from "../../src/editor/intellisense/schema";
import { indexDocument } from "../../src/editor/intellisense/document-index";
import { analyzeCursorContext } from "../../src/editor/intellisense/context";
import { positionToOffset } from "../../src/editor/intellisense/lexer";
import {
  computeInlinePrediction,
  type InlinePrediction,
} from "../../src/editor/intellisense/inline-predictions";

function ghostAt(
  srcWithCaret: string,
  dataset: Dataset,
  enabled = true,
): InlinePrediction | null {
  const idx = srcWithCaret.indexOf("|");
  if (idx === -1) {
    throw new Error("Missing '|' caret marker in test input");
  }
  const src = srcWithCaret.slice(0, idx) + srcWithCaret.slice(idx + 1);
  const before = src.slice(0, idx).split(/\r\n|\r|\n/);
  const pos = {
    lineNumber: before.length,
    column: before[before.length - 1].length + 1,
  };
  const schema = getDatasetSchemaIndex(dataset);
  const doc = indexDocument(src, schema);
  const ctx = analyzeCursorContext(doc, schema, pos);
  return computeInlinePrediction(doc, schema, ctx, pos, enabled);
}

function applyGhost(srcWithCaret: string, dataset: Dataset): string | null {
  const idx = srcWithCaret.indexOf("|");
  const src = srcWithCaret.slice(0, idx) + srcWithCaret.slice(idx + 1);
  const pred = ghostAt(srcWithCaret, dataset, true);
  if (!pred) return null;
  const startOff = positionToOffset(src, {
    lineNumber: pred.range.startLineNumber,
    column: pred.range.startColumn,
  });
  const endOff = positionToOffset(src, {
    lineNumber: pred.range.endLineNumber,
    column: pred.range.endColumn,
  });
  return src.slice(0, startOff) + pred.insertText + src.slice(endOff);
}

describe("deterministic inline ghost-text engine", () => {
  const glucose = structuredClone(glucoseData) as Dataset;
  const sepsis = structuredClone(sepsisData) as Dataset;
  const temporal = structuredClone(temporalData) as Dataset;

  it("predicts exact block closer, .latest > threshold, bind path, where value, duration unit, severity, and suppress", () => {
    expect(
      ghostAt(
        'rule R:\n    when 1 > 0:\n    then:\n        alert: "x"\n    end |\nend rule',
        glucose,
      )?.insertText,
    ).toBe("when");
    expect(
      ghostAt(
        "rule R:\n    source glucose_data\n    let threshold := 250\n    when glucose_data.|",
        glucose,
      )?.insertText,
    ).toBe("latest > threshold");
    expect(
      ghostAt("rule R:\n    bind hr_readings = |", temporal)?.insertText,
    ).toBe("Vitals.heart_rate");
    expect(
      ghostAt(
        "rule R:\n    bind hr = Vitals.heart_rate where status == |",
        temporal,
      )?.insertText,
    ).toBe('"final"');
    expect(
      ghostAt("rule R:\n    suppress: within 30 |", temporal)?.insertText,
    ).toBe("minutes");
    expect(
      ghostAt(
        'rule R:\n    when 1 > 0:\n    then:\n        alert: "High", |',
        glucose,
      )?.insertText,
    ).toBe('"WARNING"');
    expect(
      ghostAt(
        "rule R:\n    when 1 > 0:\n    then:\n        suppress: |",
        glucose,
      )?.insertText,
    ).toBe("within 4 hours");
  });

  it("predicts multi-line then/end when and end bind, but never duplicates already-present closers or when disabled", () => {
    const whenGhost = ghostAt(
      "rule HighGlucose:\n    source glucose_data\n    when glucose_data.latest > 250:\n    |",
      glucose,
    );
    expect(whenGhost?.insertText).toContain("then:");
    expect(whenGhost?.insertText).toContain("end when");

    const alreadyHasThen = ghostAt(
      'rule HighGlucose:\n    source glucose_data\n    when glucose_data.latest > 250:\n    |\n    then:\n        alert: "x"\n    end when\nend rule',
      glucose,
    );
    expect(alreadyHasThen).toBeNull();

    const alreadyClosedBind = ghostAt(
      "rule R:\n    bind hr = Vitals.heart_rate\n    |\n    end bind\nend rule",
      temporal,
    );
    expect(alreadyClosedBind).toBeNull();

    expect(ghostAt("rule R:\n    suppress: |", glucose, false)).toBeNull();
    expect(ghostAt("rule R:\n    # end |", glucose, true)).toBeNull();
  });

  it("handles prefix-aware end-block and indented en/end branch closers cleanly", () => {
    expect(
      applyGhost(
        'rule R:\n    when 1 > 0:\n    then:\n        alert: "x"\n    end wh|\nend rule',
        glucose,
      ),
    ).toBe(
      'rule R:\n    when 1 > 0:\n    then:\n        alert: "x"\n    end when\nend rule',
    );
    expect(
      ghostAt(
        'rule R:\n    when 1 > 0:\n    then:\n        alert: "x"\n    end wh|\nend rule',
        glucose,
      )?.insertText,
    ).toBe("en");
    expect(
      ghostAt(
        'rule R:\n    when 1 > 0:\n    then:\n        alert: "x"\n    end when|\nend rule',
        glucose,
      ),
    ).toBeNull();
    expect(ghostAt("rule R:\n    end wh|\nend rule", glucose)).toBeNull();

    // Rule 10: en / end inside unclosed when branch after at least one statement
    const enPred = ghostAt(
      'rule R:\n    when 1 > 0:\n    then:\n        alert: "x"\n    en|\nend rule',
      glucose,
    );
    expect(enPred?.insertText).toBe("d when");
    expect(
      applyGhost(
        'rule R:\n    when 1 > 0:\n    then:\n        alert: "x"\n    en|\nend rule',
        glucose,
      ),
    ).toBe(
      'rule R:\n    when 1 > 0:\n    then:\n        alert: "x"\n    end when\nend rule',
    );

    expect(
      ghostAt(
        'rule R:\n    when 1 > 0:\n    then:\n        alert: "x"\n    end|\nend rule',
        glucose,
      )?.insertText,
    ).toBe(" when");

    // Works inside otherwise branch after a statement
    expect(
      ghostAt(
        'rule R:\n    when 1 > 0:\n    then:\n        alert: "x"\n    otherwise:\n        suppress: within 4 hours\n    en|\nend rule',
        glucose,
      )?.insertText,
    ).toBe("d when");

    // Suppressed if no statement in branch yet, or if end when already exists, or if mid-line
    expect(
      ghostAt(
        "rule R:\n    when 1 > 0:\n    then:\n        en|\nend rule",
        glucose,
      ),
    ).toBeNull();
    expect(
      ghostAt(
        'rule R:\n    when 1 > 0:\n    then:\n        alert: "x"\n    en|\n    end when\nend rule',
        glucose,
      ),
    ).toBeNull();
    expect(
      ghostAt(
        'rule R:\n    when 1 > 0:\n    then:\n        let x := en|\nend rule',
        glucose,
      ),
    ).toBeNull();
  });

  it("handles member-access upgrades, bind-rhs matching, where-value formatting, within-unit, alert-arg, and suppress-operand", () => {
    // Member access: stem-matched numeric let wins even with multiple lets
    expect(
      ghostAt(
        "rule Sepsis:\n    bind sbp = Vitals.systolic_bp\n    end bind\n    let temp_high := 38.3\n    let sbp_crit := 90\n    when sbp.|",
        sepsis,
      )?.insertText,
    ).toBe("latest > sbp_crit");

    // Ambiguous multiple numeric lets -> stay with plain 'latest'
    expect(
      ghostAt(
        "rule R:\n    source glucose_data\n    let low := 70\n    let high := 250\n    when glucose_data.|",
        glucose,
      )?.insertText,
    ).toBe("latest");

    // Already has comparison operator on LHS -> plain 'latest'
    expect(
      ghostAt(
        "rule R:\n    source glucose_data\n    let threshold := 250\n    when 300 > glucose_data.|",
        glucose,
      )?.insertText,
    ).toBe("latest");

    // Not a bound/source series (binding prefix) -> null
    expect(ghostAt("rule R:\n    bind hr = Vitals.|", temporal)).toBeNull();

    // Partial prefix on member-access
    expect(
      applyGhost(
        "rule R:\n    source glucose_data\n    let threshold := 250\n    when glucose_data.la|",
        glucose,
      ),
    ).toBe(
      "rule R:\n    source glucose_data\n    let threshold := 250\n    when glucose_data.latest > threshold",
    );

    // bind-rhs matching schema.bindings and schema.tableNames
    expect(
      ghostAt("rule R:\n    bind wbc = |", sepsis)?.insertText,
    ).toBe("Labs.white_blood_count");
    expect(
      ghostAt("rule R:\n    bind vitals = |", sepsis)?.insertText,
    ).toBe("Vitals");
    expect(
      ghostAt("rule R:\n    bind glucose = |", glucose)?.insertText,
    ).toBe("glucose_data");
    expect(
      ghostAt("rule R:\n    bind hr_readings = Vi|", temporal)?.insertText,
    ).toBe("tals.heart_rate");
    expect(ghostAt("rule R:\n    bind unknown = |", temporal)).toBeNull();
    expect(ghostAt("rule R:\n    bind hr_readings |", temporal)).toBeNull();

    // where-value: bare number/boolean vs null inside quotes or empty table
    const boolDataset: Dataset = {
      schemaVersion: 1,
      evaluationTime: "2026-10-31T12:00:00Z",
      Bindings: {},
      tables: [
        {
          name: "Flags",
          patientIdColumn: "patient_id",
          timestampColumn: "timestamp",
          defaultValueColumn: "val",
          columns: [
            { name: "patient_id", type: "String" },
            { name: "timestamp", type: "DateTime" },
            { name: "val", type: "Integer" },
            { name: "active", type: "Boolean" },
            { name: "empty_col", type: "String" },
          ],
          rows: [
            {
              patient_id: "P1",
              timestamp: "2026-10-31T10:00:00Z",
              val: 42,
              active: true,
              empty_col: null,
            },
          ],
        },
      ],
    };
    expect(
      ghostAt("rule R:\n    bind f = Flags where val == |", boolDataset)?.insertText,
    ).toBe("42");
    expect(
      ghostAt("rule R:\n    bind f = Flags where active == |", boolDataset)
        ?.insertText,
    ).toBe("true");
    expect(
      ghostAt("rule R:\n    bind f = Flags where empty_col == |", boolDataset),
    ).toBeNull();
    expect(
      ghostAt('rule R:\n    bind hr = Vitals.heart_rate where status == "|', temporal),
    ).toBeNull();
    expect(
      ghostAt("rule R:\n    bind hr = Vitals.heart_rate where value > 1.|", temporal),
    ).toBeNull();

    // within-unit
    expect(
      ghostAt("rule R:\n    suppress: within 15 |", temporal)?.insertText,
    ).toBe("minutes");
    expect(
      ghostAt("rule R:\n    suppress: within 45 |", temporal)?.insertText,
    ).toBe("minutes");
    expect(
      ghostAt("rule R:\n    suppress: within 60 |", temporal)?.insertText,
    ).toBe("minutes");
    expect(
      ghostAt("rule R:\n    suppress: within 4 |", temporal)?.insertText,
    ).toBe("hours");
    expect(
      ghostAt("rule R:\n    suppress: within 30 m|", temporal)?.insertText,
    ).toBe("inutes");
    expect(ghostAt("rule R:\n    suppress: within 30 h|", temporal)).toBeNull();

    // alert-arg & suppress-operand guards
    expect(
      ghostAt('rule R:\n    when 1 > 0:\n    then:\n        alert: |', glucose),
    ).toBeNull();
    expect(
      ghostAt(
        'rule R:\n    when 1 > 0:\n    then:\n        alert: "High", hr|',
        temporal,
      ),
    ).toBeNull();
    expect(
      ghostAt(
        'rule R:\n    when 1 > 0:\n    then:\n        alert: "High", "WARNING" |',
        glucose,
      ),
    ).toBeNull();
    expect(
      ghostAt(
        "rule R:\n    when 1 > 0:\n    then:\n        suppress: wi|",
        glucose,
      )?.insertText,
    ).toBe("thin 4 hours");
  });

  it("aligns indentation for multi-line when and rule scaffolds and suppresses duplicate or mid-line predictions", () => {
    // Rule 8: preserves custom indentation on nested when
    const nestedWhen = applyGhost(
      "rule HighGlucose:\n    source glucose_data\n    when 1 > 0:\n    then:\n        when glucose_data.latest > 250:\n        |",
      glucose,
    );
    expect(nestedWhen).toBe(
      'rule HighGlucose:\n    source glucose_data\n    when 1 > 0:\n    then:\n        when glucose_data.latest > 250:\n        then:\n            alert: "HighGlucose triggered", "WARNING"\n        end when',
    );

    // Rule 8 suppressed on blank line before then: with blank lines in between, or empty/unclosed condition
    expect(
      ghostAt(
        'rule R:\n    when 1 > 0:\n    |\n\n    then:\n        alert: "x"\n    end when\nend rule',
        glucose,
      ),
    ).toBeNull();
    expect(ghostAt("rule R:\n    when\n    |", glucose)).toBeNull();
    expect(
      ghostAt("rule R:\n    when (glucose_data.latest > 250\n    |", glucose),
    ).toBeNull();

    // Rule 9: unclosed bind emits end bind even when end rule follows, suppressed if end bind follows
    expect(
      ghostAt(
        "rule R:\n    bind hr = Vitals.heart_rate\n    |\nend rule",
        temporal,
      )?.insertText,
    ).toBe("end bind");
    expect(
      ghostAt("rule R:\n    bind unknown =\n    |", temporal),
    ).toBeNull();
    expect(
      ghostAt("rule R:\n    bind hr\n    |", temporal),
    ).toBeNull();
    expect(
      ghostAt("rule R:\n    bind site: ICU\n    |", temporal),
    ).toBeNull();

    // Rule 11: empty unclosed rule aligns end rule with rule keyword
    expect(
      applyGhost("rule HighGlucose:\n    |", glucose),
    ).toBe("rule HighGlucose:\n    source glucose_data\nend rule");
    expect(
      applyGhost("  rule IndentedRule:\n      |", glucose),
    ).toBe("  rule IndentedRule:\n      source glucose_data\n  end rule");
    expect(
      ghostAt("rule HighGlucose:\n    |\nend rule", glucose),
    ).toBeNull();
    expect(
      ghostAt("rule HighGlucose:\n    intent: \"check\"\n    |", glucose),
    ).toBeNull();

    const emptyDataset: Dataset = {
      schemaVersion: 1,
      evaluationTime: "2026-10-31T12:00:00Z",
      Bindings: {},
      tables: [],
    };
    expect(ghostAt("rule Empty:\n    |", emptyDataset)).toBeNull();

    // Trailing non-whitespace on same line suppresses ghost-text
    expect(
      ghostAt("rule R:\n    bind hr = |# inline comment\nend rule", temporal),
    ).toBeNull();
    expect(
      ghostAt(
        "rule R:\n    source glucose_data\n    when glucose_data.| > 250",
        glucose,
      ),
    ).toBeNull();

    // String literals and comments suppress ghost-text; CRLF + UTF-16 above cursor remain exact
    expect(
      ghostAt('rule R:\n    intent: "suppress: |"\nend rule', glucose),
    ).toBeNull();
    const crlfResult = applyGhost(
      'rule R:\r\n    # ⚠️ café note\r\n    intent: "Check 🚀"\r\n    suppress: |\r\nend rule',
      glucose,
    );
    expect(crlfResult).toBe(
      'rule R:\r\n    # ⚠️ café note\r\n    intent: "Check 🚀"\r\n    suppress: within 4 hours\r\nend rule',
    );
    expect(
      ghostAt(
        'rule R:\r\n    bind hr = Vitals.heart_rate\r\n    |\r\n    end bind\r\nend rule',
        temporal,
      ),
    ).toBeNull();
  });

  it("computes inline predictions on a 500-line document well under 15 ms", () => {
    const lines = ["rule PerfRule:", "    source glucose_data"];
    for (let i = 0; i < 495; i++) {
      lines.push(`    let v_${i} := ${i}`);
    }
    lines.push("    when glucose_data.latest > v_0:");
    lines.push("    then:");
    lines.push("        suppress: |");
    const srcWithCaret = lines.join("\n");
    const start = performance.now();
    const pred = ghostAt(srcWithCaret, glucose);
    const elapsed = performance.now() - start;
    expect(pred?.insertText).toBe("within 4 hours");
    expect(elapsed).toBeLessThan(15);
  });
});
