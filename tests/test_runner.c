#include <stdio.h>
#include <stdlib.h>
#include <stdbool.h>
#include <string.h>
#include <assert.h>
#include "source.h"
#include "diagnostic.h"
#include "token.h"
#include "keywords.h"
#include "lexer.h"
#include "parser.h"

static int g_tests_run = 0;
static int g_tests_passed = 0;

#define TEST_ASSERT(cond, msg) do { \
    if (!(cond)) { \
        printf("  [FAIL] %s:%d: %s\n", __FILE__, __LINE__, msg); \
        return false; \
    } \
} while (0)

static void run_test(const char *name, bool (*test_fn)(void)) {
    g_tests_run++;
    printf("Running test: %-45s", name);
    if (test_fn()) {
        printf("[PASS]\n");
        g_tests_passed++;
    } else {
        printf("[FAILED]\n");
    }
}

/* --- Unit Tests --- */

static bool test_keywords_lookup(void) {
    TokenType type;
    TEST_ASSERT(keywords_lookup("rule", &type) && type == TOKEN_KW_RULE, "keyword rule");
    TEST_ASSERT(keywords_lookup("when", &type) && type == TOKEN_KW_WHEN, "keyword when");
    TEST_ASSERT(keywords_lookup("then", &type) && type == TOKEN_KW_THEN, "keyword then");
    TEST_ASSERT(keywords_lookup("within", &type) && type == TOKEN_KW_WITHIN, "keyword within");
    TEST_ASSERT(keywords_lookup("otherwise", &type) && type == TOKEN_KW_OTHERWISE, "keyword otherwise");
    TEST_ASSERT(keywords_lookup("end", &type) && type == TOKEN_KW_END, "keyword end");

    /* Non-reserved identifiers */
    TEST_ASSERT(!keywords_lookup("if", &type), "'if' should not be a reserved keyword");
    TEST_ASSERT(!keywords_lookup("conclude", &type), "'conclude' should not be a reserved keyword");
    TEST_ASSERT(!keywords_lookup("log", &type), "'log' should not be a reserved keyword");
    TEST_ASSERT(!keywords_lookup("glucose_data", &type), "identifier glucose_data");
    return true;
}

static bool test_lexer_basic_tokens(void) {
    SourceBuffer src;
    source_from_string("test", "rule MyRule: let x := 42.5 # Comment\nend", &src);

    DiagnosticEngine diag;
    diag_init(&diag, &src, NULL);

    Lexer lexer;
    lexer_init(&lexer, &src, &diag);

    TokenList tokens;
    bool ok = lexer_tokenize_all(&lexer, &tokens);
    TEST_ASSERT(ok, "lexer tokenized string successfully");
    TEST_ASSERT(diag.lexical_errors == 0, "no lexical errors");

    /* Expected tokens: rule, MyRule, :, let, x, :=, 42.5, end, EOF */
    TEST_ASSERT(tokens.count == 9, "token count matches");
    TEST_ASSERT(tokens.items[0].type == TOKEN_KW_RULE, "token 0 is rule");
    TEST_ASSERT(tokens.items[1].type == TOKEN_IDENTIFIER, "token 1 is MyRule");
    TEST_ASSERT(tokens.items[2].type == TOKEN_COLON, "token 2 is :");
    TEST_ASSERT(tokens.items[3].type == TOKEN_KW_LET, "token 3 is let");
    TEST_ASSERT(tokens.items[4].type == TOKEN_IDENTIFIER, "token 4 is x");
    TEST_ASSERT(tokens.items[5].type == TOKEN_ASSIGN, "token 5 is :=");
    TEST_ASSERT(tokens.items[6].type == TOKEN_FLOAT_LIT, "token 6 is 42.5");
    TEST_ASSERT(tokens.items[7].type == TOKEN_KW_END, "token 7 is end");
    TEST_ASSERT(tokens.items[8].type == TOKEN_EOF, "token 8 is EOF");

    diag_free(&diag);
    token_list_free(&tokens);
    diag_free(&diag);
    source_free(&src);
    return true;
}

