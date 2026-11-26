# HELIX Studio Predictive IntelliSense Design Specification

**Date:** 2026-11-26
**Target Branch:** `feat/helix-intellisense` (branched from `origin/main` at `97dfef6`)
**Target Surface:** HELIX Studio (`web/`, Monaco Editor 0.52.2 + React 19 + TypeScript 5.9)
**Authoritative Compiler:** ISO C11 lexer/parser/evaluator compiled to WebAssembly (`src/*.c`, unchanged ABI)

---

## 1. Intent & Why

HELIX Studio (`web/`) already ships Monaco Editor and an ISO C11/WASM compiler-evaluator, but its language support in `web/src/editor/language.ts` is currently a placeholder:

1. **Broken Monaco feature wiring:** `web/src/App.tsx` imports only `monaco-editor/esm/vs/editor/editor.api`, which omits Monaco's editor `contrib/` widgets (`suggestController`, `snippetController2`, `inlineCompletions`, `hoverContribution`, `parameterHints`, `codeActionContributions`, `goToCommands`, `documentSymbols`, `standaloneGotoSymbolQuickAccess`, `standaloneReferenceSearch`, `codiconStyles`).
2. **Naive completion logic:** `registerCompletionItemProvider` inspects only the current line prefix with four regexes and receives only `getTables(): string[]`. It suggests table names in the wrong slot right after `bind `, dumps all 21 keywords almost everywhere (including comments, strings, and top-level), ignores declared `bind`/`source`/`let`/`rule` symbols, ignores table columns, dataset `Bindings`, and cell values, and applies zero ranking.
3. **Hostile edit-time diagnostics lifecycle:** `src/parser.c`'s `parser_build_ast` returns `NULL` on any syntax error (the normal state mid-keystroke), and `web/src/App.tsx` clears `analysis` (`setAnalysis(null)`) on every edit while waiting 350 ms to re-run WASM—causing squiggles to flash away and leaving Quick Fixes blind while typing.

**Goal:** Deliver a modern, sub-5 ms, 100% local IDE IntelliSense suite for HELIX Studio that genuinely predicts what a clinical rule author wants to type next—across autocomplete, inline ghost-text, hover docs, signature help, symbol navigation, outline, and diagnostic Quick Fixes—without violating HELIX Studio's zero-backend, C11-authoritative architecture.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **Sub-5 ms keystroke responsiveness:** Incremental, error-tolerant TypeScript lexer + document symbol/block indexer cached by `(modelVersionId, datasetIdentity)`, keeping indexing under 2 ms and completion/ghost-text queries under 5 ms on 500-line `.helix` files.
- **Genuine next-input prediction:** Combine a deterministic grammar-state automaton, scoped symbol table, Data Playground schema & bounded cell-value sampling, type-compatibility & identifier-name affinity scoring, per-session MRU acceptance learning, clinical terminology lookup (`LOINC`/`SNOMED`/`RxNorm`), and deterministic multi-token inline ghost-text.
- **Full modern IDE suite in Monaco:**
  - Context-aware, ranked `CompletionItemProvider` (with dataset-aware dynamic snippets)
  - Deterministic `InlineCompletionsProvider` (ghost-text accepted via `Tab`)
  - Rich `HoverProvider` (keywords, bound series with live table/column/sample stats, `let` inferred types, clinical terminology codes)
  - `SignatureHelpProvider` (`alert:` arguments and `LOINC`/`SNOMED`/`RxNorm` calls)
  - `DefinitionProvider`, `ReferenceProvider`, and `DocumentSymbolProvider` (outline / `Ctrl+Shift+O` / breadcrumbs)
  - `CodeActionProvider` (Quick Fixes for structural `end <block>` errors, fuzzy typo replacements, missing `.latest`, and scaffolding missing `let`)
- **Executable-first with full-grammar coverage:** Prioritize constructs supported by the Studio C11 evaluator (`docs/evaluation.md`) so default predictions and snippets always evaluate cleanly; still parse, index, hover, and offer parser-only constructs (`bind site`, `suppress repeat_of:`, `for`, `when Event.name`, `alert level:`, standalone `latest`, `months`/`years`) ranked lower with an explicit `"Syntax-only (not evaluated in Studio)"` note.
- **Smooth diagnostic & editor UX:** Keep prior C/WASM analysis warm while typing (no squiggle flicker), tighten auto-analyze debounce from 350 ms to 180 ms, and add backward-compatible Settings popover toggles (`inlinePredictions`, `autoSuggest`).

