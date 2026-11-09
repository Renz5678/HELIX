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

### 2.5 Temporal Qualifiers, Duration Units, and Latest Observation Queries
- **Analysis:** Temporal windows are expressed using `within` (e.g. `within 24 hours`, `within 30 minutes`, `within 24 hours before now`, `within "24h"`). Latest-matching-record queries combine `latest <type>` with filter conditions and temporal windows.
- **Decision:**
  - `duration_expr` requires numeric literals to be followed by a valid time unit identifier (e.g., `hours`, `minutes`, `days`, `s`) or a string literal (e.g., `"24h"`).
  - `within_clause` accepts an optional temporal reference suffix `"before" "now"`.
  - `latest_query` expresses queries over observation records (`latest <observation_type> where <condition> within <duration> [before now]`), supported both as an expression and directly within rule blocks.

### 2.6 Explicit Block-Specific Terminators (`end rule`, `end bind`, `end when`)
- **Analysis:** Earlier documentation and parser drafts had an inconsistency where documentation illustrated explicit block-specific terminators (such as `end bind`, `end when`, `end rule`), while older parser implementations accepted a generic standalone `end`.
- **Decision:**
  - `end rule` closes a rule block.
  - `end bind` closes a binding block.
  - `end when` closes a conditional block.
  - A standalone `end` is not a valid complete block terminator.
  - Mismatched block terminators (e.g. `end rule` closing a `bind` block) produce a syntax error.

### 2.7 Source and Terminology Concept Mapping (`->`, `[...]`, `(...)`)
- **Analysis:** The language proposal (Page 3, §4.1, and §11) links local clinical concept names to external terminology systems using `->` and square brackets, allowing one or more mappings under a single `terminology` header (e.g., `terminology potassium -> LOINC["serum potassium"]`), and declares data interfaces via `source : FHIR_R4`. Existing repository examples and Studio fixtures also use direct terminology system declarations with parentheses (e.g., `terminology: LOINC("2339-0")` and `source: EHR -> FHIR_R4`).
- **Decision:**
  - `source_decl` accepts `source [:] IDENTIFIER [ "->" IDENTIFIER ] [ "(" [ argument_list ] ")" ]`, supporting both `source : FHIR_R4` and `source: EHR -> FHIR_R4`.
  - `terminology_decl` accepts both:
    1. **Concept-to-terminology mappings:** one or more `IDENTIFIER "->" terminology_ref` entries under `terminology [:]` (e.g., `terminology potassium -> LOINC["serum potassium"]`), where `terminology_ref` accepts bracketed (`SYSTEM[expression]`) or parenthesized (`SYSTEM([argument_list])`) selectors. In free-field layout, additional mappings under the same `terminology` header are consumed using two-token lookahead (`IDENTIFIER` followed by `->`).
    2. **Direct terminology declarations:** `terminology [:] terminology_ref [ STRING_LITERAL ]` (e.g., `terminology: LOINC("2339-0")` or `terminology: LOINC["2339-0"]`).

### 2.8 Targeted Repeat Suppression
- `suppress repeat_of : HighGlucoseAlert within 4 hours` names the rule whose repeated notifications are suppressed. The `within` clause is optional.
- `repeat_of` is contextual only when followed by `:` in a suppression statement; it remains an identifier elsewhere, preserving the 21 reserved words and existing suppression forms.
- The parser validates syntax, not rule-name resolution or notification delivery. The timeline remains a preview of one rule's suppression window.

### 2.9 Event Triggers, `for` Binding, Alert Level and Terminology Mappings (HELIX-22)
- **Analysis:** The proposal's `Hyperkalemia_Alert` example uses `when Observation.created` (no `then`), `for patient : P`, `alert level : interruptive`, and several `name -> SYSTEM["term"]` mappings under one `terminology` header inside a `bind site ... end bind` block.
- **Decision:**
  - `when <Name>.<member>` followed directly by another rule element or `end` is an event trigger. A `when` condition without `then` that is not of this shape is still a syntax error.
  - `for <name> [:] <Type>` is a rule element.
  - `level` is a contextual identifier (not a 22nd keyword). `alert level : <name | "text">` sets the alert level; any other `alert` operand is an expression as before.
  - `terminology` accepts either the old `SYSTEM [ (args) ] [ "text" ]` form or one or more `name -> postfix_expr` mappings.
  - `bind site <name>` opens a block that closes with `end bind` and may contain `source`, `terminology` and `site` declarations.

