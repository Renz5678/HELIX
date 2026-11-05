# HELIX Studio — Implementation Tasks

Status: proposed execution checklist for `tasks/plan.md`; all implementation tasks
remain open. Paths below describe future work. Commands referencing new targets
are acceptance requirements, not claims that those targets exist today.

## Contracts and baseline

### 01 — Freeze parser compatibility

- [ ] Add fixtures for empty programs/branches, suppress operands, greedy nested
  whens, trailing qualifiers, and accepted calls/indexing/arrows.
- [ ] Document current parse grouping and resolve the four decisions in plan §9
  before evaluator tasks; preserve the existing 21 keywords.

Verification: original 17 tests plus focused compatibility fixtures; compare
documented behavior to parser functions. Dependencies: none. Likely files:
`tests/test_runner.c`, `tests/parser/`, `docs/grammar.md`. Scope: medium fixture batch.

### 02 — Publish engine contracts

- [ ] Write versioned input/output examples, ownership rules, diagnostics, limits,
  binding resolution, supported expressions, clock and action semantics.
- [ ] Reconcile tracked docs and SSOT explicitly; record proposed versus settled
  decisions. Include malformed-data and UNKNOWN examples.

Verification: review every plan §4–5 decision against a contract example; parse
example JSON and check references. Dependencies: 01. Likely files: `docs/api.md`,
`docs/evaluation.md`, `docs/architecture.md`, `SOURCE_OF_TRUTH.md`. Scope: medium.

### 03 — Make build checks trustworthy

- [ ] Separate native, sanitized test, and WASM output directories; add header
  dependency tracking and a test-sanitize target that compiles/runs instrumented tests.
- [ ] Install/repair matching GCC sanitizer runtimes; the review's direct sanitized
  build could not link the configured ASan/UBSan libraries.
- [ ] Document toolchain setup and propose removal of tracked generated outputs
  separately; respect the existing untracked `.gitignore`.

Verification: fresh native test and sanitized test logs; touch a header and verify
rebuild; parallel make has no clean/build race. Dependencies: none. Likely files:
`Makefile`, `README.md`, `.gitignore`. Scope: medium.

**Checkpoint A:** 01–03 verified; contracts distinguish syntax support from runtime
support; original CLI behavior remains intact.

## Analysis slice

### 04 — Collect owned diagnostics with raw spans

- [ ] Add diagnostic codes/categories/severity, byte spans, allocation failure
  handling, and cleanup; retain CLI printing/counters.
- [ ] Update every CLI/test owner and preserve raw spans for errors/EOF.

Verification: NULL-stream diagnostics, printed diagnostics, span fixtures and
repeated invalid inputs under test-sanitize. Dependencies: 02–03. Likely files:
`include/diagnostic.h`, `src/diagnostic.c`, token/lexer span definitions, CLI/tests
(split into span and ownership commits). Scope: medium per commit.

### 05 — Expose native analysis JSON

- [ ] Add bounded JSON serialization and `helix_analyze`/`helix_free_result` with
  explicit EOF/count and allocation-failure behavior.
- [ ] Use one lexer/parser path and release all intermediate allocations.

Verification: independently parse valid/error response JSON; assert tokens, ranges,
escaping and NULL behavior; test-sanitize repeated calls. Dependencies: 04. Likely
files: `include/wasm_api.h`, `src/wasm_api.c`, JSON writer module, API tests. Scope: medium.

### 06 — Run analysis through WASM in a worker

- [ ] Pin/install an Emscripten SDK, add make wasm, and export API/allocator/helpers.
- [ ] Add worker bridge with finally-based cleanup, one initialized module,
  request/revision IDs, coalescing, and explicit load/failure states.

Verification: real module analysis matches native fixture output; repeated calls
and failure paths release allocations; deployed base-path asset smoke check.
Dependencies: 05. Likely files: `Makefile`, `web/package.json`, worker/bridge modules,
bridge tests. Scope: medium; split build and bridge commits.

### 07 — Deliver the editor analysis flow

- [ ] Build React/Vite/TypeScript shell, locally bundled Monaco, requested palette,
  header/sidebar/status, Problems/Tokens, and manual/debounced Analyze.
- [ ] Add language/theme registration and source-byte to UTF-16 marker conversion;
  stale worker responses cannot update a newer editor snapshot.

Verification: browser edits invoke real C, error navigation lands correctly,
UTF-8/CRLF ranges are accurate, missing module shows Engine Error; typecheck/build.
Dependencies: 06. Likely files: web entry/config, shell, editor, panels, styles;
split into shell and analysis integration commits. Scope: medium per commit.

