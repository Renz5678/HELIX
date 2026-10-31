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

    token_list_free(&tokens);
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

    token_list_free(&tokens);
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

    token_list_free(&tokens);
    source_free(&src);
    return true;
}

static bool test_parser_valid_minimal(void) {
    SourceBuffer src;
    source_from_string("min", "rule Minimal: end", &src);

    DiagnosticEngine diag;
    diag_init(&diag, &src, NULL);

    Lexer lexer;
    lexer_init(&lexer, &src, &diag);
    TokenList tokens;
    lexer_tokenize_all(&lexer, &tokens);

    Parser parser;
    parser_init(&parser, &tokens, &diag);
    bool parsed = parser_parse(&parser);

    TEST_ASSERT(parsed, "minimal rule parsed");
    TEST_ASSERT(diag.syntax_errors == 0, "no syntax errors");

    token_list_free(&tokens);
    source_free(&src);
    return true;
}

static bool test_parser_boolean_precedence(void) {
    SourceBuffer src;
    source_from_string("bool",
        "rule BoolPrecedence:\n"
        "    when not a and b or c then alert: \"OK\"\n"
        "end\n", &src);

    DiagnosticEngine diag;
    diag_init(&diag, &src, NULL);

    Lexer lexer;
    lexer_init(&lexer, &src, &diag);
    TokenList tokens;
    lexer_tokenize_all(&lexer, &tokens);

    Parser parser;
    parser_init(&parser, &tokens, &diag);
    bool parsed = parser_parse(&parser);

    TEST_ASSERT(parsed, "boolean precedence expression parsed");
    TEST_ASSERT(diag.syntax_errors == 0, "no syntax errors");

    token_list_free(&tokens);
    source_free(&src);
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

    token_list_free(&tokens);
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