### 2.10 Arithmetic Expressions and Precedence
- Arithmetic operators `+`, `-`, `*`, `/` and unary negation `-` (e.g., `-1`, `-B`) are supported in expressions per the language proposal.
- Precedence follows conventional mathematical hierarchy: unary `-` (right-associative) binds tighter than multiplicative `*`, `/` (left-associative), which bind tighter than additive `+`, `-` (left-associative), which bind tighter than relational comparisons.

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
  `+` (addition), `-` (subtraction), `*` (multiplication), `/` (division),
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
                     | event_trigger
                     | for_decl
                     | action_stmt
                     | latest_query ;

(* Declarations *)
intent_decl          = "intent" , [ ":" ] , STRING_LITERAL ;

schedule_decl        = "schedule" , [ ":" ] , ( STRING_LITERAL | IDENTIFIER | duration_expr ) ;

terminology_decl     = "terminology" , [ ":" ] ,
                       ( terminology_mapping , { terminology_mapping }
                       | terminology_ref , [ STRING_LITERAL ] ) ;

terminology_mapping  = IDENTIFIER , "->" , terminology_ref ;

terminology_ref      = IDENTIFIER ,
                       [ "(" , [ argument_list ] , ")"
                       | "[" , expression , "]" ] ;

site_decl            = "site" , [ ":" ] , ( IDENTIFIER | STRING_LITERAL ) ;

source_decl          = "source" , [ ":" ] , IDENTIFIER , [ "->" , IDENTIFIER ] , [ "(" , [ argument_list ] , ")" ] ;

bind_decl            = "bind" , IDENTIFIER , [ ":=" | "=" | ":" | "->" ] , postfix_expr , [ where_clause ] , [ within_clause ] , "end" , "bind"
                     | "bind" , site_decl , { source_decl | terminology_decl | site_decl } , "end" , "bind" ;

for_decl             = "for" , IDENTIFIER , [ ":" ] , IDENTIFIER ;

event_trigger        = "when" , IDENTIFIER , "." , member_name , { "." , member_name } ;
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

alert_stmt           = "alert" , [ ":" ] , ( alert_level | expression , { "," , expression } ) ;

alert_level          = "level" , ":" , ( IDENTIFIER | STRING_LITERAL ) ;

suppress_stmt        = "suppress" , [ ":" ] ,
                       ( repeat_suppression | within_clause | duration_expr | IDENTIFIER | STRING_LITERAL ) ;

repeat_suppression   = "repeat_of" , ":" , IDENTIFIER , [ within_clause ] ;

(* Expressions & Operator Precedence *)
(* Precedence: (lowest) or -> and -> not -> comparison -> additive -> multiplicative -> unary_minus -> postfix -> primary (highest) *)

expression           = or_expr ;

or_expr              = and_expr , { "or" , and_expr } ;

and_expr             = unary_expr , { "and" , unary_expr } ;

unary_expr           = "not" , unary_expr
                     | comparison_expr ;

comparison_expr      = add_expr , [ comp_op , add_expr ] , [ where_clause ] , [ within_clause ] ;

comp_op              = "==" | "!=" | ">" | "<" | ">=" | "<=" | "=" ;

add_expr             = mul_expr , { ( "+" | "-" ) , mul_expr } ;

mul_expr             = neg_expr , { ( "*" | "/" ) , neg_expr } ;

neg_expr             = "-" , neg_expr
                     | postfix_expr ;

where_clause         = "where" , expression ;

within_clause        = "within" , duration_expr , [ "before" , "now" ] ;

duration_expr        = ( INT_LITERAL | FLOAT_LITERAL ) , IDENTIFIER
                     | STRING_LITERAL ;

latest_query         = "latest" , IDENTIFIER , where_clause , within_clause ;

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
                     | latest_query
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