static bool test_lexer_operators_and_positions(void) {
    SourceBuffer src;
    source_from_string("ops", "== != <= >= -> := = < >", &src);

    DiagnosticEngine diag;
    diag_init(&diag, &src, NULL);

    Lexer lexer;
    lexer_init(&lexer, &src, &diag);

    TokenList tokens;
    lexer_tokenize_all(&lexer, &tokens);
    TEST_ASSERT(diag.lexical_errors == 0, "operators recognized cleanly");
    TEST_ASSERT(tokens.count == 10, "9 operators + 1 EOF");

    TEST_ASSERT(tokens.items[0].type == TOKEN_EQ, "==");
    TEST_ASSERT(tokens.items[1].type == TOKEN_NEQ, "!=");
    TEST_ASSERT(tokens.items[2].type == TOKEN_LTE, "<=");
    TEST_ASSERT(tokens.items[3].type == TOKEN_GTE, ">=");
    TEST_ASSERT(tokens.items[4].type == TOKEN_ARROW, "->");
    TEST_ASSERT(tokens.items[5].type == TOKEN_ASSIGN, ":=");
    TEST_ASSERT(tokens.items[6].type == TOKEN_EQUAL, "=");
    TEST_ASSERT(tokens.items[7].type == TOKEN_LT, "<");
    TEST_ASSERT(tokens.items[8].type == TOKEN_GT, ">");

    diag_free(&diag);
    token_list_free(&tokens);
    diag_free(&diag);
    source_free(&src);
    return true;
}

static bool test_lexer_error_detection(void) {
    SourceBuffer src;
    source_from_string("bad", "let $price := 10\n\"unterminated\nlet y := 12.3.4", &src);

    DiagnosticEngine diag;
    diag_init(&diag, &src, NULL);

    Lexer lexer;
    lexer_init(&lexer, &src, &diag);

    TokenList tokens;
    bool ok = lexer_tokenize_all(&lexer, &tokens);
    TEST_ASSERT(!ok, "lexer reports errors");
    TEST_ASSERT(diag.lexical_errors >= 3, "detected at least 3 lexical errors");

    diag_free(&diag);
    token_list_free(&tokens);
    diag_free(&diag);
    source_free(&src);
    return true;
}

static bool test_string_validation(const char *source, bool expect_valid) {
    SourceBuffer src;
    source_from_string("test_inline", source, &src);

    DiagnosticEngine diag;
    diag_init(&diag, &src, NULL);

    Lexer lexer;
    lexer_init(&lexer, &src, &diag);
    TokenList tokens;
    lexer_tokenize_all(&lexer, &tokens);

    Parser parser;
    parser_init(&parser, &tokens, &diag);
    parser_parse(&parser);

    bool is_valid = (diag.lexical_errors == 0 && diag.syntax_errors == 0);

    diag_free(&diag);
    token_list_free(&tokens);
    source_free(&src);

    return is_valid == expect_valid;
}

static bool test_parser_valid_minimal(void) {
    return test_string_validation("rule Minimal: end rule", true);
}

static bool test_parser_boolean_precedence(void) {
    return test_string_validation(
        "rule BoolPrecedence:\n"
        "    when not a and b or c then alert: \"OK\"\n"
        "    end when\n"
        "end rule\n", true);
}

/* HELIX-15: Block terminator test cases */
static bool test_parser_valid_bind(void) {
    return test_string_validation(
        "rule R:\n"
        "    bind g = Labs.glucose\n"
        "    end bind\n"
        "end rule\n", true);
}

static bool test_parser_valid_when(void) {
    return test_string_validation(
        "rule R:\n"
        "    when a > 1 then\n"
        "        alert: \"ok\"\n"
        "    end when\n"
        "end rule\n", true);
}

static bool test_parser_valid_nested(void) {
    return test_string_validation(
        "rule R:\n"
        "    bind g = Labs.glucose\n"
        "    end bind\n"
        "    when g.latest > 1 then\n"
        "        when g.latest > 2 then\n"
        "            alert: \"high\"\n"
        "        end when\n"
        "    otherwise:\n"
        "        suppress: within 1 hours\n"
        "    end when\n"
        "end rule\n", true);
}

static bool test_parser_invalid_standalone_end(void) {
    return test_string_validation(
        "rule R:\n"
        "    let x := 1\n"
        "end\n", false);
}

static bool test_parser_invalid_mismatched_bind(void) {
    return test_string_validation(
        "rule R:\n"
        "    bind g = Labs.glucose\n"
        "    end rule\n"
        "end rule\n", false);
}

static bool test_parser_invalid_mismatched_when(void) {
    return test_string_validation(
        "rule R:\n"
        "    when a > 1 then\n"
        "        alert: \"ok\"\n"
        "    end bind\n"
        "end rule\n", false);
}

