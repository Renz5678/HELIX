# HELIX Studio — Reviewed Implementation Plan

Review date: 2026-10-31. Status: approved and implemented; see tasks/progress.md for verification and recorded deviations.

This refines the supplied Full-Stack Implementation Plan against the repository and
`SOURCE_OF_TRUTH.md`. It preserves the intended React/Monaco IDE, C11 authority,
WASM bridge, typed Data Playground, and simulated rule evaluation. Proposed
semantics below are recommendations, not claims that the existing specification
already defines them. The original specification and implementation are unchanged.

## 1. Review verdict and evidence

The architecture is sound, but the original plan is not yet precise enough to
implement evaluation consistently. Settle language semantics and build a real
browser analysis slice before completing the evaluator or elaborate UI.

| Priority | Finding | Evidence / consequence | Plan correction |
| --- | --- | --- | --- |
| High | AST layout loses statement order | Separate `AstLet`, `AstWhen`, and action lists cannot represent interleaved declarations and branch-local assignments faithfully. | Use ordered rule elements and ordered branch statements; retain metadata as structured nodes. |
| High | Accepted syntax exceeds proposed evaluator semantics | `src/parser.c` accepts calls, indexing, arrows, standalone `latest`, and `when for`; evaluation behavior is unspecified. | Preserve parsing and represent all forms; define a supported evaluation subset and report semantic errors for unsupported executable forms. |
| High | Nested conditions have no closing delimiter | `parse_when_stmt` consumes all following statement-start tokens recursively; indentation is discarded by the lexer. A later `when` may be nested rather than a sibling. | Freeze current greedy parsing in AST tests, document it, and make structured blocks a separate language change. |
| High | `where` and `within` attachment is ambiguous to readers | `parse_where_clause` calls the full expression parser. In the temporal example the filter expression can consume the trailing `within`. Condition-level `within` has no defined target series. | Preserve the parsed shape, then normalize only documented temporal forms during semantic analysis. |
| High | Time semantics are incomplete | No evaluation clock, timezone subset, future-record policy, window boundary, or invalid-timestamp policy is specified. | Use a fixed evaluation timestamp in the input and explicit selection rules (§4). |
| High | Result schema cannot represent the language | One outcome and one alert per patient loses multiple/nested conditions, multiple alert arguments, and alert-plus-suppress actions in existing examples. | Return ordered condition traces and action events per rule/patient (§5). |
| High | Suppression implies state that does not exist | Existing examples alert and suppress in the same branch. No history or cooldown persistence is defined. | Record suppression as a simulated action; do not implement cross-run alert suppression implicitly. |
| High | Sanitizer verification is ineffective as written | `Makefile:27–31`: tests use `TEST_FLAGS`; `sanitize` changes `CFLAGS` and builds the CLI. A subsequent `make test` compiles an ordinary test runner. | Add a separate sanitized test executable and `make test-sanitize`; isolate build configurations. |
| Medium | Parser and EBNF differ | `parser_parse` rejects empty programs; `parse_when_stmt` requires nonempty branches; `parse_suppress_stmt` requires an operand and accepts `within`. The EBNF permits empty forms and `docs/grammar.md` omits this suppress variant. | Reconcile docs with compatibility fixtures before AST work. |
| Medium | Engine memory ownership is underspecified | `diag_free` introduces new obligations for `main.c` and every test; partial AST/JSON failures need cleanup. | Define owners and failure states before allocating new structures (§3). |
| Medium | Token lengths are not reliable diagnostic ranges | `TOKEN_ERROR` lexemes may be descriptive text; lexer columns count bytes. UTF-8 and raw CR line endings need a policy. | Record original byte offsets and exclusive ends; convert ranges at the editor boundary. |
| Medium | Debounce does not keep the UI responsive | A synchronous WASM call still blocks the thread that runs it. | Put the engine in a dedicated worker; coalesce pending analysis and track source/data revisions. |
| Medium | JSON and table binding contracts need more detail | `Bindings` maps strings to table names but cannot explicitly select a different column; invalid cells and missing values are conflated. | Specify typed table validation and structured binding targets (§4–5). |
| Medium | Repository reproducibility needs attention | `SOURCE_OF_TRUTH.md` is ignored; `.gitignore` is currently untracked. Binaries, object files, and the test runner are already tracked. | Put shared contracts in tracked docs; propose artifact cleanup separately, without changing history. |

