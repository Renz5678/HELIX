#ifndef HELIX_KEYWORDS_H
#define HELIX_KEYWORDS_H

#include <stdbool.h>
#include "token.h"

/**
 * Checks whether the given string is a HELIX reserved keyword.
 * If true, *out_type is populated with the corresponding TokenType (e.g. TOKEN_KW_RULE).
 * Returns false if the string is a regular identifier.
 */
bool keywords_lookup(const char *str, TokenType *out_type);

/**
 * Checks if a token type represents a reserved keyword.
 */
bool token_is_keyword(TokenType type);

#endif /* HELIX_KEYWORDS_H */
