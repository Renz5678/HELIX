# HELIX-38: Technical Design

## 1. Root Cause Analysis

Inspection of `include/token.h`, `src/token.c`, and `src/lexer.c` reveals two direct causes for `TOKEN_ERROR` on arithmetic operators:

1. **Missing Token Definitions (`include/token.h`, `src/token.c`):**
   `TokenType` defines assignment (`TOKEN_ASSIGN`, `TOKEN_EQUAL`), comparison (`TOKEN_EQ`, `TOKEN_NEQ`, `TOKEN_GT`, `TOKEN_GTE`, `TOKEN_LT`, `TOKEN_LTE`), and mapping (`TOKEN_ARROW`) operators, but has no enum entries for `+`, `-`, `*`, or `/`.
2. **Missing/Error Branches in Lexer DFA (`src/lexer.c`):**
   - In `lexer_next_token()` (`src/lexer.c:239–318`), `+`, `*`, and `/` have no `case` labels and fall into `default:` (`src/lexer.c:310–317`), which logs `DIAG_LEXICAL_ERROR` (`"Unrecognized character '%c' (0x%02X)"`) and returns `TOKEN_ERROR`.
   - `case '-':` (`src/lexer.c:280–290`) checks for `->` (`TOKEN_ARROW`), and otherwise explicitly reports `DIAG_LEXICAL_ERROR` (`"Unsupported lone character '-' (did you mean '->'?)"`) and returns `TOKEN_ERROR`.

## 2. Relevant Files and Functions

| File | Function / Symbol | Role |
|---|---|---|
| `include/token.h` | `enum TokenType` | Declares token enumeration constants |
| `src/token.c` | `token_type_name()`, `token_type_description()` | Maps `TokenType` to string names and diagnostic descriptions |
| `src/lexer.c` | `lexer_next_token()` | Scans characters and emits operator tokens |
| `tests/test_runner.c` | `is_expected_single()`, unit tests | Verifies single-character ASCII sweep and operator tokenization |

## 3. Existing Token Architecture

In `include/token.h`, operators are grouped under `/* Operators */`:
```c
    /* Operators */
    TOKEN_ASSIGN,         /* := */
    TOKEN_EQUAL,          /* = */
    TOKEN_EQ,             /* == */
    TOKEN_NEQ,            /* != */
    TOKEN_GT,             /* > */
    TOKEN_GTE,            /* >= */
    TOKEN_LT,             /* < */
    TOKEN_LTE,            /* <= */
    TOKEN_ARROW,          /* -> */
```
Following this convention, we add the four arithmetic operator tokens directly under `/* Operators */`:
```c
    TOKEN_PLUS,           /* + */
    TOKEN_MINUS,          /* - */
    TOKEN_STAR,           /* * */
    TOKEN_SLASH,          /* / */
```

## 4. Proposed Minimal Changes

### 4.1 `include/token.h`
Add `TOKEN_PLUS`, `TOKEN_MINUS`, `TOKEN_STAR`, and `TOKEN_SLASH` to `TokenType`.

### 4.2 `src/token.c`
- In `token_type_name(TokenType type)`:
  ```c
        case TOKEN_PLUS:           return "TOKEN_PLUS";
        case TOKEN_MINUS:          return "TOKEN_MINUS";
        case TOKEN_STAR:           return "TOKEN_STAR";
        case TOKEN_SLASH:          return "TOKEN_SLASH";
  ```
- In `token_type_description(TokenType type)`:
  ```c
        case TOKEN_PLUS:           return "'+'";
        case TOKEN_MINUS:          return "'-'";
        case TOKEN_STAR:           return "'*'";
        case TOKEN_SLASH:          return "'/'";
  ```