static bool test_parser_invalid_unknown_descriptor(void) {
    return test_string_validation(
        "rule R:\n"
        "    let x := 1\n"
        "end unknown\n", false);
}

static bool test_parser_invalid_missing_descriptor(void) {
    return test_string_validation(
        "rule R:\n"
        "    when a > 1 then\n"
        "        alert: \"ok\"\n"
        "    end\n"
        "end rule\n", false);
}

static bool test_parser_invalid_missing_closing_at_eof(void) {
    return test_string_validation(
        "rule R:\n"
        "    when a > 1 then\n"
        "        alert: \"ok\"\n", false);
}

static bool test_parser_invalid_incorrect_nesting(void) {
    return test_string_validation(
        "rule R:\n"
        "    when a > 1 then\n"
        "        when b > 1 then\n"
        "            alert: \"ok\"\n"
        "        end rule\n"
        "    end when\n"
        "end when\n", false);
}

static bool test_parser_suppress_repeat_of(void) {
    const struct { const char *source; bool valid; } cases[] = {
        {"rule R: suppress repeat_of : HighGlucoseAlert end rule", true},
        {"rule R: suppress repeat_of:HighGlucoseAlert within 4 hours end rule", true},
        {"rule R: suppress: repeat_of : R within 1.5 hours end rule", true},
        {"rule R: when x then suppress repeat_of : R within 4 hours end when end rule", true},
        {"rule R: when x then alert: \"high\" otherwise suppress repeat_of : R end when end rule", true},
        {"rule R: when x then when y then suppress repeat_of : R end when otherwise alert: \"low\" end when end rule", true},
        {"rule R:\r\n suppress repeat_of # target follows\r\n : R within 4 hours\r\nend rule", true},
        {"rule A: suppress repeat_of : B end rule rule B: suppress repeat_of : A end rule", true},
        {"rule repeat_of: let repeat_of := 1 suppress repeat_of end rule", true},
        {"rule R: suppress: within 4 hours end rule", true},
        {"rule R: suppress \"reason\" end rule", true},
        {"rule R: suppress R end rule", true},
        {"rule R: suppress 4 hours end rule", true},
        {"rule R: suppress repeat_of : end rule", false},
        {"rule R: suppress repeat_of : \"R\" end rule", false},
        {"rule R: suppress repeat_of : 123 end rule", false},
        {"rule R: suppress repeat_of : when x then alert: \"bad\" end when end rule", false},
        {"rule R: suppress repeat_of : R within end rule", false},
        {"rule R: suppress repeat_of : R within : 4 hours end rule", false},
        {"rule R: suppress repeat_of : R : end rule", false},
        {"rule R: suppress repeat_of R end rule", false},
        {"rule R: suppress other : R end rule", false},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        SourceBuffer src;
        TEST_ASSERT(source_from_string("suppress", cases[i].source, &src), "source loaded");
        DiagnosticEngine diag;
        diag_init(&diag, &src, NULL);
        Lexer lexer;
        lexer_init(&lexer, &src, &diag);
        TokenList tokens;
        bool lexed = lexer_tokenize_all(&lexer, &tokens);
        Parser parser;
        parser_init(&parser, &tokens, &diag);
        bool parsed = parser_parse(&parser);
        bool correct = lexed && parsed == cases[i].valid &&
            (diag.syntax_errors == 0) == cases[i].valid;
        token_list_free(&tokens);
        diag_free(&diag);
        source_free(&src);
        if (!correct) printf("\n  Source: %s\n", cases[i].source);
        TEST_ASSERT(correct, "suppression syntax matches expected validity");
    }
    return true;
}

/* --- Diagnostic recording tests (structured messages & exact positions) --- */

static bool test_diag_lexical_message_content(void) {
    SourceBuffer src;
    source_from_string("msg", "let $price := 10", &src);

    DiagnosticEngine diag;
    diag_init(&diag, &src, NULL);

    Lexer lexer;
    lexer_init(&lexer, &src, &diag);
    TokenList tokens;
    lexer_tokenize_all(&lexer, &tokens);

    TEST_ASSERT(diag_entry_count(&diag) >= 1, "at least one recorded diagnostic");
    const DiagnosticEntry *e = diag_get_entry(&diag, 0);
    TEST_ASSERT(e->kind == DIAG_LEXICAL_ERROR, "entry kind is lexical error");
    TEST_ASSERT(e->line == 1 && e->column == 5, "error points at column 5 ('$')");
    TEST_ASSERT(strstr(e->message, "Unrecognized character") != NULL,
                "message names the failure");

    token_list_free(&tokens);
    diag_free(&diag);
    source_free(&src);
    return true;
}

