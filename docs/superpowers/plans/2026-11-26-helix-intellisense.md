# HELIX Studio Predictive IntelliSense Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a sub-5 ms, 100% local, modern IDE IntelliSense suite for HELIX Studio (`web/`)—covering context/type/schema-ranked autocomplete, deterministic single-Tab inline ghost-text, hover docs, signature help, go-to-definition, find references, document outline, and live C/WASM-backed diagnostic Quick Fixes.

**Architecture:** A modular, error-tolerant TypeScript language service (`web/src/editor/intellisense/`) tokenizes, indexes blocks/scopes/symbols, and classifies cursor grammar state in O(n) cached per `(modelUri, modelVersionId, datasetRef)` alongside a `WeakMap`-cached Data Playground schema & row-sample index. Monaco's `edcore.main.js` contrib bundle enables all 8 IDE UI widgets without pulling in third-party language packs, while the existing ISO C11/WASM engine remains the sole authoritative diagnostics and evaluation engine (adding a superseding `"validate"` worker mode for live semantic squiggles without altering C/WASM).

**Tech Stack:** React 19.3.1, TypeScript 5.9.3 (`strict: true`), Vite 7.3.7, Monaco Editor 0.52.2 (`editor.api` + `edcore.main.js`), Vitest 5.0.5, Playwright 1.64.1.

**Spec:** `docs/superpowers/specs/2026-11-26-helix-intellisense-design.md`

## Global Constraints

- Target branch is `feat/helix-intellisense` (branched from `origin/main` at `97dfef6`); do not modify `src/*.c`, `include/*.h`, WASM artifacts, or legacy `gui/web/`.
- Preserve `import * as monaco from "monaco-editor/esm/vs/editor/editor.api"` for types and load Monaco contrib widgets exclusively via `import "monaco-editor/esm/vs/editor/edcore.main.js"` (never `editor.main`).
- C11/WASM (`helix_analyze`, `helix_evaluate`) remains the sole authoritative compiler and evaluator; TS IntelliSense never fabricates compiler diagnostics.
- Exact 21 HELIX reserved keywords must match `src/keywords.c`: `rule`, `intent`, `bind`, `site`, `source`, `terminology`, `schedule`, `when`, `for`, `let`, `latest`, `where`, `and`, `or`, `not`, `within`, `then`, `alert`, `suppress`, `otherwise`, `end`.
- Executable-first ranking: Studio evaluator-supported syntax and dynamic snippets rank first; parser-only forms (`bind site`, `suppress repeat_of:`, `for`, `when Event.name`, `alert level:`, standalone `latest`, `months`, `years`) are indexed and suggested lower with `"Syntax-only (not evaluated in Studio)"`.
- `CompletionItemProvider.triggerCharacters` must be `[".", "\"", "(", "["]` (deliberately excluding `" "`) so post-space inline ghost-text accepts on a single `Tab`.
- Performance bounds: files > 256 KiB skip deep row-value sampling and limit reference scans; dataset cell sampling scans at most 200 rows per table and retains at most 20 distinct non-null values per column; 500-line indexing target < 2 ms (CI assert < 10 ms) and completion/inline query target < 5 ms (CI assert < 15 ms).
- Storage compatibility: `Workspace` (`version: 1`) keeps all existing required fields and adds optional `inlinePredictions?: boolean` and `autoSuggest?: boolean` defaulting to `true` in `loadWorkspace`.
- MRU acceptance memory is strictly per-session in-memory (max 100 entries, never written to `localStorage`).
- All checks must pass cleanly: `cd web && npm run typecheck && npm test && npm run build`.

## Review Focus

- **Stale/shifted markers & UTF-8/CRLF edits:** Typing non-ASCII text or editing lines above a marker must never map stale byte offsets onto mutated text or let a Quick Fix patch the wrong token (pinned in Tasks 1, 7, and 9).
- **Duplicate ghost-text when closers already exist:** Pressing Enter or typing after `when ...:` or `bind ... = ...` when `then:` or `end bind` already exists on the next non-empty line must suppress ghost-text instead of duplicating blocks (pinned in Task 6).
- **Comments, free-text strings, and unterminated quotes:** Cursor inside `# comments` or `intent: "..."` must suppress code completions/ghost-text, whereas unterminated quotes inside `LOINC("glu` or `where status == "fi` must still produce code/value completions without corrupting tokenization on following lines (pinned in Tasks 1 and 4).
- **Branch-scoped `let` leakage and unclosed-block recovery across multiple rules:** A `let` inside `otherwise` must stay invisible in sibling/later rules, and an unclosed `when` in Rule 1 must recover cleanly when `rule Rule2:` begins (pinned in Tasks 3 and 5).
- **Legacy `workspace.v1` payloads and degenerate/large datasets:** Stored workspaces missing `inlinePredictions`/`autoSuggest` must load with defaults `true`; datasets with 0 rows, `null`-only columns, or 10,000 rows must never crash schema sampling or exceed latency budgets (pinned in Tasks 2, 7, and 9).

---

### Task 1: Shared IntelliSense Types & Error-Tolerant HELIX Lexer

**Files:**
- Create: `web/src/editor/intellisense/types.ts`
- Create: `web/src/editor/intellisense/lexer.ts`
- Test: `web/tests/intellisense/lexer-parity.test.ts`

**Interfaces:**
- Consumes: `Dataset`, `Diagnostic`, `ColumnType`, `Cell` from `../../services/types`
- Produces:
  - From `types.ts`: `HELIX_KEYWORDS: readonly string[]`, `HELIX_KEYWORD_SET: ReadonlySet<string>`, `EXECUTOR_TIME_UNITS: readonly string[]`, `PARSER_ONLY_TIME_UNITS: readonly string[]`, `MEMBER_KEYWORDS: ReadonlySet<string>`, `TextRange`, `TextPosition`, `LexTokenKind`, `LexToken`, `LexComment`, `LexResult`, `ValueType`, `BlockKind`, `BlockNode`, `SymbolKindTag`, `SymbolEntry`, `TerminologyOccurrence`, `IdentifierRef`, `DocumentIndex`, `HelixLanguageSettings`, `HelixLanguageHost`
  - From `lexer.ts`: `tokenizeHelix(source: string): LexResult`, `positionToOffset(source: string, pos: TextPosition): number`, `offsetToPosition(source: string, offset: number): TextPosition`, `isOffsetInComment(comments: readonly LexComment[], offset: number): boolean`

- [ ] **Step 1: Write the failing test**

Create `web/tests/intellisense/lexer-parity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import high from "../../../examples/high_glucose_alert.helix?raw";
import basic from "../../../examples/basic_rule.helix?raw";
import sepsis from "../../../examples/alert_rule.helix?raw";
import temporal from "../../../examples/temporal_rule.helix?raw";
import invalid from "../../../examples/invalid_syntax_demo.helix?raw";
import { HELIX_KEYWORDS } from "../../src/editor/intellisense/types";
import {
  tokenizeHelix,
  isOffsetInComment,
  positionToOffset,
  offsetToPosition,
} from "../../src/editor/intellisense/lexer";

describe("HELIX error-tolerant lexer parity", () => {
  it("exports the exact 21 C11 reserved keywords", () => {
    expect(HELIX_KEYWORDS).toHaveLength(21);
    expect([...HELIX_KEYWORDS].sort()).toEqual([
      "alert", "and", "bind", "end", "for", "intent", "latest", "let", "not",
      "or", "otherwise", "rule", "schedule", "site", "source", "suppress",
      "terminology", "then", "when", "where", "within",
    ]);
  });

  it("tokenizes all four valid presets without error tokens", () => {
    for (const src of [high, basic, sepsis, temporal]) {
      const res = tokenizeHelix(src);
      expect(res.tokens.some((t) => t.kind === "error")).toBe(false);
      expect(res.tokens[res.tokens.length - 1]?.kind).toBe("eof");
    }
  });

  it("recovers cleanly from unterminated strings, CRLF, and unicode without corrupting next line", () => {
    const src = 'rule R:\r\n    # temp °C 😀\r\n    alert: "unterminated\r\n    end rule\r\n';
    const res = tokenizeHelix(src);
    const unterm = res.tokens.find((t) => t.kind === "unterminated_string");
    expect(unterm?.lexeme).toBe('"unterminated');
    expect(unterm?.line).toBe(3);
    const endKw = res.tokens.find((t) => t.kind === "keyword" && t.lexeme === "end");
    expect(endKw?.line).toBe(4);
    expect(isOffsetInComment(res.comments, positionToOffset(src, { lineNumber: 2, column: 10 }))).toBe(true);
    expect(isOffsetInComment(res.comments, positionToOffset(src, { lineNumber: 4, column: 5 }))).toBe(false);
    const emojiEnd = positionToOffset(src, { lineNumber: 2, column: 16 });
    expect(offsetToPosition(src, emojiEnd)).toEqual({ lineNumber: 2, column: 16 });
  });

  it("recognizes multi-char operators and flags lone '!' as error token", () => {
    const res = tokenizeHelix("a := 1 + 2 - 3 * 4 / 5 == 6 != 7 <= 8 >= 9 -> x ! y");
    expect(res.tokens.filter((t) => t.kind === "operator").map((t) => t.lexeme)).toEqual([
      ":=", "+", "-", "*", "/", "==", "!=", "<=", ">=", "->",
    ]);
    expect(res.tokens.find((t) => t.kind === "error")?.lexeme).toBe("!");
    expect(tokenizeHelix(invalid).tokens.some((t) => t.kind === "error" || t.kind === "unterminated_string")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tests/intellisense/lexer-parity.test.ts`
Expected: FAIL — cannot resolve `../../src/editor/intellisense/types` / `lexer`.

- [ ] **Step 3: Implement `types.ts` and `lexer.ts`**

