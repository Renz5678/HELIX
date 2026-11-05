# HELIX Formal Grammar Specification (EBNF)

## 1. Overview & Document Purpose

This document provides the formal context-free grammar and lexical specification for **HELIX (Health Event Logic Interchange eXpression)**, a domain-specific language designed for expressing clinical event detection and alerting rules.

This specification serves as the formal foundation for the handwritten ISO C11 lexical analyzer and recursive descent syntax validator.

---

## 2. Inconsistency Analysis & Specification Decisions

The initial HELIX language documentation contains several drafting ambiguities and illustrative divergences from formal definitions. This section explicitly documents every decision made to yield a minimal, unambiguous, and internally consistent grammar.

### 2.1 Assignment Operators (`:=` vs. `=`)
- **Analysis:** Certain specification examples use `:=` (e.g., in `let` expressions: `let max_val := 150`), while other sections illustrate bindings with `=` or `:` (e.g., `let max_val = 150`, `bind glucose_data = ...`). In comparisons, `=` or `==` are sometimes mixed.
- **Decision:**
  - Token `TOKEN_ASSIGN` (`:=`) is recognized as the standard assignment operator for `let` variable definitions and bindings.
  - Token `TOKEN_EQUAL` (`=`) is also accepted in `let` definitions and binding declarations for backward compatibility with alternate examples, but in expression contexts where comparison is performed, standard comparison operators (`==`, `!=`, `<`, `<=`, `>`, `>=`) are used, with single `=` permitted as an equality comparison alias in condition expressions to prevent premature syntax rejection.

### 2.2 Formal Reserved Words vs. Illustrative Keywords (`if`, `conclude`, `log`)
- **Analysis:** The formal HELIX reserved word list explicitly specifies 21 keywords:
  ```text
  rule, intent, bind, site, source, terminology, schedule,
  when, for, let, latest, where, and, or, not,
  within, then, alert, suppress, otherwise, end
  ```
  However, non-normative code snippets occasionally feature keywords such as `if`, `conclude`, or `log`.
- **Decision:**
  - The formal 21-keyword list is strictly enforced as the core language reserved words.
  - `if`, `conclude`, and `log` are not treated as core reserved words. They lex as valid `IDENTIFIER` tokens. The core conditional statement in HELIX is `when ... then ... [otherwise ...]`. This preserves the 21-keyword lexical definition without introducing ad-hoc reserved words.

### 2.3 Declaration Delimiters (Optional Colons)
- **Analysis:** Examples vary between `rule RuleName:`, `intent "..."`, `intent: "..."`, `schedule: "..."`, `alert: "..."`, etc.
- **Decision:**
  - Colons (`:`) following declaration headers (`rule <Name>`, `intent`, `schedule`, `terminology`, `site`, `source`, `when ...`, `then`, `otherwise`, `alert`, `suppress`) are treated as optional in the grammar.
  - This guarantees that both idiomatic styles (with or without colons) parse cleanly without syntax errors.

### 2.4 Property Access on Reserved Words (`.latest`)
- **Analysis:** `latest` is a reserved word (e.g. `glucose_data.latest`), but standard lexical analyzers tokenize `latest` as `TOKEN_KW_LATEST`. If the grammar only allows `IDENTIFIER` after `.`, `glucose_data.latest` would produce a syntax error.
- **Decision:**
  - The member access grammar rule explicitly permits contextual keywords (such as `latest`, `source`, `site`, `schedule`, `terminology`) following `.` in postfix expressions:
    ```ebnf
    member_name = IDENTIFIER | "latest" | "source" | "site" | "schedule" | "terminology" ;
    ```
  - This avoids lexical state tricks and keeps the scanner purely context-free and deterministic.

### 2.5 Temporal Qualifiers and Duration Units
- **Analysis:** Temporal windows are expressed using `within` (e.g. `within 24 hours`, `within 30m`, `within "24h"`).
- **Decision:**
  - The grammar specifies `duration_expr` as accepting numeric literals followed by optional identifier units (e.g., `24 hours`, `10 m`, `7 days`), single string literals (e.g., `"24h"`), or standalone identifiers.

### 2.6 Explicit Block-Specific Terminators (`end rule`, `end bind`, `end when`)
- **Analysis:** Earlier documentation and parser drafts had an inconsistency where documentation illustrated explicit block-specific terminators (such as `end bind`, `end when`, `end rule`), while older parser implementations accepted a generic standalone `end`.
- **Decision:**
  - `end rule` closes a rule block.
  - `end bind` closes a binding block.
  - `end when` closes a conditional block.
  - A standalone `end` is not a valid complete block terminator.
  - Mismatched block terminators (e.g. `end rule` closing a `bind` block) produce a syntax error.

---

## 3. Lexical Specification

### 3.1 Whitespace and Comments
- **Whitespace:** Space (`\x20`), horizontal tab (`\t`), carriage return (`\r`), and newline (`\n`) serve as token separators and are discarded outside of string literals.
- **Comments:** Single-line comments begin with `#` and continue to the end of the line (`\n` or EOF). Comments are skipped by the scanner while line and column counters are accurately updated.

### 3.2 Reserved Words (21 Keywords)
```text
rule        intent      bind        site        source
terminology schedule    when        for         let
latest      where       and         or          not
within      then        alert       suppress    otherwise
end
```

### 3.3 Identifiers
```ebnf
letter            = "A" .. "Z" | "a" .. "z" ;
digit             = "0" .. "9" ;
identifier_start  = letter | "_" ;
identifier_part   = letter | digit | "_" ;

identifier        = identifier_start , { identifier_part } ;
```