static bool test_diag_syntax_message_content(void) {
    SourceBuffer src;
    source_from_string("msg", "rule let: end", &src);

    DiagnosticEngine diag;
    diag_init(&diag, &src, NULL);

    Lexer lexer;
    lexer_init(&lexer, &src, &diag);
    TokenList tokens;
    lexer_tokenize_all(&lexer, &tokens);

    Parser parser;
    parser_init(&parser, &tokens, &diag);
    parser_parse(&parser);

    TEST_ASSERT(diag.syntax_errors >= 1, "syntax error recorded");
    const DiagnosticEntry *e = diag_get_entry(&diag, 0);
    TEST_ASSERT(e->kind == DIAG_SYNTAX_ERROR, "entry kind is syntax error");
    TEST_ASSERT(e->line == 1 && e->column == 6, "error points at the keyword 'let'");
    TEST_ASSERT(strstr(e->message, "Expected rule name identifier") != NULL,
                "message names the expectation");

    token_list_free(&tokens);
    diag_free(&diag);
    source_free(&src);
    return true;
}

/* --- Position tracking across CRLF (Windows) line endings --- */

static bool test_crlf_position_tracking(void) {
    SourceBuffer src;
    source_from_string("crlf", "rule A:\r\n    let x := 1\r\nend\r\n", &src);

    DiagnosticEngine diag;
    diag_init(&diag, &src, NULL);

    Lexer lexer;
    lexer_init(&lexer, &src, &diag);
    TokenList tokens;
    bool ok = lexer_tokenize_all(&lexer, &tokens);

    TEST_ASSERT(ok, "no lexical errors on CRLF input");
    /* rule(1,1) A(1,6) :(1,7) let(2,5) x(2,9) :=(2,11) 1(2,14) end(3,1) EOF(4,1) */
    TEST_ASSERT(tokens.count == 9, "9 tokens incl EOF");
    TEST_ASSERT(tokens.items[3].type == TOKEN_KW_LET &&
                tokens.items[3].line == 2 && tokens.items[3].column == 5,
                "'let' located at line 2 column 5");
    TEST_ASSERT(tokens.items[7].type == TOKEN_KW_END &&
                tokens.items[7].line == 3 && tokens.items[7].column == 1,
                "'end' located at line 3 column 1");
    TEST_ASSERT(tokens.items[8].type == TOKEN_EOF &&
                tokens.items[8].line == 4 && tokens.items[8].column == 1,
                "EOF located at line 4 column 1");

    token_list_free(&tokens);
    diag_free(&diag);
    source_free(&src);
    return true;
}

/* --- Robustness: every single ASCII character must tokenize & terminate --- */

static bool is_expected_single(TokenType got, int c) {
    switch (c) {
        case ':':  return got == TOKEN_COLON;
        case '.':  return got == TOKEN_DOT;
        case ',':  return got == TOKEN_COMMA;
        case '(':  return got == TOKEN_LPAREN;
        case ')':  return got == TOKEN_RPAREN;
        case '[':  return got == TOKEN_LBRACKET;
        case ']':  return got == TOKEN_RBRACKET;
        case '+':  return got == TOKEN_PLUS;
        case '-':  return got == TOKEN_MINUS;
        case '*':  return got == TOKEN_STAR;
        case '/':  return got == TOKEN_SLASH;
        case '=':  return got == TOKEN_EQUAL;
        case '<':  return got == TOKEN_LT;
        case '>':  return got == TOKEN_GT;
        case 'a':  case 'Z': case '_': return got == TOKEN_IDENTIFIER;
        case '5':  return got == TOKEN_INT_LIT;
        case '#':  return got == TOKEN_EOF; /* comment swallows the rest */
        default:   return true;
    }
}