**Checkpoint B:** real browser-to-C analysis works before evaluator work; no mock
tokens or JS analyzer; native compatibility and sanitized suites pass.

## Evaluation slice

### 08 — Build ordered ASTs in the existing parser

- [ ] Add ordered nodes/spans for all accepted forms with one parse path and a
  compatibility wrapper; free partial trees on every error.
- [ ] Assert precedence, greedy nesting, metadata arguments, and qualifier shapes.

Verification: AST structure tests and compatibility corpus under test-sanitize.
Dependencies: 01–05. Likely files: AST header/source, parser header/source, AST tests.
Scope: medium; stage expressions and statements separately.

### 09 — Add typed runtime values

- [ ] Implement MISSING, typed comparisons, full three-valued truth tables,
  bounded numeric conversion, and strict UTC timestamp normalization.
- [ ] Define duration parsing and supported date/number boundaries from the contract.

Verification: truth tables, invalid dates, offsets, leap dates, finite-number limits,
and missing comparisons under test-sanitize. Dependencies: 02–03. Likely files:
`include/value.h`, `src/value.c`, value tests. Scope: medium.

### 10 — Parse and validate table payloads

- [ ] Implement bounded strict JSON parsing and owned DataStore construction;
  validate schema names, references, row cells and exact numeric limits.
- [ ] Preserve missing/null and Boolean false/zero distinctly; reject malformed
  or type-invalid payloads atomically with table/cell diagnostics.

Verification: independent JSON fixtures, duplicate keys/escapes/Unicode/trailing
data/depth limits, partial allocation cleanup under test-sanitize. Dependencies:
02, 04, 09. Likely files: JSON reader module, data_table header/source, data tests.
Scope: medium; split reader and schema validation commits.

### 11 — Resolve direct sources and select patient readings

- [ ] Resolve direct source tables/default columns and create deterministic patient
  groups with fixed-clock latest-row selection and tie-breaking.
- [ ] Add semantic validation for the first supported subset; reject unsupported
  executable nodes explicitly before evaluating any patient.

Verification: high-glucose population, older/tied/future/missing rows, unknown table
and unsupported expression errors. Dependencies: 08–10. Likely files: bindings and
evaluator headers/sources, selection tests. Scope: medium.

### 12 — Deliver real high-glucose evaluation

- [ ] Add helix_evaluate serialization of condition/action arrays and worker support;
  render patient traces, typed values, actions and simulation disclaimer.
- [ ] Bundle the direct-source example with P001=180, P002=275, P003=310 and a fixed clock.

Verification: FALSE/TRUE/TRUE and exactly two alert events in native API and actual
browser WASM; stale results labeled after edits; typecheck/build/test-sanitize.
Dependencies: 07, 11. Likely files: wasm_api, evaluation tests, evaluation panel,
example/data fixtures. Scope: medium; split C and UI commits.

**Checkpoint C:** deterministic high-glucose evaluation matches native and WASM
contracts; full cleanup and UNKNOWN cases verified.

## Language coverage

### 13 — Support explicit bindings and multi-source patients

- [ ] Resolve string/object mappings and qualified columns with documented priority;
  union patient populations without cross-patient leakage.
- [ ] Support row/rule lookup and ordered scoped lets; diagnose duplicate/unknown names.

Verification: explicit Labs.glucose mapping, unmapped source metadata, absent source
for one patient, shadowing and environment isolation fixtures. Dependencies: 11–12.
Likely files: bindings/evaluator modules, binding/scope tests. Scope: medium.

### 14 — Support ordered conditions and actions

- [ ] Evaluate nested whens, short circuit, branch-local lets, standalone actions,
  multiple alerts/payloads, severity defaults, and simulated suppress events.
- [ ] Preserve reached trace order and distinguish UNKNOWN from unreached conditions.

Verification: existing sepsis/basic patterns, full truth table integration, multiple
actions and invalid messages; no hidden state between repeated runs. Dependencies:
13. Likely files: evaluator, action/branch tests, evaluation panel. Scope: medium.

### 15 — Add row filters and temporal windows

- [ ] Normalize only documented qualifier shapes, filter before latest selection,
  intersect windows, and reject ambiguous series qualifiers.
- [ ] Use the input evaluation clock, inclusive boundaries, and duration rules;
  expose eligibility/missing reasons in traces.

