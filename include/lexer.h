#ifndef HELIX_LEXER_H
#define HELIX_LEXER_H

#include "source.h"
#include "token.h"
#include "diagnostic.h"

typedef struct {
    const SourceBuffer *source;
    DiagnosticEngine *diag;
    size_t cursor;     /* Byte offset in source->content */
    size_t line;       /* 1-indexed */
    size_t column;     /* 1-indexed */
} Lexer;

/**
 * Initializes a lexer instance bound to a source buffer and diagnostic engine.
 */
void lexer_init(Lexer *lexer, const SourceBuffer *source, DiagnosticEngine *diag);

/**
 * Scans the next token from the input stream using DFA logic and maximal munch.
 */
Token lexer_next_token(Lexer *lexer);

/**
 * Scans the entire source buffer into a TokenList until TOKEN_EOF.
 * Returns true if no lexical errors occurred.
 */
bool lexer_tokenize_all(Lexer *lexer, TokenList *out_tokens);

#endif /* HELIX_LEXER_H */