static bool test_exhaustive_single_char_sweep(void) {
    for (int c = 1; c < 128; c++) {
        char buf[2] = { (char)c, '\0' };
        SourceBuffer src;
        source_from_string("sweep", buf, &src);

        DiagnosticEngine diag;
        diag_init(&diag, &src, NULL);

        Lexer lexer;
        lexer_init(&lexer, &src, &diag);
        TokenList tokens;
        lexer_tokenize_all(&lexer, &tokens);

        TEST_ASSERT(tokens.count >= 1, "always yields at least EOF");
        TEST_ASSERT(tokens.count <= 2, "one char yields at most one token + EOF");
        TEST_ASSERT(tokens.items[tokens.count - 1].type == TOKEN_EOF, "EOF is last");
        TEST_ASSERT(is_expected_single(tokens.items[0].type, c),
                    "token type matches the known character classes");

        token_list_free(&tokens);
        diag_free(&diag);
        source_free(&src);
    }
    return true;
}

/* Helper to validate a file path */
static bool test_file_validation(const char *path, bool expect_valid) {
    SourceBuffer src;
    if (!source_load(path, &src)) {
        printf("Failed to load fixture %s\n", path);
        return false;
    }

    DiagnosticEngine diag;
    diag_init(&diag, &src, NULL);

    Lexer lexer;
    lexer_init(&lexer, &src, &diag);
    TokenList tokens;
    lexer_tokenize_all(&lexer, &tokens);

    Parser parser;
    parser_init(&parser, &tokens, &diag);
    parser_parse(&parser);

    bool is_valid = (diag.lexical_errors == 0 && diag.syntax_errors == 0);

    diag_free(&diag);
    token_list_free(&tokens);
    diag_free(&diag);
    source_free(&src);

    return is_valid == expect_valid;
}

static bool test_fixture_basic_rule(void) {
    return test_file_validation("examples/basic_rule.helix", true);
}

static bool test_fixture_temporal_rule(void) {
    return test_file_validation("examples/temporal_rule.helix", true);
}

static bool test_fixture_alert_rule(void) {
    return test_file_validation("examples/alert_rule.helix", true);
}

static bool test_fixture_minimal_rule(void) {
    return test_file_validation("tests/parser/test_minimal.helix", true);
}

static bool test_fixture_multiple_rules(void) {
    return test_file_validation("tests/parser/test_multiple_rules.helix", true);
}

static bool test_fixture_lex_unterminated_string(void) {
    return test_file_validation("tests/invalid/lex_unterminated_string.helix", false);
}

static bool test_fixture_lex_illegal_char(void) {
    return test_file_validation("tests/invalid/lex_illegal_char.helix", false);
}

static bool test_fixture_lex_bad_number(void) {
    return test_file_validation("tests/invalid/lex_bad_number.helix", false);
}

static bool test_fixture_syn_missing_rule_name(void) {
    return test_file_validation("tests/invalid/syn_missing_rule_name.helix", false);
}

static bool test_fixture_syn_missing_end(void) {
    return test_file_validation("tests/invalid/syn_missing_end.helix", false);
}

static bool test_fixture_syn_missing_expression(void) {
    return test_file_validation("tests/invalid/syn_missing_expression.helix", false);
}

/* --- HELIX-38 Unit Tests: Arithmetic Operators --- */

static bool check_tokens(const char *input, size_t expected_count, const TokenType *expected_types, const char **expected_lexemes) {
    SourceBuffer src;
    source_from_string("h38_test", input, &src);

    DiagnosticEngine diag;
    diag_init(&diag, &src, NULL);

    Lexer lexer;
    lexer_init(&lexer, &src, &diag);

    TokenList tokens;
    bool ok = lexer_tokenize_all(&lexer, &tokens);

    TEST_ASSERT(ok, "lexer tokenized cleanly without errors");
    TEST_ASSERT(diag.lexical_errors == 0, "zero lexical errors");
    TEST_ASSERT(tokens.count == expected_count, "token count matches expected");

    for (size_t i = 0; i < expected_count; i++) {
        TEST_ASSERT(tokens.items[i].type == expected_types[i], "token type matches");
        if (expected_lexemes && expected_lexemes[i]) {
            TEST_ASSERT(strcmp(tokens.items[i].lexeme, expected_lexemes[i]) == 0, "token lexeme matches");
        }
    }

    token_list_free(&tokens);
    diag_free(&diag);
    source_free(&src);
    return true;
}