Verification: offset-equivalent times, exact bounds, filtered newer/older rows,
future records, invalid dates, empty windows and ambiguous conditions. Dependencies:
13–14. Likely files: semantic query normalization, evaluator, temporal tests.
Scope: medium.

### 16 — Complete matched presets and language documentation

- [ ] Pair all five examples with synthetic datasets, bindings, fixed clocks,
  expected outcomes and intentional-error diagnostics.
- [ ] Correct temporal description to match latest-in-window behavior; document
  unsupported forms and greedy nesting; offer grammar-compliant snippets.

Verification: native/WASM example goldens and parser fixtures; invalid demo never
evaluates; no preset promises sustained detection. Dependencies: 15. Likely files:
examples/data, web presets, docs/grammar/evaluation. Scope: medium fixture batches.

**Checkpoint D:** every bundled valid preset evaluates against matched data; all
remaining accepted-but-unsupported executable constructs receive explicit errors.

## Studio completion

### 17 — Build typed table editing and binding controls

- [ ] Add table/row/column operations, type changes, schema references and source
  mappings; invalidate broken bindings immediately on rename/delete.
- [ ] Preserve invalid drafts visibly and MISSING distinctly; block invalid Evaluate
  while retaining user edits.

Verification: browser CRUD/type/missing/binding tests and C revalidation of payloads.
Dependencies: 12–13. Likely files: DataPlayground, table editor, schema state,
source selector and tests. Scope: medium; split table editing and bindings commits.

### 18 — Add CSV/JSON transport and persistence

- [ ] Implement previewed atomic CSV import, typed export, and lossless JSON round trip.
- [ ] Persist versioned workspace state with corrupt data/migration/quota recovery
  and an explicit CSV empty-field policy.

Verification: quoted commas/quotes/newlines/CRLF, malformed rows/headers, storage
failure, JSON missing-vs-empty fidelity; browser reload round trip. Dependencies:
17. Likely files: CSV utility/tests, tableStorage, import/export controls. Scope: medium.

### 19 — Complete file workflows, settings, and language assistance

- [ ] Add New/Open/Download, dirty-state handling, font-size/auto-analysis settings,
  keyword docs, context-aware schema completions, and validated snippets.
- [ ] Dispose models/providers/listeners and object URLs; avoid stale schema suggestions.

Verification: file round trip, unsaved-edit protection, settings persistence,
completion insertion parses, repeated editor mounts clean up. Dependencies: 07,
16–18. Likely files: header/settings, completion modules, file services/tests.
Scope: medium; separate workflows and completions commits.

### 20 — Complete inspection panels and accessibility

- [ ] Add filtered token table, per-rule/patient condition/action inspection,
  execution logs/timing and grammar reference; label stale evaluation snapshots.
- [ ] Complete keyboard/focus/labels/narrow-layout checks and keep simulation
  disclaimer visible in all evaluation-result states.

Verification: panel navigation/filtering, problem-to-editor/cell links, keyboard-only
flow, narrow viewport, worker load/retry/stale-result cases. Dependencies: 14–19.
Likely files: panels, status bar, styles, browser tests. Scope: medium per panel batch.

**Checkpoint E:** complete requested Studio flow works with real WASM and editable
data; malformed input, storage failures and engine failures remain inspectable.

## Release verification

### 21 — Run cross-target and failure-path verification

- [ ] Add clean-checkout CI for native/sanitized tests, real WASM parity,
  frontend typecheck/build/unit tests and browser integration tests.
- [ ] Instrument repeated API requests for cleanup and exercise every documented
  input/output limit, worker failure and stale-response path.

Verification: execute plan §8 matrix; archive deterministic logs/artifacts, compare
structural outputs rather than timing; no skipped WASM checks presented as passing.
Dependencies: 16–20. Likely files: CI workflow, API/bridge/browser tests, test scripts.
Scope: medium per test layer.

### 22 — Publish reproducible build and capability documentation

- [ ] Document pinned toolchains, native/WASM/web commands, asset deployment,
  API ownership, grammar/evaluator coverage, datasets and known limitations.
- [ ] Check repository structure, tracked generated-file policy and example links;
  distinguish completed features from deferred language/product changes.

Verification: follow documented commands in a clean checkout and serve the production
build at a non-root base path; rerun the native baseline. Dependencies: 21. Likely
files: README, docs/architecture/api/evaluation, dependency lockfiles. Scope: medium.

**Final checkpoint:** all applicable task criteria and plan §8 evidence are met;
native functionality is preserved; all evaluation uses the same C engine; no
clinical-use or sustained-detection behavior is implied without implementation.