### 4.3 `src/lexer.c`
In `lexer_next_token(Lexer *lexer)`:
- Update `case '-':` so that when `peek_char(lexer)` is not `'>'`, it returns `token_create(TOKEN_MINUS, "-", start_line, start_col)` instead of reporting a lexical error.
- Add `case '+':`, `case '*':`, and `case '/':`:
  ```c
        case '+':
            return token_create(TOKEN_PLUS, "+", start_line, start_col);

        case '*':
            return token_create(TOKEN_STAR, "*", start_line, start_col);

        case '/':
            return token_create(TOKEN_SLASH, "/", start_line, start_col);
  ```

### 4.4 `tests/test_runner.c`
- Update `is_expected_single()` in `test_exhaustive_single_char_sweep()` to assert `TOKEN_PLUS`, `TOKEN_MINUS`, `TOKEN_STAR`, `TOKEN_SLASH` for `'+'`, `'-'`, `'*'`, `'/'`.
- Add dedicated unit and regression tests for HELIX-38 covering all required operator combinations, whitespace variations, comments, consecutive operators, EOF boundaries, and Jira reproduction snippets.

## 5. Lexer / Parser Interaction & Limitations

- **Parser Inspection (`src/parser.c` & `docs/grammar.md`):**
  The formal grammar in `docs/grammar.md` and the recursive descent parser in `src/parser.c` define the expression hierarchy as:
  `expression -> or_expr -> and_expr -> unary_expr ('not') -> comparison_expr -> postfix_expr -> primary_expr`.
  Arithmetic expression rules (additive `+`/`-`, multiplicative `*`/`/`, unary `-`) are **not** currently defined in `src/parser.c` or `docs/grammar.md`.
- **Per Ticket Section 5 ("Parser Compatibility"):**
  > *"Inspect whether the parser already supports arithmetic expressions. If arithmetic grammar support exists, verify compatibility with the corrected tokens. If it does not exist, document the limitation rather than implementing a new expression grammar without approval. Do not introduce new operator precedence or associativity rules unless they are already established by the language specification."*
- Consequently, the lexer will cleanly tokenize arithmetic expressions without any `TOKEN_ERROR` or `DIAG_LEXICAL_ERROR`, while the parser will continue to enforce the existing EBNF grammar (reporting syntax errors when arithmetic tokens appear in parsed rules until a separate parser grammar ticket adds arithmetic precedence rules).

## 6. Edge Cases

1. **`-` vs `->`:** `a - b` emits `TOKEN_MINUS`, whereas `source: EHR -> FHIR_R4` or `a->b` emits `TOKEN_ARROW` via 1-character lookahead (`peek_char(lexer) == '>'`).
2. **Negative numbers / unary minus (`A-5`, `A*-B`, `-42`):** Because HELIX `int_literal` and `float_literal` are non-negative (`[0-9]+`), `-` before a digit or identifier is tokenized as `TOKEN_MINUS` followed by `TOKEN_INT_LIT` or `TOKEN_IDENTIFIER`.
3. **Slash `/` vs Comments (`#`):** HELIX comments start with `#`, not `//` or `/*`. Thus `/` is always `TOKEN_SLASH` (outside strings and `#` comments), `//` is two consecutive `TOKEN_SLASH` tokens, and `/# comment` emits `TOKEN_SLASH` followed by a skipped comment.
4. **No whitespace (`A+B`, `(A+3)*G/24`):** Since `+`, `-`, `*`, `/` are not valid identifier or number continuation characters, `scan_identifier_or_keyword()` and `scan_number()` stop immediately before them, ensuring accurate tokenization without spaces.
5. **EOF boundaries (`1 +`, `-`):** Operators at the very end of input consume only the single character and the subsequent call to `lexer_next_token()` cleanly returns `TOKEN_EOF`.

## 7. Regression Risks

- **Low Risk:** The change only converts previously unmapped characters (`+`, `*`, `/`) and the error branch of lone `-` into valid `TokenType` values.
- **Exhaustive Switch Warnings:** Because Makefile compiles with `-Wall -Wextra -Wpedantic`, any `switch (type)` over `TokenType` without a `default:` must handle the 4 new enum values (`src/token.c` has no `default:` inside the switch body and is updated accordingly; `src/parser.c` and `gui/server.c` have `default:` branches).