Verified baseline: a fresh GCC build of the existing test runner in `/tmp` passed
17/17 tests. The current precedence test checks acceptance only, not AST shape or
evaluation. Node/npm are available. `emcc` is not on PATH. There is no `web/`
application yet. A direct sanitizer build was also attempted: linking failed
because the GCC AddressSanitizer and UndefinedBehaviorSanitizer runtime libraries
(`libasan.so.8.0.0`, `libubsan.so.1.0.0`) are unavailable at the configured paths.
Install/repair matching sanitizer runtimes before claiming sanitized verification.
These facts establish a baseline, not evaluator/WASM correctness.

## 2. Architecture and delivery strategy

Recommended: extend the existing parser to build an AST, add a distinct semantic
validation stage, and use one shared C engine behind native tests and WASM.

Alternatives considered:

- A second parser dedicated to evaluation would initially avoid touching recovery,
  but would create two grammars and inconsistent diagnostics. Reject it.
- Implementing every evaluator feature before browser integration follows the
  original horizontal phases, but discovers WASM/worker integration problems late.
  Use incremental end-to-end slices instead.
- Replacing the grammar with explicit block terminators would improve nesting,
  but changes accepted programs and exceeds compatibility requirements. Defer to a
  separately specified language revision.

Target flow:

```text
Monaco / Data Playground
    -> worker request {requestId, sourceRevision, dataRevision, payload}
    -> C API: source -> lexer -> parser/AST -> semantic validation
                                            -> tables/bindings -> evaluator
    <- owned JSON result copied into JS, then freed
    <- versioned worker response -> markers / tokens / traces / action events
```

No server is required. JavaScript handles presentation, editor coloring, CSV
transport, and form validation. C remains authoritative for tokenization, syntax,
semantic validation, typed data acceptance, timestamp interpretation, and execution.
Do not introduce a JavaScript fallback evaluator when WASM fails.

Delivery checkpoints:

1. **Analysis slice:** Monaco -> worker -> actual C WASM -> tokens and diagnostics.
2. **Evaluation slice:** direct-source high glucose example -> three patients ->
   FALSE/TRUE/TRUE and exactly two alert events, in native and browser tests.
3. **Language coverage:** bindings, ordered statements, multi-source logic,
   filters/windows, action traces, and explicit unsupported-form diagnostics.
4. **Studio completion:** table editing/import/export, all presets, persistence,
   completion, inspection panels, accessibility, and release verification.

These checkpoints sequence the full scope; later features are not silently removed.

## 3. C engine design and ownership

### AST and compatibility

- `AstProgram` owns rules. Each rule owns an ordered list of rule elements:
  metadata declarations, sources, bindings, lets, whens, alerts, and suppressions.
- A `when` owns a condition, optional `for` identifier, and ordered then/otherwise
  statements. Preserve actual recursive-descent grouping, including greedy nesting.
- Expressions represent literal, identifier, member, arrow, call, index, comparison,
  unary, logical, filter, and temporal forms. Durations preserve value and unit.
- Attach original source spans to every relevant node. Store a separate semantic
  query plan for normalized table selection; do not silently rewrite parse structure.
- Keep `parser_parse` as the compatibility entry point. Add an AST-returning entry
  point backed by the same parsing functions. Exactly one parse per API request.
- On syntax/lexical failure, never evaluate a partial tree. Dispose of partial
  nodes deterministically while preserving useful recovery diagnostics.
- Semantic validation reports unknown variables, duplicate declarations, unsupported
  expressions, binding failures, and invalid action arguments separately from syntax.
  Syntax-valid and evaluation-ready are distinct states.