### Non-Goals
- Modifying C11 source files (`src/*.c`, `include/*.h`) or rebuilding the WASM binary (`emcc` is not required for this feature).
- Modifying the legacy `<textarea>` IDE in `gui/web/`.
- Integrating external LLM/cloud APIs or breaking HELIX Studio's zero-backend, offline design.
- Persisting MRU acceptance history across browser reloads (per-session memory only).
- Adding clinical decision validation, external terminology servers, or new HELIX language syntax.

### Anti-Goals (Failure Modes to Prevent)
- **Wrong-slot suggestions:** Never suggest table names after `bind ` (before `=`), never dump all 21 keywords inside comments/strings/top-level, and never suggest `end rule` when `end when` is the innermost unclosed block.
- **Noisy ghost-text:** Never hallucinate multi-line completions when the user is editing mid-token or when no high-confidence deterministic continuation exists.
- **Grammar drift:** Never diverge from C11's exact 21 keywords, operator set, member-name rules, or duration units (`src/keywords.c`, `src/lexer.c`, `src/parser.c`, `src/evaluator.c`).
- **Workspace breakage or disposable leaks:** Never invalidate existing `helix-studio.workspace.v1` localStorage entries; never leak Monaco provider registrations or commands across editor remounts.
- **Bundle bloat:** Never import `monaco-editor/esm/vs/editor/editor.main` (which pulls in 80 unrelated language packs and workers); load only `edcore.main.js` (core editor + IDE contrib widgets).

---

## 3. Constraints

1. **Toolchain & Runtime:** React `19.3.1`, TypeScript `5.9.3` (`strict: true`, `noEmit: true`), Vite `7.3.7`, Monaco Editor `0.52.2`, Vitest `5.0.5`, Playwright `1.64.1`.
2. **Monaco Bundle Boundary:** Keep typed `import * as monaco from "monaco-editor/esm/vs/editor/editor.api"` and add a single side-effect import `"monaco-editor/esm/vs/editor/edcore.main.js"` (declared via `web/src/editor/monaco-features.d.ts`) so all Monaco IDE contrib widgets load without bundling third-party language grammars or language workers.
3. **Authoritative Engine Boundary:** C11/WASM (`helix_analyze`, `helix_evaluate`) remains the sole authoritative diagnostics and execution engine. TS IntelliSense never fabricates compiler diagnostics or replaces C markers.
4. **Performance & Bounds:**
   - Source files up to HELIX's 1 MiB limit must never freeze the UI; files above 256 KiB degrade gracefully by skipping deep row-value sampling and limiting reference scans.
   - Dataset cell sampling is cached per `Dataset` object reference via `WeakMap`, scans at most 200 rows per table, and retains at most 20 distinct non-null values per column.
   - Typical 500-line rule file: `indexDocument` < 2 ms; `provideCompletions` < 5 ms; `provideInlinePrediction` < 3 ms.
5. **Storage Compatibility:** `Workspace` (`version: 1`) keeps all existing required fields unchanged and adds optional `inlinePredictions?: boolean` and `autoSuggest?: boolean` (defaulting to `true` when absent in `loadWorkspace`).
6. **Zero Regression on Existing Checks:** `npm run typecheck`, `npm test`, `npm run build`, and existing `web/tests/e2e/studio.spec.ts` assertions must all pass cleanly.

---

## 4. Approaches Considered

| Approach | Summary | Trade-offs | Decision |
|---|---|---|---|
| **A. Hybrid Split (Fast Incremental TS Indexer + C11/WASM Authority)** | Build a modular, error-tolerant TS lexer, grammar-state automaton, scoped symbol/block indexer, and dataset schema index cached per `(modelVersionId, dataset)`. Keep C11/WASM untouched as authoritative diagnostics & evaluation engine. Enforce C-vs-TS alignment with automated parity tests against the C keywords/examples/grammar. | Duplicates HELIX's small 21-keyword lexical/block grammar in TS, but delivers < 2 ms sync responsiveness on broken mid-typing code, needs zero Emscripten rebuild, adds zero worker queue contention, and cleanly supports all 8 Monaco providers. | **Selected** |
| **B. Extend `helix_analyze` in C/WASM + Thin TS Cursor Layer** | Add fault-tolerant partial AST & symbol serialization to `src/parser.c` / `src/wasm_api.c`, plus a TS layer for mid-line tokens between worker ticks. | Requires Emscripten 4.0.23 (not installed locally), C memory/fault-injection/sanitizer updates, and `wasm-parity.mjs` schema changes; still requires TS logic for newly typed declarations before worker debounce settles. | Rejected |
| **C. Dedicated C/WASM `helix_complete` Worker Endpoint** | Export a new C completion API invoked over the Web Worker on every keystroke. | Adds async worker serialization + UTF-8 marshaling + JSON parse latency on every keystroke, contends with `analyze`/`evaluate` in the single worker, and requires Emscripten rebuilds for every UX tweak. | Rejected |

