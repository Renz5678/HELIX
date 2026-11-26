import { describe, it, expect } from "vitest";
import sepsisData from "../../../examples/data/sepsis.json";
import temporalData from "../../../examples/data/temporal.json";
import type { Dataset } from "../../src/services/types";
import { getDatasetSchemaIndex } from "../../src/editor/intellisense/schema";
import { indexDocument } from "../../src/editor/intellisense/document-index";
import {
  analyzeCursorContext,
  type CursorContextKind,
} from "../../src/editor/intellisense/context";

function ctxAt(srcWithCaret: string, dataset: Dataset) {
  const idx = srcWithCaret.indexOf("|");
  if (idx === -1) {
    throw new Error("Missing '|' caret marker in test input");
  }
  const src = srcWithCaret.slice(0, idx) + srcWithCaret.slice(idx + 1);
  const before = src.slice(0, idx).split("\n");
  const pos = {
    lineNumber: before.length,
    column: before[before.length - 1].length + 1,
  };
  const schema = getDatasetSchemaIndex(dataset);
  const doc = indexDocument(src, schema);
  return analyzeCursorContext(doc, schema, pos);
}

describe("grammar-state cursor context classifier", () => {
  const sepsis = structuredClone(sepsisData) as Dataset;
  const temporal = structuredClone(temporalData) as Dataset;

  it("suppresses comments and free-text strings, but classifies terminology, severity, and where strings", () => {
    expect(ctxAt("rule R:\n    # hi |\nend rule", sepsis).kind).toBe("comment");
    expect(ctxAt('rule R:\n    intent: "Detect |"\nend rule', sepsis).kind).toBe(
      "string-literal",
    );
    expect(
      ctxAt('rule R:\n    terminology: LOINC("glu|\nend rule', sepsis),
    ).toMatchObject({
      kind: "terminology-code",
      terminologySystem: "LOINC",
      prefix: "glu",
    });
    expect(
      ctxAt(
        'rule R:\n    when 1 > 0:\n    then:\n        alert: "Msg", "W|\n    end when\nend rule',
        sepsis,
      ).kind,
    ).toBe("alert-severity-string");
    expect(
      ctxAt(
        'rule R:\n    bind hr = Vitals.heart_rate where status == "fi|\nend rule',
        temporal,
      ),
    ).toMatchObject({
      kind: "where-string-value",
      resolvedTableName: "heart_rate_readings",
      resolvedColumnName: "status",
      prefix: "fi",
    });
  });

  it("distinguishes bind LHS vs RHS, where columns, dot access, comparison RHS types, and exact end blocks", () => {
    expect(ctxAt("|", sepsis).kind).toBe("top-level");
    expect(ctxAt("rule R:\n    bind |\nend rule", temporal).kind).toBe("bind-name");
    expect(ctxAt("rule R:\n    bind hr = |\nend rule", temporal)).toMatchObject({
      kind: "bind-rhs",
      bindAlias: "hr",
    });
    expect(
      ctxAt("rule R:\n    bind hr = Vitals.heart_rate where |\nend rule", temporal),
    ).toMatchObject({
      kind: "where-column",
      resolvedTableName: "heart_rate_readings",
    });
    expect(
      ctxAt("rule R:\n    bind hr = Vitals.|\nend rule", temporal),
    ).toMatchObject({
      kind: "member-access",
      memberOwner: "Vitals",
    });
    expect(
      ctxAt(
        "rule R:\n    bind sbp = Vitals.systolic_bp\n    end bind\n    when sbp.latest < |\n",
        sepsis,
      ),
    ).toMatchObject({
      kind: "comparison-rhs",
      expectedType: "Number",
      lhsHintName: "sbp",
    });
    expect(
      ctxAt(
        'rule R:\n    when 1 > 0:\n    then:\n        alert: "x"\n    end |\nend rule',
        sepsis,
      ),
    ).toMatchObject({
      kind: "end-block",
      expectedBlockEnd: "when",
    });
  });

  it("classifies within units, suppress repeat_of, and alert argument positions", () => {
    expect(
      ctxAt("rule R:\n    when 1 > 0 within 30 |\nend rule", temporal),
    ).toMatchObject({
      kind: "within-unit",
      withinNumber: 30,
    });
    expect(
      ctxAt("rule R:\n    suppress: repeat_of: |\nend rule", temporal).kind,
    ).toBe("suppress-repeat-target");
    expect(
      ctxAt(
        'rule R:\n    when 1 > 0:\n    then:\n        alert: "High", "WARNING", |\n    end when\nend rule',
        temporal,
      ),
    ).toMatchObject({
      kind: "alert-arg",
      alertArgIndex: 2,
    });
  });

  it("handles comment start boundary vs inside comment and string quote boundaries", () => {
    // Strictly before '#' (offset === comment.startOffset) is NOT inside comment
    const beforeHash = ctxAt("rule R:\n    bind hr = |# comment\nend rule", temporal);
    expect(beforeHash).toMatchObject({
      kind: "bind-rhs",
      bindAlias: "hr",
    });

    // Right after '#' IS inside comment
    expect(ctxAt("rule R:\n    bind hr = #| comment\nend rule", temporal).kind).toBe(
      "comment",
    );

    // Closed terminology strings with () and [] and inner replaceRange
    const snomed = ctxAt(
      'rule R:\n    terminology: SNOMED["913|02008"]\nend rule',
      sepsis,
    );
    expect(snomed).toMatchObject({
      kind: "terminology-code",
      terminologySystem: "SNOMED",
      prefix: "913",
      replaceRange: {
        startLineNumber: 2,
        startColumn: 26,
        endLineNumber: 2,
        endColumn: 34,
      },
    });

    const rxnorm = ctxAt(
      'rule R:\n    terminology: RxNorm("860|\nend rule',
      sepsis,
    );
    expect(rxnorm).toMatchObject({
      kind: "terminology-code",
      terminologySystem: "RxNorm",
      prefix: "860",
    });

    // Arg 0 alert string is free text, while arg >= 1 is alert-severity-string
    expect(
      ctxAt(
        'rule R:\n    when 1 > 0:\n    then:\n        alert: "Msg|\n    end when\nend rule',
        sepsis,
      ).kind,
    ).toBe("string-literal");
    expect(
      ctxAt(
        'rule R:\n    when 1 > 0:\n    then:\n        alert: "Msg", "WAR|" \n    end when\nend rule',
        sepsis,
      ),
    ).toMatchObject({
      kind: "alert-severity-string",
      alertArgIndex: 1,
      prefix: "WAR",
      replaceRange: {
        startLineNumber: 4,
        startColumn: 24,
        endLineNumber: 4,
        endColumn: 27,
      },
    });

    // Cursor right after closing quote is outside the string
    expect(
      ctxAt(
        'rule R:\n    when 1 > 0:\n    then:\n        alert: "Msg"|\n    end when\nend rule',
        sepsis,
      ).kind,
    ).toBe("alert-arg");
  });

  it("classifies all remaining syntactic code slots and chained member access accurately", () => {
    const seen = new Set<CursorContextKind>();
    const check = (src: string, ds: Dataset = sepsis) => {
      const c = ctxAt(src, ds);
      seen.add(c.kind);
      return c;
    };

    expect(check("rule |")).toMatchObject({ kind: "rule-name", prefix: "" });
    expect(check("rule My|")).toMatchObject({
      kind: "rule-name",
      prefix: "My",
      replaceRange: { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 8 },
    });
    expect(check("rule R:\n    |\nend rule")).toMatchObject({
      kind: "rule-body",
      inRule: true,
      inWhen: false,
      inBind: false,
    });
    expect(
      check("rule R:\n    bind hr = Vitals.heart_rate |\nend rule", temporal),
    ).toMatchObject({
      kind: "bind-clause",
      bindAlias: "hr",
      resolvedTableName: "heart_rate_readings",
      inBind: true,
    });
    expect(
      check("rule R:\n    bind hr = Vitals.heart_rate\n    |\nend rule", temporal),
    ).toMatchObject({
      kind: "bind-clause",
      bindAlias: "hr",
      resolvedTableName: "heart_rate_readings",
      inBind: true,
    });
    expect(
      check("rule R:\n    bind site: ICU\n    |\nend bind\nend rule"),
    ).toMatchObject({
      kind: "bind-site-body",
      inBind: true,
    });
    expect(check("rule R:\n    source |\nend rule")).toMatchObject({
      kind: "source-target",
    });
    expect(check("rule R:\n    source: EHR -> |\nend rule")).toMatchObject({
      kind: "source-arrow",
    });
    expect(check("rule R:\n    let |\nend rule")).toMatchObject({
      kind: "let-name",
    });
    expect(check("rule R:\n    let threshold := |\nend rule")).toMatchObject({
      kind: "let-rhs",
    });
    expect(
      check("rule R:\n    bind hr = Vitals.heart_rate where status == |\nend rule", temporal),
    ).toMatchObject({
      kind: "where-value",
      resolvedTableName: "heart_rate_readings",
      resolvedColumnName: "status",
      expectedType: "String",
    });
    expect(check("rule R:\n    when |\nend rule")).toMatchObject({
      kind: "when-condition-start",
      inWhen: true,
      hasThen: false,
      hasOtherwise: false,
    });
    expect(check("rule R:\n    when 1 > 0 |\nend rule")).toMatchObject({
      kind: "when-condition-after-operand",
      inWhen: true,
    });
    expect(
      check("rule R:\n    when 1 > 0:\n    then:\n        |\n    end when\nend rule"),
    ).toMatchObject({
      kind: "branch-body",
      inWhen: true,
      hasThen: true,
      hasOtherwise: false,
    });
    expect(
      check(
        'rule R:\n    when 1 > 0:\n    then:\n        alert: "x"\n    otherwise:\n        |\n    end when\nend rule',
      ),
    ).toMatchObject({
      kind: "branch-body",
      inWhen: true,
      hasThen: true,
      hasOtherwise: true,
    });
    expect(check("rule R:\n    suppress: |\nend rule")).toMatchObject({
      kind: "suppress-operand",
    });
    expect(check("rule R:\n    when 1 > 0 within |\nend rule")).toMatchObject({
      kind: "within-amount",
    });
    expect(
      check("rule R:\n    when 1 > 0 within 30 minutes |\nend rule"),
    ).toMatchObject({
      kind: "within-post",
      withinNumber: 30,
    });
    expect(check("rule R:\n    terminology: |\nend rule")).toMatchObject({
      kind: "terminology-system",
    });
    expect(
      check("rule R:\n    terminology: potassium -> |\nend rule"),
    ).toMatchObject({
      kind: "terminology-system",
    });

    // Chained dot access
    expect(
      check("rule R:\n    when Vitals.systolic_bp.|\nend rule"),
    ).toMatchObject({
      kind: "member-access",
      memberOwner: "Vitals.systolic_bp",
      memberChain: ["Vitals", "systolic_bp"],
      resolvedTableName: "Vitals",
      resolvedColumnName: "systolic_bp",
    });

    // Partial word replaceRange & keyword-prefix non-hijacking
    expect(check("rule R:\n    end|")).toMatchObject({
      kind: "rule-body",
      prefix: "end",
      replaceRange: { startLineNumber: 2, startColumn: 5, endLineNumber: 2, endColumn: 8 },
    });
    expect(check("rule R:\n    bind|\nend rule")).toMatchObject({
      kind: "rule-body",
      prefix: "bind",
      replaceRange: { startLineNumber: 2, startColumn: 5, endLineNumber: 2, endColumn: 9 },
    });
    expect(check("rule R:\n    bind hr = Vitals.heart_rate\n    end |\nend rule", temporal)).toMatchObject({
      kind: "end-block",
      expectedBlockEnd: "bind",
    });
    expect(check("rule R:\n    end wh|\nend rule")).toMatchObject({
      kind: "end-block",
      expectedBlockEnd: "rule",
      prefix: "wh",
    });
    expect(check("rule R:\n    when 1 > 0:\n    then:\n        alert: \"x\"\n    end when|\nend rule")).toMatchObject({
      kind: "end-block",
      expectedBlockEnd: "when",
      prefix: "when",
    });

    // Comparison LHS type inference for <series>.<col>.latest, arithmetic, and let strings
    expect(
      check(
        "rule R:\n    bind hr = Vitals.heart_rate\n    end bind\n    when hr.status.latest == |\nend rule",
        temporal,
      ),
    ).toMatchObject({
      kind: "comparison-rhs",
      expectedType: "String",
      lhsHintName: "status",
    });
    expect(
      check(
        'rule R:\n    let note := "ok"\n    when note == |\nend rule',
      ),
    ).toMatchObject({
      kind: "comparison-rhs",
      expectedType: "String",
      lhsHintName: "note",
    });
    expect(
      check(
        "rule R:\n    bind sbp = Vitals.systolic_bp\n    end bind\n    when sbp.latest + 10 < |\nend rule",
      ),
    ).toMatchObject({
      kind: "comparison-rhs",
      expectedType: "Number",
      lhsHintName: "sbp",
    });

    // Closed child block does not leak into enclosing branch-body
    expect(
      check(
        'rule R:\n    when 1 > 0:\n    then:\n        when 2 > 1:\n        then:\n            alert: "inner"\n        end when\n        |\n    end when\nend rule',
      ),
    ).toMatchObject({
      kind: "branch-body",
      inWhen: true,
      hasThen: true,
      hasOtherwise: false,
    });

    // Completed single-line statements do not leak onto next line
    expect(
      ctxAt('rule R:\n    source Vitals\n    let x := 1\n    |\nend rule', sepsis).kind,
    ).toBe("rule-body");
    expect(
      ctxAt(
        'rule R:\n    when 1 > 0:\n    then:\n        suppress: within 4 hours\n        |\n    end when\nend rule',
        sepsis,
      ).kind,
    ).toBe("branch-body");

    // Typing then/otherwise keywords keeps hasThen/hasOtherwise false until complete,
    // and mid-typing `when sbp.latest |` resolves as when-condition-after-operand
    expect(
      ctxAt("rule R:\n    when 1 > 0:\n    then|", sepsis),
    ).toMatchObject({
      kind: "when-condition-after-operand",
      hasThen: false,
      prefix: "then",
    });
    expect(
      ctxAt("rule R:\n    bind sbp = Vitals.systolic_bp\n    end bind\n    when sbp.latest |", sepsis),
    ).toMatchObject({
      kind: "when-condition-after-operand",
      inWhen: true,
    });
    expect(
      ctxAt("rule R:\n    let x := (1 + |\nend rule", sepsis).kind,
    ).toBe("let-rhs");
    expect(
      ctxAt("rule R:\n    when latest heart_rate_readings where status == |\nend rule", temporal),
    ).toMatchObject({
      kind: "where-value",
      resolvedTableName: "heart_rate_readings",
      resolvedColumnName: "status",
      expectedType: "String",
    });

    // Verify all 31 CursorContextKind values are covered across our assertions
    const all31: CursorContextKind[] = [
      "comment",
      "string-literal",
      "terminology-code",
      "alert-severity-string",
      "where-string-value",
      "top-level",
      "rule-name",
      "rule-body",
      "bind-name",
      "bind-rhs",
      "bind-clause",
      "bind-site-body",
      "source-target",
      "source-arrow",
      "let-name",
      "let-rhs",
      "where-column",
      "where-value",
      "member-access",
      "when-condition-start",
      "when-condition-after-operand",
      "comparison-rhs",
      "branch-body",
      "alert-arg",
      "suppress-operand",
      "suppress-repeat-target",
      "within-amount",
      "within-unit",
      "within-post",
      "terminology-system",
      "end-block",
    ];
    const allExercised = new Set<CursorContextKind>([
      ...seen,
      ctxAt("rule R:\n    # hi |\nend rule", sepsis).kind,
      ctxAt('rule R:\n    intent: "Detect |"\nend rule', sepsis).kind,
      ctxAt('rule R:\n    terminology: LOINC("glu|\nend rule', sepsis).kind,
      ctxAt('rule R:\n    when 1 > 0:\n    then:\n        alert: "Msg", "W|\n    end when\nend rule', sepsis).kind,
      ctxAt('rule R:\n    bind hr = Vitals.heart_rate where status == "fi|\nend rule', temporal).kind,
      ctxAt("|", sepsis).kind,
      ctxAt("rule R:\n    bind |\nend rule", temporal).kind,
      ctxAt("rule R:\n    bind hr = |\nend rule", temporal).kind,
      ctxAt("rule R:\n    bind hr = Vitals.heart_rate where |\nend rule", temporal).kind,
      ctxAt("rule R:\n    bind sbp = Vitals.systolic_bp\n    end bind\n    when sbp.latest < |\n", sepsis).kind,
      ctxAt("rule R:\n    when 1 > 0 within 30 |\nend rule", temporal).kind,
      ctxAt("rule R:\n    suppress: repeat_of: |\nend rule", temporal).kind,
      ctxAt('rule R:\n    when 1 > 0:\n    then:\n        alert: "High", "WARNING", |\n    end when\nend rule', temporal).kind,
    ]);
    expect(allExercised.size).toBe(31);
    for (const kind of all31) {
      expect(allExercised.has(kind)).toBe(true);
    }
  });

  it("handles CRLF line endings cleanly", () => {
    const c = ctxAt(
      'rule R:\r\n    bind hr = Vitals.heart_rate where status == "fi|\r\nend rule',
      temporal,
    );
    expect(c).toMatchObject({
      kind: "where-string-value",
      resolvedTableName: "heart_rate_readings",
      resolvedColumnName: "status",
      prefix: "fi",
    });
  });

  it("handles decimal numeric entry without hijacking as member-access and supports parenthesized where/comparison RHS", () => {
    // Issue 1: numeric decimal entry after '.' must not become member-access
    expect(
      ctxAt(
        "rule R:\n    bind sbp = Vitals.systolic_bp\n    end bind\n    when sbp.latest > 1.|\nend rule",
        sepsis,
      ),
    ).toMatchObject({
      kind: "comparison-rhs",
      expectedType: "Number",
      lhsHintName: "sbp",
    });
    expect(ctxAt("rule R:\n    let t := 38.|\nend rule", sepsis).kind).toBe(
      "let-rhs",
    );

    // Issue 2a: parenthesized where clauses in when/let
    expect(
      ctxAt(
        'rule R:\n    when latest heart_rate_readings where (status == "fi|\nend rule',
        temporal,
      ),
    ).toMatchObject({
      kind: "where-string-value",
      resolvedTableName: "heart_rate_readings",
      resolvedColumnName: "status",
      prefix: "fi",
    });
    expect(
      ctxAt(
        "rule R:\n    when latest heart_rate_readings where (status == |\nend rule",
        temporal,
      ),
    ).toMatchObject({
      kind: "where-value",
      resolvedTableName: "heart_rate_readings",
      resolvedColumnName: "status",
      expectedType: "String",
    });
    expect(
      ctxAt(
        "rule R:\n    when latest heart_rate_readings where (|\nend rule",
        temporal,
      ),
    ).toMatchObject({
      kind: "where-column",
      resolvedTableName: "heart_rate_readings",
    });

    // Issue 2b: parenthesized comparison RHS vs parenthesized boolean clause
    expect(
      ctxAt(
        "rule R:\n    bind sbp = Vitals.systolic_bp\n    end bind\n    when sbp.latest < (|\nend rule",
        sepsis,
      ),
    ).toMatchObject({
      kind: "comparison-rhs",
      expectedType: "Number",
      lhsHintName: "sbp",
    });
    expect(
      ctxAt(
        "rule R:\n    bind sbp = Vitals.systolic_bp\n    end bind\n    when sbp.latest < (10 + |\nend rule",
        sepsis,
      ),
    ).toMatchObject({
      kind: "comparison-rhs",
      expectedType: "Number",
      lhsHintName: "sbp",
    });
    expect(
      ctxAt(
        "rule R:\n    bind sbp = Vitals.systolic_bp\n    end bind\n    when (sbp.latest < 90) and (|\nend rule",
        sepsis,
      ).kind,
    ).toBe("when-condition-start");
    expect(
      ctxAt(
        "rule R:\n    bind sbp = Vitals.systolic_bp\n    end bind\n    when (sbp.latest < (10 + |\nend rule",
        sepsis,
      ),
    ).toMatchObject({
      kind: "comparison-rhs",
      expectedType: "Number",
      lhsHintName: "sbp",
    });
    expect(
      ctxAt(
        "rule R:\n    bind sbp = Vitals.systolic_bp\n    end bind\n    when sbp.latest < (1.|\nend rule",
        sepsis,
      ),
    ).toMatchObject({
      kind: "comparison-rhs",
      expectedType: "Number",
      lhsHintName: "sbp",
    });
    expect(
      ctxAt(
        'rule R:\n    when (latest heart_rate_readings where status == "final") and (|\nend rule',
        temporal,
      ).kind,
    ).toBe("when-condition-start");
    expect(
      ctxAt(
        "rule R:\n    bind hr = Vitals.heart_rate where value > 38.|\nend rule",
        temporal,
      ),
    ).toMatchObject({
      kind: "where-value",
      resolvedTableName: "heart_rate_readings",
      resolvedColumnName: "value",
      expectedType: "Number",
    });

    // Item 4: withinHasBefore distinguishes `within <num> <unit> |` vs `within <num> <unit> before |`
    expect(
      ctxAt("rule R:\n    when 1 > 0 within 30 minutes before |\nend rule", sepsis),
    ).toMatchObject({
      kind: "within-post",
      withinNumber: 30,
      withinHasBefore: true,
    });
    expect(
      ctxAt("rule R:\n    when 1 > 0 within 30 minutes |\nend rule", sepsis)
        .withinHasBefore,
    ).toBeFalsy();

    // Item 7: alert-severity-string is restricted to argIndex === 1 || hasLevelPrefix
    expect(
      ctxAt(
        'rule R:\n    when 1 > 0:\n    then:\n        alert: "Msg", "WARNING", "extra|\n    end when\nend rule',
        sepsis,
      ).kind,
    ).toBe("string-literal");
    expect(
      ctxAt(
        'rule R:\n    when 1 > 0:\n    then:\n        alert: level: "W|\n    end when\nend rule',
        sepsis,
      ).kind,
    ).toBe("alert-severity-string");
  });
});
