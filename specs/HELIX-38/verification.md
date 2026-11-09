# HELIX-38: Verification Plan

## 1. Test Matrix

| Test Case / Input | Expected Lexical Behavior | Expected Parser Behavior / Notes | Status |
|---|---|---|---|
| `1 + 2` | `TOKEN_INT_LIT("1")`, `TOKEN_PLUS("+")`, `TOKEN_INT_LIT("2")`, `TOKEN_EOF` (0 lexical errors) | N/A (expression snippet) | Passed |
| `5 - 3` | `TOKEN_INT_LIT("5")`, `TOKEN_MINUS("-")`, `TOKEN_INT_LIT("3")`, `TOKEN_EOF` (0 lexical errors) | N/A (expression snippet) | Passed |
| `4 * 2` | `TOKEN_INT_LIT("4")`, `TOKEN_STAR("*")`, `TOKEN_INT_LIT("2")`, `TOKEN_EOF` (0 lexical errors) | N/A (expression snippet) | Passed |
| `8 / 2` | `TOKEN_INT_LIT("8")`, `TOKEN_SLASH("/")`, `TOKEN_INT_LIT("2")`, `TOKEN_EOF` (0 lexical errors) | N/A (expression snippet) | Passed |
| `A+B` | `TOKEN_IDENTIFIER("A")`, `TOKEN_PLUS("+")`, `TOKEN_IDENTIFIER("B")`, `TOKEN_EOF` | Tokenized cleanly without spaces | Passed |
| `A + B` | `TOKEN_IDENTIFIER("A")`, `TOKEN_PLUS("+")`, `TOKEN_IDENTIFIER("B")`, `TOKEN_EOF` | Tokenized cleanly with spaces | Passed |
| `(A + B) * C` | `TOKEN_LPAREN`, `TOKEN_IDENTIFIER("A")`, `TOKEN_PLUS`, `TOKEN_IDENTIFIER("B")`, `TOKEN_RPAREN`, `TOKEN_STAR`, `TOKEN_IDENTIFIER("C")`, `TOKEN_EOF` | Operators and delimiters recognized | Passed |
| `A-5` | `TOKEN_IDENTIFIER("A")`, `TOKEN_MINUS("-")`, `TOKEN_INT_LIT("5")`, `TOKEN_EOF` | Minus token recognized | Passed |
| `A*-B` | `TOKEN_IDENTIFIER("A")`, `TOKEN_STAR("*")`, `TOKEN_MINUS("-")`, `TOKEN_IDENTIFIER("B")`, `TOKEN_EOF` | Correct lexical tokens; parser validity evaluated separately | Passed |
| `A / B + C * D` | `A`, `/`, `B`, `+`, `C`, `*`, `D`, `EOF` | All four arithmetic operators recognized | Passed |
| `A = 10` | `TOKEN_IDENTIFIER("A")`, `TOKEN_EQUAL("=")`, `TOKEN_INT_LIT("10")`, `TOKEN_EOF` | Existing `=` assignment preserved | Passed |
| `let severe_threshold = 250 + 3` | `let`, `severe_threshold`, `=`, `250`, `+`, `3`, `EOF` (0 lexical errors) | Jira example 1 | Passed |
| `let A := (B + 3) * G / 24` | `let`, `A`, `:=`, `(`, `B`, `+`, `3`, `)`, `*`, `G`, `/`, `24`, `EOF` (0 lexical errors) | Jira example 2 (`:=` is valid per spec) | Passed |
| `+-*/ -- ++ // /* */` | Sequence of `TOKEN_PLUS`, `TOKEN_MINUS`, `TOKEN_STAR`, `TOKEN_SLASH` tokens (0 lexical errors) | Multiple consecutive operators | Passed |
| `a -> b - c` | `TOKEN_IDENTIFIER("a")`, `TOKEN_ARROW("->")`, `TOKEN_IDENTIFIER("b")`, `TOKEN_MINUS("-")`, `TOKEN_IDENTIFIER("c")`, `TOKEN_EOF` | Compound `->` vs `-` disambiguation | Passed |
| `8 / 2 # + - * / comment` | `TOKEN_INT_LIT("8")`, `TOKEN_SLASH("/")`, `TOKEN_INT_LIT("2")`, `TOKEN_EOF` | Comments containing operator chars and `/` adjacent to `#` | Passed |
| `1 +` / `5 -` / `4 *` / `8 /` | Operator at EOF boundary followed by `TOKEN_EOF` | End-of-file boundary safety | Passed |
| `let x := 10 @ 5 $ 2 ! 3` | Emits `TOKEN_ERROR` for `@`, `$`, and lone `!` | Invalid characters still rejected | Passed |

## 2. Test Execution Results

Automated test runner output via `make test`:
```text
========================================
 HELIX Test Suite (Automated Verification)
========================================

Running test: Unit: Keywords Lookup                        [PASS]
Running test: Unit: Lexer Basic Scanning                   [PASS]
Running test: Unit: Lexer Operators and Locations          [PASS]
Running test: Unit: Lexer Error Detection                  [PASS]
Running test: Unit: Parser Minimal Rule                    [PASS]
Running test: Unit: Parser Boolean Precedence              [PASS]
Running test: Unit: Diagnostic Message Content             [PASS]
Running test: Unit: Parser Diagnostic Content              [PASS]
Running test: Unit: CRLF Position Tracking                 [PASS]
Running test: Unit: Exhaustive ASCII Sweep                 [PASS]
Running test: HELIX-38: Basic Arithmetic Operators         [PASS]
Running test: HELIX-38: Spacing and Expressions            [PASS]
Running test: HELIX-38: Jira Reproduction Snippets         [PASS]
Running test: HELIX-38: Edge Cases and Invariants          [PASS]
Running test: Fixture: examples/basic_rule.helix           [PASS]
Running test: Fixture: examples/temporal_rule.helix        [PASS]
Running test: Fixture: examples/alert_rule.helix           [PASS]
Running test: Fixture: tests/parser/test_minimal.helix     [PASS]
Running test: Fixture: tests/parser/test_multiple_rules.helix[PASS]
Running test: Negative: Unterminated string                [PASS]
Running test: Negative: Illegal characters (@, $)          [PASS]
Running test: Negative: Malformed numbers                  [PASS]
Running test: Negative: Missing rule name                  [PASS]
Running test: Negative: Missing rule end                   [PASS]
Running test: Negative: Missing expression                 [PASS]

========================================
 Results: 25/25 tests passed (0 failed)
========================================
```

## 3. Remaining Limitations

1. **Parser Arithmetic Expression Grammar:**
   The HELIX parser (`src/parser.c`) and formal EBNF specification (`docs/grammar.md`) currently only define boolean (`or`, `and`, `not`), comparison (`==`, `!=`, `<`, `<=`, `>`, `>=`, `=`), postfix (`.`, `->`, `[]`, `()`), and primary expressions. They do not yet define additive (`+`, `-`), multiplicative (`*`, `/`), or unary negation (`-`) grammar productions. Per ticket scope restrictions, no unapproved parser expression grammar rules are added in HELIX-38.