---

## 5. Architecture & Module Design

### 5.1 File Map

All new code lives under `web/src/editor/intellisense/` with thin wiring in `web/src/editor/language.ts` and `web/src/App.tsx`:

```text
web/src/editor/
├── monaco-features.d.ts                 # Ambient module declaration for edcore.main.js
├── language.ts                          # Monaco language registration, theme, & composite provider registration
└── intellisense/
    ├── types.ts                         # Shared token, AST-lite block/symbol, schema, context, & host interfaces
    ├── lexer.ts                         # Error-tolerant HELIX tokenizer (1:1 with src/lexer.c)
    ├── terminology.ts                   # Typed clinical code catalog (LOINC, SNOMED-CT, RxNorm; 49 entries)
    ├── schema.ts                        # WeakMap-cached DatasetSchemaIndex (tables, columns, Bindings, row samples)
    ├── document-index.ts                # Version-cached O(n) error-tolerant block tree, symbol table, & ref map
    ├── context.ts                       # Grammar-state automaton + cursor slot & LHS type resolver
    ├── ranking.ts                       # Multi-signal scorer (slot, type, name-affinity, locality, session MRU)
    ├── completions.ts                   # CompletionItem builder + dynamic schema-aware snippets
    ├── inline-predictions.ts            # Deterministic multi-token ghost-text engine
    ├── providers.ts                     # Hover, SignatureHelp, Definition, References, DocumentSymbols, CodeActions
    └── engine.ts                        # HelixIntelliSense coordinator (cache, MRU store, provider entry points)
```

Modified existing files:
- `web/src/services/types.ts` — add optional `inlinePredictions?: boolean` and `autoSuggest?: boolean` to `Workspace`.
- `web/src/services/data.ts` — validate optional booleans (if present, must be boolean) and default missing fields to `true` in `loadWorkspace`.
- `web/src/presets.ts` — set `inlinePredictions: true, autoSuggest: true` on `defaultWorkspace`.
- `web/src/services/engine.ts` & `web/src/services/engine.worker.ts` — add a superseding `"validate"` request mode that invokes C/WASM `_helix_evaluate` silently for live semantic diagnostics without interfering with explicit `"evaluate"` requests.
- `web/src/App.tsx` — load `edcore.main.js`, wire `HelixLanguageHost` to `register(...)`, run debounced `180 ms` syntax analysis followed by silent `"validate"` semantic checks (when syntax passes and dataset is valid, stored separately from `Evaluation Results`), keep prior C/WASM diagnostics warm while typing when `autoAnalyze` is on (and clear immediately on edit when `autoAnalyze` is off), only re-apply `setModelMarkers` when fresh C diagnostics arrive (avoiding stale byte-offset corruption), add Settings toggles, configure Monaco suggest/inlineSuggest/lightbulb options, and surface the active rule name in `.editor-breadcrumb`.

### 5.2 Data Flow & Caching Pipeline

```text
Keystroke in Monaco
   ├─► Sync (< 2 ms)  ─► HelixIntelliSense.getDocument(model, dataset)
   │                        ├─ Cache hit? (uri + versionId + datasetRef) → O(1) return
   │                        └─ Cache miss → tokenize() → indexDocument() + getSchemaIndex(dataset)
   │                        ├─ CompletionItemProvider    (triggerCharacters: [".", "\"", "(", "["])
   │                        ├─ InlineCompletionsProvider (single-Tab post-space & clause ghost-text)
   │                        ├─ Hover / Signature / Def / Refs / Outline (O(1)/O(k) index lookups)
   │                        └─ CodeActionProvider        (reads active C markers + index → Quick Fixes)
   └─► Async (180 ms, autoAnalyze=true)
                      ─► Web Worker C11/WASM helix_analyze (supersedes older analyze)
                            ├─ Syntax errors → updates analysis & markers directly
                            └─ Syntax valid & dataset valid → silent "validate" (_helix_evaluate,
                               supersedes older validate) → updates live semantic markers &
                               Problems without touching Evaluation Results or stale banner
```

