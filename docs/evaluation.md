# HELIX Studio evaluation contract

Adopted from the reviewed plan after user approval on 2026-10-31.

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

## 4. Evaluation semantics

These adopted rules resolve omissions in the original specification. They govern
the implemented evaluator; the approved decisions are recorded in tasks/plan.md.

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