### Ownership and diagnostics

| Resource | Owner | Lifetime / cleanup |
| --- | --- | --- |
| Source text | `SourceBuffer` | Retained through parse/evaluation/serialization; `source_free` |
| Token lexemes | `TokenList` | `token_list_free`; AST must not borrow them after this |
| AST nodes and copied names/strings | `AstProgram` | One `ast_program_free`, safe for partially built programs |
| Diagnostic messages and optional snippets | `DiagnosticEngine` | Own copies; `diag_free` at every CLI/test/API exit |
| Tables, schemas, rows, values | `DataStore` | `data_store_free`, including partial JSON construction |
| Evaluation traces/actions | Evaluation result | Freed after JSON serialization |
| Serialized C result | API caller | Exactly one `helix_free_result`; NULL-safe |
| JS input allocations | Worker bridge | `_free` in `finally`, including partial allocation failures |

Use stable diagnostic codes, severity (`error`, `warning`, `info`), and category
(`lexical`, `syntax`, `semantic`, `data`, `evaluation`, `engine`). Preserve existing
CLI counters/output; add counters without recategorizing old errors. Data problems
include table/row/column context rather than a fictitious editor location. Unknown
conditions can carry explanatory notes without being execution failures.

Add start/end byte offsets to tokens and diagnostics. End offsets are exclusive.
Store raw spans even for error tokens and EOF. Define UTF-8 input, reject embedded
NUL/invalid encoding, normalize editor/file line endings to LF with a documented
native CR/CRLF policy, and convert byte positions to editor UTF-16 positions using
the exact submitted source snapshot. Tabs count as characters, not display width.
Do not derive error ranges from `strlen` of diagnostic or error-token messages.

All growing arrays/builders check allocation and size overflow. Add per-request
limits for source bytes, AST depth/nodes, JSON depth/bytes, rows, tokens, diagnostics,
and output size. Define numeric values in the contract task and test at/over each
limit. Failure paths produce a bounded error or NULL on allocation failure; they
must not continue with truncated source or incomplete tables.

## 4. Recommended evaluation semantics

These resolve omissions in the original plan. Record them in tracked language and
evaluation docs before implementing; decisions flagged in §9 need particular care.

### Tables, bindings, and patient population

- Keep the existing canonical input key `Bindings` to avoid unexplained drift from
  the SSOT. Extend a target to `{table, column?}`; a string target remains a shorthand
  for the table's default value column. An explicit column overrides inference.
- Resolve an exact binding-map key first; otherwise resolve a real `table.column`;
  otherwise resolve a table name. A mapped qualified path such as `Labs.glucose`
  can therefore target `{table:"glucose_data", column:"value"}`. No silent fallback
  to a similarly named table or first numeric column.
- A direct `source glucose_data` selects a table. `source EHR -> FHIR_R4` is metadata
  unless `EHR` is explicitly mapped; it is not a network adapter or FHIR importer.
  Bindings remain usable without a source declaration, as in existing examples.
- Declarations execute in source order. No forward references; reject duplicate
  names within a scope. Branch lets are local and may shadow outer names; branch
  execution does not mutate another patient's environment.
- Per rule, use the union of patient IDs in resolved execution tables. Every
  source remains scoped to the same patient; missing records yield MISSING rather
  than cross-patient matches. Sort patient IDs for deterministic output; retain
  source order for rules, traces, and actions. A rule with no resolved execution
  table is syntax-valid but not evaluable; empty resolved tables return no patients
  with an informational note.
- Require unique table/column names, declared row keys, nonempty String patient IDs,
  and valid schema references. Unknown bindings, duplicate JSON keys, malformed JSON,
  undeclared cells, and type-invalid populated cells are data errors; abort execution
  of that request. Missing or JSON-null cells become MISSING. Empty String is a
  valid String; the UI uses an explicit empty-cell state for MISSING.
