#include "json.h"
#include "lexer.h"
#include "parser.h"
#include "value.h"
#include "wasm_api.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static AstNode *first(AstNode *n, AstKind kind) {
    if (n->kind == kind)
        return n;
    for (size_t i = 0; i < n->count; i++) {
        AstNode *r = first(n->children[i], kind);
        if (r)
            return r;
    }
    return NULL;
}
int main(void) {
    const TruthValue want_and[3][3] = {{TRUTH_FALSE, TRUTH_FALSE, TRUTH_FALSE},
                                       {TRUTH_FALSE, TRUTH_TRUE, TRUTH_UNKNOWN},
                                       {TRUTH_FALSE, TRUTH_UNKNOWN, TRUTH_UNKNOWN}};
    const TruthValue want_or[3][3] = {{TRUTH_FALSE, TRUTH_TRUE, TRUTH_UNKNOWN},
                                      {TRUTH_TRUE, TRUTH_TRUE, TRUTH_TRUE},
                                      {TRUTH_UNKNOWN, TRUTH_TRUE, TRUTH_UNKNOWN}};
    for (int a = 0; a < 3; a++)
        for (int b = 0; b < 3; b++) {
            assert(truth_and(a, b) == want_and[a][b]);
            assert(truth_or(a, b) == want_or[a][b]);
        }
    assert(truth_not(TRUTH_UNKNOWN) == TRUTH_UNKNOWN);
    double a, b;
    assert(value_datetime("2024-02-29T10:00:00Z", &a));
    assert(value_datetime("2024-02-29T11:00:00+01:00", &b));
    assert(a == b);
    assert(!value_datetime("2026-02-29T10:00:00Z", &a));
    assert(!value_datetime("2026-01-01T10:00:60Z", &a));
    SourceBuffer source = {0};
    assert(
        source_from_string("test", "rule X: when not a and b or c then alert \"x\" end when end rule", &source));
    DiagnosticEngine diag;
    diag_init(&diag, &source, NULL);
    Lexer lexer;
    lexer_init(&lexer, &source, &diag);
    TokenList tokens;
    assert(lexer_tokenize_all(&lexer, &tokens));
    Parser parser;
    parser_init(&parser, &tokens, &diag);
    AstProgram *program = parser_build_ast(&parser);
    assert(program);
    AstNode *or = first(program->root, AST_OR);
    assert(or && or->count == 2);
    assert(or->children[0]->kind == AST_AND && or->children[0]->count == 2);
    assert(program->tokens.items[or->children[0]->children[0]->start].type == TOKEN_KW_NOT);
    ast_program_free(program);
    token_list_free(&tokens);
    diag_free(&diag);
    source_free(&source);
    const char *payload =
        "{\"evaluationTime\":\"2026-10-31T12:00:00Z\",\"tables\":[{\"name\":\"T\",\"columns\":[{"
        "\"name\":\"patient_id\",\"type\":\"String\"},{\"name\":\"timestamp\",\"type\":"
        "\"DateTime\"},{\"name\":\"value\",\"type\":\"Float\"}],\"rows\":[{\"patient_id\":\"P1\","
        "\"timestamp\":\"2026-10-31T11:00:00Z\",\"value\":275}]}]}";
    for (int i = 0; i < 500; i++) {
        char *response = helix_evaluate(
            "rule X: source T when T.latest > 250 then alert \"high\" suppress within 1 hours end when end rule",
            payload);
        assert(response);
        char error[128];
        JsonValue *json = json_parse(response, error, sizeof error);
        assert(json);
        assert(json_get(json, "success")->boolean);
        JsonValue *results = json_get(json, "results");
        assert(results->count == 1);
        assert(json_get(results->children[0], "actions")->count == 2);
        json_value_free(json);
        helix_free_result(response);
        response = helix_analyze("rule X: @ let x = end rule");
        assert(response);
        helix_free_result(response);
        response =
            helix_evaluate("rule X: source T when T.latest > 0 then alert \"x\" end when end rule", "{bad");
        assert(response);
        helix_free_result(response);
    }
    const char *bad[] = {"{\"x\":1,\"x\":2}", "[1,]",       "{\"x\":01}",
                         "\"\\uD800\"",       "true false", "\"\\u0000\""};
    for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++) {
        char error[128];
        JsonValue *j = json_parse(bad[i], error, sizeof error);
        assert(!j && error[0]);
    }
    puts("Studio AST, truth tables, timestamps, strict JSON and 1500 repeated API calls passed");
    return 0;
}
