import { describe, it, expect } from "vitest";
import sepsis from "../../../examples/alert_rule.helix?raw";
import sepsisData from "../../../examples/data/sepsis.json";
import temporal from "../../../examples/temporal_rule.helix?raw";
import temporalData from "../../../examples/data/temporal.json";
import type { Dataset } from "../../src/services/types";
import { HelixIntelliSense } from "../../src/editor/intellisense/engine";
import { offsetToPosition } from "../../src/editor/intellisense/lexer";
import { levenshtein } from "../../src/editor/intellisense/providers";

describe("IDE providers (hover, signature, nav, outline, quick fixes)", () => {
  const sepsisDs = structuredClone(sepsisData) as Dataset;
  const temporalDs = structuredClone(temporalData) as Dataset;

  it("renders rich hover cards for terminology codes, bound series with live samples, and let variables", () => {
    const engine = new HelixIntelliSense();
    const snomedPos = offsetToPosition(sepsis, sepsis.indexOf("91302008"));
    const snomedHover = engine.provideHover(
      "file:///s.helix",
      1,
      sepsis,
      sepsisDs,
      snomedPos,
    );
    expect(snomedHover?.markdown).toContain("SNOMED-CT");
    expect(snomedHover?.markdown).toContain("Septic shock");
    expect(snomedHover?.markdown).toContain("http://snomed.info/sct");

    const depSrc = 'rule R:\n    terminology: SNOMED("62315008")\nend rule';
    const depHover = engine.provideHover(
      "file:///dep.helix",
      1,
      depSrc,
      sepsisDs,
      offsetToPosition(depSrc, depSrc.indexOf("62315008")),
    );
    expect(depHover?.markdown).toContain("Diarrhea");
    expect(depHover?.markdown.toLowerCase()).toContain("deprecated");

    const hrPos = offsetToPosition(
      temporal,
      temporal.indexOf("hr_readings.latest") + 2,
    );
    const hrHover = engine.provideHover(
      "file:///t.helix",
      1,
      temporal,
      temporalDs,
      hrPos,
    );
    expect(hrHover?.markdown).toContain("heart_rate_readings");
    expect(hrHover?.markdown).toContain("Float");
    expect(hrHover?.markdown).toContain('status == "final"');
    expect(hrHover?.markdown).toContain("30 minutes");
    expect(hrHover?.markdown).toContain("90");
    expect(hrHover?.markdown).toContain("135");

    const letPos = offsetToPosition(sepsis, sepsis.indexOf("sbp_crit)"));
    const letHover = engine.provideHover(
      "file:///s.helix",
      1,
      sepsis,
      sepsisDs,
      letPos,
    );
    expect(letHover?.markdown).toContain("Number");
    expect(letHover?.markdown).toContain("90");
    expect(letHover?.markdown).toContain("SepsisEarlyWarningRule");
  });

  it("renders hover cards for dataset tables, bindings, columns, rules, for-vars, and keywords while suppressing comments", () => {
    const engine = new HelixIntelliSense();

    const vitalsHover = engine.provideHover(
      "file:///s.helix",
      1,
      sepsis,
      sepsisDs,
      offsetToPosition(sepsis, sepsis.indexOf("Vitals.systolic_bp") + 1),
    );
    expect(vitalsHover?.markdown).toContain("Vitals");
    expect(vitalsHover?.markdown).toContain("systolic_bp");
    expect(vitalsHover?.markdown).toContain("2 rows");

    const wbcColHover = engine.provideHover(
      "file:///s.helix",
      1,
      sepsis,
      sepsisDs,
      offsetToPosition(sepsis, sepsis.indexOf("white_blood_count") + 2),
    );
    expect(wbcColHover?.markdown).toContain("Vitals.white_blood_count");
    expect(wbcColHover?.markdown).toContain("Float");

    const ruleHover = engine.provideHover(
      "file:///s.helix",
      1,
      sepsis,
      sepsisDs,
      offsetToPosition(sepsis, sepsis.indexOf("SepsisEarlyWarningRule") + 2),
    );
    expect(ruleHover?.markdown).toContain("SepsisEarlyWarningRule");

    const forSrc =
      "rule F:\n    when for evt evt.latest > 1:\n    then:\n        alert: \"ok\"\n    end when\nend rule";
    const forKwHover = engine.provideHover(
      "file:///f.helix",
      1,
      forSrc,
      sepsisDs,
      offsetToPosition(forSrc, forSrc.indexOf("for") + 1),
    );
    expect(forKwHover?.markdown).toContain("Syntax-only");

    const forSymHover = engine.provideHover(
      "file:///f.helix",
      1,
      forSrc,
      sepsisDs,
      offsetToPosition(forSrc, forSrc.indexOf("evt.latest") + 1),
    );
    expect(forSymHover?.markdown).toContain("Syntax-only");

    const commentHover = engine.provideHover(
      "file:///s.helix",
      1,
      sepsis,
      sepsisDs,
      offsetToPosition(sepsis, sepsis.indexOf("Multi-level") + 2),
    );
    expect(commentHover).toBeNull();

    const bindSameNameSrc =
      'rule B:\n    bind status = Vitals.systolic_bp where status == "final"\nend rule';
    const bindLhsHover = engine.provideHover(
      "file:///bind-lhs.helix",
      1,
      bindSameNameSrc,
      temporalDs,
      offsetToPosition(bindSameNameSrc, bindSameNameSrc.indexOf("status =") + 1),
    );
    expect(bindLhsHover?.markdown).toContain("**bind** `status`");

    const withinSrc =
      'rule W:\n    when 1 > 0 within 30 minutes:\n    then:\n        alert: "ok"\n    end when\nend rule';
    const withinHover = engine.provideHover(
      "file:///within.helix",
      1,
      withinSrc,
      sepsisDs,
      offsetToPosition(withinSrc, withinSrc.indexOf("within") + 2),
    );
    expect(withinHover?.markdown).toContain("seconds");
    expect(withinHover?.markdown).toContain("minutes");
    expect(withinHover?.markdown).toContain("hours");
    expect(withinHover?.markdown).toContain("days");
    expect(withinHover?.markdown).toContain("weeks");
    expect(withinHover?.markdown).toContain("months");
    expect(withinHover?.markdown).toContain("years");
    expect(withinHover?.markdown.toLowerCase()).toContain("parser-only");
  });

  it("computes active signature parameter for alert and terminology calls", () => {
    const engine = new HelixIntelliSense();
    const src =
      'rule R:\n    when 1 > 0:\n    then:\n        alert: "High", "WARNING", x\n    end when\nend rule';
    const sig0 = engine.provideSignatureHelp(
      "file:///a.helix",
      1,
      src,
      sepsisDs,
      offsetToPosition(src, src.indexOf('"High"') + 2),
    );
    expect(sig0?.activeParameter).toBe(0);
    expect(sig0?.signatures[0]?.parameters).toHaveLength(3);

    const sig1 = engine.provideSignatureHelp(
      "file:///a.helix",
      1,
      src,
      sepsisDs,
      offsetToPosition(src, src.indexOf('"WARNING"') + 2),
    );
    expect(sig1?.activeParameter).toBe(1);

    const sig2 = engine.provideSignatureHelp(
      "file:///a.helix",
      1,
      src,
      sepsisDs,
      offsetToPosition(src, src.indexOf(", x") + 2),
    );
    expect(sig2?.activeParameter).toBe(2);

    const nextLineSig = engine.provideSignatureHelp(
      "file:///a.helix",
      1,
      src,
      sepsisDs,
      offsetToPosition(src, src.indexOf("end when") + 2),
    );
    expect(nextLineSig).toBeNull();

    const termSrc = 'rule T:\n    terminology: LOINC("2339-0")\nend rule';
    const termInside = engine.provideSignatureHelp(
      "file:///term.helix",
      1,
      termSrc,
      sepsisDs,
      offsetToPosition(termSrc, termSrc.indexOf("2339-0") + 2),
    );
    expect(termInside?.activeParameter).toBe(0);
    expect(termInside?.signatures[0]?.label).toContain("LOINC");

    const termOutside = engine.provideSignatureHelp(
      "file:///term.helix",
      1,
      termSrc,
      sepsisDs,
      offsetToPosition(termSrc, termSrc.indexOf('")') + 2),
    );
    expect(termOutside).toBeNull();

    const unclosedTermNextLine =
      'rule T2:\n    terminology: LOINC("233\n    let x := 1';
    expect(
      engine.provideSignatureHelp(
        "file:///term2.helix",
        1,
        unclosedTermNextLine,
        sepsisDs,
        offsetToPosition(unclosedTermNextLine, unclosedTermNextLine.indexOf("x")),
      ),
    ).toBeNull();
  });

  it("resolves go-to-definition, find references (including repeat_of), and document outline hierarchy", () => {
    const engine = new HelixIntelliSense();
    const usePos = offsetToPosition(sepsis, sepsis.indexOf("sbp.latest") + 1);
    const def = engine.provideDefinition(
      "file:///s.helix",
      1,
      sepsis,
      sepsisDs,
      usePos,
    );
    expect(def?.startLineNumber).toBe(7);

    const refsWithDecl = engine.provideReferences(
      "file:///s.helix",
      1,
      sepsis,
      sepsisDs,
      usePos,
      true,
    );
    expect(refsWithDecl.length).toBeGreaterThanOrEqual(3);
    const refsNoDecl = engine.provideReferences(
      "file:///s.helix",
      1,
      sepsis,
      sepsisDs,
      usePos,
      false,
    );
    expect(refsNoDecl.length).toBe(refsWithDecl.length - 1);

    const repeatSrc = [
      "rule BaseAlert:",
      "    when 1 > 0:",
      "    then:",
      '        alert: "Base"',
      "    end when",
      "end rule",
      "rule FollowUp:",
      "    when 1 > 0:",
      "    then:",
      "        suppress: repeat_of: BaseAlert within 2 hours",
      "    end when",
      "end rule",
    ].join("\n");
    const repeatPos = offsetToPosition(
      repeatSrc,
      repeatSrc.lastIndexOf("BaseAlert") + 2,
    );
    const repeatDef = engine.provideDefinition(
      "file:///rep.helix",
      1,
      repeatSrc,
      sepsisDs,
      repeatPos,
    );
    expect(repeatDef?.startLineNumber).toBe(1);
    const repeatRefs = engine.provideReferences(
      "file:///rep.helix",
      1,
      repeatSrc,
      sepsisDs,
      repeatPos,
      true,
    );
    expect(repeatRefs).toHaveLength(2);

    const outline = engine.provideDocumentSymbols(
      "file:///s.helix",
      1,
      sepsis,
      sepsisDs,
    );
    expect(outline[0]?.name).toBe("SepsisEarlyWarningRule");
    expect(outline[0]?.children.map((c) => c.name)).toContain("sbp");
    const whenSymbol = outline[0]?.children.find((c) => c.kind === "when");
    expect(whenSymbol).toBeDefined();
    expect(whenSymbol?.children.some((c) => c.kind === "alert")).toBe(true);
    expect(whenSymbol?.children.some((c) => c.kind === "suppress")).toBe(true);
    expect(
      whenSymbol?.children.some(
        (c) => c.kind === "let" && c.name === "observation_status",
      ),
    ).toBe(true);
  });

  it("computes bounded levenshtein edit distances accurately", () => {
    expect(levenshtein("Vitals", "Vitals")).toBe(0);
    expect(levenshtein("Vitlas", "Vitals", 3)).toBe(2);
    expect(levenshtein("limt", "limit", 3)).toBe(1);
    expect(levenshtein("completely_different", "Vitals", 3)).toBeGreaterThan(3);
  });

  it("generates all 5 Quick Fix categories and skips edits when marker text is stale", () => {
    const engine = new HelixIntelliSense();

    // 1a. Missing block terminator at EOF
    const missingEnd =
      'rule R:\n    source Vitals\n    when Vitals.latest > 10:\n    then:\n        alert: "x"\n';
    const fixMissing = engine.provideQuickFixes(
      "file:///q1.helix",
      1,
      missingEnd,
      sepsisDs,
      [
        {
          code: "SYNTAX_ERROR",
          message:
            "Expected 'end when' to terminate when block. Got 'end of file'",
          range: {
            startLineNumber: 5,
            startColumn: 19,
            endLineNumber: 5,
            endColumn: 20,
          },
        },
      ],
    );
    expect(fixMissing[0]?.title).toContain("end when");

    // 1b. Missing block descriptor after 'end'
    const missingDesc =
      'rule R:\n    bind sbp = Vitals.systolic_bp\n    end\nend rule';
    const fixMissingDesc = engine.provideQuickFixes(
      "file:///q1b.helix",
      1,
      missingDesc,
      sepsisDs,
      [
        {
          code: "SYNTAX_ERROR",
          message:
            "Missing block descriptor after 'end': expected 'end bind'",
          range: {
            startLineNumber: 3,
            startColumn: 5,
            endLineNumber: 3,
            endColumn: 8,
          },
        },
      ],
    );
    expect(fixMissingDesc[0]?.edit.text).toContain("bind");

    // 2. Mismatched block terminator
    const mismatch =
      "rule R:\n    bind sbp = Vitals.systolic_bp\n    end when\nend rule";
    const fixMismatch = engine.provideQuickFixes(
      "file:///q2.helix",
      1,
      mismatch,
      sepsisDs,
      [
        {
          code: "SYNTAX_ERROR",
          message:
            "Mismatched block terminator 'end when': expected 'end bind'",
          range: {
            startLineNumber: 3,
            startColumn: 9,
            endLineNumber: 3,
            endColumn: 13,
          },
        },
      ],
    );
    expect(fixMismatch[0]?.edit.text).toBe("bind");

    // 3. Unknown source/binding typo
    const typo = "rule R:\n    source Vitlas\nend rule";
    const fixTypo = engine.provideQuickFixes(
      "file:///q3.helix",
      1,
      typo,
      sepsisDs,
      [
        {
          code: "SOURCE_NOT_FOUND",
          message: "Source table is not mapped",
          range: {
            startLineNumber: 2,
            startColumn: 12,
            endLineNumber: 2,
            endColumn: 18,
          },
        },
      ],
    );
    expect(fixTypo.some((f) => f.edit.text === "Vitals")).toBe(true);

    // 4. Bound/source series used without .latest
    const noLatest =
      'rule R:\n    source Vitals\n    when Vitals > 100:\n    then:\n        alert: "x"\n    end when\nend rule';
    const fixLatest = engine.provideQuickFixes(
      "file:///q4.helix",
      1,
      noLatest,
      sepsisDs,
      [
        {
          code: "UNKNOWN_IDENTIFIER",
          message: "Unknown identifier or series used without .latest",
          range: {
            startLineNumber: 3,
            startColumn: 10,
            endLineNumber: 3,
            endColumn: 16,
          },
        },
      ],
    );
    expect(fixLatest.some((f) => f.edit.text === ".latest")).toBe(true);
    expect(fixLatest.find((f) => f.edit.text === ".latest")?.isPreferred).toBe(
      true,
    );

    // 5. Unknown identifier in expression -> insert `let <ident> := 0` above enclosing `when`
    const missingVar =
      'rule R:\n    source Vitals\n    when Vitals.latest > limt:\n    then:\n        alert: "x"\n    end when\nend rule';
    const fixVar = engine.provideQuickFixes(
      "file:///q5.helix",
      1,
      missingVar,
      sepsisDs,
      [
        {
          code: "UNKNOWN_IDENTIFIER",
          message: "Unknown identifier or series used without .latest",
          range: {
            startLineNumber: 3,
            startColumn: 26,
            endLineNumber: 3,
            endColumn: 30,
          },
        },
      ],
    );
    const declareFix = fixVar.find((f) =>
      f.title.includes("Declare 'let limt"),
    );
    expect(declareFix).toBeDefined();
    expect(declareFix?.edit.text).toBe("    let limt := 0\n");
    expect(declareFix?.edit.range.startLineNumber).toBe(3);

    // Stale marker checks (text changed, deleted line, or already has .latest)
    const staleMismatch = engine.provideQuickFixes(
      "file:///q6.helix",
      2,
      "rule R:\n    source Vitals\nend rule",
      sepsisDs,
      [
        {
          code: "SYNTAX_ERROR",
          message:
            "Mismatched block terminator 'end when': expected 'end bind'",
          range: {
            startLineNumber: 2,
            startColumn: 12,
            endLineNumber: 2,
            endColumn: 18,
          },
        },
      ],
    );
    expect(staleMismatch).toEqual([]);

    const staleOutOfBounds = engine.provideQuickFixes(
      "file:///q7.helix",
      2,
      "rule R:\nend rule",
      sepsisDs,
      [
        {
          code: "UNKNOWN_IDENTIFIER",
          message: "Unknown identifier or series used without .latest",
          range: {
            startLineNumber: 8,
            startColumn: 5,
            endLineNumber: 8,
            endColumn: 10,
          },
        },
      ],
    );
    expect(staleOutOfBounds).toEqual([]);

    const alreadyFixedLatest = engine.provideQuickFixes(
      "file:///q8.helix",
      2,
      'rule R:\n    source Vitals\n    when Vitals.latest > 100:\n    then:\n        alert: "x"\n    end when\nend rule',
      sepsisDs,
      [
        {
          code: "UNKNOWN_IDENTIFIER",
          message: "Unknown identifier or series used without .latest",
          range: {
            startLineNumber: 3,
            startColumn: 10,
            endLineNumber: 3,
            endColumn: 16,
          },
        },
      ],
    );
    expect(alreadyFixedLatest.some((f) => f.edit.text === ".latest")).toBe(
      false,
    );

    // Missing `end when` recovered before `rule R2:` (`Got 'rule'`)
    const missingBeforeRule =
      'rule R1:\r\n    # emoji 😀\r\n    source Vitals\r\n    when Vitals.latest > 10:\r\n    then:\r\n        alert: "x"\r\nrule R2:\r\nend rule';
    const fixBeforeRule = engine.provideQuickFixes(
      "file:///q9.helix",
      1,
      missingBeforeRule,
      sepsisDs,
      [
        {
          code: "SYNTAX_ERROR",
          message: "Expected 'end when' to terminate when block. Got 'rule'",
          range: {
            startLineNumber: 7,
            startColumn: 1,
            endLineNumber: 7,
            endColumn: 5,
          },
        },
      ],
    );
    expect(fixBeforeRule[0]?.edit.text).toBe("    end when\n");
    expect(fixBeforeRule[0]?.edit.range.startLineNumber).toBe(7);

    // Shifted mid-token marker after edit must be rejected as stale
    const shifted = "rule R:\n    source xxVitlas\nend rule";
    const fixShifted = engine.provideQuickFixes(
      "file:///q10.helix",
      2,
      shifted,
      sepsisDs,
      [
        {
          code: "SOURCE_NOT_FOUND",
          message: "Source table is not mapped",
          range: {
            startLineNumber: 2,
            startColumn: 12,
            endLineNumber: 2,
            endColumn: 18,
          },
        },
      ],
    );
    expect(fixShifted).toEqual([]);

    // Stale UNKNOWN_IDENTIFIER marker on series prefix followed by `.` must not emit `.latest`
    const dottedSeries =
      'rule R:\n    source Vitals\n    when Vitals.heart_rate > 100:\n    then:\n        alert: "x"\n    end when\nend rule';
    const fixStaleDottedSeries = engine.provideQuickFixes(
      "file:///q11.helix",
      2,
      dottedSeries,
      sepsisDs,
      [
        {
          code: "UNKNOWN_IDENTIFIER",
          message: "Unknown identifier or series used without .latest",
          range: {
            startLineNumber: 3,
            startColumn: 10,
            endLineNumber: 3,
            endColumn: 16,
          },
        },
      ],
    );
    expect(fixStaleDottedSeries).toEqual([]);

    // Positive BINDING_NOT_FOUND typo fix still succeeds when full dotted path matches
    const bindingTypo = "rule R:\n    bind x = Vitals.systolc_bp\nend rule";
    const fixBindingTypo = engine.provideQuickFixes(
      "file:///q11b.helix",
      1,
      bindingTypo,
      sepsisDs,
      [
        {
          code: "BINDING_NOT_FOUND",
          message: "Binding must resolve to a declared table and column",
          range: {
            startLineNumber: 2,
            startColumn: 14,
            endLineNumber: 2,
            endColumn: 31,
          },
        },
      ],
    );
    expect(fixBindingTypo.some((f) => f.edit.text === "Vitals.systolic_bp")).toBe(
      true,
    );

    // Stale BINDING_NOT_FOUND marker on prefix of extended dotted path must not emit prefix-only replacement
    const extendedBinding = "rule R:\n    bind x = Vitals.systolc_bp.extra\nend rule";
    const fixStaleExtendedBinding = engine.provideQuickFixes(
      "file:///q12.helix",
      2,
      extendedBinding,
      sepsisDs,
      [
        {
          code: "BINDING_NOT_FOUND",
          message: "Binding must resolve to a declared table and column",
          range: {
            startLineNumber: 2,
            startColumn: 14,
            endLineNumber: 2,
            endColumn: 31,
          },
        },
      ],
    );
    expect(fixStaleExtendedBinding).toEqual([]);
  });
});
