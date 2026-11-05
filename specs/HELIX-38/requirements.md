# HELIX-38: Requirements Specification

## 1. Problem Statement

The HELIX lexical analyzer (`src/lexer.c`) currently rejects standard arithmetic operators (`+`, `-`, `*`, `/`) and emits `TOKEN_ERROR` along with a `DIAG_LEXICAL_ERROR` diagnostic:
- `+`, `*`, and `/` fall through to the `default:` branch in `lexer_next_token()`, reporting `"Unrecognized character '%c'"` and returning `TOKEN_ERROR`.
- A standalone `-` not followed by `>` explicitly reports `"Unsupported lone character '-' (did you mean '->'?)"` and returns `TOKEN_ERROR`.

As a result, clinical rules and expressions containing arithmetic operations such as:
```helix
let severe_threshold = 250 + 3
```
or
```helix
let A := (B + 3) * G / 24
```
fail during lexical analysis with `TOKEN_ERROR`.

## 2. Scope and Non-Goals

### In Scope
- Define distinct `TokenType` enum values for `+` (`TOKEN_PLUS`), `-` (`TOKEN_MINUS`), `*` (`TOKEN_STAR`), and `/` (`TOKEN_SLASH`) in `include/token.h`.
- Implement token name (`token_type_name`) and description (`token_type_description`) mappings in `src/token.c`.
- Update `lexer_next_token()` in `src/lexer.c` to recognize `+`, `-`, `*`, and `/` as valid operator tokens while preserving `->` (`TOKEN_ARROW`) maximal-munch recognition.
- Update operator token classification in `gui/server.c` (`token_kind`) and `gui/web/src/lib/highlighter.js` if applicable, to maintain consistency with `TokenType`.
- Document parser interaction and current expression grammar limitations in `src/parser.c` (do not invent unapproved arithmetic grammar rules).
- Add comprehensive unit and regression tests in `tests/test_runner.c` covering all required operator cases and edge cases.

### Non-Goals / Out of Scope
- Rewriting or extending the recursive descent expression parser (`src/parser.c`) with new arithmetic precedence/associativity grammar tiers (unless separately specified and approved).
- Introducing compound assignment operators (`+=`, `-=`, `*=`, `/=`) or increment/decrement operators (`++`, `--`).
- Changing comment syntax (`#` is the sole comment delimiter in HELIX; `//` and `/* */` are not part of the language specification).
- Modifying `:=` (`TOKEN_ASSIGN`) or `=` (`TOKEN_EQUAL`) behavior, both of which are already supported in the specification and lexer.

## 3. Investigation of `:=` vs. `=` in Language Specification

Per `docs/grammar.md` (Section 2.1 & Section 3.5) and `docs/token_reference.md` (Section 4):
- Both `:=` (`TOKEN_ASSIGN`) and `=` (`TOKEN_EQUAL`) are **already valid** in the HELIX language specification and implemented in `src/lexer.c` (lines 240–252) and `src/parser.c` (`parse_let_decl`, line 397: `let_decl = "let" , IDENTIFIER , ( ":=" | "=" ) , expression ;`).
- Therefore, both `let severe_threshold = 250 + 3` and `let A := (B + 3) * G / 24` use valid assignment operators according to the existing language specification.

## 4. Functional Requirements

- **FR-1:** The lexer shall recognize `+` and emit `TOKEN_PLUS` with lexeme `"+"` and exact 1-based line and column coordinates.
- **FR-2:** The lexer shall recognize `-` (when not immediately followed by `>`) and emit `TOKEN_MINUS` with lexeme `"-"` and exact 1-based line and column coordinates. When `-` is immediately followed by `>`, maximal munch shall continue to emit `TOKEN_ARROW` (`"->"`).
- **FR-3:** The lexer shall recognize `*` and emit `TOKEN_STAR` with lexeme `"*"` and exact 1-based line and column coordinates.
- **FR-4:** The lexer shall recognize `/` and emit `TOKEN_SLASH` with lexeme `"/"` and exact 1-based line and column coordinates.
- **FR-5:** `token_type_name()` and `token_type_description()` shall return human-readable names and descriptions for `TOKEN_PLUS`, `TOKEN_MINUS`, `TOKEN_STAR`, and `TOKEN_SLASH`.
- **FR-6:** No `TOKEN_ERROR` or `DIAG_LEXICAL_ERROR` shall be emitted for `+`, `-`, `*`, or `/`.

## 5. Compatibility Requirements

- **CR-1:** Existing operators (`:=`, `=`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `->`) must remain unchanged.
- **CR-2:** Existing delimiters (`:`, `.`, `,`, `(`, `)`, `[`, `]`), keywords (21 reserved words), identifiers, numeric literals (`TOKEN_INT_LIT`, `TOKEN_FLOAT_LIT`), and string literals (`TOKEN_STRING_LIT`) must remain unchanged.
- **CR-3:** Single-line `#` comments containing `+`, `-`, `*`, `/` or adjacent to `/` must continue to be skipped until end-of-line or EOF.
- **CR-4:** Existing lexical error detection (unrecognized characters like `@`, `$`, lone `!`, malformed numbers, unterminated strings) must remain intact.

## 6. Acceptance Criteria

1. `let severe_threshold = 250 + 3` tokenizes into `TOKEN_KW_LET`, `TOKEN_IDENTIFIER` (`severe_threshold`), `TOKEN_EQUAL` (`=`), `TOKEN_INT_LIT` (`250`), `TOKEN_PLUS` (`+`), `TOKEN_INT_LIT` (`3`), `TOKEN_EOF` with `0` lexical errors.
2. `let A := (B + 3) * G / 24` tokenizes into `TOKEN_KW_LET`, `TOKEN_IDENTIFIER` (`A`), `TOKEN_ASSIGN` (`:=`), `TOKEN_LPAREN` (`(`), `TOKEN_IDENTIFIER` (`B`), `TOKEN_PLUS` (`+`), `TOKEN_INT_LIT` (`3`), `TOKEN_RPAREN` (`)`), `TOKEN_STAR` (`*`), `TOKEN_IDENTIFIER` (`G`), `TOKEN_SLASH` (`/`), `TOKEN_INT_LIT` (`24`), `TOKEN_EOF` with `0` lexical errors.
3. All test matrix cases in Section 6 of the ticket pass automated verification via `make test`.
4. Project compiles cleanly under `-std=c11 -Wall -Wextra -Wpedantic` with zero warnings.