- Support bounded signed integers, finite floating-point numbers, booleans,
  strings, and DateTime. Document JS safe-integer limits and reject integers outside
  the shared exact range at the boundary. No implicit string-to-number coercion.

### Selection, filters, and time

- Require `evaluationTime` for evaluation requests; the UI captures it once when
  Evaluate is pressed and supports a fixed timestamp in presets/tests. C does not
  read a hidden wall clock. Return that timestamp with the result.
- Define the supported timestamp profile as Gregorian
  `YYYY-MM-DDTHH:mm:ss[.fraction](Z|±HH:MM)`, with up to millisecond precision.
  Validate dates, offsets, and leap years; reject timezone-free dates, leap seconds,
  excess fractional precision, and impossible dates. Compare normalized UTC instants,
  without local-time APIs or lexical string ordering.
- For `.latest`: filter by patient, exclude missing timestamps and timestamps after
  `evaluationTime`, apply row filters and time windows, then select the largest
  instant. Equal instants select the later input row. Missing timestamps are noted;
  malformed nonempty DateTime cells fail input validation. No eligible row means
  MISSING. A selected row with a missing value stays MISSING; do not substitute an
  older nonmissing value silently.
- `where` sees candidate-row fields first, then rule variables; only TRUE retains
  a row. FALSE or UNKNOWN excludes it; an unknown column is a semantic error.
- Normalize `bind x = T.c where predicate within D` into a series query with filter
  and time window even when the parser attaches `within` inside the filter tree.
  Support only this documented trailing qualifier normalization; reject ambiguous
  row-series combinations instead of guessing.
- `within D` on a comparison with exactly one series reference further restricts
  that series; zero/multiple series references require a semantic error in v1.
  Combined bind/condition windows intersect. Use the inclusive interval
  `[evaluationTime - D, evaluationTime]`. Durations must be positive, finite, and
  have recognized units (`s`, seconds, `m`, minutes, `h`, hours, `d`, days, with
  singular variants); define string and variable forms and reject unitless numeric
  durations. Windowing does not prove sustained or consecutive abnormal readings.
- `table.latest` uses the schema's default value column; `table.column` denotes a
  bound series and must be selected with `.latest` for scalar use. Preserve other
  parsed member forms but report unsupported use. Standalone `latest`, executable
  calls/indexing/arrows, and `when for` get explicit unsupported-feature errors
  until their semantics are specified. Metadata argument lists remain supported.

### Values, conditions, and actions

- Comparisons involving MISSING produce UNKNOWN, including `!=`. Int/Float
  comparison uses documented promotion within the shared exact range. No truthy
  strings or numbers; logical operands must be boolean/three-valued results.
  Incompatible types generate an evaluation diagnostic and UNKNOWN.
- Same-type String and DateTime comparisons have defined ordering; Boolean values
  support equality/inequality. Other Boolean ordering is a type error. Boolean
  literals are not new keywords: the current grammar treats their spellings as
  identifiers. Boolean table values are supported without changing the 21 keywords.
- Preserve `comparison > not > and > or` precedence and left association for
  logical chains. FALSE AND UNKNOWN = FALSE; TRUE AND UNKNOWN = UNKNOWN;
  TRUE OR UNKNOWN = TRUE; FALSE OR UNKNOWN = UNKNOWN; NOT UNKNOWN = UNKNOWN.
  Specify left-to-right short circuit; semantic validation still checks all branches.
- TRUE runs then, FALSE runs otherwise, UNKNOWN runs neither. Record nested
  condition traces only when reached; unreached conditions are not reported FALSE.
- Alert arguments are ordered expressions. First argument is a required String
  message. A recognized second String (`INFO`, `WARNING`, `CRITICAL`) is severity;
  otherwise remaining arguments are payload values and severity defaults to WARNING.
  A missing/nonstring message is an action error, with no alert event. Preserve
  every payload argument; the temporal example's numeric second argument is valid.
