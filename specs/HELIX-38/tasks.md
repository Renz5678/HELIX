# HELIX-38: Implementation Tasks

- [x] **Task 1: Add arithmetic operator token enum values**
  - **Modification:** Add `TOKEN_PLUS`, `TOKEN_MINUS`, `TOKEN_STAR`, and `TOKEN_SLASH` under `/* Operators */` in `TokenType`.
  - **Files:** `include/token.h`
  - **Dependencies:** None
  - **Verification:** Header compiles cleanly with all translation units.

- [x] **Task 2: Add token name and description mappings**
  - **Modification:** Add `TOKEN_PLUS`, `TOKEN_MINUS`, `TOKEN_STAR`, and `TOKEN_SLASH` cases to `token_type_name()` and `token_type_description()`.
  - **Files:** `src/token.c`
  - **Dependencies:** Task 1
  - **Verification:** `gcc -std=c11 -Wall -Wextra -Wpedantic -Iinclude -c src/token.c` succeeds with zero `-Wswitch` warnings.

- [x] **Task 3: Recognize `+`, `-`, `*`, `/` in the lexer**
  - **Modification:** In `lexer_next_token()`, add cases for `'+'` (`TOKEN_PLUS`), `'*'` (`TOKEN_STAR`), `'/'` (`TOKEN_SLASH`), and update `'-'` to return `TOKEN_MINUS` when not followed by `'>'`.
  - **Files:** `src/lexer.c`
  - **Dependencies:** Task 1, Task 2
  - **Verification:** `make` compiles cleanly; lexer tokenizes `+`, `-`, `*`, `/` without `TOKEN_ERROR`.

- [x] **Task 4: Add unit and regression tests for HELIX-38**
  - **Modification:**
    - Update `is_expected_single()` in `tests/test_runner.c` for `'+'`, `'-'`, `'*'`, `'/'`.
    - Add unit tests in `tests/test_runner.c` covering:
      - `1 + 2`, `5 - 3`, `4 * 2`, `8 / 2`
      - `A+B` (without spaces) and `A + B` (with spaces)
      - `(A + B) * C`, `A-5`, `A*-B`, `A / B + C * D`
      - `A = 10` and `A := 10` (existing assignment preserved)
      - Jira reproduction cases: `let severe_threshold = 250 + 3` and `let A := (B + 3) * G / 24`
      - Edge cases: consecutive operators, comments with operators, division adjacent to `#` comments, EOF boundaries, `->` arrow preservation, and invalid characters still failing.
  - **Files:** `tests/test_runner.c`
  - **Dependencies:** Task 3
  - **Verification:** Run `make test` and verify all tests pass with 0 failures.