### 5.3 Core Component Contracts

#### 5.3.1 Error-Tolerant Lexer (`lexer.ts`)
Must mirror `src/lexer.c` and `src/keywords.c` identically:
- **Exact 21 reserved keywords:** `rule`, `intent`, `bind`, `site`, `source`, `terminology`, `schedule`, `when`, `for`, `let`, `latest`, `where`, `and`, `or`, `not`, `within`, `then`, `alert`, `suppress`, `otherwise`, `end`.
- **Token categories:** `keyword`, `identifier`, `int`, `float`, `string`, `unterminated_string`, `operator` (`:=`, `==`, `!=`, `<=`, `>=`, `->`, `=`, `<`, `>`, `+`, `-`, `*`, `/`), `delimiter` (`:`, `.`, `,`, `(`, `)`, `[`, `]`), `comment`, `error`, `eof`.
- Emits `comment` tokens into a separate array (or marks them skipped from the parser token stream) while preserving their exact UTF-16 `startOffset`/`endOffset` so cursor-in-comment detection is O(log n) via binary search.
- Unterminated strings (e.g., `alert: "High` mid-typing) emit a single `unterminated_string` token up to EOL with `rawText` and `unquotedValue`, allowing string-slot completions (alert severities, terminology codes, `where` string values) to trigger immediately after typing `"`.

