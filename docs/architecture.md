# HELIX Studio architecture

The browser runs a locally bundled Monaco editor, React shell, and typed Data
Playground. A dedicated module worker owns one Emscripten engine instance. It
serializes calls and coalesces queued analysis requests. Source/data revisions
prevent stale results from replacing a newer workspace snapshot.

The shared ISO C11 pipeline is source -> DFA lexer -> recursive descent parser ->
ordered AST -> semantic validation -> typed tables and bindings -> per-patient
evaluation -> owned JSON output. `parser_parse` and `parser_build_ast` use the same
parsing functions. Ordered grammar nodes retain token ranges, grouping, metadata,
and branch structure; `AstProgram` owns copied tokens and all nodes. Calls/indexes
and other historical forms are retained in the tree even when runtime execution
is unsupported.

DataStore owns a bounded JSON tree and schema views into it. Values are validated
in C before execution. Binding resolution never falls back to an arbitrary table.
Patient environments are independent; branch variables are scoped. Selection
filters by patient, timestamp eligibility, row predicate, and intersected windows
before selecting the latest reading. Literal/source-span strings are cached with a
request-wide cap to avoid allocations proportional to rows times literal size.

C APIs borrow input strings and return allocated JSON strings. JS preserves the
numeric result pointer, copies it to a JS string, parses JSON, and releases result
and input allocations in finally blocks. Partial trees, tables and diagnostics have
explicit destructors. Allocation failures propagate across nested serializers;
no successful response is built from a partial writer. UTF-8 and finite numeric
boundaries are validated before output.

Read docs/api.md and docs/evaluation.md for the versioned contract and runtime
rules. Native/WASM parity compares the complete JSON output for all five presets.
The native compatibility suite, explicit AST/value/JSON tests, repeated API memory
checks, allocation-failure injection, and real-browser tests cover distinct layers.

The older analyzer architecture is retained below as historical module context.
Its references to tests or guarantees describe the original analyzer only.

---

# HELIX Analyzer Architecture

## 1. Architectural Overview

The HELIX analyzer is organized as a clean, decoupled compiler front-end pipeline written in strict ISO C11. It consists of six core modules:

```text
               +----------------------------------------+
               |               main.c                   |
               | (CLI coordinator, argument dispatcher) |
               +-------------------+--------------------+
                                   |
                                   v
                      +--------------------------+
                      |   source.h / source.c    |
                      | (Source buffer manager)  |
                      +------------+-------------+
                                   |
                                   v
+------------------------+   +--------------------------+
| keywords.h/keywords.c  |-->|    lexer.h / lexer.c     |
| (Reserved word lookup) |   | (DFA character scanner)  |
+------------------------+   +-------------+------------+
                                           |
                                           v
                             +--------------------------+
                             |    token.h / token.c     |
                             | (Token structures & list)|
                             +-------------+------------+
                                           |
                                           v
                             +--------------------------+   +--------------------------+
                             |   parser.h / parser.c    |-->| diagnostic.h/diagnostic.c|
                             | (Recursive descent engine|   | (Unified error reporter) |
                             +--------------------------+   +--------------------------+
```

---

## 2. Module Responsibilities & Interfaces

### 2.1 `source` (`include/source.h`, `src/source.c`)
- **Responsibility:** Manages reading source files into continuous, null-terminated memory buffers.
- **Line Slicing:** Provides `source_get_line()` to slice out exact source lines for visual caret (`^`) diagnostic messages.
- **Ownership:** Owns the loaded file buffer. Cleaned up deterministically via `source_free()`.

### 2.2 `diagnostic` (`include/diagnostic.h`, `src/diagnostic.c`)
- **Responsibility:** Centralized error formatting and tallying for both lexical and syntax errors.
- **Visual Diagnostics:** Formats standard compiler diagnostics:
  ```text
  file:line:col: Category: Message
      line content here
               ^
  ```
- **Error Counters:** Tracks `lexical_errors` and `syntax_errors` counts to drive CLI exit codes and summary statistics.

### 2.3 `token` (`include/token.h`, `src/token.c`)
- **Responsibility:** Defines the `TokenType` enumeration, the `Token` structure (type, owned heap string `lexeme`, 1-indexed `line`, 1-indexed `column`), and dynamic `TokenList`.
- **Memory Invariant:** Every token allocates its own lexeme copy via `token_create()`. `token_list_free()` completely deallocates the token array and all token lexemes without memory leaks.

### 2.4 `keywords` (`include/keywords.h`, `src/keywords.c`)
- **Responsibility:** Maps identifier strings to the 21 formal HELIX reserved word tokens via binary search or direct lookup table.
- **Context-Free:** Distinguishes keywords from generic identifiers strictly based on text matching.

### 2.5 `lexer` (`include/lexer.h`, `src/lexer.c`)
- **Responsibility:** Handwritten Deterministic Finite Automaton (DFA) scanner implementing maximal munch.
- **Capabilities:**
  - Robust line and column tracking across tabs and newlines.
  - Skips `#` single-line comments.
  - Detects multi-character operators (`:=`, `==`, `!=`, `>=`, `<=`, `->`) before single characters.
  - Recognizes numbers (`123`, `123.456`) and strings (`"hello\"world"`).
  - Reports lexical errors (illegal characters, unclosed strings, malformed numbers) via `DiagnosticEngine` and always makes forward progress (no infinite loops).

### 2.6 `parser` (`include/parser.h`, `src/parser.c`)
- **Responsibility:** Handwritten recursive descent parser enforcing the formal HELIX context-free grammar.
- **Expression Precedence:** Enforces `not > and > or` using structured function descent:
  - `parse_expression()`
  - `parse_or_expr()`
  - `parse_and_expr()`
  - `parse_unary_expr()`
  - `parse_comparison_expr()`
  - `parse_postfix_expr()`
  - `parse_primary_expr()`
- **Error Recovery:** Implements panic-mode recovery. When a syntax error occurs, `panic_mode` suppresses cascaded error output until a synchronization token (`rule`, `end`, `when`, `then`, `let`, `bind`, etc.) is reached.

---

## 3. Data Flow & Memory Management Rules

1. `main` loads the input file into `SourceBuffer`.
2. `lexer_tokenize` creates a `TokenList` containing all recognized tokens from the buffer.
3. If `--tokens` is requested, the tokens are printed in tabular format.
4. If `--check` is requested (or default), `parser_parse` runs on the `TokenList`.
5. All allocated memory (`SourceBuffer`, `TokenList`) is cleanly deallocated before exit.
6. AddressSanitizer and UndefinedBehaviorSanitizer are used during testing to guarantee zero memory leaks and safety compliance.