Create `web/src/editor/intellisense/types.ts` defining the shared interfaces and pinned constants:
- `HELIX_KEYWORDS`: exact 21 keywords matching `src/keywords.c`.
- `EXECUTOR_TIME_UNITS`: `["minutes", "hours", "days", "seconds", "weeks", "m", "h", "d", "s", "w", "minute", "hour", "day", "second", "week", "min", "mins", "hr", "hrs", "sec", "secs", "wk", "wks"]`.
- `PARSER_ONLY_TIME_UNITS`: `["months", "month", "years", "year"]`.
- `MEMBER_KEYWORDS`: `new Set(["latest", "source", "site", "schedule", "terminology"])`.
- `LexTokenKind`: `"keyword" | "identifier" | "int" | "float" | "string" | "unterminated_string" | "operator" | "delimiter" | "error" | "eof"`.
- `TextPosition` (`{ lineNumber: number; column: number }`, 1-based UTF-16) and `TextRange` (`{ startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }`).
- `LexToken` (`kind`, `lexeme`, `startOffset`, `endOffset`, `line`, `column`, `endLine`, `endColumn`), `LexComment` (`startOffset`, `endOffset`, `line`, `column`, `text`), `LexResult` (`tokens`, `comments`, `lineStarts`).
- `ValueType`: `"Number" | "String" | "Boolean" | "DateTime" | "Series" | "Unknown"`.
- `HelixLanguageSettings`: `{ inlinePredictions: boolean; autoSuggest: boolean }`.
- `HelixLanguageHost`: `{ getDataset: () => Dataset; getSettings: () => HelixLanguageSettings; getFilename: () => string; getDiagnostics?: () => Diagnostic[] }`.
- `BlockNode`, `SymbolEntry`, `TerminologyOccurrence`, `IdentifierRef`, `DocumentIndex` contracts consumed by Tasks 3–8.

