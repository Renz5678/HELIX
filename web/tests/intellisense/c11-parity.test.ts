import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import glucoseData from "../../../examples/data/glucose.json";
import { HelixIntelliSense } from "../../src/editor/intellisense/engine";
import { tokenizeHelix } from "../../src/editor/intellisense/lexer";
import type {
  MarkerInput,
  QuickFixEdit,
} from "../../src/editor/intellisense/providers";
import { byteOffsetToPosition } from "../../src/services/positions";
import type {
  Analysis,
  Dataset,
  Diagnostic,
  Evaluation,
} from "../../src/services/types";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const NATIVE_LIB = process.env.HELIX_NATIVE_LIB ?? "";

const PY_BRIDGE = `
import ctypes, json, sys
lib = ctypes.CDLL(sys.argv[1])
lib.helix_analyze.restype = ctypes.c_void_p
lib.helix_analyze.argtypes = [ctypes.c_char_p]
lib.helix_evaluate.restype = ctypes.c_void_p
lib.helix_evaluate.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
lib.helix_free_result.argtypes = [ctypes.c_void_p]
reqs = json.loads(sys.stdin.read())
out = []
for req in reqs:
    if req["kind"] == "analyze":
        p = lib.helix_analyze(req["source"].encode("utf-8"))
    else:
        p = lib.helix_evaluate(req["source"].encode("utf-8"), req["data"].encode("utf-8"))
    if not p:
        raise RuntimeError("C engine returned NULL")
    try:
        out.append(json.loads(ctypes.string_at(p).decode("utf-8")))
    finally:
        lib.helix_free_result(p)
sys.stdout.write(json.dumps(out))
`;

type NativeReq =
  | { kind: "analyze"; source: string }
  | { kind: "evaluate"; source: string; data: string };

let cachedPython = "";
function findPython(): string {
  if (cachedPython) return cachedPython;
  const candidates =
    process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  for (const cmd of candidates) {
    try {
      execFileSync(cmd, ["--version"], { stdio: "ignore" });
      cachedPython = cmd;
      return cmd;
    } catch {
      // try next
    }
  }
  throw new Error("Python 3 is required to run C11 parity tests");
}

function callNativeBatch(requests: NativeReq[]): Array<Analysis | Evaluation> {
  const raw = execFileSync(findPython(), ["-c", PY_BRIDGE, NATIVE_LIB], {
    input: JSON.stringify(requests),
    encoding: "utf8",
  });
  return JSON.parse(raw) as Array<Analysis | Evaluation>;
}

function mapNativeKind(token: { type: string; category: string }): string {
  if (token.type === "TOKEN_EOF") return "eof";
  if (token.type === "TOKEN_INT_LIT") return "int";
  if (token.type === "TOKEN_FLOAT_LIT") return "float";
  if (token.type === "TOKEN_STRING_LIT") return "string";
  if (token.category === "KEYWORD") return "keyword";
  if (token.category === "IDENTIFIER") return "identifier";
  if (token.category === "OPERATOR") return "operator";
  if (token.category === "DELIMITER") return "delimiter";
  return "error";
}

function toMarkers(source: string, diagnostics: Diagnostic[]): MarkerInput[] {
  return diagnostics
    .filter((d) => d.startOffset !== undefined)
    .map((d) => {
      const start = byteOffsetToPosition(source, d.startOffset!);
      const end = byteOffsetToPosition(
        source,
        d.endOffset ?? d.startOffset! + 1,
      );
      return {
        code: d.code,
        message: d.message,
        range: {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: Math.max(
            end.column,
            start.lineNumber === end.lineNumber ? start.column + 1 : 1,
          ),
        },
      };
    });
}

function applyEdit(source: string, edit: QuickFixEdit): string {
  const lines = source.split("\n");
  const lineStarts: number[] = [0];
  for (let i = 0; i < lines.length - 1; i++) {
    lineStarts.push(lineStarts[i] + lines[i].length + 1);
  }
  const start =
    lineStarts[edit.range.startLineNumber - 1] + (edit.range.startColumn - 1);
  const end =
    lineStarts[edit.range.endLineNumber - 1] + (edit.range.endColumn - 1);
  return source.slice(0, start) + edit.text + source.slice(end);
}

