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

/* --- HELIX-12 Unit Tests: Nesting Depth Protection --- */

static bool test_helix12_normal_expression(void) {
    return test_string_validation(
        "rule NormalExpr:\n"
        "    let x := (1)\n"
        "    when not (x > 10 and (x < 20 or (x == 15))) then\n"
        "        alert: \"OK\"\n"
        "    end when\n"
        "end rule\n", true);
}

static bool test_helix12_parentheses_limits(void) {
    /* Below limit: 34 nested parens */
    char *buf34 = (char *)malloc(34 * 2 + 64);
    TEST_ASSERT(buf34 != NULL, "allocation succeeded");
    char *p = buf34;
    p += sprintf(p, "rule L:\n    let x := ");
    for (int i = 0; i < 34; i++) *p++ = '(';
    *p++ = '1';
    for (int i = 0; i < 34; i++) *p++ = ')';
    sprintf(p, "\nend rule\n");
    bool ok34 = test_string_validation(buf34, true);
    free(buf34);
    TEST_ASSERT(ok34, "34 nested parentheses (below limit) succeeds");

    /* Exactly at limit: 35 nested parens */
    char *buf35 = (char *)malloc(35 * 2 + 64);
    TEST_ASSERT(buf35 != NULL, "allocation succeeded");
    p = buf35;
    p += sprintf(p, "rule L:\n    let x := ");
    for (int i = 0; i < 35; i++) *p++ = '(';
    *p++ = '1';
    for (int i = 0; i < 35; i++) *p++ = ')';
    sprintf(p, "\nend rule\n");
    bool ok35 = test_string_validation(buf35, true);
    free(buf35);
    TEST_ASSERT(ok35, "35 nested parentheses (at limit) succeeds");

    /* Exceeding limit: 36 nested parens */
    char *buf36 = (char *)malloc(36 * 2 + 64);
    TEST_ASSERT(buf36 != NULL, "allocation succeeded");
    p = buf36;
    p += sprintf(p, "rule L:\n    let x := ");
    for (int i = 0; i < 36; i++) *p++ = '(';
    *p++ = '1';
    for (int i = 0; i < 36; i++) *p++ = ')';
    sprintf(p, "\nend rule\n");
    bool ok36 = test_string_validation(buf36, false);
    free(buf36);
    TEST_ASSERT(ok36, "36 nested parentheses (exceeding limit) rejected with syntax error");

    return true;
}

static bool test_helix12_deep_30000_parentheses(void) {
    size_t n = 30000;
    size_t sz = n * 2 + 128;
    char *buf = (char *)malloc(sz);
    TEST_ASSERT(buf != NULL, "allocation succeeded");

    char *p = buf;
    p += sprintf(p, "rule Deep:\n    let x := ");
    memset(p, '(', n);
    p += n;
    *p++ = '1';
    memset(p, ')', n);
    p += n;
    sprintf(p, "\nend rule\n");

    SourceBuffer src;
    source_from_string("deep", buf, &src);

    DiagnosticEngine diag;
    diag_init(&diag, &src, NULL);

    Lexer lexer;
    lexer_init(&lexer, &src, &diag);
    TokenList tokens;
    bool lex_ok = lexer_tokenize_all(&lexer, &tokens);
    TEST_ASSERT(lex_ok, "lexing 30,000 parentheses succeeds");

    Parser parser;
    parser_init(&parser, &tokens, &diag);
    bool parsed = parser_parse(&parser);

    TEST_ASSERT(!parsed, "30,000 parentheses rejected without crashing");
    TEST_ASSERT(diag.syntax_errors >= 1, "syntax error recorded");
    TEST_ASSERT(parser.depth == 0, "parser depth restored to 0");

    const DiagnosticEntry *e = diag_get_entry(&diag, 0);
    TEST_ASSERT(e != NULL && strstr(e->message, "nesting limit exceeded") != NULL,
                "diagnostic names nesting limit");

    token_list_free(&tokens);
    diag_free(&diag);
    source_free(&src);
    free(buf);
    return true;
}

