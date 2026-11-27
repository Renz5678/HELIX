import { describe, it, expect } from "vitest";
import sepsis from "../../../examples/alert_rule.helix?raw";
import sepsisData from "../../../examples/data/sepsis.json";
import temporalData from "../../../examples/data/temporal.json";
import glucoseData from "../../../examples/data/glucose.json";
import type { Dataset } from "../../src/services/types";
import { getDatasetSchemaIndex } from "../../src/editor/intellisense/schema";
import { indexDocument } from "../../src/editor/intellisense/document-index";
import { analyzeCursorContext } from "../../src/editor/intellisense/context";
import {
  MruTracker,
  computeNameAffinity,
  extractStems,
  scoreCandidate,
  toSortText,
} from "../../src/editor/intellisense/ranking";
import {
  buildCompletions,
  type CompletionCandidate,
} from "../../src/editor/intellisense/completions";

function completeAt(
  srcWithCaret: string,
  dataset: Dataset,
  mru = new MruTracker(),
  filename = "test.helix",
): CompletionCandidate[] {
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
  const ctx = analyzeCursorContext(doc, schema, pos);
  return buildCompletions(doc, schema, ctx, mru, filename);
}

describe("multi-signal prediction ranker and completion builder", () => {
  const sepsisDs = structuredClone(sepsisData) as Dataset;
  const temporalDs = structuredClone(temporalData) as Dataset;
  const glucoseDs = structuredClone(glucoseData) as Dataset;

  it("extracts stems, computes name affinity, scores signals, and formats monotonic sortText", () => {
    expect(extractStems("glucose_data")).toEqual(["glucose"]);
    expect(extractStems("hr_readings")).toEqual(["hr"]);
    expect(extractStems("systolicBPValue")).toEqual(["systolic", "bp"]);
    expect(extractStems("sbp_crit")).toEqual(["sbp", "crit"]);

    expect(computeNameAffinity("sbp_crit", "sbp", "Number")).toBe(180);
    expect(computeNameAffinity("sbp_prev", "sbp", "Number")).toBe(120);
    expect(computeNameAffinity("threshold", "glucose", "Number")).toBe(60);
    expect(computeNameAffinity("threshold", "note", "String")).toBe(0);

    const compat = scoreCandidate({
      base: 920,
      candidateType: "Number",
      expectedType: "Number",
      candidateName: "sbp_crit",
      lhsHintName: "sbp",
      localityBonus: 30,
      mruBoost: 60,
    });
    const incompat = scoreCandidate({
      base: 920,
      candidateType: "String",
      expectedType: "Number",
      candidateName: "note",
      lhsHintName: "sbp",
      localityBonus: 30,
    });
    const syntaxPenalty = scoreCandidate({
      base: 780,
      syntaxOnly: true,
    });
    expect(compat).toBe(1370);
    expect(incompat).toBe(790);
    expect(syntaxPenalty).toBe(530);

    expect(toSortText(1370, "sbp_crit") < toSortText(790, "note")).toBe(true);
    expect(toSortText(0, "a") < toSortText(-50, "a")).toBe(true);
    expect(toSortText(-50, "a") < toSortText(-100, "b")).toBe(true);
  });

  it("maintains in-memory MRU history capped at 100 entries with linear recency decay", () => {
    const mru = new MruTracker();
    expect(mru.boost("within-unit", "days")).toBe(0);

    mru.record("within-unit", "hours");
    expect(mru.boost("within-unit", "hours")).toBe(60);

    mru.record("within-unit", "days");
    expect(mru.boost("within-unit", "days")).toBe(60);
    expect(mru.boost("within-unit", "hours")).toBeLessThan(60);
    expect(mru.boost("within-unit", "hours")).toBeGreaterThan(0);

    for (let i = 0; i < 100; i++) {
      mru.record("rule-body", `item_${i}`);
    }
    expect(mru.boost("within-unit", "hours")).toBe(0);
    expect(mru.boost("within-unit", "days")).toBe(0);
    expect(mru.boost("rule-body", "item_0")).toBeGreaterThan(0);
    expect(mru.boost("rule-body", "item_99")).toBe(60);

    mru.record("rule-body", "item_100");
    expect(mru.boost("rule-body", "item_0")).toBe(0);

    mru.clear();
    expect(mru.boost("rule-body", "item_99")).toBe(0);
    expect(mru.boost("rule-body", "item_100")).toBe(0);
  });

  it("ranks type-compatible and name-affinity variables #1 on comparison RHS", () => {
    const src = [
      "rule Sepsis:",
      "    bind sbp = Vitals.systolic_bp",
      "    end bind",
      '    let note := "ok"',
      "    let temp_high := 38.3",
      "    let sbp_crit := 90",
      "    when sbp.latest < |",
    ].join("\n");
    const items = completeAt(src, sepsisDs);
    expect(items[0]?.label).toBe("sbp_crit");
    const noteIdx = items.findIndex((i) => i.label === "note");
    const sbpIdx = items.findIndex((i) => i.label === "sbp_crit");
    expect(sbpIdx).toBeLessThan(noteIdx === -1 ? Infinity : noteIdx);
  });

  it("never suggests raw table names after 'bind ', suggests Bindings after '=', and suggests real cell values in 'where'", () => {
    const bindLhs = completeAt("rule R:\n    bind |\nend rule", temporalDs);
    expect(bindLhs.some((i) => i.label === "heart_rate_readings")).toBe(false);
    const siteItem = bindLhs.find((i) => i.label === "site");
    expect(siteItem).toBeDefined();
    expect(siteItem?.syntaxOnly).toBe(true);
    expect(siteItem?.detail).toContain("Syntax-only (not evaluated in Studio)");

    const bindRhs = completeAt("rule R:\n    bind hr = |\nend rule", temporalDs);
    expect(bindRhs.some((i) => i.label === "Vitals.heart_rate")).toBe(true);
    expect(bindRhs[0]?.label).toBe("Vitals.heart_rate");

    const whereCols = completeAt(
      "rule R:\n    bind hr = Vitals.heart_rate where |\nend rule",
      temporalDs,
    );
    expect(whereCols.map((i) => i.label)).toContain("status");

    const whereVals = completeAt(
      "rule R:\n    bind hr = Vitals.heart_rate where status == |\nend rule",
      temporalDs,
    );
    expect(whereVals[0]?.insertText).toBe('"final"');

    const whereStringVals = completeAt(
      'rule R:\n    bind hr = Vitals.heart_rate where status == "fi|\nend rule',
      temporalDs,
    );
    expect(whereStringVals[0]?.insertText).toBe("final");
  });

  it("predicts exact innermost end-block closer and ranks executable syntax above syntax-only forms", () => {
    const endWhen = completeAt(
      'rule R:\n    when 1 > 0:\n    then:\n        alert: "x"\n    end |\nend rule',
      sepsisDs,
    );
    expect(endWhen[0]?.label).toBe("when");
    expect(endWhen.map((i) => i.label)).not.toContain("bind");

    const ruleBody = completeAt("rule R:\n    |\nend rule", sepsisDs);
    const bindItem = ruleBody.find((i) => i.label === "bind")!;
    const forItem = ruleBody.find((i) => i.label === "for")!;
    const latestItem = ruleBody.find((i) => i.label === "latest")!;
    expect(bindItem.sortText < forItem.sortText).toBe(true);
    expect(forItem.syntaxOnly).toBe(true);
    expect(forItem.detail).toContain("Syntax-only (not evaluated in Studio)");
    expect(latestItem.syntaxOnly).toBe(true);
    expect(latestItem.detail).toContain("Syntax-only (not evaluated in Studio)");
  });

  it("populates dynamic snippets with active dataset tables instead of hardcoded glucose_data", () => {
    const topItems = completeAt("|", sepsisDs);
    const snippet = topItems.find((i) => i.isSnippet);
    expect(snippet?.insertText).toContain("Vitals");
    expect(snippet?.insertText).not.toContain("glucose_data");

    const ruleBody = completeAt("rule R:\n    |\nend rule", sepsisDs);
    const snippets = ruleBody.filter((i) => i.isSnippet);
    expect(snippets.length).toBeGreaterThanOrEqual(2);
    for (const s of snippets) {
      expect(s.insertText).not.toContain("glucose_data");
    }
    expect(snippets.some((s) => s.insertText.includes("Vitals"))).toBe(true);
  });

  it("searches clinical terminology by description and promotes MRU-accepted items", () => {
    const codes = completeAt(
      'rule R:\n    terminology: LOINC("glucose|\nend rule',
      sepsisDs,
    );
    const firstCode = codes.find((i) => i.insertText === "2339-0");
    expect(firstCode).toBeDefined();
    expect(firstCode?.filterText?.toLowerCase()).toContain("glucose");

    const mru = new MruTracker();
    mru.record("within-unit", "days");
    const units = completeAt(
      "rule R:\n    when 1 > 0 within 10 |\nend rule",
      sepsisDs,
      mru,
    );
    const days = units.find((i) => i.label === "days")!;
    const months = units.find((i) => i.label === "months")!;
    expect(days.sortText < months.sortText).toBe(true);
    expect(months.syntaxOnly).toBe(true);
    expect(months.detail).toContain("Syntax-only (not evaluated in Studio)");
  });

  it("completes sepsis preset comparison RHS, member-access latest > var, and branch scopes", () => {
    const sepsisCmpRhs = sepsis.replace(
      "when (sbp.latest < sbp_crit)",
      "when (sbp.latest < |",
    );
    const cmpItems = completeAt(sepsisCmpRhs, sepsisDs);
    expect(cmpItems[0]?.label).toBe("sbp_crit");
    expect(cmpItems.some((i) => i.label === "temp.latest")).toBe(true);

    const sepsisMember = sepsis.replace(
      "when (sbp.latest < sbp_crit)",
      "when (sbp.|",
    );
    const memberItems = completeAt(sepsisMember, sepsisDs);
    expect(memberItems[0]?.label).toBe("latest");
    expect(memberItems[0]?.preselect).toBe(true);
    expect(memberItems.some((i) => i.label === "latest > sbp_crit")).toBe(true);

    const sepsisWhenStart = sepsis.replace(
      "when (sbp.latest < sbp_crit) and ((temp.latest > temp_high) or (temp.latest < temp_low)):",
      "when |:",
    );
    const startItems = completeAt(sepsisWhenStart, sepsisDs);
    expect(startItems.map((i) => i.label)).toContain("sbp.latest");
    expect(startItems.map((i) => i.label)).toContain("temp.latest");
    expect(startItems.map((i) => i.label)).not.toContain("observation_status");

    const singleNumericLet = completeAt(
      "rule HighGlucose:\n    source glucose_data\n    let threshold := 250\n    when glucose_data.|",
      glucoseDs,
    );
    expect(singleNumericLet[0]?.label).toBe("latest");
    expect(singleNumericLet[1]?.label).toBe("latest > threshold");

    const ambiguousNumericLet = completeAt(
      "rule R:\n    bind temp = Vitals.body_temperature\n    end bind\n    let temp_high := 38.3\n    let temp_low := 36.0\n    when temp.|",
      sepsisDs,
    );
    expect(ambiguousNumericLet[0]?.label).toBe("latest");
    expect(ambiguousNumericLet.some((i) => i.label.startsWith("latest >"))).toBe(
      false,
    );
  });

  it("handles all remaining context kinds including suppression, alerts, branches, member prefixes, and comments/strings", () => {
    expect(completeAt("rule R:\n    # inside comment |\nend rule", sepsisDs)).toEqual(
      [],
    );
    expect(
      completeAt('rule R:\n    intent: "free text |\nend rule', sepsisDs),
    ).toEqual([]);

    const ruleName = completeAt(
      "rule |",
      sepsisDs,
      new MruTracker(),
      "high_glucose_alert.helix",
    );
    expect(ruleName[0]?.label).toBe("HighGlucoseAlert");

    const vitalsPrefix = completeAt(
      "rule R:\n    bind hr = Vitals.|\nend rule",
      temporalDs,
    );
    expect(vitalsPrefix.map((i) => i.label)).toContain("heart_rate");

    const branchWithOtherwise = completeAt(
      'rule R:\n    when 1 > 0:\n    then:\n        |\n    otherwise:\n        alert: "ok"\n    end when\nend rule',
      sepsisDs,
    );
    expect(branchWithOtherwise.map((i) => i.label)).not.toContain("otherwise");
    expect(branchWithOtherwise.map((i) => i.label)).toContain("alert");

    const branchNoOtherwise = completeAt(
      "rule R:\n    when 1 > 0:\n    then:\n        |\n    end when\nend rule",
      sepsisDs,
    );
    expect(branchNoOtherwise.map((i) => i.label)).toContain("otherwise");

    const alertArg0 = completeAt(
      "rule R:\n    when 1 > 0:\n    then:\n        alert: |\n    end when\nend rule",
      sepsisDs,
    );
    const levelItem = alertArg0.find((i) => i.label === "level:");
    expect(levelItem?.syntaxOnly).toBe(true);
    expect(levelItem?.detail).toContain("Syntax-only (not evaluated in Studio)");

    const alertArg1 = completeAt(
      'rule R:\n    when 1 > 0:\n    then:\n        alert: "Msg", |\n    end when\nend rule',
      sepsisDs,
    );
    expect(alertArg1[0]?.insertText).toBe('"WARNING"');

    const alertSeverityStr = completeAt(
      'rule R:\n    when 1 > 0:\n    then:\n        alert: "Msg", "C|\n    end when\nend rule',
      sepsisDs,
    );
    expect(alertSeverityStr[0]?.insertText).toBe("CRITICAL");

    const suppressOp = completeAt(
      "rule R:\n    when 1 > 0:\n    then:\n        suppress: |\n    end when\nend rule",
      sepsisDs,
    );
    const repeatOf = suppressOp.find((i) => i.label === "repeat_of:");
    expect(repeatOf?.syntaxOnly).toBe(true);
    expect(repeatOf?.detail).toContain("Syntax-only (not evaluated in Studio)");

    const repeatTarget = completeAt(
      "rule FirstRule:\nend rule\nrule SecondRule:\n    suppress: repeat_of: |\nend rule",
      sepsisDs,
    );
    expect(repeatTarget.map((i) => i.label)).toContain("FirstRule");
    expect(repeatTarget.map((i) => i.label)).toContain("SecondRule");

    const sourceTarget = completeAt(
      "rule R:\n    source |\nend rule",
      sepsisDs,
    );
    expect(sourceTarget.map((i) => i.label)).toContain("Vitals");
    expect(sourceTarget.map((i) => i.label)).toContain("EHR");

    const sourceArrow = completeAt(
      "rule R:\n    source: EHR -> |\nend rule",
      sepsisDs,
    );
    expect(sourceArrow.map((i) => i.label)).toEqual(["FHIR_R4", "HL7v2", "OMOP"]);

    const termSys = completeAt(
      "rule R:\n    terminology: |\nend rule",
      sepsisDs,
    );
    expect(termSys.map((i) => i.label)).toEqual(["LOINC", "SNOMED", "RxNorm"]);
  });

  it("covers bind-clause, bind-site-body, let slots, condition operators, alert payload, within presets, and unquoted terminology", () => {
    const bindClause = completeAt(
      "rule R:\n    bind hr = Vitals.heart_rate |\nend rule",
      temporalDs,
    );
    expect(bindClause.map((i) => i.label)).toEqual(["where", "within", "end bind"]);

    const bindSiteBody = completeAt(
      "rule R:\n    bind site: ICU\n        |\n    end bind\nend rule",
      sepsisDs,
    );
    expect(bindSiteBody.map((i) => i.label)).toContain("source");
    expect(bindSiteBody.find((i) => i.label === "site")?.syntaxOnly).toBe(true);

    const letName = completeAt(
      "rule R:\n    bind sbp = Vitals.systolic_bp\n    end bind\n    let |\nend rule",
      sepsisDs,
    );
    expect(letName.map((i) => i.label)).toContain("threshold");
    expect(letName.map((i) => i.label)).toContain("sbp_crit");

    const letRhs = completeAt(
      "rule R:\n    bind sbp = Vitals.systolic_bp\n    end bind\n    let a := 100\n    let b := |\nend rule",
      sepsisDs,
    );
    expect(letRhs[0]?.label).toBe("sbp.latest");
    expect(letRhs.map((i) => i.label)).toContain("a");
    expect(letRhs.find((i) => i.label === "latest")?.syntaxOnly).toBe(true);

    const afterOp = completeAt(
      "rule R:\n    bind sbp = Vitals.systolic_bp\n    end bind\n    when sbp.latest |\nend rule",
      sepsisDs,
    );
    expect(afterOp.map((i) => i.label)).toContain(">");
    expect(afterOp.map((i) => i.label)).toContain("and");
    expect(afterOp.map((i) => i.label)).toContain("then:");

    const alertPayload = completeAt(
      'rule R:\n    bind sbp = Vitals.systolic_bp\n    end bind\n    when sbp.latest < 90:\n    then:\n        alert: "Low", "CRITICAL", |\n    end when\nend rule',
      sepsisDs,
    );
    expect(alertPayload[0]?.label).toBe("sbp.latest");

    const withinAmount = completeAt(
      "rule R:\n    when 1 > 0 within |\nend rule",
      sepsisDs,
    );
    expect(withinAmount.map((i) => i.label)).toContain("15 minutes");
    expect(withinAmount.map((i) => i.label)).toContain("4 hours");

    const withinPost = completeAt(
      "rule R:\n    when 1 > 0 within 30 minutes |\nend rule",
      sepsisDs,
    );
    expect(withinPost.map((i) => i.label)).toContain("before now");
    expect(withinPost.map((i) => i.label)).toContain("then:");

    const unquotedTerm = completeAt(
      "rule R:\n    terminology: LOINC(|\nend rule",
      sepsisDs,
    );
    expect(unquotedTerm[0]?.insertText).toBe('"2339-0"');
  });

  it("enforces locality bonus, suppresses latest > var after comparison operator, isolates multi-rule scopes, and handles empty datasets", () => {
    const localityItems = completeAt(
      [
        "rule R:",
        "    bind sbp = Vitals.systolic_bp",
        "    end bind",
        "    let older_val := 80",
        "    let spacer_a := 1",
        "    let spacer_b := 2",
        "    let newer_val := 90",
        "    when sbp.latest < |",
      ].join("\n"),
      sepsisDs,
    );
    const newerIdx = localityItems.findIndex((i) => i.label === "newer_val");
    const olderIdx = localityItems.findIndex((i) => i.label === "older_val");
    expect(newerIdx).toBeGreaterThanOrEqual(0);
    expect(olderIdx).toBeGreaterThan(newerIdx);

    const memberAfterCmp = completeAt(
      [
        "rule R:",
        "    bind sbp = Vitals.systolic_bp",
        "    end bind",
        "    bind temp = Vitals.body_temperature",
        "    end bind",
        "    let temp_high := 38.3",
        "    when sbp.latest < temp.|",
      ].join("\n"),
      sepsisDs,
    );
    expect(memberAfterCmp[0]?.label).toBe("latest");
    expect(memberAfterCmp.some((i) => i.label.startsWith("latest >"))).toBe(
      false,
    );

    const multiRule = completeAt(
      [
        "rule Rule1:",
        "    bind sbp = Vitals.systolic_bp",
        "    end bind",
        "    when sbp.latest < 90:",
        "    then:",
        "        let only_then := 1",
        "    otherwise:",
        "        let only_otherwise := 2",
        "rule Rule2:",
        "    bind temp = Vitals.body_temperature",
        "    end bind",
        "    when temp.latest > |",
      ].join("\n"),
      sepsisDs,
    );
    expect(multiRule.map((i) => i.label)).not.toContain("only_then");
    expect(multiRule.map((i) => i.label)).not.toContain("only_otherwise");
    expect(multiRule.map((i) => i.label)).not.toContain("sbp.latest");

    const multiRuleEnd = completeAt(
      [
        "rule Rule1:",
        "    when 1 > 0:",
        "rule Rule2:",
        "    end |",
      ].join("\n"),
      sepsisDs,
    );
    expect(multiRuleEnd.map((i) => i.label)).toEqual(["rule"]);

    const emptyDataset: Dataset = {
      schemaVersion: 1,
      evaluationTime: "2026-10-31T12:00:00Z",
      Bindings: {},
      tables: [
        {
          name: "NullReadings",
          patientIdColumn: "patient_id",
          timestampColumn: "timestamp",
          defaultValueColumn: "reading_val",
          columns: [
            { name: "patient_id", type: "String" },
            { name: "timestamp", type: "DateTime" },
            { name: "reading_val", type: "Float" },
            { name: "status", type: "String" },
          ],
          rows: [
            {
              patient_id: null,
              timestamp: null,
              reading_val: null,
              status: null,
            },
          ],
        },
      ],
    };
    const topEmpty = completeAt("|", emptyDataset);
    expect(topEmpty.find((i) => i.isSnippet)?.insertText).toContain("NullReadings");
    expect(topEmpty.find((i) => i.isSnippet)?.insertText).not.toContain("glucose_data");

    const zeroTableDataset: Dataset = {
      schemaVersion: 1,
      evaluationTime: "2026-10-31T12:00:00Z",
      Bindings: {},
      tables: [],
    };
    const topZero = completeAt("|", zeroTableDataset);
    expect(topZero.find((i) => i.isSnippet)?.insertText).not.toContain("glucose_data");
    const whereZero = completeAt(
      "rule R:\n    bind x = Missing.col where status == |\nend rule",
      zeroTableDataset,
    );
    expect(Array.isArray(whereZero)).toBe(true);
  });

  it("never emits true/false literals for Boolean tables, marks parser-only duration units syntax-only, prevents duplicate before-now, and avoids .latest.latest", () => {
    const boolDataset: Dataset = {
      schemaVersion: 1,
      evaluationTime: "2026-10-31T12:00:00Z",
      Bindings: {},
      tables: [
        {
          name: "Flags",
          patientIdColumn: "patient_id",
          timestampColumn: "timestamp",
          defaultValueColumn: "active",
          columns: [
            { name: "patient_id", type: "String" },
            { name: "timestamp", type: "DateTime" },
            { name: "active", type: "Boolean" },
          ],
          rows: [
            {
              patient_id: "P1",
              timestamp: "2026-10-31T11:00:00Z",
              active: true,
            },
            {
              patient_id: "P2",
              timestamp: "2026-10-31T11:05:00Z",
              active: false,
            },
          ],
        },
      ],
    };

    const topBool = completeAt("|", boolDataset);
    const topSnippet = topBool.find((i) => i.isSnippet)?.insertText ?? "";
    expect(topSnippet).toContain(".latest:");
    expect(topSnippet).not.toMatch(/\b(?:true|false)\b/);
    expect(topSnippet).not.toContain("expected_flag");

    const bodyBool = completeAt("rule R:\n    |\nend rule", boolDataset);
    for (const s of bodyBool.filter((i) => i.isSnippet)) {
      expect(s.insertText).not.toMatch(/\b(?:true|false)\b/);
    }

    const whereBool = completeAt(
      "rule R:\n    bind f = Flags where active == |\nend rule",
      boolDataset,
    );
    expect(whereBool.map((i) => i.label)).not.toContain("true");
    expect(whereBool.map((i) => i.label)).not.toContain("false");

    const cmpBool = completeAt(
      "rule R:\n    bind f = Flags\n    end bind\n    when f.latest == |\nend rule",
      boolDataset,
    );
    expect(cmpBool.map((i) => i.label)).not.toContain("true");
    expect(cmpBool.map((i) => i.label)).not.toContain("false");

    // Duration units C11 parity: only s/m/h/d + singular/plural forms are evaluated
    const units = completeAt(
      "rule R:\n    when 1 > 0 within 10 |\nend rule",
      sepsisDs,
    );
    const days = units.find((i) => i.label === "days")!;
    const minutes = units.find((i) => i.label === "minutes")!;
    expect(days.syntaxOnly).toBeUndefined();
    expect(minutes.syntaxOnly).toBeUndefined();
    for (const parserOnly of [
      "weeks",
      "week",
      "w",
      "wk",
      "wks",
      "min",
      "mins",
      "hr",
      "hrs",
      "sec",
      "secs",
      "months",
      "years",
    ]) {
      const item = units.find((i) => i.label === parserOnly);
      expect(item).toBeDefined();
      expect(item?.syntaxOnly).toBe(true);
      expect(item?.detail).toContain("Syntax-only");
      expect(item!.sortText > days.sortText).toBe(true);
      expect(item!.sortText > minutes.sortText).toBe(true);
    }

    // Prevent duplicate `before before now`
    const afterBefore = completeAt(
      "rule R:\n    when 1 > 0 within 30 minutes before |\nend rule",
      sepsisDs,
    );
    expect(afterBefore.map((i) => i.label)).toContain("now");
    expect(afterBefore.map((i) => i.label)).not.toContain("before now");

    // Prevent `.latest.` suggesting `.latest` again
    const afterLatestBind = completeAt(
      "rule R:\n    bind sbp = Vitals.systolic_bp\n    end bind\n    when sbp.latest.|\nend rule",
      sepsisDs,
    );
    expect(afterLatestBind.map((i) => i.label)).not.toContain("latest");

    const afterLatestCol = completeAt(
      "rule R:\n    source Vitals\n    when Vitals.systolic_bp.latest.|\nend rule",
      sepsisDs,
    );
    expect(afterLatestCol.map((i) => i.label)).not.toContain("latest");
  });
});