- Each alert/suppress statement emits its own event. `suppress within D` records a
  simulated cooldown request, with no cross-run state and no retroactive removal of
  a preceding alert. `suppress "reason"` records a reason; identifier operands
  resolve variables and must be a valid reason/duration. UI labels explain this.
  Stateful suppression and scheduler execution are outside this release.
- Site, intent, terminology, schedule, and source mapping metadata are inspectable;
  they do not implement terminology validation, clinical inference, scheduled jobs,
  or remote EHR access.

## 5. API contract refinements

Retain the three proposed C signatures: `helix_analyze`, `helix_evaluate`, and
`helix_free_result`. Inputs are borrowed UTF-8 strings; results are owned heap
strings. NULL input produces a structured error if allocation permits. NULL result
means allocation/engine failure and is never passed to JSON.parse. No static result
buffer; repeated calls are independent.

Add `schemaVersion: 1` to request/response JSON contracts and track examples in
`docs/api.md`. This is a proposed revision of the unreleased SSOT contract.

Analysis response preserves tokens/counts/diagnostics. Define `tokenCount` as
non-EOF entries (including error tokens); include EOF in `tokens` with its sentinel
category. Derive the count explicitly rather than assuming `TokenList.count`.
`success` means lexical and syntax validation succeeded; this does not promise
that a program is evaluation-ready. A later evaluation can return semantic errors.

Evaluation input adds `evaluationTime` to the existing `tables`/`Bindings` object.
Result contract:

```json
{
  "schemaVersion": 1,
  "success": true,
  "analysisSuccess": true,
  "evaluationTime": "2026-10-31T12:00:00Z",
  "results": [{
    "ruleId": "rule:0",
    "ruleName": "HighGlucoseAlert",
    "patientId": "P002",
    "conditions": [{
      "conditionId": "rule:0/when:0",
      "conditionText": "glucose_data.latest > 250",
      "outcome": "TRUE",
      "resolvedValues": [{
        "expression": "glucose_data.latest",
        "table": "glucose_data",
        "column": "value",
        "rowIndex": 1,
        "timestamp": "2026-10-31T09:00:00Z",
        "type": "Float",
        "value": 275
      }]
    }],
    "actions": [{
      "kind": "alert",
      "conditionId": "rule:0/when:0",
      "message": "High glucose detected",
      "severity": "WARNING",
      "payload": []
    }],
    "diagnostics": []
  }],
  "diagnostics": []
}
```

Add spans to conditions/actions in the complete schema. IDs are stable for the
same source snapshot; edits may change them. Do not invent a single patient-level
outcome when several conditions differ. Standalone actions have a null condition ID.
MISSING values serialize with explicit type `Missing`, `value: null`, and a reason.
Suppression events carry duration/reason fields instead of alert-only fields.

`analysisSuccess` concerns lexical/syntax validity. `success` means data validation,
semantic validation, and execution completed without error diagnostics. UNKNOWN
alone is a successful evaluation. Pre-execution errors return no patient results;
runtime errors retain explicit partial traces with `success:false`. Warnings/info
do not flip success. There are no actual patient notifications or side effects.

## 6. WASM and frontend implementation constraints

- Compile shared C modules, excluding `main.c`, to a modularized ES module with
  an asynchronous factory. Export the three API functions plus allocator helpers
  needed by the bridge. Export UTF-8 conversion helpers explicitly when used.
  Keep the factory/loader and binary together and resolve assets relative to the
  deployed base path. Pin an actual tested SDK version during implementation.
- Return C pointers as numbers, copy UTF-8 JSON into JS, and free the C result in
  `finally`. Do not use a string-return wrapper that discards the pointer needed
  for freeing. Do not cache heap views across potential WASM memory growth.
- One worker owns one engine instance. Serialize calls; coalesce queued auto-analysis
  to the newest source. Manual Evaluate captures source, data, bindings, and clock
  as one immutable snapshot. Replies carry request/source/data revisions; stale
  replies cannot overwrite markers or results. Mark previous evaluations stale
  immediately after source/data/binding changes.