static bool test_helix38_basic_arithmetic(void) {
    {
        TokenType types[] = { TOKEN_INT_LIT, TOKEN_PLUS, TOKEN_INT_LIT, TOKEN_EOF };
        const char *lexemes[] = { "1", "+", "2", "" };
        TEST_ASSERT(check_tokens("1 + 2", 4, types, lexemes), "1 + 2 recognized");
    }
    {
        TokenType types[] = { TOKEN_INT_LIT, TOKEN_MINUS, TOKEN_INT_LIT, TOKEN_EOF };
        const char *lexemes[] = { "5", "-", "3", "" };
        TEST_ASSERT(check_tokens("5 - 3", 4, types, lexemes), "5 - 3 recognized");
    }
    {
        TokenType types[] = { TOKEN_INT_LIT, TOKEN_STAR, TOKEN_INT_LIT, TOKEN_EOF };
        const char *lexemes[] = { "4", "*", "2", "" };
        TEST_ASSERT(check_tokens("4 * 2", 4, types, lexemes), "4 * 2 recognized");
    }
    {
        TokenType types[] = { TOKEN_INT_LIT, TOKEN_SLASH, TOKEN_INT_LIT, TOKEN_EOF };
        const char *lexemes[] = { "8", "/", "2", "" };
        TEST_ASSERT(check_tokens("8 / 2", 4, types, lexemes), "8 / 2 recognized");
    }
    return true;
}

static bool test_helix38_spacing_and_expressions(void) {
    /* A+B without spaces */
    {
        TokenType types[] = { TOKEN_IDENTIFIER, TOKEN_PLUS, TOKEN_IDENTIFIER, TOKEN_EOF };
        const char *lexemes[] = { "A", "+", "B", "" };
        TEST_ASSERT(check_tokens("A+B", 4, types, lexemes), "A+B without spaces");
    }
    /* A + B with spaces */
    {
        TokenType types[] = { TOKEN_IDENTIFIER, TOKEN_PLUS, TOKEN_IDENTIFIER, TOKEN_EOF };
        const char *lexemes[] = { "A", "+", "B", "" };
        TEST_ASSERT(check_tokens("A + B", 4, types, lexemes), "A + B with spaces");
    }
    /* (A + B) * C */
    {
        TokenType types[] = { TOKEN_LPAREN, TOKEN_IDENTIFIER, TOKEN_PLUS, TOKEN_IDENTIFIER, TOKEN_RPAREN, TOKEN_STAR, TOKEN_IDENTIFIER, TOKEN_EOF };
        const char *lexemes[] = { "(", "A", "+", "B", ")", "*", "C", "" };
        TEST_ASSERT(check_tokens("(A + B) * C", 8, types, lexemes), "(A + B) * C");
    }
    /* A-5 */
    {
        TokenType types[] = { TOKEN_IDENTIFIER, TOKEN_MINUS, TOKEN_INT_LIT, TOKEN_EOF };
        const char *lexemes[] = { "A", "-", "5", "" };
        TEST_ASSERT(check_tokens("A-5", 4, types, lexemes), "A-5 recognized");
    }
    /* A*-B */
    {
        TokenType types[] = { TOKEN_IDENTIFIER, TOKEN_STAR, TOKEN_MINUS, TOKEN_IDENTIFIER, TOKEN_EOF };
        const char *lexemes[] = { "A", "*", "-", "B", "" };
        TEST_ASSERT(check_tokens("A*-B", 5, types, lexemes), "A*-B recognized");
    }
    /* A / B + C * D */
    {
        TokenType types[] = { TOKEN_IDENTIFIER, TOKEN_SLASH, TOKEN_IDENTIFIER, TOKEN_PLUS, TOKEN_IDENTIFIER, TOKEN_STAR, TOKEN_IDENTIFIER, TOKEN_EOF };
        const char *lexemes[] = { "A", "/", "B", "+", "C", "*", "D", "" };
        TEST_ASSERT(check_tokens("A / B + C * D", 8, types, lexemes), "A / B + C * D recognized");
    }
    return true;
}

