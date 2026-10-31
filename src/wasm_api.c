#include "wasm_api.h"
#include "json.h"
#include "lexer.h"
#include "parser.h"
#include "source.h"
#include <stdlib.h>
#include <string.h>
static void field_number(JsonWriter *w, const char *name, size_t n) {
    json_write(w, ",\"");
    json_write(w, name);
    json_write(w, "\":");
    json_number(w, (double)n);
}
char *helix_analyze(const char *text) {
    if (!text || strlen(text) > 1024 * 1024 || !json_utf8_valid(text)) {
        JsonWriter w = {0};
        json_write(&w, "{\"schemaVersion\":1,\"success\":false,\"tokenCount\":0,"
                       "\"lexicalErrorCount\":0,\"syntaxErrorCount\":0,\"warningCount\":0,"
                       "\"summary\":\"Invalid source input\",\"tokens\":[],\"diagnostics\":[{"
                       "\"severity\":\"error\",\"category\":\"engine\",\"code\":\"INPUT_LIMIT\","
                       "\"message\":\"Source must be valid UTF-8, non-null and at most 1 MiB\"}]}");
        return json_finish(&w);
    }
    SourceBuffer source = {0};
    if (!source_from_string("studio.helix", text, &source))
        return NULL;
    DiagnosticEngine diag;
    diag_init(&diag, &source, NULL);
    Lexer lexer;
    lexer_init(&lexer, &source, &diag);
    TokenList tokens;
    bool lexed = lexer_tokenize_all(&lexer, &tokens);
    Parser parser;
    parser_init(&parser, &tokens, &diag);
    parser_parse(&parser);
    if (diag.allocation_failed) {
        diag_free(&diag);
        token_list_free(&tokens);
        source_free(&source);
        return NULL;
    }
    JsonWriter w = {0};
    bool success = lexed && !diag_has_errors(&diag);
    json_write(&w, "{\"schemaVersion\":1,\"success\":");
    json_write(&w, success ? "true" : "false");
    field_number(&w, "tokenCount", tokens.count ? tokens.count - 1 : 0);
    field_number(&w, "lexicalErrorCount", diag.lexical_errors);
    field_number(&w, "syntaxErrorCount", diag.syntax_errors);
    field_number(&w, "warningCount", diag.warnings);
    json_write(&w, ",\"tokens\":[");
    for (size_t i = 0; i < tokens.count; i++) {
        Token *t = &tokens.items[i];
        if (i)
            json_write(&w, ",");
        json_write(&w, "{\"index\":");
        json_number(&w, (double)i);
        json_write(&w, ",\"type\":");
        json_string(&w, token_type_name(t->type));
        json_write(&w, ",\"category\":");
        json_string(&w, t->type <= TOKEN_KW_END       ? "KEYWORD"
                        : t->type == TOKEN_EOF        ? "SENTINEL"
                        : t->type == TOKEN_ERROR      ? "ERROR"
                        : t->type == TOKEN_IDENTIFIER ? "IDENTIFIER"
                        : t->type <= TOKEN_STRING_LIT ? "LITERAL"
                        : t->type <= TOKEN_ARROW      ? "OPERATOR"
                                                      : "DELIMITER");
        json_write(&w, ",\"lexeme\":");
        json_string(&w, t->lexeme);
        field_number(&w, "line", t->line);
        field_number(&w, "column", t->column);
        field_number(&w, "startOffset", t->start_offset);
        field_number(&w, "endOffset", t->end_offset);
        json_write(&w, "}");
    }
    json_write(&w, "],\"diagnostics\":[");
    for (size_t i = 0; i < diag.count; i++) {
        DiagnosticItem *d = &diag.items[i];
        if (i)
            json_write(&w, ",");
        json_write(&w, "{\"severity\":");
        json_string(&w, d->kind == DIAG_WARNING ? "warning" : "error");
        json_write(&w, ",\"category\":");
        json_string(&w, d->kind == DIAG_LEXICAL_ERROR  ? "lexical"
                        : d->kind == DIAG_SYNTAX_ERROR ? "syntax"
                                                       : "analysis");
        json_write(&w, ",\"code\":");
        json_string(&w, d->kind == DIAG_LEXICAL_ERROR ? "LEXICAL_ERROR" : "SYNTAX_ERROR");
        field_number(&w, "line", d->line);
        field_number(&w, "column", d->column);
        field_number(&w, "endLine", d->end_line);
        field_number(&w, "endColumn", d->end_column);
        field_number(&w, "startOffset", d->start_offset);
        field_number(&w, "endOffset", d->end_offset);
        json_write(&w, ",\"message\":");
        json_string(&w, d->message);
        json_write(&w, ",\"snippet\":");
        json_string(&w, d->snippet);
        json_write(&w, "}");
    }
    json_write(&w, "],\"summary\":");
    json_string(&w, success ? "Lexical and syntax analysis passed"
                            : "Analysis failed; see diagnostics");
    json_write(&w, "}");
    diag_free(&diag);
    token_list_free(&tokens);
    source_free(&source);
    return json_finish(&w);
}
void helix_free_result(char *result) { free(result); }

#include "evaluator.h"
char *helix_evaluate(const char *source, const char *table_data_json) {
    return evaluator_run(source, table_data_json);
}