- Distinguish Loading, Ready, Analyzing, Valid, Invalid, Evaluating, and Engine Error.
  A worker/module failure disables engine actions and exposes a retry. Disposing
  an editor/app cleans up workers, providers, listeners, models, and object URLs.
- Use the requested palette/layout. Package Monaco and its workers locally; avoid
  requiring runtime CDN availability. Start with editor, Problems, and Tokens;
  add the remaining panels after their data contracts exist.
- Keep incomplete cell edits as drafts; show exact table/cell errors and disable
  Evaluate until they are valid. Permit deliberately missing values, with explicit
  MISSING styling. Validate full datasets in C even when JS has already validated.
- Add/delete/rename tables, rows, and columns with unique names and validated schema
  references. Renaming a bound table/column must surface broken bindings immediately.
  Type changes validate existing rows and never silently discard/coerce data.
- CSV uses quoted commas, escaped quotes, CRLF, and quoted newlines; reject duplicate
  headers and inconsistent row widths. Import previews type mapping, validates all
  rows, then commits atomically. CSV cannot preserve every type/missing distinction:
  document its empty-field policy and offer JSON for lossless round trips.
- Persist versioned source/settings/tables/bindings, handle corrupt/older storage
  and quota failures visibly, and keep work usable when persistence fails. Avoid
  logging imported datasets. Use synthetic data for bundled examples.
- Problems navigation uses C spans converted for Monaco; data diagnostics navigate
  to cells. Completions are suggestions only, use current schema snapshots, and
  avoid adding unsupported evaluator syntax to recommended snippets.
- Provide keyboard access, focus indicators, accessible labels, readable status
  text in addition to colors, panel overflow handling, and a usable narrow layout.
  Evaluation Results always displays “Simulated Rule Output — Not for Clinical Use”.