### 3.4 Literals
```ebnf
int_literal       = digit , { digit } ;
float_literal     = digit , { digit } , "." , digit , { digit } ;
string_char       = any_character_except_quote_or_newline | '\"' | '\\' ;
string_literal    = '"' , { string_char } , '"' ;
```

### 3.5 Operators and Delimiters
- **Multi-character Operators:**
  `:=` (assignment), `==` (equality), `!=` (inequality), `>=` (greater or equal), `<=` (less or equal), `->` (arrow/mapping).
- **Single-character Operators & Delimiters:**
  `=` (equal), `>` (greater than), `<` (less than),
  `:` (colon), `.` (dot), `,` (comma),
  `(` (left parenthesis), `)` (right parenthesis),
  `[` (left bracket), `]` (right bracket).

---

## 4. Formal Grammar in EBNF

```ebnf
(* ==========================================
   HELIX Grammar (Extended Backus-Naur Form)
   ========================================== *)

program              = rule_decl , { rule_decl } , EOF ;

rule_decl            = "rule" , IDENTIFIER , [ ":" ] ,
                       { rule_element } ,
                       "end" , "rule" ;

rule_element         = intent_decl
                     | schedule_decl
                     | terminology_decl
                     | site_decl
                     | source_decl
                     | bind_decl
                     | let_decl
                     | when_stmt
                     | action_stmt ;

(* Declarations *)
intent_decl          = "intent" , [ ":" ] , STRING_LITERAL ;

schedule_decl        = "schedule" , [ ":" ] , ( STRING_LITERAL | IDENTIFIER | duration_expr ) ;

terminology_decl     = "terminology" , [ ":" ] , IDENTIFIER , [ "(" , [ argument_list ] , ")" ] , [ STRING_LITERAL ] ;

site_decl            = "site" , [ ":" ] , ( IDENTIFIER | STRING_LITERAL ) ;

source_decl          = "source" , [ ":" ] , IDENTIFIER , [ "->" , IDENTIFIER ] , [ "(" , [ argument_list ] , ")" ] ;

bind_decl            = "bind" , IDENTIFIER , [ ":=" | "=" | ":" | "->" ] , postfix_expr , [ where_clause ] , [ within_clause ] , "end" , "bind" ;

let_decl             = "let" , IDENTIFIER , ( ":=" | "=" ) , expression ;

(* Conditional and Control Flow *)
when_stmt            = "when" , [ "for" , IDENTIFIER ] , expression ,
                       [ ":" ] , "then" , [ ":" ] ,
                       statement_in_branch , { statement_in_branch } ,
                       [ "otherwise" , [ ":" ] , statement_in_branch , { statement_in_branch } ] ,
                       "end" , "when" ;

statement_in_branch  = let_decl
                     | action_stmt
                     | when_stmt ;

(* Actions *)
action_stmt          = alert_stmt | suppress_stmt ;

alert_stmt           = "alert" , [ ":" ] , expression , { "," , expression } ;

suppress_stmt        = "suppress" , [ ":" ] , ( "within" , duration_expr | IDENTIFIER | STRING_LITERAL | duration_expr ) ;

(* Expressions & Operator Precedence *)
(* Precedence: (lowest) or -> and -> not -> comparison -> postfix -> primary (highest) *)

expression           = or_expr ;

or_expr              = and_expr , { "or" , and_expr } ;

and_expr             = unary_expr , { "and" , unary_expr } ;

unary_expr           = "not" , unary_expr
                     | comparison_expr ;

comparison_expr      = postfix_expr , [ comp_op , postfix_expr ] , [ where_clause ] , [ within_clause ] ;

comp_op              = "==" | "!=" | ">" | "<" | ">=" | "<=" | "=" ;

where_clause         = "where" , expression ;

within_clause        = "within" , duration_expr ;

duration_expr        = ( INT_LITERAL | FLOAT_LITERAL ) , [ IDENTIFIER ]
                     | STRING_LITERAL
                     | IDENTIFIER ;

postfix_expr         = primary_expr , { postfix_op } ;

postfix_op           = "." , member_name
                     | "[" , expression , "]"
                     | "(" , [ argument_list ] , ")"
                     | "->" , member_name ;

member_name          = IDENTIFIER
                     | "latest"
                     | "source"
                     | "site"
                     | "schedule"
                     | "terminology" ;

argument_list        = expression , { "," , expression } ;

primary_expr         = IDENTIFIER
                     | INT_LITERAL
                     | FLOAT_LITERAL
                     | STRING_LITERAL
                     | "latest"
                     | "(" , expression , ")" ;
```


## 5. Studio compatibility and evaluation

The native parser requires at least one rule, at least one statement in each
present then/otherwise branch, and an operand after suppress. Thus the executable
productions use `program = rule_decl, {rule_decl}, EOF`, and nonempty branch
sequences. `suppress within duration_expr` is accepted.

Newlines/indentation are whitespace, not block delimiters. Blocks are explicitly closed
with block-specific terminators: `end when` closes a when block, `end bind` closes a bind
declaration block, and `end rule` closes a rule block. AST construction uses the same
parsing functions and preserves this grouping.

The lexer retains the 21 keywords. Boolean values enter through typed tables; true
and false spellings are identifiers, not literal keywords. Accepted calls, indexes,
arrows, standalone latest, and when-for remain syntax-valid but are diagnosed as
unsupported executable expressions during semantic validation. Metadata arguments
are preserved. Compare docs/evaluation.md for the supported runtime subset.

A bind filter followed by within is normalized to one series query even if the
recursive expression parser captures within in the filter expression. A condition
window requires exactly one series reference. Windowing selects recent eligible
readings; it does not establish sustained abnormal observations.