describe.skipIf(!NATIVE_LIB && !process.env.CI)("Real C11 engine parity", () => {
  it("matches C11 lexer tokens across all example programs", () => {
    expect(NATIVE_LIB).not.toBe("");
    const examples = [
      "examples/high_glucose_alert.helix",
      "examples/basic_rule.helix",
      "examples/alert_rule.helix",
      "examples/temporal_rule.helix",
    ];
    const sources = examples.map((relPath) =>
      readFileSync(resolve(REPO_ROOT, relPath), "utf8").replace(/\r\n/g, "\n"),
    );
    const analyses = callNativeBatch(
      sources.map((source) => ({ kind: "analyze", source })),
    ) as Analysis[];

    for (let idx = 0; idx < examples.length; idx++) {
      const relPath = examples[idx];
      const source = sources[idx];
      const native = analyses[idx];
      expect(native.success, `${relPath} should analyze cleanly`).toBe(true);

      const tsLex = tokenizeHelix(source);
      expect(tsLex.tokens.length, `${relPath} token count`).toBe(
        native.tokens.length,
      );

      for (let i = 0; i < native.tokens.length; i++) {
        const cTok = native.tokens[i];
        const tsTok = tsLex.tokens[i];
        expect(tsTok.kind, `${relPath} tok[${i}] kind`).toBe(
          mapNativeKind(cTok),
        );
        expect(tsTok.lexeme, `${relPath} tok[${i}] lexeme`).toBe(cTok.lexeme);
        expect(tsTok.line, `${relPath} tok[${i}] line`).toBe(cTok.line);
        expect(tsTok.column, `${relPath} tok[${i}] column`).toBe(cTok.column);
      }
    }
  });

  it("repairs real C11 syntax and semantic errors via Quick Fixes", () => {
    expect(NATIVE_LIB).not.toBe("");
    const engine = new HelixIntelliSense();
    const ds: Dataset = structuredClone(glucoseData as Dataset);
    ds.Bindings["Labs.glucose"] = { table: "glucose_data", column: "value" };
    const dsJson = JSON.stringify(ds);

    const cases: Array<{
      name: string;
      kind: "analyze" | "evaluate";
      source: string;
      pickFix: (
        fixes: ReturnType<HelixIntelliSense["provideQuickFixes"]>,
      ) => QuickFixEdit;
    }> = [
      {
        name: "missing end when (multi-line)",
        kind: "analyze",
        source:
          'rule R:\n    source glucose_data\n    when glucose_data.latest > 180:\n    then:\n        alert: "high"\nend rule\n',
        pickFix: (fixes) => fixes[0].edit,
      },
      {
        name: "missing end when (single-line)",
        kind: "analyze",
        source:
          'rule R: source glucose_data when glucose_data.latest > 180: then: alert: "high" end rule',
        pickFix: (fixes) => fixes[0].edit,
      },
      {
        name: "missing end rule at EOF",
        kind: "analyze",
        source:
          'rule R:\n    source glucose_data\n    when glucose_data.latest > 180:\n    then:\n        alert: "high"\n    end when\n',
        pickFix: (fixes) => fixes[0].edit,
      },
      {
        name: "mismatched end when -> end bind",
        kind: "analyze",
        source: "rule R:\n    bind g = Labs.glucose\n    end when\nend rule\n",
        pickFix: (fixes) => fixes[0].edit,
      },
      {
        name: "SOURCE_NOT_FOUND omits dotted bindings and fixes to glucose_data",
        kind: "evaluate",
        source:
          'rule R:\n    source glucse_data\n    when glucose_data.latest > 180:\n    then:\n        alert: "high"\n    end when\nend rule\n',
        pickFix: (fixes) => {
          expect(fixes.some((f) => f.edit.text.includes("."))).toBe(false);
          expect(fixes[0]?.edit.text).toBe("glucose_data");
          return fixes[0].edit;
        },
      },
      {
        name: "BINDING_NOT_FOUND fixes to Labs.glucose",
        kind: "evaluate",
        source:
          'rule R:\n    bind g = Labs.glucse end bind\n    when g.latest > 180:\n    then:\n        alert: "high"\n    end when\nend rule\n',
        pickFix: (fixes) => {
          expect(fixes[0]?.edit.text).toBe("Labs.glucose");
          return fixes[0].edit;
        },
      },
      {
        name: "series used without .latest",
        kind: "evaluate",
        source:
          'rule R:\n    source glucose_data\n    when glucose_data > 180:\n    then:\n        alert: "high"\n    end when\nend rule\n',
        pickFix: (fixes) => {
          const addLatest = fixes.find((f) => f.edit.text === ".latest");
          expect(addLatest).toBeDefined();
          return addLatest!.edit;
        },
      },
      {
        name: "undeclared variable -> let declaration",
        kind: "evaluate",
        source:
          'rule R:\n    source glucose_data\n    when glucose_data.latest > limt:\n    then:\n        alert: "high"\n    end when\nend rule\n',
        pickFix: (fixes) => {
          const declFix = fixes.find((f) => f.title.includes("let limt"));
          expect(declFix).toBeDefined();
          return declFix!.edit;
        },
      },
    ];

    const brokenResults = callNativeBatch(
      cases.map((c) =>
        c.kind === "analyze"
          ? { kind: "analyze", source: c.source }
          : { kind: "evaluate", source: c.source, data: dsJson },
      ),
    );

    const fixedSources = cases.map((c, idx) => {
      const result = brokenResults[idx];
      expect(result.success, `${c.name} should initially fail`).toBe(false);
      const fixes = engine.provideQuickFixes(
        `file:///c11-${idx}.helix`,
        1,
        c.source,
        ds,
        toMarkers(c.source, result.diagnostics),
      );
      expect(fixes.length, `${c.name} should produce fixes`).toBeGreaterThan(0);
      return applyEdit(c.source, c.pickFix(fixes));
    });

    const fixedResults = callNativeBatch(
      cases.map((c, idx) =>
        c.kind === "analyze"
          ? { kind: "analyze", source: fixedSources[idx] }
          : { kind: "evaluate", source: fixedSources[idx], data: dsJson },
      ),
    );

    for (let idx = 0; idx < cases.length; idx++) {
      expect(
        fixedResults[idx].success,
        `${cases[idx].name} failed after fix:\n${fixedSources[idx]}`,
      ).toBe(true);
    }
  });
});