#### 5.3.2 Dataset Schema Index (`schema.ts`)
Cached in `WeakMap<Dataset, DatasetSchemaIndex>`:
- `tablesByName: Map<string, TableSchemaView>`
- `bindings: Map<string, ResolvedBinding>` — resolves every key in `dataset.Bindings` using the exact semantics of `src/bindings.c` (`string` target → table's `defaultValueColumn`; `{ table, column? }` → explicit or default column).
- `bindingPrefixes: Map<string, BindingSuffixEntry[]>` — splits dotted `Bindings` keys (e.g., `"Labs.glucose"` → prefix `"Labs"`, suffix `"glucose"` with target table/column/type) so typing `Labs.` immediately predicts `glucose`.
- `resolvePath(path: string): ResolvedBinding | null` — mirrors `binding_resolve()` in `src/bindings.c`: (1) exact `Bindings[path]`, (2) `table.column` via last dot, (3) bare `table` using `defaultValueColumn`.
- `columnSamples(tableName, columnName): ColumnSampleSummary` — lazily computed once per column from at most the first 200 rows: up to 20 distinct non-null values ordered by frequency (most frequent first), total non-null count, missing count, and numeric min/max when `Integer`/`Float`.

#### 5.3.3 Document Index (`document-index.ts`)
Single-pass error-tolerant scanner over non-comment tokens producing `DocumentIndex`:
- **Blocks (`BlockNode[]`):** Tracks nested `rule`, `bind` (including `bind site`), and `when` blocks with `kind`, `name` (for `rule`/`bind`), `openOffset`, `closeOffset` (`null` if unclosed), `headerRange`, `fullRange`, `thenOffset`, `otherwiseOffset`, and `parentIndex`.
  - Uses explicit `end rule`, `end bind`, `end when` matching; if an unexpected `rule` starts at top-level while an earlier block is unclosed, closes the synthetic recovery boundary so later rules still index cleanly.
  - Exposes `openBlocksAt(offset): BlockNode[]` (innermost last) so `end ` always knows the exact missing block closer.
- **Symbols (`SymbolEntry[]`):**
  - `kind`: `"rule" | "source" | "bind" | "let" | "for"`
  - `name`, `nameRange`, `declarationRange`, `scopeStartOffset`, `scopeEndOffset` (rule-wide or `then`/`otherwise` branch-scoped)
  - `valueType`: `"Number" | "String" | "Boolean" | "DateTime" | "Series" | "Unknown"`
  - `resolvedTarget?: ResolvedBinding` (for `source` and `bind` series, including `where` table context and optional `whereText`/`withinText` for rich hover!)
  - `initializerPreview?: string` (for `let` hover, e.g., `250`, `"monitoring"`)
  - `syntaxOnly?: boolean` (true for `for` or `bind site`)
  - Helper `visibleSymbolsAt(offset): SymbolEntry[]` returning symbols declared in enclosing scopes *before* `offset` (or all rules for `repeat_of:`).
- **Terminology Calls (`TerminologyOccurrence[]`):** Exact spans of `LOINC(...)`, `SNOMED(...)`, `RxNorm(...)` (supporting both `(...)` and `[...]`, quoted or bare) for hover and signature help.
- **Identifier References (`IdentifierRef[]`):** Every identifier token (excluding keywords except member `.latest`) mapped to its resolved symbol (or dataset table/binding/column), enabling instant Go-to-Definition and Find References.

#### 5.3.4 Grammar-State Context Classifier (`context.ts`)
Given `(doc, schema, position)`:
1. Binary-search comments: if cursor is strictly inside a `# ...` comment, return `{ kind: "comment" }` (suppress all suggestions).
2. Check if cursor is inside a `string` or `unterminated_string` token:
   - Inside `LOINC("...")` / `SNOMED("...")` / `RxNorm("...")` → `{ kind: "terminology-code", system, query, replaceRange }`.
   - Inside `alert` argument index ≥ 1 (and not arg 0) → `{ kind: "alert-severity-string", query, replaceRange }`.
   - Inside `where <col> (==|!=|<|<=|>|>=|=) "..."` → `{ kind: "where-string-value", tableName, columnName, query, replaceRange }`.
   - Inside `suppress: "..."` / `intent: "..."` / `schedule: "..."` → `{ kind: "string-literal" }` (suppress noise).
3. Otherwise inspect the preceding non-comment tokens in the current statement/clause + `openBlocksAt(offset)` to classify one of 21 precise slots:
   - `top-level`, `rule-name`, `rule-body`, `bind-name`, `bind-rhs`, `bind-clause`, `bind-site-body`, `source-target`, `source-arrow`, `let-name`, `let-rhs`, `where-column`, `where-value`, `member-access`, `when-condition-start`, `when-condition-after-operand`, `comparison-rhs`, `branch-body`, `alert-arg`, `suppress-operand`, `suppress-repeat-target`, `within-amount`, `within-unit`, `within-post`, `terminology-system`, `end-block`.
4. **Type inference for LHS of comparisons & expressions:**
   - `<series>.latest` → `resolvedTarget.columnType` (`Integer`/`Float` → `"Number"`, `String`, `Boolean`, `DateTime`)
   - `<series>.<col>.latest` → that column's `ColumnType`
   - `<letVar>` → its inferred `valueType`
   - Numeric literal / arithmetic expr → `"Number"`, string literal → `"String"`
   - Passes `expectedType` + `lhsHintName` (e.g., `"sbp"` from `sbp.latest <`, `"hr_readings"` from `hr_readings.latest >=`) into the ranker!

#### 5.3.5 Multi-Signal Prediction Ranker (`ranking.ts`)
Every candidate carries a structured score computed deterministically (no floats drifting order):
- **Base slot priority (`0..1000`):**
  - Exact innermost `end <block>` after `end ` → `1000`
  - `.latest` on a bound/source series → `980`
  - Resolved table column in `where` → `960`
  - Bound `<series>.latest` shorthand in `when` condition → `940`
  - Distinct dataset cell values in `where <col> == ` → `930` (scaled `+0..+20` by row frequency)
  - Type-compatible `let` variables in `comparison-rhs` → `920`
  - Executable keywords valid in current slot → `750..880`
  - Dynamic context snippets → `700..820`
  - Syntax-only constructs (`bind site`, `for`, `alert level:`, `suppress repeat_of:`, standalone `latest`, `months`/`years`) → `base - 250` (and tagged `detail: "Syntax-only (not evaluated in Studio)"`)
- **Type-compatibility modifier:** `+180` for exact/numeric match against `expectedType`; `-160` for incompatible type (e.g., suggesting a `String` variable after `glucose_data.latest >`).
- **Identifier name-affinity modifier (`+0..+140`):** Splits candidate & `lhsHintName` on `_` and camelCase into lowercase stems (ignoring generic stop-words like `data`, `readings`, `val`, `value`). Overlapping stems (e.g., `sbp` ↔ `sbp_crit`, `temp` ↔ `temp_high`/`temp_low`, `hr` ↔ `max_hr`) earn `+120`; threshold-pattern stems (`threshold`, `limit`, `max`, `min`, `crit`, `high`, `low`) on numeric comparison RHS earn `+60`.
- **Proximity bonus (`+0..+40`):** Closer preceding declarations within the same rule rank above distant ones.
- **Per-session MRU boost (`+0..+60`):** `MruTracker` records `(contextKind, label)` when accepted via Monaco command `helix.recordAcceptance`, keeping the last 100 entries with linear recency decay (in-memory only, reset on page reload).
- Converted to Monaco `sortText = String(Math.max(0, 9999 - Math.round(score))).padStart(4, "0") + "_" + label.toLowerCase()` so Monaco's widget displays predictions in exact predicted order!

### 5.3.6 Deterministic Inline Ghost-Text & Trigger Coordination (`inline-predictions.ts`)
- **Trigger coordination with Monaco's Suggest widget:** `CompletionItemProvider` registers `triggerCharacters: [".", "\"", "(", "["]` (deliberately excluding `" "`). Because Monaco 0.52.2 requires `!suggestWidgetVisible` for `Tab` to accept inline completions, excluding bare space lets post-space slots (`end `, `bind <alias> = `, `where <col> == `, `within <num> `, `alert: "<msg>", `, `suppress: `) display distraction-free inline ghost-text accepted with a single `Tab`, while typing the first character or pressing `Ctrl+Space` immediately opens the full ranked completion dropdown. For `.` on a bound series inside a `when` condition, the completion dropdown itself surfaces `latest` and (when a unique matching numeric `let` exists) `latest > <var>` so `.` stays one-keystroke productive.
- Implements `monaco.languages.InlineCompletionsProvider`, returning at most **one** high-confidence ghost-text item (or `[]` when confidence is below threshold or `inlinePredictions === false`):
1. **Block closer after `end `:** Ghosts exact innermost unclosed block (`when`, `bind`, or `rule`).
2. **Member completion after `<series>.`:** Ghosts `latest`; if inside a `when` condition with no operator yet and there is a *unique* name-matched or single numeric `let` variable in scope (e.g., `threshold` in `high_glucose_alert.helix`), ghosts `latest > threshold`.
3. **Matching binding path after `bind <alias> = `:** If a single `Bindings` key or table cleanly matches `<alias>` (by suffix/stem match, e.g., `bind glucose_data = ` → `Labs.glucose` or `glucose_data`, `bind hr_readings = ` → `Vitals.heart_rate`), ghosts that path.
4. **Dominant `where` value after `where <col> == `:** If the resolved table has a clear top sample value for `<col>` (e.g., `"final"`), ghosts the formatted literal.
5. **Duration unit after `within <num> `:** Ghosts `minutes` for amounts in `{15, 30, 45, 60}` or `hours` otherwise (matching clinical rules).
6. **Alert severity after `alert: "<msg>", `:** Ghosts `"WARNING"`.
7. **Suppress window after `suppress: `:** Ghosts `within 4 hours`.
8. **Clause continuation after `when <complete-condition>:` + newline (or blank line inside open `when` with no `then`):** Ghosts indented `then:\n    alert: "<RuleName> triggered", "WARNING"\nend when`.
9. **Close open `bind` on newline after `bind <alias> = <path>...` (if unclosed):** Ghosts aligned `end bind`.
10. **Close open `when` on blank indented line after an action in `then`/`otherwise` when user types `en`:** Ghosts `d when`.
11. **Empty rule body after `rule <Name>:` + newline (if unclosed and no body statements yet):** Ghosts `    source <firstTable>\nend rule` (using the dataset's actual first table name!).

Every ghost-text rule checks the text *after* the cursor on the current line (and next non-empty line for multi-line closers) so it never duplicates already-present tokens like `end bind` or `then:`.

#### 5.3.7 Hover, Signature Help, Navigation, Outline & Quick Fixes (`providers.ts`)
- **Hover (`HoverProvider`):**
  - Clinical terminology call (`LOINC("2339-0")`): System badge, code, full clinical description, URI, deprecated warning if applicable.
  - Bound/source series identifier: Resolved `table.column`, `ColumnType`, `where`/`within` clauses, live Data Playground row count + up to 4 sample values (and min–max for numbers).
  - `let` variable: Scope (`rule` or `when` branch), inferred type, initializer preview.
  - Dataset table / binding / column identifier: Schema columns or sample values.
  - HELIX keywords: Concise grammar summary + Studio evaluator behavior (or `"Syntax-only"` badge).
- **Signature Help (`SignatureHelpProvider`, triggers `:`, `,`, `(`, `[`):**
  - `alert: message: String, [severity: "INFO" | "WARNING" | "CRITICAL"], [...payload: Expr]` — highlights active parameter based on comma count.
  - `LOINC(code: String)` / `SNOMED(code: String)` / `RxNorm(code: String)` — shows clinical code format & example.
- **Go-to-Definition (`DefinitionProvider`) & Find References (`ReferenceProvider`):**
  - Resolves `bind`, `source`, `let`, `for`, and `rule` (including `suppress repeat_of: <RuleName>`) via `DocumentIndex.references`.
- **Document Symbols (`DocumentSymbolProvider`):**
  - Hierarchical symbols: `Rule` (`SymbolKind.Class`) containing `source` (`Module`), `bind` (`Property`), `let` (`Variable`), `when` (`Boolean`/`Operator` with condition summary) → nested `alert` (`Event`), `suppress` (`Event`), nested `let`/`when`.
- **Quick Fixes (`CodeActionProvider`, `providedCodeActionKinds: ["quickfix"]`):**
  - Inspects active Monaco markers (`owner === "helix"`) overlapping the requested range:
    1. **Missing block terminator** (message matches `/Expected 'end (rule|when|bind)'/` or `/Missing block descriptor after 'end': expected 'end (rule|when|bind)'/`): offers preferred Quick Fix inserting `end <block>` (or completing `<block>` after bare `end`).
    2. **Mismatched block terminator** (message matches `/Mismatched block terminator 'end \w+': expected 'end (rule|when|bind)'/`): offers preferred Quick Fix replacing wrong descriptor with expected descriptor.
    3. **Unknown source/binding/identifier** (codes `SOURCE_NOT_FOUND`, `BINDING_NOT_FOUND`, `UNKNOWN_IDENTIFIER`, or message mentioning unknown series/identifier): computes bounded Levenshtein distance (≤ 3) against valid dataset tables, `Bindings`, columns, or visible symbols and offers `"Replace with '<best>'"`.
    4. **Series used without `.latest`** (message mentions `series used without .latest` or `followed by .latest`): offers preferred Quick Fix appending `.latest` at the identifier end.
    5. **Declare missing `let` variable** (on `UNKNOWN_IDENTIFIER` inside an expression): offers Quick Fix inserting `let <ident> := 0` before the enclosing `when` statement.

### 5.4 Studio App & Settings Integration (`web/src/App.tsx`, `engine.ts`, `engine.worker.ts`, `data.ts`, `types.ts`)
- **Live semantic validation & warm analysis continuity (Builder-resolved call + user decision):**
  - `engine.worker.ts` adds a `"validate"` request kind that calls `_helix_evaluate` and supersedes older queued `"validate"` requests (mirroring `"analyze"` superseding, never canceling explicit user `"evaluate"` requests). `EngineClient.request("validate", source, dataset)` exposes this cleanly.
  - When `workspace.autoAnalyze === true`, `sourceChanged()` keeps prior `analysis` and `semanticDiagnostics` warm during the `180 ms` debounce (preventing squiggle flicker). Crucially, `monaco.editor.setModelMarkers` runs **only when fresh `analysis`, `semanticDiagnostics`, or explicit `evaluation` arrives** (mapping byte offsets against the exact source snapshot that produced those diagnostics, rather than re-running on every `workspace.source` edit), letting Monaco natively shift existing markers across edits without corrupting spans.
  - After debounced `analyze()` succeeds (`result.success === true`), if `errors.length === 0` (valid dataset), Studio silently triggers `engine.request("validate", source, dataset)` and merges only its non-info diagnostics (`semanticDiagnostics`) into `Problems` and Monaco markers—completely separate from `evaluation` / `Evaluation Results` tab / `stale` results banner. When syntax fails (`result.success === false`), `semanticDiagnostics` is cleared so syntax errors take precedence.
  - Also re-runs silent `"validate"` (debounced `180 ms`) when `workspace.dataset` changes while `autoAnalyze` is on and syntax is currently valid, so adding/renaming a table or binding in Data Playground immediately resolves or flags semantic markers.
  - When `workspace.autoAnalyze === false` (manual mode, builder call): `sourceChanged()` clears `analysis` and `semanticDiagnostics` immediately, matching Studio's existing contract so outdated markers never persist indefinitely in manual mode.
  - `CodeActionProvider` validates marker text against the current model before generating edits so a stale marker mid-edit never produces a corrupt patch.
- **Settings toggles:** Add two checkboxes to `.settings-popover`:
  - `Inline predictions (ghost text)` → toggles `workspace.inlinePredictions` (default `true`)
  - `Auto-trigger suggestions` → toggles `workspace.autoSuggest` (default `true`)
  - Update existing label to `Automatic analysis · 180 ms`.
- **Dynamic breadcrumb:** Show the rule name containing the current cursor (from `DocumentIndex`) alongside the filename in `.editor-breadcrumb` when present.
- **Monaco Editor options:** Enable `inlineSuggest: { enabled: workspace.inlinePredictions ?? true }`, `quickSuggestions: workspace.autoSuggest ?? true ? { other: "on", comments: "off", strings: "on" } : false`, `suggestOnTriggerCharacters: workspace.autoSuggest ?? true`, `parameterHints: { enabled: true }`, `lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.On }`, `suggest: { preview: true, showStatusBar: true }`.

---

## 6. Verification Strategy

1. **Unit & Grammar Parity Tests (Vitest, `web/tests/intellisense/`):**
   - `lexer-parity.test.ts`: Verifies the TS lexer produces the exact same 21 keywords, operators, delimiters, numbers, strings, and error recovery as `src/keywords.c` & `src/lexer.c` across all 5 bundled presets (`examples/*.helix`) plus malformed/unterminated mid-typing buffers.
   - `context-ranking.test.ts`: Tests all 21 grammar slots, scope visibility, type-compatible ranking (`sbp.latest <` ranks `sbp_crit` #1), `where` column & distinct row-value suggestions (`status == ` → `"final"`), `Bindings` prefix completion (`Vitals.` → `heart_rate`), exact `end <block>` prediction, executable-before-syntax-only ordering, clinical terminology code/name search (`"glucose"` → `LOINC("2339-0")`), and per-session MRU promotion.
   - `inline-predictions.test.ts`: Tests every ghost-text rule (block closers, `.latest`, binding path match, `where` dominant value, duration unit, alert severity, `when` → `then/end when`, no duplicate ghost-text when already closed, respects `inlinePredictions: false`).
   - `providers.test.ts`: Tests Hover cards, Signature Help active parameter tracking, Go-to-Definition, Find References, Document Symbols hierarchy, and all 5 Quick Fix categories.
   - `performance.test.ts`: Benchmarks a 500-line multi-rule `.helix` document + 200-row dataset, asserting cache-hit O(1) lookup, cold `indexDocument` < 10 ms (target < 2 ms), and `provideCompletions` + `provideInlinePrediction` < 15 ms in CI/Vitest (target < 5 ms).
   - `data.test.ts` additions: Verifies legacy `helix-studio.workspace.v1` JSON (without `inlinePredictions` / `autoSuggest`) loads cleanly with both defaulted to `true`, and rejects non-boolean values if corrupted.
2. **Typechecking & Production Build:** `cd web && npm run typecheck && npm test && npm run build`.
3. **Browser E2E (`web/tests/e2e/studio.spec.ts`):** Add real-browser Playwright scenarios verifying live autocomplete popup with dataset/symbol suggestions, `Tab` acceptance of inline ghost-text, hover tooltip rendering, and Settings toggle persistence (executed in CI where Emscripten builds `wasm/helix_engine.mjs`).

---

## 7. Left to the Builder

- Exact Markdown formatting strings for Hover cards and snippet placeholder labels (as long as snippets remain 100% valid under the C11 evaluator and dynamically use active dataset/rule symbols).
- Internal helper naming and small private utilities (e.g., Levenshtein distance helper, stem splitter) beyond the exported module interfaces defined in the implementation plan.
- Exact CSS spacing tweaks for the two additional checkboxes in `.settings-popover`.