The modularized loader and explicit C exports follow
[Emscripten modularized output](https://emscripten.org/docs/compiling/Modularized-Output.html)
and [C/JavaScript interoperability](https://emscripten.org/docs/porting/connecting_cpp_and_javascript/Interacting-with-code.html).
Build flags and bundler integration still require testing against pinned versions.

## 7. Ordered implementation work

Detailed tasks, dependencies, and verification are in `tasks/todo.md`.

| Checkpoint | Tasks | Deliverable |
| --- | --- | --- |
| Contracts and baseline | 01–03 | Compatibility corpus, tracked contracts, correct sanitizer builds |
| Analysis slice | 04–07 | Structured C analysis running in a browser worker and Monaco |
| Evaluation slice | 08–12 | Ordered AST, typed data, bindings, and real high-glucose results |
| Language coverage | 13–16 | Multi-source values, filters/time, actions, matching datasets |
| Studio completion | 17–20 | Typed tables, CSV/storage, editor assistance and remaining panels |
| Release verification | 21–22 | Native/WASM parity, browser coverage, reproducible documentation |

Each checkpoint requires its verification before dependent tasks begin. A failed
check is an engineering stop to fix evidence, not a request for permission to
continue already authorized work. Do not mark later tasks complete based on mock
results or analysis-only tests.

## 8. Acceptance and verification matrix

| Area | Required evidence |
| --- | --- |
| Native compatibility | Fresh build; original 17 tests plus empty program/branch/suppress/nesting/qualifier fixtures; existing CLI modes and exit behavior retained |
| AST | Tree shape for precedence, nested branches, qualifier attachment, declaration order, metadata arguments; partial-tree cleanup under sanitizers |
| Values/data | Full 3×3 AND/OR truth tables, NOT, numeric/type boundaries, strict JSON rejection, missing/null, duplicate keys, Unicode/escaping, depth and allocation failures |
| Patient selection | P001=180 -> FALSE/no alert; P002=275 and P003=310 -> TRUE/alert; older/newer/tied rows, missing latest values, no cross-patient leakage |
| Multiple sources | Union population with one source absent; per-patient variable isolation; binding failures never select an arbitrary table |
| Temporal | Offset-equivalent instants, leap dates, missing/invalid/future timestamps, exact inclusive boundaries, row filters before latest, intersection of windows |
| Actions | Multiple ordered alerts, payload arguments, standalone actions, nested conditions, UNKNOWN executes neither branch, suppression trace without hidden history |
| Memory | Native sanitized test binary actually executes; repeated successful and failing APIs return allocations to baseline using instrumentation; cleanup on parse/JSON errors |
| Native/WASM parity | Same source/data/clock yields structurally equal tokens, codes, traces, and actions after normalizing only platform timing metadata |
| Browser | Actual WASM load/failure/retry; responsive editing; stale responses dropped; error click navigation; saved file round trip; no mock engine substituted |
| Playground | Schema edits, invalid drafts, MISSING vs zero/false, atomic CSV import, JSON round trip, bindings invalidated on rename, persistence failure recovery |
| UI | All five examples with datasets, settings, editor completions, all requested tabs, visible simulation disclaimer, keyboard and narrow-layout checks |

Planned commands (new targets/scripts must be implemented before use): `make all`,
`make test`, `make test-sanitize`, `make wasm`, then `npm ci`, `npm run typecheck`,
`npm test`, `npm run build`, and `npm run test:e2e` inside `web/`. WASM parity runs
as part of the bridge/integration suite. Missing toolchain/assets fail the relevant
check explicitly. CI builds from a clean checkout so tracked stale binaries cannot
mask a source failure. Add header dependency files and separate native/sanitized/WASM
build directories; avoid racing `clean` prerequisites under parallel make.

## 9. Decisions to confirm before evaluation implementation

The analysis slice can proceed using existing syntax. Before committing the
evaluation contract, resolve these product/language choices; recommended defaults
are already written into this plan so review has concrete proposals:

1. **Temporal meaning:** fixed input clock, inclusive windows, no future readings,
   and “latest eligible reading”, rather than sustained-condition detection. Rename
   the temporal preset description unless sustained detection is separately specified.
2. **Suppression:** simulated event only. A persistent cooldown requires a separate
   state schema, reset/history UX, and replay rules; add scope before implementing it.
3. **Grammar compatibility:** preserve current greedy nesting and diagnose
   unsupported executable forms; do not add branch terminators or Boolean keywords
   as incidental implementation changes.
4. **API revision:** adopt structured binding targets and arrays of condition/action
   traces instead of the SSOT's one-outcome/one-alert presentation fields.

Implementation may choose ordinary module/function names and component boundaries
without further design approval. When the decisions above are settled, update
tracked `docs/grammar.md`, `docs/evaluation.md`, and `docs/api.md` together, and
explicitly reconcile `SOURCE_OF_TRUTH.md` to avoid competing contracts. Keep the
requested ignored SSOT policy; do not silently change it during this review.

## 10. Risks and scope boundaries

| Risk | Mitigation |
| --- | --- |
| Custom JSON parser consumes most engine time | Keep it isolated, bounded, strictly tested; if third-party code is permitted later, evaluate a small C dependency explicitly rather than introducing one silently |
| AST work changes recovery or accepted programs | Compatibility corpus before refactor; tree snapshots and negative cases after every parser change |
| Main-thread stalls or large responses | Worker, bounded input/output, coalesced analysis, indexed per-patient selection, paginated/virtualized inspectors when measured necessary |
| Deferred constructs appear to work | Semantic errors and capability documentation; no best-effort execution of unsupported AST nodes |
| Build appears green from checked-in outputs | Fresh isolated builds and CI; tracked artifact cleanup as a separate maintenance task |
| Nice-looking demo hides engine gaps | Actual WASM end-to-end checkpoints and native/browser golden dataset parity |

No real clinical deployment, patient notifications, persistent suppression,
scheduler service, network EHR integration, or sustained-event inference is implied
by this release. These would each need additional requirements and validation.
