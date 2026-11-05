# HELIX Token Reference

This document catalogs all lexical tokens recognized by the HELIX lexical analyzer, including their categories, token enumeration names, patterns, and usage examples.

---

## 1. Reserved Words (21 Keywords)

Reserved words are case-sensitive and must be written in lowercase.

| Token Type Enum | Keyword Lexeme | Description / Category | Example |
| :--- | :--- | :--- | :--- |
| `TOKEN_KW_RULE` | `rule` | Rule declaration header | `rule HighGlucoseAlert:` |
| `TOKEN_KW_INTENT` | `intent` | Clinical objective / rationale | `intent: "Detect acute hyperglycemia"` |
| `TOKEN_KW_BIND` | `bind` | Data source binding | `bind glucose_data = Labs.glucose` |
| `TOKEN_KW_SITE` | `site` | Clinical care setting / department | `site: ICU` |
| `TOKEN_KW_SOURCE` | `source` | External system or feed | `source: EHR -> FHIR_R4` |
| `TOKEN_KW_TERMINOLOGY` | `terminology` | Code systems (SNOMED, LOINC) | `terminology: LOINC("2339-0")` |
| `TOKEN_KW_SCHEDULE` | `schedule` | Evaluation cadence / trigger | `schedule: "every 15m"` |
| `TOKEN_KW_WHEN` | `when` | Condition evaluation trigger | `when glucose_data.latest > 180` |
| `TOKEN_KW_FOR` | `for` | Subject binding in condition | `when for patient glucose_data.latest > 180` |
| `TOKEN_KW_LET` | `let` | Intermediate variable definition | `let threshold := 180` |
| `TOKEN_KW_LATEST` | `latest` | Most recent reading or value | `glucose_data.latest` |
| `TOKEN_KW_WHERE` | `where` | Filter expression | `where status == "final"` |
| `TOKEN_KW_AND` | `and` | Logical conjunction | `a > 10 and b < 20` |
| `TOKEN_KW_OR` | `or` | Logical disjunction | `a > 10 or b < 20` |
| `TOKEN_KW_NOT` | `not` | Logical negation | `not patient.discharged` |
| `TOKEN_KW_WITHIN` | `within` | Temporal window filter | `within 24 hours` |
| `TOKEN_KW_THEN` | `then` | Consequence block introducer | `then alert: "High glucose"` |
| `TOKEN_KW_ALERT` | `alert` | Alert action statement | `alert: "Severe Hyperglycemia", "CRITICAL"` |
| `TOKEN_KW_SUPPRESS` | `suppress` | Alert suppression statement | `suppress: within 6 hours` |
| `TOKEN_KW_OTHERWISE`| `otherwise` | Alternative branch in `when` | `otherwise let status := "normal"` |
| `TOKEN_KW_END` | `end` | Block terminator keyword | `end rule`, `end bind`, `end when` |

---

## 2. Identifiers

| Token Type Enum | Pattern | Description | Examples |
| :--- | :--- | :--- | :--- |
| `TOKEN_IDENTIFIER` | `[a-zA-Z_][a-zA-Z0-9_]*` | Variable names, rule names, field names | `HighGlucoseAlert`, `glucose_data`, `_temp`, `patient` |

*Note: Any token matching the identifier pattern that matches an entry in the reserved-word table is classified as that keyword's specific token type.*

---

## 3. Literals

| Token Type Enum | Pattern | Description | Examples |
| :--- | :--- | :--- | :--- |
| `TOKEN_INT_LIT` | `[0-9]+` | Non-negative integer decimal literal | `0`, `42`, `180` |
| `TOKEN_FLOAT_LIT` | `[0-9]+\.[0-9]+` | Standard floating-point literal | `0.5`, `37.2`, `98.6` |
| `TOKEN_STRING_LIT` | `"([^"\\\n]|\\.)*"` | Double-quoted string literal | `"High Glucose"`, `"LOINC:2339-0"` |

---

## 4. Operators

| Token Type Enum | Lexeme | Description | Precedence (in grammar) |
| :--- | :--- | :--- | :--- |
| `TOKEN_ASSIGN` | `:=` | Variable assignment operator | Statement level |
| `TOKEN_EQUAL` | `=` | Assignment / equality alias | Comparison / assignment |
| `TOKEN_EQ` | `==` | Equality comparison operator | Comparison level |
| `TOKEN_NEQ` | `!=` | Inequality comparison operator | Comparison level |
| `TOKEN_GT` | `>` | Greater-than comparison | Comparison level |
| `TOKEN_GTE` | `>=` | Greater-than-or-equal comparison | Comparison level |
| `TOKEN_LT` | `<` | Less-than comparison | Comparison level |
| `TOKEN_LTE` | `<=` | Less-than-or-equal comparison | Comparison level |
| `TOKEN_ARROW` | `->` | Directional source mapping operator | Postfix / declaration |

---

## 5. Delimiters and Punctuation

| Token Type Enum | Lexeme | Description |
| :--- | :--- | :--- |
| `TOKEN_COLON` | `:` | Declaration header delimiter (optional in grammar) |
| `TOKEN_DOT` | `.` | Member and property navigation operator |
| `TOKEN_COMMA` | `,` | Argument and element separator |
| `TOKEN_LPAREN` | `(` | Left grouping parenthesis |
| `TOKEN_RPAREN` | `)` | Right grouping parenthesis |
| `TOKEN_LBRACKET`| `[` | Left index / filter bracket |
| `TOKEN_RBRACKET`| `]` | Right index / filter bracket |

---

## 6. Special Tokens

| Token Type Enum | Description |
| :--- | :--- |
| `TOKEN_EOF` | End-of-file sentinel indicating completion of source input |
| `TOKEN_ERROR` | Error token produced when an illegal character or malformed literal is encountered |
