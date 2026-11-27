import { describe, it, expect } from "vitest";
import sepsis from "../../../examples/alert_rule.helix?raw";
import sepsisData from "../../../examples/data/sepsis.json";
import temporal from "../../../examples/temporal_rule.helix?raw";
import temporalData from "../../../examples/data/temporal.json";
import high from "../../../examples/high_glucose_alert.helix?raw";
import basic from "../../../examples/basic_rule.helix?raw";
import invalid from "../../../examples/invalid_syntax_demo.helix?raw";
import latestObs from "../../../tests/parser/test_latest_observation.helix?raw";
import multiRules from "../../../tests/parser/test_multiple_rules.helix?raw";
import type { Dataset } from "../../src/services/types";
import { getDatasetSchemaIndex } from "../../src/editor/intellisense/schema";
import {
  indexDocument,
  openBlocksAt,
  activeRuleAt,
  visibleSymbolsAt,
  findReferenceAtOffset,
  findTerminologyAtOffset,
} from "../../src/editor/intellisense/document-index";

describe("error-tolerant document index", () => {
  it("extracts rules, bindings, inferred let types, terminology calls, and branch scopes", () => {
    const schema = getDatasetSchemaIndex(structuredClone(sepsisData) as Dataset);
    const doc = indexDocument(sepsis, schema);
    expect(doc.blocks.filter((b) => b.kind === "rule").map((b) => b.name)).toEqual([
      "SepsisEarlyWarningRule",
    ]);
    const sbp = doc.symbols.find((s) => s.name === "sbp");
    expect(sbp?.kind).toBe("bind");
    expect(sbp?.resolvedTarget).toMatchObject({ tableName: "Vitals", columnName: "systolic_bp" });

    const sbpCrit = doc.symbols.find((s) => s.name === "sbp_crit");
    expect(sbpCrit?.valueType).toBe("Number");
    expect(sbpCrit?.initializerPreview).toBe("90");

    const obsStatus = doc.symbols.find((s) => s.name === "observation_status");
    expect(obsStatus?.valueType).toBe("String");

    const snomedOffset = sepsis.indexOf("91302008");
    expect(findTerminologyAtOffset(doc, snomedOffset)).toMatchObject({
      system: "SNOMED",
      code: "91302008",
    });

    const whenBlock = doc.blocks.find((b) => b.kind === "when");
    expect(whenBlock?.conditionPreview).toContain("sbp.latest < sbp_crit");

    // Outside end rule: no blocks are open, no active rule, branch-local let is hidden
    expect(openBlocksAt(doc, sepsis.length)).toEqual([]);
    expect(activeRuleAt(doc, sepsis.length)).toBeNull();
    expect(visibleSymbolsAt(doc, sepsis.indexOf("end rule"))).not.toContainEqual(
      expect.objectContaining({ name: "observation_status" })
    );
  });

  it("isolates branch-scoped let variables and recovers across unclosed blocks in multi-rule files", () => {
    const schema = getDatasetSchemaIndex(structuredClone(temporalData) as Dataset);
    const src = [
      "rule RuleOne:",
      "    bind hr = Vitals.heart_rate",
      "    end bind",
      "    when hr.latest > 100:",
      "    then:",
      '        alert: "High"',
      "    otherwise:",
      '        let branch_only := "monitoring"',
      "rule RuleTwo:",
      "    let r2_limit := 80",
      "    when ",
    ].join("\n");
    const doc = indexDocument(src, schema);

    const r1 = doc.blocks.find((b) => b.kind === "rule" && b.name === "RuleOne");
    const r1When = doc.blocks.find((b) => b.kind === "when" && b.parentIndex === r1?.index);
    const expectedPrevEnd = src.indexOf('"monitoring"') + '"monitoring"'.length;
    expect(r1?.syntheticClosed).toBe(true);
    expect(r1?.closeOffset).toBe(expectedPrevEnd);
    expect(r1When?.syntheticClosed).toBe(true);
    expect(r1When?.closeOffset).toBe(expectedPrevEnd);

    const r2WhenEnd = src.length;
    const open = openBlocksAt(doc, r2WhenEnd);
    expect(open.map((b) => b.kind)).toEqual(["rule", "when"]);
    expect(activeRuleAt(doc, r2WhenEnd)?.name).toBe("RuleTwo");

    const visibleInR2 = visibleSymbolsAt(doc, r2WhenEnd).map((s) => s.name);
    expect(visibleInR2).toContain("r2_limit");
    expect(visibleInR2).not.toContain("branch_only");
    expect(visibleInR2).not.toContain("hr");
  });

  it("records bind site blocks and syntax-only for declarations without crashing", () => {
    const schema = getDatasetSchemaIndex(structuredClone(temporalData) as Dataset);
    const src = [
      "rule MetaRule:",
      "    bind site: ICU",
      "        source: EHR -> FHIR_R4",
      "    end bind",
      "    for p : Patient",
      "end rule",
    ].join("\n");
    const doc = indexDocument(src, schema);
    expect(doc.blocks.some((b) => b.kind === "bind-site")).toBe(true);
    const forSym = doc.symbols.find((s) => s.name === "p");
    expect(forSym?.kind).toBe("for");
    expect(forSym?.syntaxOnly).toBe(true);
    const sourceSym = doc.symbols.find((s) => s.kind === "source" && s.name === "EHR");
    expect(sourceSym?.syntaxOnly).toBe(true);
  });

  it("tracks where/within metadata on bound series for hover", () => {
    const schema = getDatasetSchemaIndex(structuredClone(temporalData) as Dataset);
    const doc = indexDocument(temporal, schema);
    const hr = doc.symbols.find((s) => s.name === "hr_readings");
    expect(hr?.whereText).toContain('status == "final"');
    expect(hr?.withinText).toContain("30 minutes");
  });

  it("distinguishes when Event.name triggers from when ... end when blocks", () => {
    const schema = getDatasetSchemaIndex(structuredClone(temporalData) as Dataset);
    const src = [
      "rule EventRule:",
      "    when Patient.admitted",
      "    let x := 1",
      "    when Lab.reported",
      "end rule",
      "rule EofEventRule:",
      "    when Discharge.completed",
    ].join("\n");
    const doc = indexDocument(src, schema);
    expect(doc.blocks.filter((b) => b.kind === "when")).toHaveLength(0);
    expect(activeRuleAt(doc, src.length)?.name).toBe("EofEventRule");

    const realWhenSrc = [
      "rule RealWhen:",
      "    bind hr = Vitals.heart_rate",
      "    end bind",
      "    when hr.latest > 100:",
      "    then:",
      '        alert: "High"',
      "    end when",
      "end rule",
    ].join("\n");
    const realDoc = indexDocument(realWhenSrc, schema);
    expect(realDoc.blocks.filter((b) => b.kind === "when")).toHaveLength(1);
  });

  it("infers let value types across arithmetic, strings, series.latest, copies, and booleans", () => {
    const ds: Dataset = {
      schemaVersion: 1,
      evaluationTime: "2026-10-31T12:00:00Z",
      Bindings: {},
      tables: [
        {
          name: "Labs",
          patientIdColumn: "patient_id",
          timestampColumn: "timestamp",
          defaultValueColumn: "value",
          columns: [
            { name: "patient_id", type: "String" },
            { name: "timestamp", type: "DateTime" },
            { name: "value", type: "Float" },
            { name: "status", type: "String" },
            { name: "verified", type: "Boolean" },
          ],
          rows: [],
        },
      ],
    };
    const schema = getDatasetSchemaIndex(ds);
    const src = [
      "rule TypeRule:",
      "    bind lab = Labs.value",
      "    end bind",
      "    let n1 := 42",
      "    let n2 := lab.latest + 10",
      "    let s1 := lab.status.latest",
      '    let s2 := "ok"',
      "    let b1 := lab.verified.latest",
      "    let t1 := lab.timestamp.latest",
      "    let copy_s1 := s1",
      "    let cmp := (n1 > 10) and not (b1 == b1)",
      "    let self_ref := self_ref",
      "    let latest_val := lab.latest",
      "end rule",
    ].join("\n");
    const doc = indexDocument(src, schema);
    const typeOf = (name: string) => doc.symbols.find((s) => s.name === name)?.valueType;
    expect(typeOf("lab")).toBe("Series");
    expect(typeOf("n1")).toBe("Number");
    expect(typeOf("n2")).toBe("Number");
    expect(typeOf("s1")).toBe("String");
    expect(typeOf("s2")).toBe("String");
    expect(typeOf("b1")).toBe("Boolean");
    expect(typeOf("t1")).toBe("DateTime");
    expect(typeOf("copy_s1")).toBe("String");
    expect(typeOf("cmp")).toBe("Boolean");
    expect(typeOf("self_ref")).toBe("Unknown");
    expect(typeOf("latest_val")).toBe("Number");

    const selfUseOffset = src.lastIndexOf("self_ref");
    expect(findReferenceAtOffset(doc, selfUseOffset)?.symbolIndex).toBeNull();
  });

  it("isolates then vs otherwise and nested when branch scopes", () => {
    const schema = getDatasetSchemaIndex(structuredClone(sepsisData) as Dataset);
    const src = [
      "rule NestedRule:",
      "    let outer_var := 1",
      "    when outer_var > 0:",
      "    then:",
      "        let then_var := 2",
      "        when then_var > 1:",
      "        then:",
      "            let inner_then := 3",
      "        otherwise:",
      "            let inner_else := 4",
      "        end when",
      '        alert: "after inner"',
      "    otherwise:",
      "        let else_var := 5",
      "    end when",
      '    alert: "after outer"',
      "end rule",
    ].join("\n");
    const doc = indexDocument(src, schema);
    const namesAt = (marker: string) =>
      visibleSymbolsAt(doc, src.indexOf(marker)).map((s) => s.name);

    expect(namesAt("let inner_then")).toEqual(
      expect.arrayContaining(["NestedRule", "outer_var", "then_var"])
    );
    expect(namesAt("let inner_then")).not.toContain("inner_else");

    expect(namesAt('alert: "after inner"')).toEqual(
      expect.arrayContaining(["NestedRule", "outer_var", "then_var"])
    );
    expect(namesAt('alert: "after inner"')).not.toContain("inner_then");
    expect(namesAt('alert: "after inner"')).not.toContain("inner_else");
    expect(namesAt('alert: "after inner"')).not.toContain("else_var");

    expect(namesAt("let else_var")).not.toContain("then_var");
    expect(namesAt('alert: "after outer"')).not.toContain("then_var");
    expect(namesAt('alert: "after outer"')).not.toContain("else_var");
    expect(namesAt('alert: "after outer"')).toContain("outer_var");
  });

  it("extracts quoted, bracketed, bare, and mid-typing terminology occurrences", () => {
    const schema = getDatasetSchemaIndex(structuredClone(sepsisData) as Dataset);
    const src = [
      "rule TermRule:",
      '    terminology: LOINC("2339-0")',
      "    terminology: RxNorm[1049502]",
      "    terminology: LOINC(2823-3)",
      '    terminology: SNOMED("913',
      "    terminology: LOINC(",
      "end rule",
    ].join("\n");
    const doc = indexDocument(src, schema);
    expect(doc.terminologyCalls.map((t) => [t.system, t.code])).toEqual([
      ["LOINC", "2339-0"],
      ["RxNorm", "1049502"],
      ["LOINC", "2823-3"],
      ["SNOMED", "913"],
      ["LOINC", ""],
    ]);

    expect(findTerminologyAtOffset(doc, src.indexOf("1049502"))).toMatchObject({
      system: "RxNorm",
      code: "1049502",
    });
    expect(findTerminologyAtOffset(doc, src.indexOf("913") + 3)).toMatchObject({
      system: "SNOMED",
      code: "913",
    });
    expect(findTerminologyAtOffset(doc, src.lastIndexOf("LOINC(") + 6)).toMatchObject({
      system: "LOINC",
      code: "",
    });
    expect(findTerminologyAtOffset(doc, 0)).toBeNull();
  });

  it("indexes references including .latest member targets, source tables, and repeat_of rules", () => {
    const ds: Dataset = {
      schemaVersion: 1,
      evaluationTime: "2026-10-31T12:00:00Z",
      Bindings: {},
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
          rows: [],
        },
      ],
    };
    const schema = getDatasetSchemaIndex(ds);
    const doc = indexDocument(high, schema);

    const srcSym = doc.symbols.find((s) => s.kind === "source" && s.name === "glucose_data");
    expect(srcSym?.resolvedTarget?.tableName).toBe("glucose_data");
    expect(srcSym?.valueType).toBe("Series");
    expect(srcSym?.syntaxOnly).toBe(false);

    const latestUseOffset = high.indexOf("latest", high.indexOf("when"));
    const latestRef = findReferenceAtOffset(doc, latestUseOffset);
    expect(latestRef).toMatchObject({
      name: "latest",
      memberOf: "glucose_data",
      symbolIndex: srcSym?.index,
      isDeclaration: false,
    });

    const repeatSrc = [
      "rule First:",
      '    alert: "one"',
      "end rule",
      "rule Second:",
      "    when First.x > 1:",
      "    then:",
      "        suppress: repeat_of: First within 1 hours",
      "    end when",
      "end rule",
    ].join("\n");
    const repeatDoc = indexDocument(repeatSrc, schema);
    const firstRuleSym = repeatDoc.symbols.find((s) => s.kind === "rule" && s.name === "First");
    const repeatRef = findReferenceAtOffset(repeatDoc, repeatSrc.lastIndexOf("First"));
    expect(repeatRef?.symbolIndex).toBe(firstRuleSym?.index);

    // Basic rule (source: EHR -> FHIR_R4) should not throw and flags source as syntaxOnly
    const basicDoc = indexDocument(basic, schema);
    expect(basicDoc.symbols.find((s) => s.name === "EHR")?.syntaxOnly).toBe(true);
  });

  it("handles incomplete input, CRLF/unicode, missing end descriptors, and unclosed bind/when recovery", () => {
    const schema = getDatasetSchemaIndex(structuredClone(sepsisData) as Dataset);
    expect(() => indexDocument("", schema)).not.toThrow();
    expect(() => indexDocument("# only comment\n", schema)).not.toThrow();
    expect(() => indexDocument(invalid, schema)).not.toThrow();

    const weirdSrc = [
      "rule R1:\r",
      '    # emoji 😀\r',
      "    bind s = Vitals.systolic_bp\r",
      "    when s.latest > 100:\r",
      "    then:\r",
      '        let a := "unterm\r',
      "end\r",
      "rule R2:\r",
      "    let b := 5\r",
      "end rule\r",
    ].join("\n");
    const doc = indexDocument(weirdSrc, schema);
    expect(doc.blocks.filter((b) => b.kind === "rule").map((b) => b.name)).toEqual(["R1", "R2"]);
    const bindBlock = doc.blocks.find((b) => b.kind === "bind");
    expect(bindBlock?.syntheticClosed).toBe(true);
    expect(activeRuleAt(doc, weirdSrc.indexOf("let b"))?.name).toBe("R2");
    expect(visibleSymbolsAt(doc, weirdSrc.indexOf("let b := 5") + 10).map((s) => s.name)).not.toContain("a");
  });

  it("enforces large-file guard and meets 500-line indexing latency budget", () => {
    const schema = getDatasetSchemaIndex(structuredClone(sepsisData) as Dataset);
    const skipped = indexDocument(sepsis, schema, { skipDeepRefs: true });
    expect(skipped.largeFileDegraded).toBe(true);
    expect(skipped.references.some((r) => !r.isDeclaration)).toBe(false);

    const bigRuleLines = ["rule BigRule:", "    bind sbp = Vitals.systolic_bp", "    end bind"];
    for (let i = 0; i < 495; i++) {
      bigRuleLines.push(`    let v${i} := ${i} + 1`);
    }
    bigRuleLines.push("    when sbp.latest > v0 then alert: \"ok\" end when", "end rule");
    const fiveHundredLines = bigRuleLines.join("\n");

    // 1-call V8 JIT warmup on a small scratch input before measuring 500-line cold indexing
    const warmupLines = [
      "rule Warmup:",
      "    bind sbp = Vitals.systolic_bp",
      "    end bind",
      ...Array.from({ length: 40 }, (_, i) => `    let w${i} := ${i} + 1`),
      '    when sbp.latest > w0 then alert: "ok" end when',
      "end rule",
    ];
    indexDocument(warmupLines.join("\n"), schema);

    const t0 = performance.now();
    const bigDoc = indexDocument(fiveHundredLines, schema);
    const elapsedMs = performance.now() - t0;
    expect(bigDoc.largeFileDegraded).toBe(false);
    expect(bigDoc.symbols.length).toBeGreaterThan(490);
    expect(elapsedMs).toBeLessThan(10);

    // > 256 KiB triggers largeFileDegraded
    const huge = fiveHundredLines + "\n" + "# ".repeat(135_000);
    expect(huge.length).toBeGreaterThan(262_144);
    const hugeDoc = indexDocument(huge, schema);
    expect(hugeDoc.largeFileDegraded).toBe(true);
    expect(hugeDoc.references.some((r) => !r.isDeclaration)).toBe(false);
  });

  it("keeps references strictly sorted for binary search and handles member keywords and parser corpus files", () => {
    const schema = getDatasetSchemaIndex(structuredClone(temporalData) as Dataset);
    const doc = indexDocument(temporal, schema);

    for (let k = 1; k < doc.references.length; k++) {
      expect(doc.references[k].startOffset).toBeGreaterThan(doc.references[k - 1].startOffset);
    }

    // Declaration and usage lookup via findReferenceAtOffset
    const hrDeclRef = findReferenceAtOffset(doc, temporal.indexOf("hr_readings"));
    expect(hrDeclRef).toMatchObject({ name: "hr_readings", isDeclaration: true });
    expect(findReferenceAtOffset(doc, temporal.indexOf("Vitals"))?.name).toBe("Vitals");
    expect(findReferenceAtOffset(doc, temporal.indexOf("heart_rate"))).toMatchObject({
      name: "heart_rate",
      memberOf: "Vitals",
    });
    expect(findReferenceAtOffset(doc, temporal.indexOf("status"))?.name).toBe("status");
    // `within 15 minutes` / `within 30 minutes` should not emit duration unit refs
    expect(doc.references.some((r) => r.name === "minutes")).toBe(false);

    // Member keywords after '.' inside let / when expressions must not truncate expressions
    const memberSrc = [
      "rule MemberKw:",
      '    let s := event.site',
      '    when event.source == "EHR":',
      "    then:",
      '        alert: "ok"',
      "    end when",
      "end rule",
    ].join("\n");
    const memberDoc = indexDocument(memberSrc, schema);
    expect(memberDoc.symbols.find((s) => s.name === "s")?.initializerPreview).toBe("event.site");
    expect(memberDoc.blocks.find((b) => b.kind === "when")?.conditionPreview).toBe(
      'event.source == "EHR"'
    );
    expect(findReferenceAtOffset(memberDoc, memberSrc.indexOf("site"))).toMatchObject({
      name: "site",
      memberOf: "event",
    });

    // Existing parser corpus files index cleanly
    const latestDoc = indexDocument(latestObs, schema);
    expect(latestDoc.symbols.find((s) => s.name === "k_bound")).toMatchObject({
      kind: "bind",
      whereText: "code = potassium",
      withinText: "24 hours before now",
    });
    expect(latestDoc.symbols.find((s) => s.name === "k_reading")?.valueType).toBe("Unknown");

    const multiDoc = indexDocument(multiRules, schema);
    expect(multiDoc.blocks.filter((b) => b.kind === "rule").map((b) => b.name)).toEqual([
      "RuleA",
      "RuleB",
    ]);
    expect(openBlocksAt(multiDoc, multiRules.length)).toEqual([]);
  });

  it("scopes when for loop variable to condition, then, and otherwise without leaking after end when", () => {
    const schema = getDatasetSchemaIndex(structuredClone(temporalData) as Dataset);
    const src = [
      "rule WhenForScope:",
      "    when for p p.latest > 10:",
      "    then:",
      '        alert: "x", p',
      "    otherwise:",
      '        alert: "y", p',
      "    end when",
      "    let after := p",
      "end rule",
    ].join("\n");
    const doc = indexDocument(src, schema);

    const forSym = doc.symbols.find((s) => s.kind === "for" && s.name === "p");
    expect(forSym).toBeDefined();
    expect(forSym?.syntaxOnly).toBe(true);

    const condUseOffset = src.indexOf("p.latest");
    const thenUseOffset = src.indexOf(", p") + 2;
    const otherwiseUseOffset = src.indexOf(", p", thenUseOffset) + 2;
    const afterEndWhenOffset = src.lastIndexOf("p");

    expect(findReferenceAtOffset(doc, condUseOffset)?.symbolIndex).toBe(forSym?.index);
    expect(findReferenceAtOffset(doc, thenUseOffset)?.symbolIndex).toBe(forSym?.index);
    expect(findReferenceAtOffset(doc, otherwiseUseOffset)?.symbolIndex).toBe(forSym?.index);
    expect(findReferenceAtOffset(doc, afterEndWhenOffset)?.symbolIndex).toBeNull();

    expect(visibleSymbolsAt(doc, condUseOffset).map((s) => s.name)).toContain("p");
    expect(visibleSymbolsAt(doc, thenUseOffset).map((s) => s.name)).toContain("p");
    expect(visibleSymbolsAt(doc, otherwiseUseOffset).map((s) => s.name)).toContain("p");
    expect(visibleSymbolsAt(doc, afterEndWhenOffset).map((s) => s.name)).not.toContain("p");
  });
});