static bool test_helix12_repeated_not(void) {
    /* Below/at limit: 246 nots */
    size_t sz = 250 * 4 + 64;
    char *buf246 = (char *)malloc(sz);
    TEST_ASSERT(buf246 != NULL, "allocation succeeded");
    char *p = buf246;
    p += sprintf(p, "rule NotAtLimit:\n    let x := ");
    for (int i = 0; i < 246; i++) {
        memcpy(p, "not ", 4);
        p += 4;
    }
    sprintf(p, "1\nend rule\n");
    bool ok246 = test_string_validation(buf246, true);
    free(buf246);
    TEST_ASSERT(ok246, "246 not operators (at limit) succeeds");

    /* Exceeding limit: 247 nots */
    char *buf247 = (char *)malloc(sz);
    TEST_ASSERT(buf247 != NULL, "allocation succeeded");
    p = buf247;
    p += sprintf(p, "rule NotOverLimit:\n    let x := ");
    for (int i = 0; i < 247; i++) {
        memcpy(p, "not ", 4);
        p += 4;
    }
    sprintf(p, "1\nend rule\n");
    bool ok247 = test_string_validation(buf247, false);
    free(buf247);
    TEST_ASSERT(ok247, "247 not operators (exceeding limit) rejected");

    /* Deeply exceeding: 5000 nots */
    size_t sz5000 = 5000 * 4 + 64;
    char *buf5000 = (char *)malloc(sz5000);
    TEST_ASSERT(buf5000 != NULL, "allocation succeeded");
    p = buf5000;
    p += sprintf(p, "rule Not5000:\n    let x := ");
    for (int i = 0; i < 5000; i++) {
        memcpy(p, "not ", 4);
        p += 4;
    }
    sprintf(p, "1\nend rule\n");
    bool ok5000 = test_string_validation(buf5000, false);
    free(buf5000);
    TEST_ASSERT(ok5000, "5000 not operators rejected safely without stack overflow");

    return true;
}

static bool test_helix12_nested_branches(void) {
    /* Below/at limit: 122 nested whens */
    size_t sz = 125 * 30 + 128;
    char *buf122 = (char *)malloc(sz);
    TEST_ASSERT(buf122 != NULL, "allocation succeeded");
    char *p = buf122;
    p += sprintf(p, "rule When122:\n");
    for (int i = 0; i < 122; i++) {
        p += sprintf(p, "when 1 > 0 then\n");
    }
    p += sprintf(p, "alert: \"OK\"\n");
    for (int i = 0; i < 122; i++) {
        p += sprintf(p, "end when\n");
    }
    sprintf(p, "end rule\n");
    bool ok122 = test_string_validation(buf122, true);
    free(buf122);
    TEST_ASSERT(ok122, "122 nested when branches (at limit) succeeds");

    /* Exceeding limit: 123 nested whens */
    char *buf123 = (char *)malloc(sz);
    TEST_ASSERT(buf123 != NULL, "allocation succeeded");
    p = buf123;
    p += sprintf(p, "rule When123:\n");
    for (int i = 0; i < 123; i++) {
        p += sprintf(p, "when 1 > 0 then\n");
    }
    p += sprintf(p, "alert: \"OK\"\n");
    for (int i = 0; i < 123; i++) {
        p += sprintf(p, "end when\n");
    }
    sprintf(p, "end rule\n");
    bool ok123 = test_string_validation(buf123, false);
    free(buf123);
    TEST_ASSERT(ok123, "123 nested when branches (exceeding limit) rejected");

    /* Deeply exceeding: 1000 nested whens */
    size_t sz1000 = 1000 * 30 + 128;
    char *buf1000 = (char *)malloc(sz1000);
    TEST_ASSERT(buf1000 != NULL, "allocation succeeded");
    p = buf1000;
    p += sprintf(p, "rule When1000:\n");
    for (int i = 0; i < 1000; i++) {
        p += sprintf(p, "when 1 > 0 then\n");
    }
    p += sprintf(p, "alert: \"OK\"\n");
    for (int i = 0; i < 1000; i++) {
        p += sprintf(p, "end when\n");
    }
    sprintf(p, "end rule\n");
    bool ok1000 = test_string_validation(buf1000, false);
    free(buf1000);
    TEST_ASSERT(ok1000, "1000 nested when branches rejected safely without stack overflow");

    return true;
}

