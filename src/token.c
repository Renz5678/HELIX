#include "token.h"
#include <stdlib.h>
#include <string.h>

static char *duplicate_string(const char *s) {
    if (!s) return NULL;
    size_t len = strlen(s);
    char *copy = (char *)malloc(len + 1);
    if (copy) {
        memcpy(copy, s, len + 1);
    }
    return copy;
}

Token token_create(TokenType type, const char *lexeme, size_t line, size_t column) {
    Token t;
    t.type = type;
    t.lexeme = duplicate_string(lexeme ? lexeme : "");
    t.line = line;
    t.column = column;
    return t;
}

void token_free(Token *token) {
    if (!token) return;
    if (token->lexeme) {
        free(token->lexeme);
        token->lexeme = NULL;
    }
}

const char *token_type_name(TokenType type) {
    switch (type) {
        case TOKEN_KW_RULE:        return "TOKEN_KW_RULE";
        case TOKEN_KW_INTENT:      return "TOKEN_KW_INTENT";
        case TOKEN_KW_BIND:        return "TOKEN_KW_BIND";
        case TOKEN_KW_SITE:        return "TOKEN_KW_SITE";
        case TOKEN_KW_SOURCE:      return "TOKEN_KW_SOURCE";
        case TOKEN_KW_TERMINOLOGY: return "TOKEN_KW_TERMINOLOGY";
        case TOKEN_KW_SCHEDULE:    return "TOKEN_KW_SCHEDULE";
        case TOKEN_KW_WHEN:        return "TOKEN_KW_WHEN";
        case TOKEN_KW_FOR:         return "TOKEN_KW_FOR";
        case TOKEN_KW_LET:         return "TOKEN_KW_LET";
        case TOKEN_KW_LATEST:      return "TOKEN_KW_LATEST";
        case TOKEN_KW_WHERE:       return "TOKEN_KW_WHERE";
        case TOKEN_KW_AND:         return "TOKEN_KW_AND";
        case TOKEN_KW_OR:          return "TOKEN_KW_OR";
        case TOKEN_KW_NOT:         return "TOKEN_KW_NOT";
        case TOKEN_KW_WITHIN:      return "TOKEN_KW_WITHIN";
        case TOKEN_KW_THEN:        return "TOKEN_KW_THEN";
        case TOKEN_KW_ALERT:       return "TOKEN_KW_ALERT";
        case TOKEN_KW_SUPPRESS:    return "TOKEN_KW_SUPPRESS";
        case TOKEN_KW_OTHERWISE:   return "TOKEN_KW_OTHERWISE";
        case TOKEN_KW_END:         return "TOKEN_KW_END";

        case TOKEN_IDENTIFIER:     return "TOKEN_IDENTIFIER";
        case TOKEN_INT_LIT:        return "TOKEN_INT_LIT";
        case TOKEN_FLOAT_LIT:      return "TOKEN_FLOAT_LIT";
        case TOKEN_STRING_LIT:     return "TOKEN_STRING_LIT";

        case TOKEN_ASSIGN:         return "TOKEN_ASSIGN";
        case TOKEN_EQUAL:          return "TOKEN_EQUAL";
        case TOKEN_EQ:             return "TOKEN_EQ";
        case TOKEN_NEQ:            return "TOKEN_NEQ";
        case TOKEN_GT:             return "TOKEN_GT";
        case TOKEN_GTE:            return "TOKEN_GTE";
        case TOKEN_LT:             return "TOKEN_LT";
        case TOKEN_LTE:            return "TOKEN_LTE";
        case TOKEN_ARROW:          return "TOKEN_ARROW";
        case TOKEN_PLUS:           return "TOKEN_PLUS";
        case TOKEN_MINUS:          return "TOKEN_MINUS";
        case TOKEN_STAR:           return "TOKEN_STAR";
        case TOKEN_SLASH:          return "TOKEN_SLASH";

        case TOKEN_COLON:          return "TOKEN_COLON";
        case TOKEN_DOT:            return "TOKEN_DOT";
        case TOKEN_COMMA:          return "TOKEN_COMMA";
        case TOKEN_LPAREN:         return "TOKEN_LPAREN";
        case TOKEN_RPAREN:         return "TOKEN_RPAREN";
        case TOKEN_LBRACKET:       return "TOKEN_LBRACKET";
        case TOKEN_RBRACKET:       return "TOKEN_RBRACKET";

        case TOKEN_EOF:            return "TOKEN_EOF";
        case TOKEN_ERROR:          return "TOKEN_ERROR";
    }
    return "UNKNOWN_TOKEN";
}

