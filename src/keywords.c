#include "keywords.h"
#include <string.h>

typedef struct {
    const char *word;
    TokenType type;
} KeywordEntry;

/* The 21 formal HELIX reserved words, kept sorted alphabetically for clarity & fast search */
static const KeywordEntry KEYWORD_TABLE[] = {
    {"alert",       TOKEN_KW_ALERT},
    {"and",         TOKEN_KW_AND},
    {"bind",        TOKEN_KW_BIND},
    {"end",         TOKEN_KW_END},
    {"for",         TOKEN_KW_FOR},
    {"intent",      TOKEN_KW_INTENT},
    {"latest",      TOKEN_KW_LATEST},
    {"let",         TOKEN_KW_LET},
    {"not",         TOKEN_KW_NOT},
    {"or",          TOKEN_KW_OR},
    {"otherwise",   TOKEN_KW_OTHERWISE},
    {"rule",        TOKEN_KW_RULE},
    {"schedule",    TOKEN_KW_SCHEDULE},
    {"site",        TOKEN_KW_SITE},
    {"source",      TOKEN_KW_SOURCE},
    {"suppress",    TOKEN_KW_SUPPRESS},
    {"terminology", TOKEN_KW_TERMINOLOGY},
    {"then",        TOKEN_KW_THEN},
    {"when",        TOKEN_KW_WHEN},
    {"where",       TOKEN_KW_WHERE},
    {"within",      TOKEN_KW_WITHIN}
};

static const size_t KEYWORD_COUNT = sizeof(KEYWORD_TABLE) / sizeof(KEYWORD_TABLE[0]);

bool keywords_lookup(const char *str, TokenType *out_type) {
    if (!str || !out_type) return false;

    /* Binary search */
    int low = 0;
    int high = (int)KEYWORD_COUNT - 1;

    while (low <= high) {
        int mid = low + (high - low) / 2;
        int cmp = strcmp(str, KEYWORD_TABLE[mid].word);
        if (cmp == 0) {
            *out_type = KEYWORD_TABLE[mid].type;
            return true;
        } else if (cmp < 0) {
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }

    return false;
}

bool token_is_keyword(TokenType type) {
    return (type >= TOKEN_KW_RULE && type <= TOKEN_KW_END);
}