static bool test_helix38_jira_reproduction(void) {
    /* Jira Example 1: let severe_threshold = 250 + 3 */
    {
        TokenType types[] = {
            TOKEN_KW_LET, TOKEN_IDENTIFIER, TOKEN_EQUAL, TOKEN_INT_LIT, TOKEN_PLUS, TOKEN_INT_LIT, TOKEN_EOF
        };
        const char *lexemes[] = {
            "let", "severe_threshold", "=", "250", "+", "3", ""
        };
        TEST_ASSERT(check_tokens("let severe_threshold = 250 + 3", 7, types, lexemes),
                    "Jira example 1: let severe_threshold = 250 + 3");
    }
    /* Jira Example 2: let A := (B + 3) * G / 24 */
    {
        TokenType types[] = {
            TOKEN_KW_LET, TOKEN_IDENTIFIER, TOKEN_ASSIGN, TOKEN_LPAREN, TOKEN_IDENTIFIER, TOKEN_PLUS,
            TOKEN_INT_LIT, TOKEN_RPAREN, TOKEN_STAR, TOKEN_IDENTIFIER, TOKEN_SLASH, TOKEN_INT_LIT, TOKEN_EOF
        };
        const char *lexemes[] = {
            "let", "A", ":=", "(", "B", "+", "3", ")", "*", "G", "/", "24", ""
        };
        TEST_ASSERT(check_tokens("let A := (B + 3) * G / 24", 13, types, lexemes),
                    "Jira example 2: let A := (B + 3) * G / 24");
    }
    return true;
}

static bool test_helix38_edge_cases(void) {
    /* Existing assignment operators preserved */
    {
        TokenType types1[] = { TOKEN_IDENTIFIER, TOKEN_EQUAL, TOKEN_INT_LIT, TOKEN_EOF };
        const char *lexemes1[] = { "A", "=", "10", "" };
        TEST_ASSERT(check_tokens("A = 10", 4, types1, lexemes1), "A = 10 preserved");

        TokenType types2[] = { TOKEN_IDENTIFIER, TOKEN_ASSIGN, TOKEN_INT_LIT, TOKEN_EOF };
        const char *lexemes2[] = { "A", ":=", "10", "" };
        TEST_ASSERT(check_tokens("A := 10", 4, types2, lexemes2), "A := 10 preserved");
    }
    /* Disambiguation: -> vs - */
    {
        TokenType types[] = { TOKEN_IDENTIFIER, TOKEN_ARROW, TOKEN_IDENTIFIER, TOKEN_MINUS, TOKEN_IDENTIFIER, TOKEN_EOF };
        const char *lexemes[] = { "a", "->", "b", "-", "c", "" };
        TEST_ASSERT(check_tokens("a -> b - c", 6, types, lexemes), "arrow vs minus disambiguation");
    }
    /* Consecutive operators: + - * / -- ++ // / * * / */
    {
        TokenType types[] = {
            TOKEN_PLUS, TOKEN_MINUS, TOKEN_STAR, TOKEN_SLASH,
            TOKEN_MINUS, TOKEN_MINUS,
            TOKEN_PLUS, TOKEN_PLUS,
            TOKEN_SLASH, TOKEN_SLASH,
            TOKEN_SLASH, TOKEN_STAR,
            TOKEN_STAR, TOKEN_SLASH,
            TOKEN_EOF
        };
        TEST_ASSERT(check_tokens("+-*/ -- ++ // /* */", 15, types, NULL), "consecutive operators");
    }
    /* Slash and comments */
    {
        TokenType types[] = { TOKEN_INT_LIT, TOKEN_SLASH, TOKEN_INT_LIT, TOKEN_EOF };
        const char *lexemes[] = { "8", "/", "2", "" };
        TEST_ASSERT(check_tokens("8 / 2 # comment with + - * /", 4, types, lexemes), "slash before comment");
    }
    /* Operators at EOF boundary */
    {
        TokenType t_plus[] = { TOKEN_INT_LIT, TOKEN_PLUS, TOKEN_EOF };
        TEST_ASSERT(check_tokens("1 +", 3, t_plus, NULL), "plus at EOF");

        TokenType t_minus[] = { TOKEN_INT_LIT, TOKEN_MINUS, TOKEN_EOF };
        TEST_ASSERT(check_tokens("5 -", 3, t_minus, NULL), "minus at EOF");

        TokenType t_star[] = { TOKEN_INT_LIT, TOKEN_STAR, TOKEN_EOF };
        TEST_ASSERT(check_tokens("4 *", 3, t_star, NULL), "star at EOF");

        TokenType t_slash[] = { TOKEN_INT_LIT, TOKEN_SLASH, TOKEN_EOF };
        TEST_ASSERT(check_tokens("8 /", 3, t_slash, NULL), "slash at EOF");
    }
    /* Negative test: invalid characters still error out */
    {
        SourceBuffer src;
        source_from_string("bad_ops", "let x := 10 @ 5 $ 2 ! 3", &src);

        DiagnosticEngine diag;
        diag_init(&diag, &src, NULL);

        Lexer lexer;
        lexer_init(&lexer, &src, &diag);

        TokenList tokens;
        bool ok = lexer_tokenize_all(&lexer, &tokens);
        TEST_ASSERT(!ok, "errors reported for invalid characters");
        TEST_ASSERT(diag.lexical_errors >= 3, "at least 3 lexical errors for @, $, !");

        token_list_free(&tokens);
        diag_free(&diag);
        source_free(&src);
    }
    return true;
}