const char *token_type_description(TokenType type) {
    switch (type) {
        case TOKEN_KW_RULE:        return "'rule'";
        case TOKEN_KW_INTENT:      return "'intent'";
        case TOKEN_KW_BIND:        return "'bind'";
        case TOKEN_KW_SITE:        return "'site'";
        case TOKEN_KW_SOURCE:      return "'source'";
        case TOKEN_KW_TERMINOLOGY: return "'terminology'";
        case TOKEN_KW_SCHEDULE:    return "'schedule'";
        case TOKEN_KW_WHEN:        return "'when'";
        case TOKEN_KW_FOR:         return "'for'";
        case TOKEN_KW_LET:         return "'let'";
        case TOKEN_KW_LATEST:      return "'latest'";
        case TOKEN_KW_WHERE:       return "'where'";
        case TOKEN_KW_AND:         return "'and'";
        case TOKEN_KW_OR:          return "'or'";
        case TOKEN_KW_NOT:         return "'not'";
        case TOKEN_KW_WITHIN:      return "'within'";
        case TOKEN_KW_THEN:        return "'then'";
        case TOKEN_KW_ALERT:       return "'alert'";
        case TOKEN_KW_SUPPRESS:    return "'suppress'";
        case TOKEN_KW_OTHERWISE:   return "'otherwise'";
        case TOKEN_KW_END:         return "'end'";

        case TOKEN_IDENTIFIER:     return "identifier";
        case TOKEN_INT_LIT:        return "integer literal";
        case TOKEN_FLOAT_LIT:      return "floating-point literal";
        case TOKEN_STRING_LIT:     return "string literal";

        case TOKEN_ASSIGN:         return "':='";
        case TOKEN_EQUAL:          return "'='";
        case TOKEN_EQ:             return "'=='";
        case TOKEN_NEQ:            return "'!='";
        case TOKEN_GT:             return "'>'";
        case TOKEN_GTE:            return "'>='";
        case TOKEN_LT:             return "'<'";
        case TOKEN_LTE:            return "'<='";
        case TOKEN_ARROW:          return "'->'";
        case TOKEN_PLUS:           return "'+'";
        case TOKEN_MINUS:          return "'-'";
        case TOKEN_STAR:           return "'*'";
        case TOKEN_SLASH:          return "'/'";

        case TOKEN_COLON:          return "':'";
        case TOKEN_DOT:            return "'.'";
        case TOKEN_COMMA:          return "','";
        case TOKEN_LPAREN:         return "'('";
        case TOKEN_RPAREN:         return "')'";
        case TOKEN_LBRACKET:       return "'['";
        case TOKEN_RBRACKET:       return "']'";

        case TOKEN_EOF:            return "end of file";
        case TOKEN_ERROR:          return "lexical error";
    }
    return "unknown token";
}

void token_list_init(TokenList *list) {
    if (!list) return;
    list->items = NULL;
    list->count = 0;
    list->capacity = 0;
}

bool token_list_append(TokenList *list, Token token) {
    if (!list) return false;
    if (list->count >= list->capacity) {
        size_t new_cap = (list->capacity == 0) ? 16 : list->capacity * 2;
        Token *new_items = (Token *)realloc(list->items, new_cap * sizeof(Token));
        if (!new_items) return false;
        list->items = new_items;
        list->capacity = new_cap;
    }
    list->items[list->count++] = token;
    return true;
}

void token_list_free(TokenList *list) {
    if (!list) return;
    for (size_t i = 0; i < list->count; i++) {
        token_free(&list->items[i]);
    }
    free(list->items);
    list->items = NULL;
    list->count = 0;
    list->capacity = 0;
}
