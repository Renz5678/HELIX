#ifndef HELIX_PARSER_H
#define HELIX_PARSER_H

#include "ast.h"
#include "diagnostic.h"
#include "token.h"

#define PARSER_MAX_DEPTH 256

typedef struct {
    const TokenList *tokens;
    size_t current;
    DiagnosticEngine *diag;
    bool panic_mode;
    AstProgram *ast;
    AstNode *parent;
    size_t depth;
} Parser;

/**
 * Initializes a recursive descent parser with a token stream and diagnostic engine.
 */
void parser_init(Parser *parser, const TokenList *tokens, DiagnosticEngine *diag);

/**
 * Parses the token stream according to the HELIX grammar.
 * Returns true if the program is syntactically valid (no syntax errors).
 */
bool parser_parse(Parser *parser);
AstProgram *parser_build_ast(Parser *parser);

#endif /* HELIX_PARSER_H */
