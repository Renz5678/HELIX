#ifndef HELIX_TOKEN_H
#define HELIX_TOKEN_H

#include <stdbool.h>
#include <stddef.h>

/**
 * All token types recognized by the HELIX language.
 */
typedef enum {
    /* Reserved Words (21 core keywords) */
    TOKEN_KW_RULE,        /* rule */
    TOKEN_KW_INTENT,      /* intent */
    TOKEN_KW_BIND,        /* bind */
    TOKEN_KW_SITE,        /* site */
    TOKEN_KW_SOURCE,      /* source */
    TOKEN_KW_TERMINOLOGY, /* terminology */
    TOKEN_KW_SCHEDULE,    /* schedule */
    TOKEN_KW_WHEN,        /* when */
    TOKEN_KW_FOR,         /* for */
    TOKEN_KW_LET,         /* let */
    TOKEN_KW_LATEST,      /* latest */
    TOKEN_KW_WHERE,       /* where */
    TOKEN_KW_AND,         /* and */
    TOKEN_KW_OR,          /* or */
    TOKEN_KW_NOT,         /* not */
    TOKEN_KW_WITHIN,      /* within */
    TOKEN_KW_THEN,        /* then */
    TOKEN_KW_ALERT,       /* alert */
    TOKEN_KW_SUPPRESS,    /* suppress */
    TOKEN_KW_OTHERWISE,   /* otherwise */
    TOKEN_KW_END,         /* end */

    /* Identifiers & Literals */
    TOKEN_IDENTIFIER, /* e.g. glucose_data, patient */
    TOKEN_INT_LIT,    /* e.g. 100, 42 */
    TOKEN_FLOAT_LIT,  /* e.g. 37.5, 0.9 */
    TOKEN_STRING_LIT, /* e.g. "Critical glucose reading" */

    /* Operators */
    TOKEN_ASSIGN, /* := */
    TOKEN_EQUAL,  /* = */
    TOKEN_EQ,     /* == */
    TOKEN_NEQ,    /* != */
    TOKEN_GT,     /* > */
    TOKEN_GTE,    /* >= */
    TOKEN_LT,     /* < */
    TOKEN_LTE,    /* <= */
    TOKEN_ARROW,  /* -> */

    /* Delimiters and Punctuation */
    TOKEN_COLON,    /* : */
    TOKEN_DOT,      /* . */
    TOKEN_COMMA,    /* , */
    TOKEN_LPAREN,   /* ( */
    TOKEN_RPAREN,   /* ) */
    TOKEN_LBRACKET, /* [ */
    TOKEN_RBRACKET, /* ] */

    /* Special Sentinel Tokens */
    TOKEN_EOF,  /* End of input */
    TOKEN_ERROR /* Lexical error token */
} TokenType;

/**
 * Represents a single token emitted by the lexer.
 */
typedef struct {
    TokenType type;
    size_t start_offset, end_offset; /* Original UTF-8 byte range, end exclusive */
    char *lexeme;                    /* Heap-allocated null-terminated copy */
    size_t line;                     /* 1-indexed */
    size_t column;                   /* 1-indexed */
} Token;

/**
 * Dynamic array of tokens.
 */
typedef struct {
    Token *items;
    size_t count;
    size_t capacity;
} TokenList;

/**
 * Creates a token with an allocated duplicate of lexeme.
 */
Token token_create(TokenType type, const char *lexeme, size_t line, size_t column);

/**
 * Frees heap resources owned by a single token.
 */
void token_free(Token *token);

/**
 * Returns human-readable name of token type (e.g. "TOKEN_KW_RULE", "IDENTIFIER").
 */
const char *token_type_name(TokenType type);

/**
 * Returns a friendly display name for diagnostic messages (e.g. "'rule'", "identifier", "':='").
 */
const char *token_type_description(TokenType type);

/**
 * Initializes an empty TokenList.
 */
void token_list_init(TokenList *list);

/**
 * Appends a token to the list, expanding capacity if needed.
 */
bool token_list_append(TokenList *list, Token token);

/**
 * Frees all tokens in the list and the list items buffer.
 */
void token_list_free(TokenList *list);

#endif /* HELIX_TOKEN_H */