int main(void) {
    printf("========================================\n");
    printf(" HELIX Test Suite (Automated Verification)\n");
    printf("========================================\n\n");

    /* Unit tests */
    run_test("Unit: Keywords Lookup", test_keywords_lookup);
    run_test("Unit: Lexer Basic Scanning", test_lexer_basic_tokens);
    run_test("Unit: Lexer Operators and Locations", test_lexer_operators_and_positions);
    run_test("Unit: Lexer Error Detection", test_lexer_error_detection);
    run_test("Unit: Parser Minimal Rule", test_parser_valid_minimal);
    run_test("Unit: Parser Boolean Precedence", test_parser_boolean_precedence);
    run_test("Unit: Parser Suppress Repeat Of", test_parser_suppress_repeat_of);
    run_test("Unit: Diagnostic Message Content", test_diag_lexical_message_content);
    run_test("Unit: Parser Diagnostic Content", test_diag_syntax_message_content);
    run_test("Unit: CRLF Position Tracking", test_crlf_position_tracking);
    run_test("Unit: Exhaustive ASCII Sweep", test_exhaustive_single_char_sweep);
    run_test("Unit: Block end bind (valid)", test_parser_valid_bind);
    run_test("Unit: Block end when (valid)", test_parser_valid_when);
    run_test("Unit: Block nested blocks (valid)", test_parser_valid_nested);
    run_test("Unit: Standalone end error (invalid)", test_parser_invalid_standalone_end);
    run_test("Unit: Mismatched end rule on bind (invalid)", test_parser_invalid_mismatched_bind);
    run_test("Unit: Mismatched end bind on when (invalid)", test_parser_invalid_mismatched_when);
    run_test("Unit: Unknown block descriptor (invalid)", test_parser_invalid_unknown_descriptor);
    run_test("Unit: Missing block descriptor (invalid)", test_parser_invalid_missing_descriptor);
    run_test("Unit: Missing closing at EOF (invalid)", test_parser_invalid_missing_closing_at_eof);
    run_test("Unit: Incorrect block nesting (invalid)", test_parser_invalid_incorrect_nesting);
    run_test("HELIX-38: Basic Arithmetic Operators", test_helix38_basic_arithmetic);
    run_test("HELIX-38: Spacing and Expressions", test_helix38_spacing_and_expressions);
    run_test("HELIX-38: Jira Reproduction Snippets", test_helix38_jira_reproduction);
    run_test("HELIX-38: Edge Cases and Invariants", test_helix38_edge_cases);

    /* Integration / Fixture tests */
    run_test("Fixture: examples/basic_rule.helix", test_fixture_basic_rule);
    run_test("Fixture: examples/temporal_rule.helix", test_fixture_temporal_rule);
    run_test("Fixture: examples/alert_rule.helix", test_fixture_alert_rule);
    run_test("Fixture: tests/parser/test_minimal.helix", test_fixture_minimal_rule);
    run_test("Fixture: tests/parser/test_multiple_rules.helix", test_fixture_multiple_rules);

    /* Negative Fixture tests */
    run_test("Negative: Unterminated string", test_fixture_lex_unterminated_string);
    run_test("Negative: Illegal characters (@, $)", test_fixture_lex_illegal_char);
    run_test("Negative: Malformed numbers", test_fixture_lex_bad_number);
    run_test("Negative: Missing rule name", test_fixture_syn_missing_rule_name);
    run_test("Negative: Missing rule end", test_fixture_syn_missing_end);
    run_test("Negative: Missing expression", test_fixture_syn_missing_expression);

    printf("\n========================================\n");
    printf(" Results: %d/%d tests passed (%d failed)\n",
           g_tests_passed, g_tests_run, g_tests_run - g_tests_passed);
    printf("========================================\n");

    return (g_tests_passed == g_tests_run) ? EXIT_SUCCESS : EXIT_FAILURE;
}
