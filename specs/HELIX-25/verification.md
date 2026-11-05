# HELIX-25: arithmetic expressions, operator precedence, and negative values

Date: 2026-11-05 (Asia/Manila)
Branch: `jm-v1-HELIX-25`, based on `a38713f`.

## Result

Arithmetic expressions with `+`, `-`, `*`, `/` and unary negation (`-1`, `-B`) now pass both lexical analysis and syntax validation in `let` assignments, `when` conditions, and `alert` arguments. Precedence follows the language proposal (§10.3 & §11):
- Unary `-` (`parse_neg_expr`, right-associative) binds tighter than
- Multiplicative `*`, `/` (`parse_mul_expr`, left-associative), which bind tighter than
- Additive `+`, `-` (`parse_add_expr`, left-associative), which bind tighter than
- Relational comparisons (`parse_comparison_expr`).

In particular, `rule R: let x := 1 + 2 - 3 * 4 / 5 end rule` parses `3 * 4 / 5` as the right-hand multiplicative term of `-`, and `1 + 2` as the left-hand additive term. Both the C evaluator (`src/evaluator.c`) and the browser AST/FHIR Sandbox (`gui/web/src/lib/ast.js`, `sandbox.js`) preserve this precedence and evaluate `1 + 2 - 3 * 4 / 5` to `0.6`.

## Action log and reasons

1. Read Ponytail Ultra and ub-mode instructions; audited git history (`HELIX-38` commits `eada326` and `c1ee431`, `HELIX-15` commit `949807d`, `HELIX-37` commit `ae452ca`), `src/lexer.c`, `src/parser.c`, `src/evaluator.c`, `src/wasm_api.c`, `docs/grammar.md`, and `context/qa/QA-REPORT.md`.
2. Verified that `HELIX-38` added `TOKEN_PLUS`, `TOKEN_MINUS`, `TOKEN_STAR`, `TOKEN_SLASH` to the lexer, eliminating the 4 lexical errors, but left the recursive-descent parser and EBNF grammar without arithmetic productions.
3. Added failing C parser tests (`test_parser_arithmetic_expressions` in `tests/test_runner.c`) and failing Node UI tests (`gui/web/src/lib/arithmetic.test.js`) before editing implementation code (TDD Red phase). Confirmed both failed for the expected syntax/AST reasons.
4. Added `AST_ADD` and `AST_MUL` to `include/ast.h` and implemented `parse_neg_expr`, `parse_mul_expr`, and `parse_add_expr` in `src/parser.c` below `parse_comparison_expr`. Reused `AST_UNARY` for unary `-` only when `TOKEN_MINUS` is present so non-negated expressions incur zero extra AST wrapper depth.
5. Updated `src/evaluator.c` to evaluate unary `-`, `AST_ADD`, and `AST_MUL` (returning `VAL_MISSING` / `UNKNOWN` on missing operands or division by zero per Proposal §10.4) and relaxed `AST_COMPARISON`'s RHS child check from `AST_POSTFIX` to `!= AST_WHERE && != AST_WITHIN`.
6. Fixed `src/wasm_api.c` token categorization bound (`t->type <= TOKEN_SLASH ? "OPERATOR"`) and added `[+\-*/]` to the operator regex in `web/src/editor/language.ts`.
7. Updated `gui/web/src/lib/ast.js` and `gui/web/src/lib/sandbox.js` to parse and evaluate arithmetic precedence and unary `-`, and to consume explicit block terminators (`end bind`, `end when`, `end rule`) introduced by `HELIX-15`.
8. Updated `docs/grammar.md`, `docs/token_reference.md`, and `README.md` to document the arithmetic productions and precedence hierarchy.
9. Captured before/after CLI logs, C/UI/sanitizer test outputs, API probes, and 4 verification screenshots in `dev-docs/HELIX-25/`.

## Verification

- `./build/native/test_runner`: **37/37 pass**, including the 22-case arithmetic syntax matrix, C AST precedence verification, and existing `HELIX-38` / `HELIX-37` / `HELIX-15` suites.
- `./build/native/test_studio`: **pass** (AST, truth tables, timestamps, strict JSON, and 1,500 repeated API calls).
- `npm test` in `gui/web`: **9/9 pass** (arithmetic AST precedence, unary negation, sandbox calculation, repeat_of AST/timeline/YAML).
- `npm run build` in `gui/web`: **pass**.
- Test runner compiled with `-fsanitize=address,undefined`: **37/37 pass**.
- `git diff --check`: **pass**.
