import { describe, it, expect } from "vitest";
import type { Dataset } from "../../src/services/types";
import { HelixIntelliSense } from "../../src/editor/intellisense/engine";

function make500LineProgram(): string {
  const rules: string[] = [];
  for (let i = 0; i < 42; i++) {
    rules.push(
      `rule ClinicalRule${i}:`,
      `    intent: "Monitor rule ${i}"`,
      `    bind sbp_${i} = Vitals.systolic_bp where status == "final" within 30 minutes`,
      `    end bind`,
      `    let sbp_crit_${i} := ${90 + i}`,
      `    when sbp_${i}.latest < sbp_crit_${i}:`,
      `    then:`,
      `        alert: "Alert ${i}", "WARNING", sbp_${i}.latest`,
      `        suppress: within 4 hours`,
      `    otherwise:`,
      `        let ok_${i} := "ok"`,
      `    end when`,
      `end rule`,
    );
  }
  return rules.join("\n");
}

function make200RowDataset(rowCount = 200): Dataset {
  return {
    schemaVersion: 1,
    evaluationTime: "2026-10-31T12:00:00Z",
    Bindings: { "Vitals.systolic_bp": { table: "Vitals", column: "systolic_bp" } },
    tables: [
      {
        name: "Vitals",
        patientIdColumn: "patient_id",
        timestampColumn: "timestamp",
        defaultValueColumn: "systolic_bp",
        columns: [
          { name: "patient_id", type: "String" },
          { name: "timestamp", type: "DateTime" },
          { name: "systolic_bp", type: "Float" },
          { name: "status", type: "String" },
        ],
        rows: Array.from({ length: rowCount }, (_, i) => ({
          patient_id: `P${i % 20}`,
          timestamp: "2026-10-31T11:55:00Z",
          systolic_bp: 80 + (i % 60),
          status: i % 4 === 0 ? "preliminary" : "final",
        })),
      },
    ],
  };
}

describe("IntelliSense performance budgets and coordinator engine", () => {
  it("bounds URI cache to 4 entries, tracks active rule & MRU acceptance, and handles 10,000-row datasets cleanly", () => {
    const engine = new HelixIntelliSense();
    const ds = make200RowDataset(10_000);
    const s1 = [
      "rule One:",
      '    bind sbp = Vitals.systolic_bp where status == "final" within 30 minutes',
      "    end bind",
      "    let t := 100",
      "    when sbp.latest > t:",
      "    then:",
      '        alert: "hi", "WARNING", sbp.latest',
      "        suppress: within 4 hours",
      "    otherwise:",
      '        let ok := "ok"',
      "    end when",
      "end rule",
    ].join("\n");

    const d1 = engine.getDocument("file:///1.helix", 1, s1, ds);
    engine.getDocument("file:///2.helix", 1, s1, ds);
    engine.getDocument("file:///3.helix", 1, s1, ds);
    engine.getDocument("file:///4.helix", 1, s1, ds);
    // 5th distinct URI evicts the LRU entry (1.helix)
    engine.getDocument("file:///5.helix", 1, s1, ds);

    const d1Again = engine.getDocument("file:///1.helix", 1, s1, ds);
    expect(d1Again.doc).not.toBe(d1.doc);

    expect(
      engine.getActiveRuleName("file:///1.helix", 1, s1, ds, {
        lineNumber: 2,
        column: 5,
      }),
    ).toBe("One");

    const exprSrc = [
      "rule R:",
      '    bind sbp = Vitals.systolic_bp where status == "final" within 30 minutes',
      "    end bind",
      "    let alpha := 1",
      "    let beta := 2",
      "    when sbp.latest > ",
    ].join("\n");
    const pos = { lineNumber: 6, column: 23 };
    const before = engine.provideCompletions(
      "file:///mru.helix",
      1,
      exprSrc,
      ds,
      pos,
    );
    const betaIdxBefore = before.findIndex((c) => c.label === "beta");
    expect(betaIdxBefore).toBeGreaterThan(-1);

    engine.recordAcceptance("comparison-rhs", "beta");
    const after = engine.provideCompletions(
      "file:///mru.helix",
      1,
      exprSrc,
      ds,
      pos,
    );
    const betaScoreBefore = before[betaIdxBefore]!.score;
    const betaScoreAfter = after.find((c) => c.label === "beta")!.score;
    expect(betaScoreAfter).toBeGreaterThan(betaScoreBefore);

    expect(
      engine.provideDocumentSymbols("file:///1.helix", 1, s1, ds)[0]?.name,
    ).toBe("One");

    const cached = engine.getDocument("file:///mru.helix", 1, exprSrc, ds);
    engine.clearCache();
    const rebuilt = engine.getDocument("file:///mru.helix", 1, exprSrc, ds);
    expect(rebuilt.doc).not.toBe(cached.doc);
  });

  it("indexes 500+ lines cold under 10 ms, hits cache in O(1), and answers completions/ghost-text under 15 ms", () => {
    const src = make500LineProgram();
    const ds = make200RowDataset(200);
    const engine = new HelixIntelliSense();
    const lines = src.split("\n");
    expect(lines.length).toBeGreaterThan(500);

    const t0 = performance.now();
    const first = engine.getDocument("file:///perf.helix", 1, src, ds);
    const coldIndexMs = performance.now() - t0;
    expect(coldIndexMs).toBeLessThan(10);

    const second = engine.getDocument("file:///perf.helix", 1, src, ds);
    expect(second.doc).toBe(first.doc);

    const pos = { lineNumber: 19, column: 28 };
    const t1 = performance.now();
    const items = engine.provideCompletions(
      "file:///perf.helix",
      1,
      src,
      ds,
      pos,
      "perf.helix",
    );
    const ghost = engine.provideInlinePrediction(
      "file:///perf.helix",
      1,
      src,
      ds,
      pos,
      true,
    );
    const queryMs = performance.now() - t1;
    expect(items.length).toBeGreaterThan(0);
    expect(ghost === null || typeof ghost.insertText === "string").toBe(true);
    expect(queryMs).toBeLessThan(15);
  });
});