static bool test_helix12_analyzer_availability_after_error(void) {
    /* 1. Reject deeply nested input */
    size_t n = 1000;
    size_t sz = n * 2 + 128;
    char *buf = (char *)malloc(sz);
    TEST_ASSERT(buf != NULL, "allocation succeeded");
    char *p = buf;
    p += sprintf(p, "rule Deep:\n    let x := ");
    memset(p, '(', n);
    p += n;
    *p++ = '1';
    memset(p, ')', n);
    p += n;
    sprintf(p, "\nend rule\n");

    bool bad_rejected = !test_string_validation(buf, true);
    free(buf);
    TEST_ASSERT(bad_rejected, "deep expression rejected");

    /* 2. Immediately parse a valid rule in the same process and verify availability */
    bool good_parsed = test_string_validation(
        "rule Recovered:\n"
        "    let x := 42\n"
        "    when x > 10 then\n"
        "        alert: \"System fully operational\"\n"
        "    end when\n"
        "end rule\n", true);
    TEST_ASSERT(good_parsed, "analyzer successfully processes subsequent valid rule");
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

/* --- HELIX-17 Unit Tests: Latest Observation Queries --- */

static bool test_parse_string(const char *source, bool expect_valid) {
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

    token_list_free(&tokens);
    diag_free(&diag);
    source_free(&src);

    return is_valid == expect_valid;
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

static bool test_helix17_valid_latest_query_multiline(void) {
    const char *code =
        "rule PotassiumAlert:\n"
        "    latest Observation\n"
        "    where code = potassium\n"
        "    within 24 hours before now\n"
        "end rule\n";
    return test_parse_string(code, true);
}

static bool test_helix17_valid_query_in_expressions(void) {
    const char *code_let =
        "rule LetQuery:\n"
        "    let k := latest Observation where code = potassium within 24 hours before now\n"
        "end rule\n";
    const char *code_bind =
        "rule BindQuery:\n"
        "    bind k = latest Observation where code = potassium within 24 hours before now\n"
        "    end bind\n"
        "end rule\n";
    const char *code_when =
        "rule WhenQuery:\n"
        "    when (latest Observation where code = potassium within 24 hours before now) > 5.0\n"
        "    then alert: \"High\"\n"
        "    end when\n"
        "end rule\n";
    return test_parse_string(code_let, true) &&
           test_parse_string(code_bind, true) &&
           test_parse_string(code_when, true);
}

static bool test_helix17_valid_without_before_now(void) {
    const char *code =
        "rule WithoutBeforeNow:\n"
        "    latest Observation where code = potassium within 24 hours\n"
        "end rule\n";
    return test_parse_string(code, true);
}

static bool test_helix17_valid_various_units_and_types(void) {
    const char *code1 =
        "rule DaysUnit:\n"
        "    latest BloodPressure where systolic > 140 within 7 days before now\n"
        "end rule\n";
    const char *code2 =
        "rule MinutesUnit:\n"
        "    latest Glucose where level > 200 within 30 minutes before now\n"
        "end rule\n";
    const char *code3 =
        "rule StringDuration:\n"
        "    latest HeartRate where rate > 100 within \"24h\" before now\n"
        "end rule\n";
    return test_parse_string(code1, true) &&
           test_parse_string(code2, true) &&
           test_parse_string(code3, true);
}

static bool test_helix17_neg_missing_obs_type(void) {
    const char *code1 = "rule Bad: latest where code = potassium within 24 hours before now end rule";
    const char *code2 = "rule Bad: latest end rule";
    return test_parse_string(code1, false) && test_parse_string(code2, false);
}

static bool test_helix17_neg_missing_where_condition(void) {
    const char *code1 = "rule Bad: latest Observation where within 24 hours before now end rule";
    const char *code2 = "rule Bad: latest Observation where end rule";
    return test_parse_string(code1, false) && test_parse_string(code2, false);
}

static bool test_helix17_neg_missing_duration(void) {
    const char *code1 = "rule Bad: latest Observation where code = potassium within before now end rule";
    const char *code2 = "rule Bad: latest Observation where code = potassium within end rule";
    return test_parse_string(code1, false) && test_parse_string(code2, false);
}

static bool test_helix17_neg_invalid_time_unit(void) {
    const char *code1 = "rule Bad: latest Observation where code = potassium within 24 lightyears before now end rule";
    const char *code2 = "rule Bad: latest Observation where code = potassium within 24 before now end rule";
    return test_parse_string(code1, false) && test_parse_string(code2, false);
}

static bool test_helix17_neg_missing_temporal_ref(void) {
    const char *code1 = "rule Bad: latest Observation where code = potassium within 24 hours before end rule";
    const char *code2 = "rule Bad: latest Observation where code = potassium within 24 hours before yesterday end rule";
    return test_parse_string(code1, false) && test_parse_string(code2, false);
}

static bool test_helix17_neg_incomplete_query(void) {
    const char *code1 = "rule Bad: latest Observation end rule";
    const char *code2 = "rule Bad: latest Observation where code = potassium end rule";
    return test_parse_string(code1, false) && test_parse_string(code2, false);
}

static bool test_helix17_neg_trailing_tokens(void) {
    const char *code =
        "rule Bad:\n"
        "    let x := latest Observation where code = potassium within 24 hours before now trailing_junk\n"
        "end rule\n";
    return test_parse_string(code, false);
}

static bool test_fixture_latest_observation(void) {
    return test_file_validation("tests/parser/test_latest_observation.helix", true);
}

static bool test_fixture_syn_missing_obs_type(void) {
    return test_file_validation("tests/invalid/syn_missing_obs_type.helix", false);
}

static bool test_fixture_syn_incomplete_latest_query(void) {
    return test_file_validation("tests/invalid/syn_incomplete_latest_query.helix", false);
}

static bool test_fixture_syn_invalid_time_unit(void) {
    return test_file_validation("tests/invalid/syn_invalid_time_unit.helix", false);
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

/* --- HELIX-22: event trigger, for, alert level, terminology mappings, bind site block --- */
static bool test_helix22_event_trigger(void) {
    return test_string_validation("rule R: when Observation.created end rule", true) &&
           test_string_validation("rule R:\n    when Observation.created\n    for patient : P\nend rule\n", true);
}

static bool test_helix22_for_decl(void) {
    return test_string_validation("rule R: for patient : P end rule", true) &&
           test_string_validation("rule R: for patient P end rule", true);
}

static bool test_helix22_alert_level(void) {
    return test_string_validation("rule R: alert level : interruptive end rule", true) &&
           test_string_validation("rule R: when x > 1 then alert level : \"critical\" end when end rule", true);
}

static bool test_helix22_terminology_mappings(void) {
    return test_string_validation(
               "rule R: terminology potassium -> LOINC[\"serum potassium\"] glucose -> LOINC[\"glucose\"] end rule", true) &&
           test_string_validation("rule R: terminology LOINC end rule", true);
}

static bool test_helix22_bind_site_block(void) {
    return test_string_validation(
        "rule R: bind site \"Hospital_A\" source : FHIR_R4 terminology potassium -> LOINC[\"serum potassium\"] end bind end rule", true);
}

static bool test_helix22_full_example(void) {
    /* suppress repeat_of is covered by HELIX-16; here it is a plain suppress */
    return test_string_validation(
        "# Alert when a critical potassium result is recorded\n"
        "rule Hyperkalemia_Alert\n"
        "  intent \"Detect a critical laboratory result\"\n"
        "  bind site \"Hospital_A\"\n"
        "    source : FHIR_R4\n"
        "    terminology\n"
        "      potassium -> LOINC[\"serum potassium\"]\n"
        "  end bind\n"
        "  schedule : event_driven\n"
        "  when Observation.created\n"
        "  for patient : P\n"
        "  let lab := latest Observation where code = potassium within 24 hours before now\n"
        "  when lab.value > 6.0\n"
        "  then alert level : interruptive\n"
        "       suppress \"Hyperkalemia_Alert\"\n"
        "  end when\n"
        "end rule\n", true);
}

static bool test_helix22_negatives(void) {
    return test_string_validation("rule R: when x end rule", false) &&
           test_string_validation("rule R: for patient : end rule", false) &&
           test_string_validation("rule R: alert level : end rule", false) &&
           test_string_validation("rule R: terminology potassium -> end rule", false) &&
           test_string_validation("rule R: bind site end bind end rule", false);
}

/* --- HELIX-36 Unit Tests: bind site configuration blocks --- */

static bool test_helix36_valid_bind_site(void) {
    const char *with_string =
        "rule R:\n"
        "    bind site \"Hospital_B\"\n"
        "    end bind\n"
        "end rule\n";
    const char *with_ident =
        "rule R:\n"
        "    bind site Hospital_B\n"
        "    end bind\n"
        "end rule\n";
    return test_parse_string(with_string, true) && test_parse_string(with_ident, true);
}

static bool test_helix36_valid_source_and_terminology(void) {
    const char *code =
        "rule R:\n"
        "    bind site \"Hospital_B\"\n"
        "        source : FHIR_R4\n"
        "        terminology: LOINC(\"2339-0\")\n"
        "    end bind\n"
        "    alert: \"ok\"\n"
        "end rule\n";
    return test_parse_string(code, true);
}

static bool test_helix36_bind_identifier_still_works(void) {
    const char *code =
        "rule R:\n"
        "    bind x = T.value\n"
        "    end bind\n"
        "end rule\n";
    return test_parse_string(code, true);
}

static bool test_helix36_neg_invalid_token_after_bind(void) {
    const char *num = "rule R:\n    bind 42\n    end bind\nend rule\n";
    const char *str = "rule R:\n    bind \"x\"\n    end bind\nend rule\n";
    return test_parse_string(num, false) && test_parse_string(str, false);
}

static bool test_helix36_neg_terminators(void) {
    const char *missing_eof = "rule R:\n    bind site \"H\"\n";
    const char *wrong_desc  = "rule R:\n    bind site \"H\"\n    end rule\n";
    const char *bare_end    = "rule R:\n    bind site \"H\"\n    end\nend rule\n";
    return test_parse_string(missing_eof, false) &&
           test_parse_string(wrong_desc, false) &&
           test_parse_string(bare_end, false);
}

static bool test_helix36_neg_unexpected_statements(void) {
    const char *alert = "rule R:\n    bind site \"H\"\n    alert: \"x\"\n    end bind\nend rule\n";
    const char *let   = "rule R:\n    bind site \"H\"\n    let a := 1\n    end bind\nend rule\n";
    const char *when  = "rule R:\n    bind site \"H\"\n    when a > 1:\n    end when\n    end bind\nend rule\n";
    return test_parse_string(alert, false) &&
           test_parse_string(let, false) &&
           test_parse_string(when, false);
}

static bool test_helix36_neg_site_without_name(void) {
    const char *code = "rule R:\n    bind site\n    end bind\nend rule\n";
    return test_parse_string(code, false);
}

/* --- HELIX-14 Unit Tests: Source & Terminology Mapping Syntax --- */

static bool test_helix14_terminology_mapping(void) {
    /* 1. Proposal Page 3 / Section 4.1 single concept mapping */
    TEST_ASSERT(test_string_validation(
        "rule Hyperkalemia_Alert\n"
        "    source : FHIR_R4\n"
        "    terminology\n"
        "        potassium -> LOINC[\"serum potassium\"]\n"
        "end rule\n", true),
        "Proposal Page 3 single concept -> LOINC[...] mapping");

    /* 2. Proposal Section 11 multiple mappings under one terminology header */
    TEST_ASSERT(test_string_validation(
        "rule MultiMapping:\n"
        "    source : FHIR_R4\n"
        "    terminology\n"
        "        potassium -> LOINC[\"serum potassium\"]\n"
        "        sodium -> LOINC[\"2951-2\"]\n"
        "        sepsis -> SNOMED[\"91302008\"]\n"
        "    let threshold := 6.0\n"
        "end rule\n", true),
        "Multiple concept mappings under a single terminology header");

    /* 3. Free-field single-line multi-mapping followed by next statement */
    TEST_ASSERT(test_string_validation(
        "rule FreeFieldMapping terminology potassium -> LOINC[\"2823-3\"] sodium -> LOINC[\"2951-2\"] let x := 1 end rule",
        true),
        "Free-field single-line multi-mapping stops cleanly before let");

    /* 4. Optional colon and parenthesized code selector on concept mapping */
    TEST_ASSERT(test_string_validation(
        "rule ColonParenMapping:\n"
        "    terminology: potassium -> LOINC(\"2823-3\")\n"
        "end rule\n", true),
        "Concept mapping with optional colon and parenthesized code");

    /* 5. Backward compatibility with existing direct terminology forms */
    TEST_ASSERT(test_string_validation(
        "rule LegacyTerminology:\n"
        "    source: EHR -> FHIR_R4\n"
        "    terminology: LOINC(\"2339-0\")\n"
        "    terminology: SNOMED[\"91302008\"]\n"
        "    terminology LOINC(\"2339-0\") \"Glucose\"\n"
        "end rule\n", true),
        "Existing direct terminology forms remain valid");

    /* 6. AST span covers full terminology mapping declaration */
    {
        SourceBuffer src;
        source_from_string("h14_ast",
            "rule AstCheck\n"
            "    terminology\n"
            "        potassium -> LOINC[\"serum potassium\"]\n"
            "        sodium -> LOINC[\"2951-2\"]\n"
            "    let x := 1\n"
            "end rule\n", &src);
        DiagnosticEngine diag;
        diag_init(&diag, &src, NULL);
        Lexer lexer;
        lexer_init(&lexer, &src, &diag);
        TokenList tokens;
        TEST_ASSERT(lexer_tokenize_all(&lexer, &tokens), "h14_ast lexes cleanly");
        Parser parser;
        parser_init(&parser, &tokens, &diag);
        AstProgram *ast = parser_build_ast(&parser);
        TEST_ASSERT(ast != NULL && !ast->failed, "AST builds cleanly for multi-mapping terminology");
        TEST_ASSERT(ast->root->count == 1 && ast->root->children[0]->count == 2,
                    "Rule AST has AST_TERMINOLOGY and AST_LET element wrappers");
        TEST_ASSERT(ast->root->children[0]->children[0]->count == 1 &&
                    ast->root->children[0]->children[0]->children[0]->kind == AST_TERMINOLOGY,
                    "First rule element unwraps to AST_TERMINOLOGY");
        TEST_ASSERT(ast->root->children[0]->children[1]->count == 1 &&
                    ast->root->children[0]->children[1]->children[0]->kind == AST_LET,
                    "Second rule element unwraps to AST_LET");
        ast_program_free(ast);
        token_list_free(&tokens);
        diag_free(&diag);
        source_free(&src);
    }

    /* 7. Negative cases: malformed mappings must be rejected */
    TEST_ASSERT(test_string_validation(
        "rule Bad1:\n"
        "    terminology potassium ->\n"
        "end rule\n", false),
        "Reject missing target system after '->'");

    TEST_ASSERT(test_string_validation(
        "rule Bad2:\n"
        "    terminology potassium -> LOINC[\"serum potassium\"\n"
        "end rule\n", false),
        "Reject unclosed '[' in terminology reference");

    TEST_ASSERT(test_string_validation(
        "rule Bad3:\n"
        "    terminology potassium -> LOINC[]\n"
        "end rule\n", false),
        "Reject empty '[]' in terminology reference");

    TEST_ASSERT(test_string_validation(
        "rule Bad4:\n"
        "    terminology -> LOINC[\"serum potassium\"]\n"
        "end rule\n", false),
        "Reject missing local concept name before '->'");

    TEST_ASSERT(test_string_validation(
        "rule Bad5:\n"
        "    terminology\n"
        "        potassium -> LOINC[\"2823-3\"]\n"
        "        sodium ->\n"
        "end rule\n", false),
        "Reject incomplete second mapping in multi-mapping block");

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
    run_test("HELIX-12: Normal Expression", test_helix12_normal_expression);
    run_test("HELIX-12: Parentheses Nesting Limits", test_helix12_parentheses_limits);
    run_test("HELIX-12: Deep 30,000 Parentheses", test_helix12_deep_30000_parentheses);
    run_test("HELIX-12: Repeated Not Operators", test_helix12_repeated_not);
    run_test("HELIX-12: Nested When Branches", test_helix12_nested_branches);
    run_test("HELIX-12: Availability After Depth Error", test_helix12_analyzer_availability_after_error);
    run_test("HELIX-38: Basic Arithmetic Operators", test_helix38_basic_arithmetic);
    run_test("HELIX-38: Spacing and Expressions", test_helix38_spacing_and_expressions);
    run_test("HELIX-38: Jira Reproduction Snippets", test_helix38_jira_reproduction);
    run_test("HELIX-38: Edge Cases and Invariants", test_helix38_edge_cases);
    run_test("HELIX-14: Source and Terminology Mappings", test_helix14_terminology_mapping);

    /* HELIX-17 Unit Tests */
    run_test("HELIX-17: Valid Latest Observation Query", test_helix17_valid_latest_query_multiline);
    run_test("HELIX-17: Query in Let, Bind, When", test_helix17_valid_query_in_expressions);
    run_test("HELIX-17: Query without Before Now", test_helix17_valid_without_before_now);
    run_test("HELIX-17: Query with Various Units & Types", test_helix17_valid_various_units_and_types);
    run_test("HELIX-17: Neg - Missing Observation Type", test_helix17_neg_missing_obs_type);
    run_test("HELIX-17: Neg - Missing Where Condition", test_helix17_neg_missing_where_condition);
    run_test("HELIX-17: Neg - Missing Duration", test_helix17_neg_missing_duration);
    run_test("HELIX-17: Neg - Invalid Time Unit", test_helix17_neg_invalid_time_unit);
    run_test("HELIX-17: Neg - Missing Temporal Reference", test_helix17_neg_missing_temporal_ref);
    run_test("HELIX-17: Neg - Incomplete Query", test_helix17_neg_incomplete_query);
    run_test("HELIX-17: Neg - Trailing Tokens", test_helix17_neg_trailing_tokens);

    
    /* HELIX-22 Unit Tests */
    run_test("HELIX-22: when Event.name trigger", test_helix22_event_trigger);
    run_test("HELIX-22: for patient : P", test_helix22_for_decl);
    run_test("HELIX-22: alert level : X", test_helix22_alert_level);
    run_test("HELIX-22: terminology mappings", test_helix22_terminology_mappings);
    run_test("HELIX-22: bind site block", test_helix22_bind_site_block);
    run_test("HELIX-22: full proposal example", test_helix22_full_example);
    run_test("HELIX-22: Neg - malformed forms", test_helix22_negatives);
    /* HELIX-36: bind site configuration blocks */
    run_test("HELIX-36: Valid bind site", test_helix36_valid_bind_site);
    run_test("HELIX-36: bind site with source & terminology", test_helix36_valid_source_and_terminology);
    run_test("HELIX-36: bind <identifier> still works", test_helix36_bind_identifier_still_works);
    run_test("HELIX-36: Neg - Invalid token after bind", test_helix36_neg_invalid_token_after_bind);
    run_test("HELIX-36: Neg - Bad block terminators", test_helix36_neg_terminators);
    run_test("HELIX-36: Neg - Unexpected statements in block", test_helix36_neg_unexpected_statements);
    run_test("HELIX-36: Neg - site without name", test_helix36_neg_site_without_name);

    /* Integration / Fixture tests */
    run_test("Fixture: examples/basic_rule.helix", test_fixture_basic_rule);
    run_test("Fixture: examples/temporal_rule.helix", test_fixture_temporal_rule);
    run_test("Fixture: examples/alert_rule.helix", test_fixture_alert_rule);
    run_test("Fixture: tests/parser/test_minimal.helix", test_fixture_minimal_rule);
    run_test("Fixture: tests/parser/test_multiple_rules.helix", test_fixture_multiple_rules);
    run_test("Fixture: tests/parser/test_latest_observation.helix", test_fixture_latest_observation);

    /* Negative Fixture tests */
    run_test("Negative: Unterminated string", test_fixture_lex_unterminated_string);
    run_test("Negative: Illegal characters (@, $)", test_fixture_lex_illegal_char);
    run_test("Negative: Malformed numbers", test_fixture_lex_bad_number);
    run_test("Negative: Missing rule name", test_fixture_syn_missing_rule_name);
    run_test("Negative: Missing rule end", test_fixture_syn_missing_end);
    run_test("Negative: Missing expression", test_fixture_syn_missing_expression);
    run_test("Negative: Missing observation type", test_fixture_syn_missing_obs_type);
    run_test("Negative: Incomplete latest query", test_fixture_syn_incomplete_latest_query);
    run_test("Negative: Invalid time unit", test_fixture_syn_invalid_time_unit);

    printf("\n========================================\n");
    printf(" Results: %d/%d tests passed (%d failed)\n",
           g_tests_passed, g_tests_run, g_tests_run - g_tests_passed);
    printf("========================================\n");

    return (g_tests_passed == g_tests_run) ? EXIT_SUCCESS : EXIT_FAILURE;
}