Create `web/src/editor/intellisense/lexer.ts` implementing `tokenizeHelix(source)`, `positionToOffset(source, pos)`, `offsetToPosition(source, offset)`, and `isOffsetInComment(comments, offset)` matching `src/lexer.c` rules (UTF-16 offsets + 1-based lines/columns, `\r\n` and `\r` handling, `#` comments captured in `comments[]`, single-line strings terminating before `\r`/`\n` as `unterminated_string` with escape handling `\"` `\\` `\n` `\t` `\r`, numbers with optional `.digits` without backtracking regexes, binary search on `lineStarts` and `comments`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run tests/intellisense/lexer-parity.test.ts`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add web/src/editor/intellisense/types.ts web/src/editor/intellisense/lexer.ts web/tests/intellisense/lexer-parity.test.ts
git commit -m "feat(intellisense): add shared types and error-tolerant HELIX lexer"
```

---

### Task 2: Clinical Terminology Catalog & WeakMap-Cached Dataset Schema Index

**Files:**
- Create: `web/src/editor/intellisense/terminology.ts`
- Create: `web/src/editor/intellisense/schema.ts`
- Test: `web/tests/intellisense/schema-terminology.test.ts`

**Interfaces:**
- Consumes: `Dataset`, `Table`, `Column`, `ColumnType`, `Cell` from `../../services/types`; `ValueType` from `./types`
- Produces:
  - From `terminology.ts`: `TerminologySystem = "LOINC" | "SNOMED" | "RxNorm"`, `TerminologyEntry`, `TERMINOLOGY_SYSTEMS`, `TERMINOLOGY_CODES: readonly TerminologyEntry[]`, `findTerm(system: string, code: string): TerminologyEntry | null`, `searchTerms(query: string, system?: TerminologySystem): TerminologyEntry[]`
  - From `schema.ts`: `ResolvedBinding` (`{ path: string; tableName: string; columnName: string; columnType: ColumnType; table: Table }`), `BindingSuffixEntry` (`{ prefix: string; suffix: string; fullPath: string; target: ResolvedBinding }`), `ColumnSampleSummary` (`{ values: Cell[]; counts: Map<Cell, number>; nonNullCount: number; missingCount: number; min?: number; max?: number }`), `DatasetSchemaIndex`, `getDatasetSchemaIndex(dataset: Dataset): DatasetSchemaIndex`, `columnTypeToValueType(type: ColumnType): ValueType`

- [ ] **Step 1: Write the failing test**

Create `web/tests/intellisense/schema-terminology.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import sepsisData from "../../../examples/data/sepsis.json";
import temporalData from "../../../examples/data/temporal.json";
import type { Dataset } from "../../src/services/types";
import {
  TERMINOLOGY_CODES,
  findTerm,
  searchTerms,
} from "../../src/editor/intellisense/terminology";
import {
  getDatasetSchemaIndex,
  columnTypeToValueType,
} from "../../src/editor/intellisense/schema";

describe("terminology catalog and dataset schema index", () => {
  it("ports all 49 curated clinical codes and supports exact, alias, and description search", () => {
    expect(TERMINOLOGY_CODES).toHaveLength(49);
    expect(findTerm("LOINC", "2339-0")?.description).toContain("Glucose");
    expect(findTerm("LOINC", "serum potassium")?.code).toBe("2823-3");
    expect(findTerm("SNOMED", "62315008")?.deprecated).toBe(true);
    expect(searchTerms("septic", "SNOMED")[0]?.code).toBe("91302008");
    expect(searchTerms("2339", "LOINC")[0]?.code).toBe("2339-0");
  });

  it("caches per Dataset reference and mirrors src/bindings.c resolution", () => {
    const ds = structuredClone(temporalData) as Dataset;
    const idx1 = getDatasetSchemaIndex(ds);
    const idx2 = getDatasetSchemaIndex(ds);
    expect(idx1).toBe(idx2);
    expect(idx1.resolvePath("Vitals.heart_rate")).toMatchObject({
      tableName: "heart_rate_readings",
      columnName: "value",
      columnType: "Float",
    });
    expect(idx1.bindingPrefixes.get("Vitals")?.map((e) => e.suffix)).toEqual(["heart_rate"]);
    expect(idx1.resolvePath("heart_rate_readings.status")?.columnType).toBe("String");
    expect(idx1.resolvePath("heart_rate_readings")?.columnName).toBe("value");
    expect(idx1.resolvePath("missing.path")).toBeNull();
    expect(columnTypeToValueType("Integer")).toBe("Number");
    expect(columnTypeToValueType("Float")).toBe("Number");
  });

  it("samples distinct non-null column values ordered by frequency and handles empty/large/null tables safely", () => {
    const idx = getDatasetSchemaIndex(structuredClone(temporalData) as Dataset);
    const sample = idx.getColumnSamples("heart_rate_readings", "status");
    expect(sample.values).toEqual(["final", "preliminary"]);
    expect(sample.nonNullCount).toBe(3);

    const sepsisIdx = getDatasetSchemaIndex(structuredClone(sepsisData) as Dataset);
    const sbp = sepsisIdx.getColumnSamples("Vitals", "systolic_bp");
    expect(sbp.min).toBe(85);
    expect(sbp.max).toBe(120);

    const big: Dataset = {
      schemaVersion: 1,
      evaluationTime: "2026-10-31T12:00:00Z",
      Bindings: {},
      tables: [
        {
          name: "huge",
          patientIdColumn: "patient_id",
          timestampColumn: "timestamp",
          defaultValueColumn: "value",
          columns: [
            { name: "patient_id", type: "String" },
            { name: "timestamp", type: "DateTime" },
            { name: "value", type: "Float" },
            { name: "tag", type: "String" },
          ],
          rows: Array.from({ length: 10000 }, (_, i) => ({
            patient_id: `P${i}`,
            timestamp: "2026-10-31T11:00:00Z",
            value: null,
            tag: `v${i % 50}`,
          })),
        },
        {
          name: "empty_tbl",
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
    const bigIdx = getDatasetSchemaIndex(big);
    expect(bigIdx.getColumnSamples("huge", "value").values).toEqual([]);
    expect(bigIdx.getColumnSamples("huge", "value").missingCount).toBe(200);
    expect(bigIdx.getColumnSamples("huge", "tag").values.length).toBeLessThanOrEqual(20);
    expect(bigIdx.getColumnSamples("empty_tbl", "value").values).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tests/intellisense/schema-terminology.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `terminology.ts` and `schema.ts`**

Create `web/src/editor/intellisense/terminology.ts`:
- Port all 49 entries verbatim from `gui/web/src/lib/terminology.js` (24 LOINC, 15 SNOMED, 10 RxNorm, including `aliases` on `2823-3` and `deprecated: true` on `62315008`), plus `TERMINOLOGY_SYSTEMS` (`LOINC`, `SNOMED`, `RxNorm` with labels & URIs).
- Build an O(1) lookup `Map` keyed by `${system.toUpperCase()}|${codeOrAlias.toLowerCase()}` for `findTerm(system, code)`.
- Implement `searchTerms(query, system?)` filtering by optional system and ranking exact code prefix matches ahead of description/alias substring matches.

Create `web/src/editor/intellisense/schema.ts`:
- Use `const schemaCache = new WeakMap<Dataset, DatasetSchemaIndex>()`.
- Implement `getDatasetSchemaIndex(dataset)` indexing `tablesByName`, `tableNames`, `bindings` (resolving each `dataset.Bindings` entry identically to `src/bindings.c`), `bindingPrefixes` (for dotted keys like `Labs.glucose`), `resolvePath(path)` (1. exact `Bindings[path]`, 2. split on last `.` into `table.column`, 3. bare `table` using `defaultValueColumn`), and lazy per-column `getColumnSamples(tableName, columnName)` capped at **200 rows scanned** and **20 distinct non-null values** ordered descending by frequency, computing `min`/`max` for `Integer`/`Float`.
- Export `columnTypeToValueType(type: ColumnType): ValueType`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run tests/intellisense/schema-terminology.test.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add web/src/editor/intellisense/terminology.ts web/src/editor/intellisense/schema.ts web/tests/intellisense/schema-terminology.test.ts
git commit -m "feat(intellisense): add clinical terminology catalog and cached dataset schema index"
```

---

### Task 3: Incremental Error-Tolerant Document Index

**Files:**
- Create: `web/src/editor/intellisense/document-index.ts`
- Test: `web/tests/intellisense/document-index.test.ts`

**Interfaces:**
- Consumes: `tokenizeHelix`, `positionToOffset`, `offsetToPosition` from `./lexer`; `DatasetSchemaIndex`, `columnTypeToValueType` from `./schema`; `DocumentIndex`, `BlockNode`, `SymbolEntry`, `TerminologyOccurrence`, `IdentifierRef`, `ValueType` from `./types`
- Produces:
  - `indexDocument(source: string, schema: DatasetSchemaIndex, options?: { skipDeepRefs?: boolean }): DocumentIndex`
  - `openBlocksAt(doc: DocumentIndex, offset: number): BlockNode[]`
  - `activeRuleAt(doc: DocumentIndex, offset: number): BlockNode | null`
  - `visibleSymbolsAt(doc: DocumentIndex, offset: number): SymbolEntry[]`
  - `findReferenceAtOffset(doc: DocumentIndex, offset: number): IdentifierRef | null`
  - `findTerminologyAtOffset(doc: DocumentIndex, offset: number): TerminologyOccurrence | null`

- [ ] **Step 1: Write the failing test**

Create `web/tests/intellisense/document-index.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import sepsis from "../../../examples/alert_rule.helix?raw";
import sepsisData from "../../../examples/data/sepsis.json";
import temporal from "../../../examples/temporal_rule.helix?raw";
import temporalData from "../../../examples/data/temporal.json";
import type { Dataset } from "../../src/services/types";
import { getDatasetSchemaIndex } from "../../src/editor/intellisense/schema";
import {
  indexDocument,
  openBlocksAt,
  activeRuleAt,
  visibleSymbolsAt,
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

    const obsStatus = doc.symbols.find((s) => s.name === "observation_status");
    expect(obsStatus?.valueType).toBe("String");

    const snomedOffset = sepsis.indexOf("91302008");
    expect(findTerminologyAtOffset(doc, snomedOffset)).toMatchObject({
      system: "SNOMED",
      code: "91302008",
    });
  });

  it("isolates branch-scoped let variables and recovers across unclosed blocks in multi-rule files", () => {
    const schema = getDatasetSchemaIndex(structuredClone(temporalData) as Dataset);
    const src = [
      "rule RuleOne:",
      "    bind hr = Vitals.heart_rate",
      "    end bind",
      "    when hr.latest > 100:",
      "    then:",
      "        alert: \"High\"",
      "    otherwise:",
      "        let branch_only := \"monitoring\"",
      "rule RuleTwo:",
      "    let r2_limit := 80",
      "    when ",
    ].join("\n");
    const doc = indexDocument(src, schema);

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
  });

  it("tracks where/within metadata on bound series for hover", () => {
    const schema = getDatasetSchemaIndex(structuredClone(temporalData) as Dataset);
    const doc = indexDocument(temporal, schema);
    const hr = doc.symbols.find((s) => s.name === "hr_readings");
    expect(hr?.whereText).toContain('status == "final"');
    expect(hr?.withinText).toContain("30 minutes");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tests/intellisense/document-index.test.ts`
Expected: FAIL — `document-index` module not found.

- [ ] **Step 3: Implement `document-index.ts`**

Create `web/src/editor/intellisense/document-index.ts`:
- Single-pass O(n) scan over `tokenizeHelix(source)` tokens (never throws on incomplete input).
- Maintain a block stack for `rule`, `bind` / `bind-site`, and `when` (recognizing `when Event.member` event triggers when followed immediately by a rule-element keyword or `end`, mirroring `is_event_trigger_ahead` in `src/parser.c`).
- Recovery boundary: when `rule <Name>` appears while previous blocks are still open, synthetically close all open blocks at the previous token's `endOffset` so subsequent rules have accurate scopes and `openBlocksAt`.
- Scope tracking for `let`: if declared inside a `then` branch (between `thenOffset` and `otherwiseOffset ?? closeOffset`) or `otherwise` branch (between `otherwiseOffset` and `closeOffset`), set `scopeStartOffset`/`scopeEndOffset` to that branch; otherwise set scope to the enclosing `rule` block.
- Infer `let` `ValueType` from RHS tokens: numeric literal or arithmetic expression → `"Number"`, string literal → `"String"`, `<series>.latest` → `columnTypeToValueType(resolvedTarget.columnType)`, existing `let` → copy its type, comparison/boolean `and`/`or`/`not` → `"Boolean"`, else `"Unknown"`.
- Extract `TerminologyOccurrence` for `LOINC`/`SNOMED`/`RxNorm` calls (`(...)` or `[...]`, quoted or bare, complete or mid-typing).
- Unless `source.length > 262_144` (256 KiB large-file guard) or `options?.skipDeepRefs`, collect `IdentifierRef[]` mapping every identifier occurrence (and `.latest` member targets) to its resolved `SymbolEntry` or dataset target for O(k) Go-to-Definition and Find References.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run tests/intellisense/document-index.test.ts`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add web/src/editor/intellisense/document-index.ts web/tests/intellisense/document-index.test.ts
git commit -m "feat(intellisense): add incremental error-tolerant document and scope indexer"
```

---

### Task 4: Grammar-State Automaton & Cursor Context Classifier

**Files:**
- Create: `web/src/editor/intellisense/context.ts`
- Test: `web/tests/intellisense/context.test.ts`

**Interfaces:**
- Consumes: `DocumentIndex`, `TextPosition`, `TextRange`, `ValueType`, `LexToken`, `MEMBER_KEYWORDS` from `./types`; `positionToOffset`, `offsetToPosition`, `isOffsetInComment` from `./lexer`; `DatasetSchemaIndex`, `columnTypeToValueType` from `./schema`; `openBlocksAt`, `visibleSymbolsAt` from `./document-index`
- Produces:
  - `CursorContextKind` (union of 31 exact slots: `"comment"`, `"string-literal"`, `"terminology-code"`, `"alert-severity-string"`, `"where-string-value"`, `"top-level"`, `"rule-name"`, `"rule-body"`, `"bind-name"`, `"bind-rhs"`, `"bind-clause"`, `"bind-site-body"`, `"source-target"`, `"source-arrow"`, `"let-name"`, `"let-rhs"`, `"where-column"`, `"where-value"`, `"member-access"`, `"when-condition-start"`, `"when-condition-after-operand"`, `"comparison-rhs"`, `"branch-body"`, `"alert-arg"`, `"suppress-operand"`, `"suppress-repeat-target"`, `"within-amount"`, `"within-unit"`, `"within-post"`, `"terminology-system"`, `"end-block"`)
  - `CursorContext` (discriminated metadata: `kind`, `offset`, `position`, `replaceRange`, `prefix`, `openBlocks`, `inRule`, `inWhen`, `inBind`, `expectedBlockEnd?`, `memberOwner?`, `resolvedTableName?`, `resolvedColumnName?`, `expectedType?`, `lhsHintName?`, `alertArgIndex?`, `terminologySystem?`, `withinNumber?`, `bindAlias?`, `hasOtherwise?`, `hasThen?`)
  - `analyzeCursorContext(doc: DocumentIndex, schema: DatasetSchemaIndex, position: TextPosition): CursorContext`

- [ ] **Step 1: Write the failing test**

Create `web/tests/intellisense/context.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import sepsisData from "../../../examples/data/sepsis.json";
import temporalData from "../../../examples/data/temporal.json";
import type { Dataset } from "../../src/services/types";
import { getDatasetSchemaIndex } from "../../src/editor/intellisense/schema";
import { indexDocument } from "../../src/editor/intellisense/document-index";
import { analyzeCursorContext } from "../../src/editor/intellisense/context";

function ctxAt(srcWithCaret: string, dataset: Dataset) {
  const idx = srcWithCaret.indexOf("|");
  const src = srcWithCaret.slice(0, idx) + srcWithCaret.slice(idx + 1);
  const before = src.slice(0, idx).split("\n");
  const pos = { lineNumber: before.length, column: before[before.length - 1].length + 1 };
  const schema = getDatasetSchemaIndex(dataset);
  const doc = indexDocument(src, schema);
  return analyzeCursorContext(doc, schema, pos);
}

describe("grammar-state cursor context classifier", () => {
  const sepsis = structuredClone(sepsisData) as Dataset;
  const temporal = structuredClone(temporalData) as Dataset;

  it("suppresses comments and free-text strings, but classifies terminology, severity, and where strings", () => {
    expect(ctxAt("rule R:\n    # hi |\nend rule", sepsis).kind).toBe("comment");
    expect(ctxAt('rule R:\n    intent: "Detect |"\nend rule', sepsis).kind).toBe("string-literal");
    expect(ctxAt('rule R:\n    terminology: LOINC("glu|\nend rule', sepsis)).toMatchObject({
      kind: "terminology-code",
      terminologySystem: "LOINC",
      prefix: "glu",
    });
    expect(ctxAt('rule R:\n    when 1 > 0:\n    then:\n        alert: "Msg", "W|\n    end when\nend rule', sepsis).kind).toBe(
      "alert-severity-string",
    );
    expect(
      ctxAt('rule R:\n    bind hr = Vitals.heart_rate where status == "fi|\nend rule', temporal),
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
    expect(ctxAt("rule R:\n    bind hr = Vitals.heart_rate where |\nend rule", temporal)).toMatchObject({
      kind: "where-column",
      resolvedTableName: "heart_rate_readings",
    });
    expect(ctxAt("rule R:\n    bind hr = Vitals.|\nend rule", temporal)).toMatchObject({
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
    expect(ctxAt("rule R:\n    when 1 > 0:\n    then:\n        alert: \"x\"\n    end |\nend rule", sepsis)).toMatchObject({
      kind: "end-block",
      expectedBlockEnd: "when",
    });
  });

  it("classifies within units, suppress repeat_of, and alert argument positions", () => {
    expect(ctxAt("rule R:\n    when 1 > 0 within 30 |\nend rule", temporal)).toMatchObject({
      kind: "within-unit",
      withinNumber: 30,
    });
    expect(ctxAt("rule R:\n    suppress: repeat_of: |\nend rule", temporal).kind).toBe(
      "suppress-repeat-target",
    );
    expect(
      ctxAt('rule R:\n    when 1 > 0:\n    then:\n        alert: "High", "WARNING", |\n    end when\nend rule', temporal),
    ).toMatchObject({
      kind: "alert-arg",
      alertArgIndex: 2,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tests/intellisense/context.test.ts`
Expected: FAIL — `context` module not found.

- [ ] **Step 3: Implement `context.ts`**

Create `web/src/editor/intellisense/context.ts` implementing `analyzeCursorContext(doc, schema, position)`:
- Locate cursor offset via `positionToOffset(doc.source, position)`.
- Check `isOffsetInComment(doc.comments, offset)` first → `"comment"`.
- Check if offset falls strictly inside a `string` or `unterminated_string` token (between opening `"` + 1 and closing `"` or EOL): inspect preceding tokens to return `"terminology-code"`, `"alert-severity-string"`, `"where-string-value"`, or `"string-literal"` with `replaceRange` spanning the inner text and `prefix` set to text before cursor inside the quote.
- Extract the current partial identifier/word at cursor (`prefix`, `replaceRange`) and the slice of preceding tokens belonging to the current clause/statement.
- Walk backwards from the token immediately preceding the active word (or cursor) using a clean deterministic precedence chain:
  1. Preceded by `.` → `"member-access"` with `memberOwner` (and full dotted chain if chained like `a.b.`).
  2. Preceded by `end` → `"end-block"` with `expectedBlockEnd` from innermost `openBlocksAt(doc, offset)`.
  3. Preceded by `within` → `"within-amount"`; `within <int|float>` → `"within-unit"` (`withinNumber`); `within <num> <unit>` → `"within-post"`.
  4. Inside `bind` clause (after `bind <alias> (=|:=|:|->) <path>` and before `end bind`): resolve the `bind`'s target table via `schema.resolvePath(path)` so `where` sets `"where-column"` (`resolvedTableName`) and `where <col> <compOp>` sets `"where-value"` (`resolvedTableName`, `resolvedColumnName`, `expectedType`).
  5. After `bind` → `"bind-name"`; after `bind <alias> (=|:=|:|->)` → `"bind-rhs"` (`bindAlias`); inside `bind-site` block → `"bind-site-body"`.
  6. After `source [:]` → `"source-target"`; after `source X ->` → `"source-arrow"`.
  7. After `let` → `"let-name"`; after `let <name> (:=|=)` → `"let-rhs"`.
  8. After `terminology [:]` → `"terminology-system"`.
  9. Inside `alert [:]` → count top-level commas to return `"alert-arg"` with `alertArgIndex`.
  10. Inside `suppress [:]` → `"suppress-repeat-target"` after `repeat_of :`, else `"suppress-operand"`.
  11. After comparison operator (`==`, `!=`, `<`, `<=`, `>`, `>=`, `=`) outside `where` → `"comparison-rhs"` with `expectedType` and `lhsHintName` inferred from the LHS token slice (`<series>.latest`, `<series>.<col>.latest`, `<letVar>`, literal).
  12. Inside `when` condition (before `then`) → `"when-condition-after-operand"` if previous token ends an operand (identifier, literal, `latest`, `)`) else `"when-condition-start"`.
  13. Inside `when` branch (after `then` / `otherwise`) → `"branch-body"` (`hasOtherwise`).
  14. Inside `rule` → `"rule-body"`; after `rule` → `"rule-name"`; outside any rule → `"top-level"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run tests/intellisense/context.test.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add web/src/editor/intellisense/context.ts web/tests/intellisense/context.test.ts
git commit -m "feat(intellisense): implement grammar-state cursor context classifier"
```

---

### Task 5: Multi-Signal Prediction Ranker & Completion Builder

**Files:**
- Create: `web/src/editor/intellisense/ranking.ts`
- Create: `web/src/editor/intellisense/completions.ts`
- Test: `web/tests/intellisense/completions-ranking.test.ts`

**Interfaces:**
- Consumes: `CursorContext` from `./context`; `DocumentIndex`, `SymbolEntry`, `ValueType`, `TextRange`, `EXECUTOR_TIME_UNITS`, `PARSER_ONLY_TIME_UNITS` from `./types`; `DatasetSchemaIndex`, `columnTypeToValueType` from `./schema`; `visibleSymbolsAt` from `./document-index`; `searchTerms`, `TERMINOLOGY_SYSTEMS` from `./terminology`
- Produces:
  - From `ranking.ts`: `MruTracker` (`record(contextKind: string, label: string): void`, `boost(contextKind: string, label: string): number`, `clear(): void`), `RankedCandidate`, `extractStems(ident: string): string[]`, `computeNameAffinity(candidateName: string, lhsHintName?: string, expectedType?: ValueType): number`, `scoreCandidate(input: ScoreInput): number`, `toSortText(score: number, label: string): string`
  - From `completions.ts`: `CompletionCandidate` (Monaco-independent representation with `label`, `kind`, `insertText`, `isSnippet`, `detail`, `documentation`, `sortText`, `filterText?`, `range`, `preselect?`, `syntaxOnly?`, `score`, `contextKind`), `buildCompletions(doc: DocumentIndex, schema: DatasetSchemaIndex, ctx: CursorContext, mru: MruTracker, filename: string): CompletionCandidate[]`

- [ ] **Step 1: Write the failing test**

Create `web/tests/intellisense/completions-ranking.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import sepsis from "../../../examples/alert_rule.helix?raw";
import sepsisData from "../../../examples/data/sepsis.json";
import temporalData from "../../../examples/data/temporal.json";
import type { Dataset } from "../../src/services/types";
import { getDatasetSchemaIndex } from "../../src/editor/intellisense/schema";
import { indexDocument } from "../../src/editor/intellisense/document-index";
import { analyzeCursorContext } from "../../src/editor/intellisense/context";
import { MruTracker } from "../../src/editor/intellisense/ranking";
import { buildCompletions } from "../../src/editor/intellisense/completions";

function completeAt(srcWithCaret: string, dataset: Dataset, mru = new MruTracker(), filename = "test.helix") {
  const idx = srcWithCaret.indexOf("|");
  const src = srcWithCaret.slice(0, idx) + srcWithCaret.slice(idx + 1);
  const before = src.slice(0, idx).split("\n");
  const pos = { lineNumber: before.length, column: before[before.length - 1].length + 1 };
  const schema = getDatasetSchemaIndex(dataset);
  const doc = indexDocument(src, schema);
  const ctx = analyzeCursorContext(doc, schema, pos);
  return buildCompletions(doc, schema, ctx, mru, filename);
}

describe("multi-signal prediction ranker and completion builder", () => {
  const sepsisDs = structuredClone(sepsisData) as Dataset;
  const temporalDs = structuredClone(temporalData) as Dataset;

  it("ranks type-compatible and name-affinity variables #1 on comparison RHS", () => {
    const src = [
      "rule Sepsis:",
      "    bind sbp = Vitals.systolic_bp",
      "    end bind",
      "    let note := \"ok\"",
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
    expect(bindLhs.some((i) => i.label === "site")).toBe(true);

    const bindRhs = completeAt("rule R:\n    bind hr = |\nend rule", temporalDs);
    expect(bindRhs.some((i) => i.label === "Vitals.heart_rate")).toBe(true);

    const whereCols = completeAt("rule R:\n    bind hr = Vitals.heart_rate where |\nend rule", temporalDs);
    expect(whereCols.map((i) => i.label)).toContain("status");

    const whereVals = completeAt("rule R:\n    bind hr = Vitals.heart_rate where status == |\nend rule", temporalDs);
    expect(whereVals[0]?.insertText).toBe('"final"');
  });

  it("predicts exact innermost end-block closer and ranks executable syntax above syntax-only forms", () => {
    const endWhen = completeAt("rule R:\n    when 1 > 0:\n    then:\n        alert: \"x\"\n    end |\nend rule", sepsisDs);
    expect(endWhen[0]?.label).toBe("when");
    expect(endWhen.map((i) => i.label)).not.toContain("bind");

    const ruleBody = completeAt("rule R:\n    |\nend rule", sepsisDs);
    const bindItem = ruleBody.find((i) => i.label === "bind")!;
    const forItem = ruleBody.find((i) => i.label === "for")!;
    expect(bindItem.sortText < forItem.sortText).toBe(true);
    expect(forItem.detail).toContain("Syntax-only");
  });

  it("populates dynamic snippets with active dataset tables instead of hardcoded glucose_data", () => {
    const topItems = completeAt("|", sepsisDs);
    const snippet = topItems.find((i) => i.isSnippet);
    expect(snippet?.insertText).toContain("Vitals");
    expect(snippet?.insertText).not.toContain("glucose_data");
  });

  it("searches clinical terminology by description and promotes MRU-accepted items", () => {
    const codes = completeAt('rule R:\n    terminology: LOINC("glucose|\nend rule', sepsisDs);
    expect(codes.some((i) => i.insertText === "2339-0")).toBe(true);

    const mru = new MruTracker();
    mru.record("within-unit", "days");
    const units = completeAt("rule R:\n    when 1 > 0 within 10 |\nend rule", sepsisDs, mru);
    const days = units.find((i) => i.label === "days")!;
    const months = units.find((i) => i.label === "months")!;
    expect(days.sortText < months.sortText).toBe(true);
    expect(months.detail).toContain("Syntax-only");
    expect(sepsis.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tests/intellisense/completions-ranking.test.ts`
Expected: FAIL — `ranking` / `completions` modules not found.

- [ ] **Step 3: Implement `ranking.ts` and `completions.ts`**

Create `web/src/editor/intellisense/ranking.ts`:
- `MruTracker` keeping at most 100 `(contextKind, label)` entries in memory (most recent at end), returning linear recency boost `+0..+60`.
- `extractStems(ident)` splitting snake_case and camelCase into lowercase stems while filtering stop-words (`data`, `readings`, `reading`, `val`, `value`, `var`).
- `computeNameAffinity(candidateName, lhsHintName, expectedType)`: `+120` on shared stem, `+60` on threshold stems (`threshold`, `limit`, `max`, `min`, `crit`, `critical`, `high`, `low`) when `expectedType === "Number"`.
- `scoreCandidate` implementing the exact spec weights (`base`, `+180/-160` type compatibility, name affinity, `+0..+40` locality, `+0..+60` MRU, `-250` syntax-only penalty) and `toSortText(score, label)`.

Create `web/src/editor/intellisense/completions.ts`:
- Handle all context kinds cleanly:
  - `"comment"` / `"string-literal"` → `[]`.
  - `"top-level"` → `rule` keyword + dynamic `rule template` snippet using the dataset's first table/binding (`schema.tableNames[0]`).
  - `"rule-name"` → PascalCase filename-derived suggestion (e.g. `HighGlucoseAlert`).
  - `"rule-body"` → executable keywords (`intent`, `source`, `bind`, `let`, `when`, `alert`, `suppress`, `site`, `schedule`, `terminology`, `end rule`), dynamic snippets (`when / otherwise`, `filtered binding`) populated with real visible series / dataset bindings, and syntax-only (`for`, `latest`) with `-250` penalty & `"Syntax-only (not evaluated in Studio)"` detail.
  - `"bind-name"` → smart unused alias names derived from dataset `Bindings` suffixes / table names (e.g. `glucose`, `heart_rate`) + `site` (tagged `"Syntax-only"`), NEVER raw table names as RHS.
  - `"bind-rhs"` → `Bindings` keys (`Labs.glucose`), `Table.column` pairs, bare table names.
  - `"bind-clause"` → `where`, `within`, `end bind`.
  - `"bind-site-body"` → `site`, `source`, `terminology`, `end bind`.
  - `"source-target"` → dataset table names + `EHR`. `"source-arrow"` → `FHIR_R4`, `HL7v2`, `OMOP`.
  - `"let-name"` → smart names (`threshold`, `max_<series>`, `min_<series>`). `"let-rhs"` → visible `<series>.latest`, visible `let` vars.
  - `"where-column"` → columns of `ctx.resolvedTableName` (showing `ColumnType` & sample preview) + `not`.
  - `"where-value"` / `"where-string-value"` → `schema.getColumnSamples(table, col).values` (quoted if `String` and not already inside quotes; bare inner text if `"where-string-value"`) + type-compatible `let` vars.
  - `"member-access"` → if `memberOwner` is a visible `bind`/`source` series: `latest` (#1, preselected), plus `latest > <uniqueMatchedLet>` when inside `when` condition, plus columns of its resolved table; if `memberOwner` is in `schema.bindingPrefixes`: matching `Bindings` suffixes; if `memberOwner` is a table name: its columns; else contextual `MEMBER_KEYWORDS`.
  - `"when-condition-start"` → visible bound/source series as `<series>.latest`, visible `let` vars, `not`.
  - `"when-condition-after-operand"` → type-appropriate operators (`>`, `<`, `>=`, `<=`, `==`, `!=`, `+`, `-`, `*`, `/`), `and`, `or`, `within`, `then:`.
  - `"comparison-rhs"` → visible `let` vars (type & affinity scored!), other `<series>.latest` of matching type, representative table min/max values.
  - `"branch-body"` → `alert`, `suppress`, `let`, `when`, `otherwise` (only if `!ctx.hasOtherwise`), `end when`.
  - `"alert-arg"` / `"alert-severity-string"` → arg 0: message snippet + syntax-only `level:`; arg 1: `"WARNING"`, `"CRITICAL"`, `"INFO"` + `<series>.latest` / `let` payload expressions; arg 2+: payload expressions.
  - `"suppress-operand"` → `within`, duration presets (`within 1 hours`, `within 4 hours`, `within 6 hours`), `"reason"` snippet, syntax-only `repeat_of:`; `"suppress-repeat-target"` → all declared `rule` names.
  - `"within-amount"` → presets (`15 minutes`, `30 minutes`, `1 hours`, `4 hours`, `6 hours`, `24 hours`, `7 days`). `"within-unit"` → `EXECUTOR_TIME_UNITS` ranked ahead of `PARSER_ONLY_TIME_UNITS` (`"Syntax-only"`). `"within-post"` → `before now`, `then:`, `end bind`.
  - `"terminology-system"` → `LOINC("${1:2339-0}")`, `SNOMED("${1:91302008}")`, `RxNorm("${1:860975}")`. `"terminology-code"` → `searchTerms(ctx.prefix, ctx.terminologySystem)` with `filterText: "${c.code} ${c.description}"` so typing `"glucose"` inside `LOINC("` matches and inserts `"2339-0"`.
  - `"end-block"` → exact `ctx.expectedBlockEnd` ONLY (when open block exists), else `["rule", "when", "bind"]`.
- Sort output ascending by `sortText`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run tests/intellisense/completions-ranking.test.ts`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add web/src/editor/intellisense/ranking.ts web/src/editor/intellisense/completions.ts web/tests/intellisense/completions-ranking.test.ts
git commit -m "feat(intellisense): add multi-signal ranker and context-aware completion builder"
```

---

### Task 6: Deterministic Multi-Token Inline Ghost-Text Engine

**Files:**
- Create: `web/src/editor/intellisense/inline-predictions.ts`
- Test: `web/tests/intellisense/inline-predictions.test.ts`

**Interfaces:**
- Consumes: `DocumentIndex`, `TextPosition`, `TextRange` from `./types`; `DatasetSchemaIndex` from `./schema`; `CursorContext` from `./context`; `visibleSymbolsAt` from `./document-index`; `extractStems` from `./ranking`
- Produces:
  - `InlinePrediction = { insertText: string; range: TextRange }`
  - `computeInlinePrediction(doc: DocumentIndex, schema: DatasetSchemaIndex, ctx: CursorContext, position: TextPosition, enabled: boolean): InlinePrediction | null`

- [ ] **Step 1: Write the failing test**

Create `web/tests/intellisense/inline-predictions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import glucoseData from "../../../examples/data/glucose.json";
import temporalData from "../../../examples/data/temporal.json";
import type { Dataset } from "../../src/services/types";
import { getDatasetSchemaIndex } from "../../src/editor/intellisense/schema";
import { indexDocument } from "../../src/editor/intellisense/document-index";
import { analyzeCursorContext } from "../../src/editor/intellisense/context";
import { computeInlinePrediction } from "../../src/editor/intellisense/inline-predictions";

function ghostAt(srcWithCaret: string, dataset: Dataset, enabled = true) {
  const idx = srcWithCaret.indexOf("|");
  const src = srcWithCaret.slice(0, idx) + srcWithCaret.slice(idx + 1);
  const before = src.slice(0, idx).split("\n");
  const pos = { lineNumber: before.length, column: before[before.length - 1].length + 1 };
  const schema = getDatasetSchemaIndex(dataset);
  const doc = indexDocument(src, schema);
  const ctx = analyzeCursorContext(doc, schema, pos);
  return computeInlinePrediction(doc, schema, ctx, pos, enabled);
}

describe("deterministic inline ghost-text engine", () => {
  const glucose = structuredClone(glucoseData) as Dataset;
  const temporal = structuredClone(temporalData) as Dataset;

  it("predicts exact block closer, .latest > threshold, bind path, where value, duration unit, severity, and suppress", () => {
    expect(ghostAt('rule R:\n    when 1 > 0:\n    then:\n        alert: "x"\n    end |\nend rule', glucose)?.insertText).toBe("when");
    expect(ghostAt("rule R:\n    source glucose_data\n    let threshold := 250\n    when glucose_data.|", glucose)?.insertText).toBe("latest > threshold");
    expect(ghostAt("rule R:\n    bind hr_readings = |", temporal)?.insertText).toBe("Vitals.heart_rate");
    expect(ghostAt("rule R:\n    bind hr = Vitals.heart_rate where status == |", temporal)?.insertText).toBe('"final"');
    expect(ghostAt("rule R:\n    suppress: within 30 |", temporal)?.insertText).toBe("minutes");
    expect(ghostAt('rule R:\n    when 1 > 0:\n    then:\n        alert: "High", |', glucose)?.insertText).toBe('"WARNING"');
    expect(ghostAt("rule R:\n    when 1 > 0:\n    then:\n        suppress: |", glucose)?.insertText).toBe("within 4 hours");
  });

  it("predicts multi-line then/end when and end bind, but never duplicates already-present closers or when disabled", () => {
    const whenGhost = ghostAt("rule HighGlucose:\n    source glucose_data\n    when glucose_data.latest > 250:\n    |", glucose);
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tests/intellisense/inline-predictions.test.ts`
Expected: FAIL — `inline-predictions` module not found.

- [ ] **Step 3: Implement `inline-predictions.ts`**

Create `web/src/editor/intellisense/inline-predictions.ts` implementing `computeInlinePrediction(doc, schema, ctx, position, enabled)`:
- Return `null` immediately when `!enabled`, `ctx.kind === "comment"`, `ctx.kind === "string-literal"`, or there is non-whitespace text remaining after `position` on the same line.
- Implement the 11 deterministic spec rules in priority order, checking the next non-empty line before emitting any multi-line closer (`then:`, `end bind`, `end when`, `end rule`) so existing tokens are never duplicated:
  1. `end-block` with `expectedBlockEnd` (prefix-aware: `end ` → `when`, `end wh` → `en`).
  2. `member-access` on a bound/source series: `latest`, upgraded to `latest > <uniqueMatchedNumericLet>` when in `when` condition with no operator yet and a single clear numeric `let` match.
  3. `bind-rhs` with `bindAlias`: unique stem/suffix match in `schema.bindings` or `schema.tableNames`.
  4. `where-value` (outside quotes) when `getColumnSamples(table, col).values[0]` exists: formatted literal (`"final"` for `String`, bare number/boolean otherwise).
  5. `within-unit`: `minutes` for `withinNumber` in `{15, 30, 45, 60}`, else `hours`.
  6. `alert-arg` at `alertArgIndex === 1`: `"WARNING"`.
  7. `suppress-operand`: `within 4 hours`.
  8. Blank indented line inside an unclosed `when` without `then:` (and next non-empty line doesn't start with `then`): `then:\n    alert: "<RuleName> triggered", "WARNING"\nend when` aligned to current indentation.
  9. Blank indented line inside an unclosed `bind` (after RHS path, next non-empty line doesn't start with `end bind`): `end bind`.
  10. Indented `en` / `end` prefix inside an unclosed `when` branch after at least one statement: remaining suffix of `end when`.
  11. Blank indented line inside an empty unclosed `rule` (no body statements yet, next non-empty line doesn't start with `end rule`): `source <firstTable>\nend rule`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run tests/intellisense/inline-predictions.test.ts`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add web/src/editor/intellisense/inline-predictions.ts web/tests/intellisense/inline-predictions.test.ts
git commit -m "feat(intellisense): add deterministic multi-token inline ghost-text engine"
```

---

### Task 7: IDE Providers (Hover, Signature Help, Navigation, Outline, Quick Fixes) & Coordinator Engine

**Files:**
- Create: `web/src/editor/intellisense/providers.ts`
- Create: `web/src/editor/intellisense/engine.ts`
- Test: `web/tests/intellisense/providers.test.ts`
- Test: `web/tests/intellisense/performance.test.ts`

**Interfaces:**
- Consumes: `DocumentIndex`, `TextPosition`, `TextRange`, `HelixLanguageHost` from `./types`; `DatasetSchemaIndex`, `getDatasetSchemaIndex` from `./schema`; `indexDocument`, `activeRuleAt`, `findReferenceAtOffset`, `findTerminologyAtOffset`, `visibleSymbolsAt` from `./document-index`; `analyzeCursorContext` from `./context`; `MruTracker` from `./ranking`; `buildCompletions`, `CompletionCandidate` from `./completions`; `computeInlinePrediction`, `InlinePrediction` from `./inline-predictions`; `findTerm`, `TERMINOLOGY_SYSTEMS` from `./terminology`
- Produces:
  - From `providers.ts`: `HoverResult`, `SignatureResult`, `OutlineSymbol`, `MarkerInput`, `QuickFixEdit`, `QuickFixAction`, `computeHover(doc, schema, pos): HoverResult | null`, `computeSignatureHelp(doc, pos): SignatureResult | null`, `computeDefinition(doc, pos): TextRange | null`, `computeReferences(doc, pos, includeDeclaration): TextRange[]`, `computeDocumentSymbols(doc): OutlineSymbol[]`, `computeQuickFixes(doc, schema, markers): QuickFixAction[]`, `levenshtein(a: string, b: string, maxDist?: number): number`
  - From `engine.ts`: `HelixIntelliSense` class (`getDocument(uri: string, versionId: number, source: string, dataset: Dataset): { doc: DocumentIndex; schema: DatasetSchemaIndex }`, `getActiveRuleName(uri, versionId, source, dataset, pos): string | null`, `recordAcceptance(contextKind: string, label: string): void`, `provideCompletions(...)`, `provideInlinePrediction(...)`, `provideHover(...)`, `provideSignatureHelp(...)`, `provideDefinition(...)`, `provideReferences(...)`, `provideDocumentSymbols(...)`, `provideQuickFixes(...)`, `clearCache(): void`)

- [ ] **Step 1: Write the failing tests**

Create `web/tests/intellisense/providers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import sepsis from "../../../examples/alert_rule.helix?raw";
import sepsisData from "../../../examples/data/sepsis.json";
import temporal from "../../../examples/temporal_rule.helix?raw";
import temporalData from "../../../examples/data/temporal.json";
import type { Dataset } from "../../src/services/types";
import { HelixIntelliSense } from "../../src/editor/intellisense/engine";
import { offsetToPosition } from "../../src/editor/intellisense/lexer";

describe("IDE providers (hover, signature, nav, outline, quick fixes)", () => {
  const sepsisDs = structuredClone(sepsisData) as Dataset;
  const temporalDs = structuredClone(temporalData) as Dataset;

  it("renders rich hover cards for terminology codes, bound series with live samples, and let variables", () => {
    const engine = new HelixIntelliSense();
    const snomedPos = offsetToPosition(sepsis, sepsis.indexOf("91302008"));
    const snomedHover = engine.provideHover("file:///s.helix", 1, sepsis, sepsisDs, snomedPos);
    expect(snomedHover?.markdown).toContain("Septic shock");

    const hrPos = offsetToPosition(temporal, temporal.indexOf("hr_readings.latest") + 2);
    const hrHover = engine.provideHover("file:///t.helix", 1, temporal, temporalDs, hrPos);
    expect(hrHover?.markdown).toContain("heart_rate_readings");
    expect(hrHover?.markdown).toContain("Float");
    expect(hrHover?.markdown).toContain('status == "final"');

    const letPos = offsetToPosition(sepsis, sepsis.indexOf("sbp_crit)"));
    const letHover = engine.provideHover("file:///s.helix", 1, sepsis, sepsisDs, letPos);
    expect(letHover?.markdown).toContain("Number");
    expect(letHover?.markdown).toContain("90");
  });

  it("computes active signature parameter for alert and terminology calls", () => {
    const engine = new HelixIntelliSense();
    const src = 'rule R:\n    when 1 > 0:\n    then:\n        alert: "High", "WARNING", x\n    end when\nend rule';
    const sig0 = engine.provideSignatureHelp("file:///a.helix", 1, src, sepsisDs, offsetToPosition(src, src.indexOf('"High"') + 2));
    expect(sig0?.activeParameter).toBe(0);
    const sig1 = engine.provideSignatureHelp("file:///a.helix", 1, src, sepsisDs, offsetToPosition(src, src.indexOf('"WARNING"') + 2));
    expect(sig1?.activeParameter).toBe(1);
    const sig2 = engine.provideSignatureHelp("file:///a.helix", 1, src, sepsisDs, offsetToPosition(src, src.indexOf(", x") + 2));
    expect(sig2?.activeParameter).toBe(2);
  });

  it("resolves go-to-definition, find references, and document outline hierarchy", () => {
    const engine = new HelixIntelliSense();
    const usePos = offsetToPosition(sepsis, sepsis.indexOf("sbp.latest") + 1);
    const def = engine.provideDefinition("file:///s.helix", 1, sepsis, sepsisDs, usePos);
    expect(def?.startLineNumber).toBe(7);

    const refs = engine.provideReferences("file:///s.helix", 1, sepsis, sepsisDs, usePos, true);
    expect(refs.length).toBeGreaterThanOrEqual(3);

    const outline = engine.provideDocumentSymbols("file:///s.helix", 1, sepsis, sepsisDs);
    expect(outline[0]?.name).toBe("SepsisEarlyWarningRule");
    expect(outline[0]?.children.map((c) => c.name)).toContain("sbp");
    expect(outline[0]?.children.some((c) => c.kind === "when")).toBe(true);
  });

  it("generates all 5 Quick Fix categories and skips edits when marker text is stale", () => {
    const engine = new HelixIntelliSense();

    const missingEnd = 'rule R:\n    source Vitals\n    when Vitals.latest > 10:\n    then:\n        alert: "x"\n';
    const fixMissing = engine.provideQuickFixes("file:///q1.helix", 1, missingEnd, sepsisDs, [
      {
        code: "SYNTAX_ERROR",
        message: "Expected 'end when' to terminate when block. Got 'end of file'",
        range: { startLineNumber: 5, startColumn: 19, endLineNumber: 5, endColumn: 20 },
      },
    ]);
    expect(fixMissing[0]?.title).toContain("end when");

    const mismatch = 'rule R:\n    bind sbp = Vitals.systolic_bp\n    end when\nend rule';
    const fixMismatch = engine.provideQuickFixes("file:///q2.helix", 1, mismatch, sepsisDs, [
      {
        code: "SYNTAX_ERROR",
        message: "Mismatched block terminator 'end when': expected 'end bind'",
        range: { startLineNumber: 3, startColumn: 9, endLineNumber: 3, endColumn: 13 },
      },
    ]);
    expect(fixMismatch[0]?.edit.text).toBe("bind");

    const typo = 'rule R:\n    source Vitlas\nend rule';
    const fixTypo = engine.provideQuickFixes("file:///q3.helix", 1, typo, sepsisDs, [
      {
        code: "SOURCE_NOT_FOUND",
        message: "Source table is not mapped",
        range: { startLineNumber: 2, startColumn: 12, endLineNumber: 2, endColumn: 18 },
      },
    ]);
    expect(fixTypo.some((f) => f.edit.text === "Vitals")).toBe(true);

    const noLatest = 'rule R:\n    source Vitals\n    when Vitals > 100:\n    then:\n        alert: "x"\n    end when\nend rule';
    const fixLatest = engine.provideQuickFixes("file:///q4.helix", 1, noLatest, sepsisDs, [
      {
        code: "UNKNOWN_IDENTIFIER",
        message: "Unknown identifier or series used without .latest",
        range: { startLineNumber: 3, startColumn: 10, endLineNumber: 3, endColumn: 16 },
      },
    ]);
    expect(fixLatest.some((f) => f.edit.text === ".latest")).toBe(true);

    const missingVar = 'rule R:\n    source Vitals\n    when Vitals.latest > limt:\n    then:\n        alert: "x"\n    end when\nend rule';
    const fixVar = engine.provideQuickFixes("file:///q5.helix", 1, missingVar, sepsisDs, [
      {
        code: "UNKNOWN_IDENTIFIER",
        message: "Unknown identifier or series used without .latest",
        range: { startLineNumber: 3, startColumn: 26, endLineNumber: 3, endColumn: 30 },
      },
    ]);
    expect(fixVar.some((f) => f.title.includes("Declare 'let limt"))).toBe(true);

    const staleFixes = engine.provideQuickFixes("file:///q6.helix", 2, 'rule R:\n    source Vitals\nend rule', sepsisDs, [
      {
        code: "SYNTAX_ERROR",
        message: "Mismatched block terminator 'end when': expected 'end bind'",
        range: { startLineNumber: 2, startColumn: 12, endLineNumber: 2, endColumn: 18 },
      },
    ]);
    expect(staleFixes).toEqual([]);
  });
});
```

Create `web/tests/intellisense/performance.test.ts`:

```ts
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

function make200RowDataset(): Dataset {
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
        rows: Array.from({ length: 200 }, (_, i) => ({
          patient_id: `P${i % 20}`,
          timestamp: "2026-10-31T11:55:00Z",
          systolic_bp: 80 + (i % 60),
          status: i % 4 === 0 ? "preliminary" : "final",
        })),
      },
    ],
  };
}

describe("IntelliSense performance budgets", () => {
  it("indexes 500+ lines cold under 10 ms, hits cache in O(1), and answers completions/ghost-text under 15 ms", () => {
    const src = make500LineProgram();
    const ds = make200RowDataset();
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
    const items = engine.provideCompletions("file:///perf.helix", 1, src, ds, pos, "perf.helix");
    const ghost = engine.provideInlinePrediction("file:///perf.helix", 1, src, ds, pos, true);
    const queryMs = performance.now() - t1;
    expect(items.length).toBeGreaterThan(0);
    expect(ghost === null || typeof ghost.insertText === "string").toBe(true);
    expect(queryMs).toBeLessThan(15);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run tests/intellisense/providers.test.ts tests/intellisense/performance.test.ts`
Expected: FAIL — `providers` / `engine` modules not found.

- [ ] **Step 3: Implement `providers.ts` and `engine.ts`**

Create `web/src/editor/intellisense/providers.ts`:
- `computeHover(doc, schema, pos)`: check terminology occurrence first → symbol reference (series with table/column/type/filter/samples, `let` with scope/type/initializer, `rule`, `for`) → dataset table/binding/column → HELIX keyword reference (with `"Syntax-only"` note for parser-only forms).
- `computeSignatureHelp(doc, pos)`: detect `alert [:]` argument index (3 params: `message: String`, `severity?: "INFO" | "WARNING" | "CRITICAL"`, `...payload: Expr`) and `LOINC`/`SNOMED`/`RxNorm` call (`code: String`).
- `computeDefinition(doc, pos)` & `computeReferences(doc, pos, includeDeclaration)`: look up `findReferenceAtOffset` and return `symbol.nameRange` / matching reference ranges (matching by symbol identity).
- `computeDocumentSymbols(doc)`: build nested `OutlineSymbol[]` (`rule` → `source`, `bind`, `let`, `when` → nested `alert`, `suppress`, `let`, `when`).
- `levenshtein(a, b, maxDist = 3)`: bounded edit distance with early exit.
- `computeQuickFixes(doc, schema, markers)`: implement all 5 spec Quick Fixes and **validate that the text at `marker.range` in `doc.source` still matches the expected token** (e.g., for mismatched `end when`, verify the range actually reads `when`; for `SOURCE_NOT_FOUND`/`UNKNOWN_IDENTIFIER`, verify non-empty identifier at range) so stale markers never emit corrupt edits.

Create `web/src/editor/intellisense/engine.ts`:
- `HelixIntelliSense` caching the latest `{ uri, versionId, dataset, doc, schema }` entry per URI (single-slot or small Map capped at 4 URIs to prevent unbounded growth), owning an in-memory `MruTracker`, and delegating to `buildCompletions`, `computeInlinePrediction`, and all `providers.ts` functions.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run tests/intellisense/providers.test.ts tests/intellisense/performance.test.ts`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add web/src/editor/intellisense/providers.ts web/src/editor/intellisense/engine.ts web/tests/intellisense/providers.test.ts web/tests/intellisense/performance.test.ts
git commit -m "feat(intellisense): add hover, signature, nav, outline, quick fixes, and coordinator engine"
```

---

### Task 8: Monaco Feature Registration & Language Wiring

**Files:**
- Create: `web/src/editor/monaco-features.d.ts`
- Modify: `web/src/editor/language.ts:1-160`
- Test: `web/tests/intellisense/language-registration.test.ts`

**Interfaces:**
- Consumes: `HelixIntelliSense` from `./intellisense/engine`; `HELIX_KEYWORDS`, `HelixLanguageHost` from `./intellisense/types`; `monaco-editor` types
- Produces:
  - `keywords` (re-export of `HELIX_KEYWORDS` for compatibility)
  - `registerHelixLanguage(monaco: typeof Monaco, host: HelixLanguageHost, engine?: HelixIntelliSense): Monaco.IDisposable`
  - `register` alias matching `registerHelixLanguage` (cleanly replacing the old `getTables` signature)

- [ ] **Step 1: Write the failing test**

Create `web/tests/intellisense/language-registration.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import glucoseData from "../../../examples/data/glucose.json";
import type { Dataset } from "../../src/services/types";
import { registerHelixLanguage, keywords } from "../../src/editor/language";

function makeFakeMonaco() {
  const disposables: ReturnType<typeof vi.fn>[] = [];
  const makeDisp = () => {
    const dispose = vi.fn();
    disposables.push(dispose);
    return { dispose };
  };
  let completionTriggerChars: string[] | undefined;
  const monacoMock = {
    languages: {
      getLanguages: vi.fn(() => []),
      register: vi.fn(),
      setMonarchTokensProvider: vi.fn(),
      setLanguageConfiguration: vi.fn(),
      registerCompletionItemProvider: vi.fn((_lang, provider) => {
        completionTriggerChars = provider.triggerCharacters;
        return makeDisp();
      }),
      registerInlineCompletionsProvider: vi.fn(() => makeDisp()),
      registerHoverProvider: vi.fn(() => makeDisp()),
      registerSignatureHelpProvider: vi.fn(() => makeDisp()),
      registerDefinitionProvider: vi.fn(() => makeDisp()),
      registerReferenceProvider: vi.fn(() => makeDisp()),
      registerDocumentSymbolProvider: vi.fn(() => makeDisp()),
      registerCodeActionProvider: vi.fn(() => makeDisp()),
      CompletionItemKind: {
        Keyword: 17, Variable: 4, Field: 3, Property: 9, Class: 5, Value: 13,
        EnumMember: 16, Unit: 12, Snippet: 27, Module: 8, Constant: 14, Operator: 11,
      },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      SymbolKind: { Class: 4, Module: 1, Property: 6, Variable: 12, Boolean: 16, Event: 23 },
    },
    editor: {
      defineTheme: vi.fn(),
      registerCommand: vi.fn(() => makeDisp()),
      getModelMarkers: vi.fn(() => []),
    },
  };
  return { monacoMock, disposables, getTriggerChars: () => completionTriggerChars };
}

describe("Monaco HELIX language registration", () => {
  it("registers all 8 providers with punctuation-only triggers (no space) and disposes cleanly", () => {
    const { monacoMock, disposables, getTriggerChars } = makeFakeMonaco();
    const disp = registerHelixLanguage(monacoMock as never, {
      getDataset: () => structuredClone(glucoseData) as Dataset,
      getSettings: () => ({ inlinePredictions: true, autoSuggest: true }),
      getFilename: () => "high_glucose_alert.helix",
    });

    expect(keywords).toHaveLength(21);
    expect(getTriggerChars()).toEqual([".", '"', "(", "["]);
    expect(monacoMock.languages.registerCompletionItemProvider).toHaveBeenCalledTimes(1);
    expect(monacoMock.languages.registerInlineCompletionsProvider).toHaveBeenCalledTimes(1);
    expect(monacoMock.languages.registerHoverProvider).toHaveBeenCalledTimes(1);
    expect(monacoMock.languages.registerSignatureHelpProvider).toHaveBeenCalledTimes(1);
    expect(monacoMock.languages.registerDefinitionProvider).toHaveBeenCalledTimes(1);
    expect(monacoMock.languages.registerReferenceProvider).toHaveBeenCalledTimes(1);
    expect(monacoMock.languages.registerDocumentSymbolProvider).toHaveBeenCalledTimes(1);
    expect(monacoMock.languages.registerCodeActionProvider).toHaveBeenCalledTimes(1);

    disp.dispose();
    for (const d of disposables) expect(d).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tests/intellisense/language-registration.test.ts`
Expected: FAIL — `registerHelixLanguage` not exported from `web/src/editor/language.ts`.

- [ ] **Step 3: Create `monaco-features.d.ts` and update `web/src/editor/language.ts`**

Create `web/src/editor/monaco-features.d.ts`:

```ts
declare module "monaco-editor/esm/vs/editor/edcore.main.js";
```

Update `web/src/editor/language.ts`:
- Re-export `HELIX_KEYWORDS as keywords`.
- Keep Monarch tokenizer (`helix`), `helix-dark` theme, and upgrade `setLanguageConfiguration` with `wordPattern: /[a-zA-Z_][\w]*/`, `folding` markers (`rule`/`bind`/`when` → `end (rule|bind|when)`), and `indentationRules` (`increaseIndentPattern` for `rule|when|then|otherwise|bind`, `decreaseIndentPattern` for `end\b|otherwise\b|then\b`).
- Implement `registerHelixLanguage(monaco, host, engine = new HelixIntelliSense())`:
  - Register `helix.recordAcceptance` command via `monaco.editor.registerCommand("helix.recordAcceptance", (_accessor, contextKind: string, label: string) => engine.recordAcceptance(contextKind, label))` (note: Monaco passes `accessor` as arg 0 before command `arguments`).
  - Register all 8 providers:
    1. `registerCompletionItemProvider("helix", { triggerCharacters: [".", "\"", "(", "["], provideCompletionItems })` attaching `command: { id: "helix.recordAcceptance", title: "Record", arguments: [item.contextKind, item.label] }`.
    2. `registerInlineCompletionsProvider("helix", { provideInlineCompletions, freeInlineCompletions })` gated by `host.getSettings().inlinePredictions`.
    3. `registerHoverProvider("helix", ...)`.
    4. `registerSignatureHelpProvider("helix", { signatureHelpTriggerCharacters: [":", ",", "(", "["], signatureHelpRetriggerCharacters: [","], provideSignatureHelp })`.
    5. `registerDefinitionProvider("helix", ...)`.
    6. `registerReferenceProvider("helix", ...)`.
    7. `registerDocumentSymbolProvider("helix", ...)`.
    8. `registerCodeActionProvider("helix", { provideCodeActions }, { providedCodeActionKinds: ["quickfix"] })` reading `monaco.editor.getModelMarkers({ owner: "helix", resource: model.uri })` filtered to overlapping ranges.
  - Return a single composite `IDisposable` that disposes all 9 registrations (8 providers + command) and calls `engine.clearCache()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run tests/intellisense/language-registration.test.ts`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add web/src/editor/monaco-features.d.ts web/src/editor/language.ts web/tests/intellisense/language-registration.test.ts
git commit -m "feat(intellisense): register all 8 Monaco IDE providers and language config"
```

---

### Task 9: HELIX Studio Integration (Live Semantic Worker Validation, Warm Markers, Settings, Breadcrumb & E2E)

**Files:**
- Modify: `web/src/services/types.ts:104-111`
- Modify: `web/src/services/data.ts:215-243`
- Modify: `web/src/presets.ts:51-58`
- Modify: `web/src/services/engine.ts:38-56`
- Modify: `web/src/services/engine.worker.ts:28-73`
- Modify: `web/src/App.tsx:1-570`
- Test: `web/tests/data.test.ts`
- Test: `web/tests/e2e/studio.spec.ts`

**Interfaces:**
- Consumes: `registerHelixLanguage` from `./editor/language`; `HelixIntelliSense` from `./editor/intellisense/engine`; `EngineClient` from `./services/engine`
- Produces:
  - Extended `Workspace` in `types.ts`: optional `inlinePredictions?: boolean`, `autoSuggest?: boolean`
  - Backward-compatible `loadWorkspace` in `data.ts` defaulting missing fields to `true` and rejecting non-boolean corrupt values
  - `EngineClient.request(kind: "validate", source: string, dataset: Dataset): Promise<Evaluation>` (supersedes older `"validate"` in `engine.worker.ts`, never cancels explicit `"evaluate"`)
  - Live Studio integration in `App.tsx` + E2E IntelliSense tests in `studio.spec.ts`

- [ ] **Step 1: Write the failing unit tests in `web/tests/data.test.ts`**

Append to `web/tests/data.test.ts`:

```ts
describe("workspace IntelliSense settings compatibility", () => {
  it("loads legacy v1 workspaces without IntelliSense flags and defaults both to true", () => {
    const legacy = {
      version: 1,
      source: defaultWorkspace.source,
      filename: defaultWorkspace.filename,
      dataset: defaultWorkspace.dataset,
      autoAnalyze: true,
      fontSize: 14,
    };
    const store = { getItem: () => JSON.stringify(legacy), setItem: () => {} };
    const loaded = loadWorkspace(store);
    expect(loaded.warning).toBeUndefined();
    expect(loaded.workspace.inlinePredictions).toBe(true);
    expect(loaded.workspace.autoSuggest).toBe(true);
  });

  it("recovers cleanly when stored IntelliSense flags have non-boolean types", () => {
    const corrupt = { ...defaultWorkspace, inlinePredictions: "yes" };
    const store = { getItem: () => JSON.stringify(corrupt), setItem: () => {} };
    const loaded = loadWorkspace(store);
    expect(loaded.warning).toBeTruthy();
    expect(loaded.workspace.inlinePredictions).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tests/data.test.ts`
Expected: FAIL — `inlinePredictions` / `autoSuggest` are `undefined` on legacy workspace and corrupt type is not rejected.

- [ ] **Step 3: Update `types.ts`, `data.ts`, `presets.ts`, `engine.ts`, `engine.worker.ts`, and `App.tsx`**

1. **`web/src/services/types.ts` (lines 104–111):** Add `inlinePredictions?: boolean; autoSuggest?: boolean;` to `Workspace`.
2. **`web/src/presets.ts` (lines 51–58):** Set `inlinePredictions: true, autoSuggest: true` on `defaultWorkspace`.
3. **`web/src/services/data.ts` (lines 215–243):** In `loadWorkspace`, reject if `(w.inlinePredictions !== undefined && typeof w.inlinePredictions !== "boolean") || (w.autoSuggest !== undefined && typeof w.autoSuggest !== "boolean")`, and normalize `{ ...w, inlinePredictions: w.inlinePredictions ?? true, autoSuggest: w.autoSuggest ?? true }`.
4. **`web/src/services/engine.ts` (lines 38–56) & `web/src/services/engine.worker.ts` (lines 28–73):**
   - Extend `Request.kind` to `"analyze" | "validate" | "evaluate"`.
   - In `engine.worker.ts`, supersede pending `"validate"` requests when a new `"validate"` arrives (error `"Superseded validation"`), and handle both `"evaluate"` and `"validate"` by calling `_helix_evaluate(a, b)` — leaving explicit `"evaluate"` untouched.
   - Add overload `request(kind: "validate", source: string, dataset: Dataset): Promise<Evaluation>` on `EngineClient`.
5. **`web/src/App.tsx`:**
   - Add `import "monaco-editor/esm/vs/editor/edcore.main.js";` right beside `import * as monaco from "monaco-editor/esm/vs/editor/editor.api";`.
   - Create a stable `intellisense = useRef(new HelixIntelliSense())` and pass it into `registerHelixLanguage(m, host, intellisense.current)` in `beforeMount`.
   - Track `{ analysis, analysisSource }` and `{ semanticDiagnostics, semanticSource }` (with `validateId` ref) separately from `evaluation`:
     - In `analyze()`: on `result.success === true`, store `{ analysis: result, analysisSource: source }`; if `validateDataset(current.current.dataset).length === 0 && Object.keys(draftErrorsRef.current).length === 0`, launch silent `engine.request("validate", source, structuredClone(current.current.dataset))` and store its non-info diagnostics (`d.severity !== "info"`) in `semanticDiagnostics` (ignoring `"Superseded validation"` errors, never touching `evaluation` or `tab`). On `result.success === false`, clear `semanticDiagnostics`.
     - Tighten auto-analyze debounce from `350` to `180` ms; also schedule a `180` ms silent `"validate"` when `workspace.dataset` changes while `workspace.autoAnalyze && ready && analysis?.success && errors.length === 0`.
     - In `sourceChanged(source)`: when `!current.current.autoAnalyze`, clear `analysis` and `semanticDiagnostics` immediately (manual mode contract); when `current.current.autoAnalyze`, keep prior `analysis` and `semanticDiagnostics` warm so markers do not flicker.
     - In `replaceFile(...)`: clear `analysis`, `semanticDiagnostics`, and `evaluation`.
     - Deduplicate displayed diagnostics: combine `analysis?.diagnostics ?? []` with `(evaluation && evalRevision === revision.current ? evaluation.diagnostics : semanticDiagnostics)` so explicit evaluation and background validation never double-report the same semantic error.
     - Update the `setModelMarkers` `useEffect` so it depends ONLY on `[analysis, semanticDiagnostics, evaluation, evalRevision]` (NOT `workspace.source`!), mapping each diagnostic's `startOffset`/`endOffset` against its own snapshot source (`analysisSource` / `semanticSource` / `evalSource`) so byte offsets never corrupt edited text while Monaco natively shifts existing markers.
     - Compute active rule name at `cursor` via `intellisense.current.getActiveRuleName(...)` and show it in `.editor-breadcrumb` when non-null.
   - Update `.settings-popover`:
     - Label: `Automatic analysis · 180 ms`
     - Checkbox: `Inline predictions (ghost text)` (`workspace.inlinePredictions ?? true`)
     - Checkbox: `Auto-trigger suggestions` (`workspace.autoSuggest ?? true`)
   - Update `<Editor options={...}>`:
     - `inlineSuggest: { enabled: workspace.inlinePredictions ?? true }`
     - `quickSuggestions: (workspace.autoSuggest ?? true) ? { other: "on", comments: "off", strings: "on" } : false`
     - `suggestOnTriggerCharacters: workspace.autoSuggest ?? true`
     - `parameterHints: { enabled: true }`
     - `lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.On }`
     - `suggest: { preview: true, showStatusBar: true }`
6. **Add Playwright E2E test in `web/tests/e2e/studio.spec.ts`:**
   - Add a test `"IntelliSense predicts bound series, accepts inline ghost-text, shows hover docs, and persists settings"` verifying:
     1. Clicking inside the Monaco editor, typing after `when ` triggers predictive suggestions showing `glucose_data.latest`.
     2. Typing `end ` on a new line inside an unclosed `when` displays inline ghost-text and `Tab` completes `end when`.
     3. Opening Settings shows `Inline predictions (ghost text)` and `Auto-trigger suggestions`, toggling persists across `page.reload()`.

- [ ] **Step 4: Run full frontend verification (typecheck, unit tests, production build)**

Run: `cd web && npm run typecheck && npm test && npm run build`
Expected:
- `tsc --noEmit` exits 0 with zero errors
- All Vitest suites pass (`bridge.test.ts`, `data.test.ts`, plus all 6 `tests/intellisense/*.test.ts` suites)
- `vite build` exits 0 and emits `web/dist/` cleanly (no extra Monaco language worker chunks bundled).

- [ ] **Step 5: Commit**

```bash
git add web/src/services/types.ts web/src/services/data.ts web/src/presets.ts web/src/services/engine.ts web/src/services/engine.worker.ts web/src/App.tsx web/tests/data.test.ts web/tests/e2e/studio.spec.ts
git commit -m "feat(studio): integrate predictive IntelliSense, live semantic checks, and settings"
```
