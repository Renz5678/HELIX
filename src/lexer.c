#include "lexer.h"
#include "keywords.h"
#include <ctype.h>
#include <stdlib.h>
#include <string.h>

void lexer_init(Lexer *lexer, const SourceBuffer *source, DiagnosticEngine *diag) {
    if (!lexer) return;
    lexer->source = source;
    lexer->diag = diag;
    lexer->cursor = 0;
    lexer->line = 1;
    lexer->column = 1;
}

static char peek_char(const Lexer *lexer) {
    if (!lexer->source || !lexer->source->content) return '\0';
    if (lexer->cursor >= lexer->source->length) return '\0';
    return lexer->source->content[lexer->cursor];
}

static char peek_next(const Lexer *lexer) {
    if (!lexer->source || !lexer->source->content) return '\0';
    if (lexer->cursor + 1 >= lexer->source->length) return '\0';
    return lexer->source->content[lexer->cursor + 1];
}

static char advance_char(Lexer *lexer) {
    char c = peek_char(lexer);
    if (c == '\0') return '\0';

    lexer->cursor++;
    if (c == '\n') {
        lexer->line++;
        lexer->column = 1;
    } else {
        lexer->column++;
    }
    return c;
}

static void skip_whitespace_and_comments(Lexer *lexer) {
    while (true) {
        char c = peek_char(lexer);
        if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
            advance_char(lexer);
        } else if (c == '#') {
            /* Comment: skip until newline or EOF */
            while (peek_char(lexer) != '\0' && peek_char(lexer) != '\n') {
                advance_char(lexer);
            }
        } else {
            break;
        }
    }
}

static Token scan_identifier_or_keyword(Lexer *lexer) {
    size_t start_col = lexer->column;
    size_t start_line = lexer->line;
    size_t start_pos = lexer->cursor;

    /* First char is [a-zA-Z_] */
    advance_char(lexer);

    while (true) {
        char c = peek_char(lexer);
        if (isalnum((unsigned char)c) || c == '_') {
            advance_char(lexer);
        } else {
            break;
        }
    }

    size_t len = lexer->cursor - start_pos;
    char *buf = (char *)malloc(len + 1);
    if (!buf) {
        return token_create(TOKEN_ERROR, "Out of memory", start_line, start_col);
    }
    memcpy(buf, &lexer->source->content[start_pos], len);
    buf[len] = '\0';

    TokenType type = TOKEN_IDENTIFIER;
    keywords_lookup(buf, &type);

    Token tok = token_create(type, buf, start_line, start_col);
    free(buf);
    return tok;
}

static Token scan_number(Lexer *lexer) {
    size_t start_col = lexer->column;
    size_t start_line = lexer->line;
    size_t start_pos = lexer->cursor;

    while (isdigit((unsigned char)peek_char(lexer))) {
        advance_char(lexer);
    }

    bool is_float = false;
    /* Check for decimal point followed by a digit */
    if (peek_char(lexer) == '.' && isdigit((unsigned char)peek_next(lexer))) {
        is_float = true;
        advance_char(lexer); /* Consume '.' */
        while (isdigit((unsigned char)peek_char(lexer))) {
            advance_char(lexer);
        }
    }

    /* Check for malformed trailing letters immediately attached, e.g. 123abc */
    if (isalpha((unsigned char)peek_char(lexer)) || peek_char(lexer) == '_') {
        while (isalnum((unsigned char)peek_char(lexer)) || peek_char(lexer) == '_') {
            advance_char(lexer);
        }
        size_t len = lexer->cursor - start_pos;
        char *buf = (char *)malloc(len + 1);
        if (buf) {
            memcpy(buf, &lexer->source->content[start_pos], len);
            buf[len] = '\0';
        }
        if (lexer->diag) {
            diag_report(lexer->diag, DIAG_LEXICAL_ERROR, start_line, start_col,
                        "Malformed numeric literal '%s' contains invalid suffix", buf ? buf : "");
        }
        Token tok = token_create(TOKEN_ERROR, buf ? buf : "", start_line, start_col);
        free(buf);
        return tok;
    }

    /* Check for malformed double dots e.g. 12.34.56 */
    if (is_float && peek_char(lexer) == '.') {
        while (isdigit((unsigned char)peek_char(lexer)) || peek_char(lexer) == '.') {
            advance_char(lexer);
        }
        size_t len = lexer->cursor - start_pos;
        char *buf = (char *)malloc(len + 1);
        if (buf) {
            memcpy(buf, &lexer->source->content[start_pos], len);
            buf[len] = '\0';
        }
        if (lexer->diag) {
            diag_report(lexer->diag, DIAG_LEXICAL_ERROR, start_line, start_col,
                        "Malformed numeric literal '%s' has multiple decimal points", buf ? buf : "");
        }
        Token tok = token_create(TOKEN_ERROR, buf ? buf : "", start_line, start_col);
        free(buf);
        return tok;
    }

    size_t len = lexer->cursor - start_pos;
    char *buf = (char *)malloc(len + 1);
    if (!buf) {
        return token_create(TOKEN_ERROR, "Out of memory", start_line, start_col);
    }
    memcpy(buf, &lexer->source->content[start_pos], len);
    buf[len] = '\0';

    TokenType type = is_float ? TOKEN_FLOAT_LIT : TOKEN_INT_LIT;
    Token tok = token_create(type, buf, start_line, start_col);
    free(buf);
    return tok;
}

static Token scan_string(Lexer *lexer) {
    size_t start_col = lexer->column;
    size_t start_line = lexer->line;
    size_t start_pos = lexer->cursor;

    advance_char(lexer); /* Consume opening quote '"' */

    while (true) {
        char c = peek_char(lexer);
        if (c == '\0' || c == '\n') {
            /* Unterminated string literal */
            if (lexer->diag) {
                diag_report(lexer->diag, DIAG_LEXICAL_ERROR, start_line, start_col,
                            "Unterminated string literal");
            }
            return token_create(TOKEN_ERROR, "Unterminated string", start_line, start_col);
        }

        if (c == '"') {
            advance_char(lexer); /* Consume closing quote */
            break;
        }

        if (c == '\\') {
            advance_char(lexer); /* Consume backslash */
            char esc = peek_char(lexer);
            if (esc != '\0') {
                advance_char(lexer);
            }
        } else {
            advance_char(lexer);
        }
    }

    size_t len = lexer->cursor - start_pos;
    char *buf = (char *)malloc(len + 1);
    if (!buf) {
        return token_create(TOKEN_ERROR, "Out of memory", start_line, start_col);
    }
    memcpy(buf, &lexer->source->content[start_pos], len);
    buf[len] = '\0';

    Token tok = token_create(TOKEN_STRING_LIT, buf, start_line, start_col);
    free(buf);
    return tok;
}

Token lexer_next_token(Lexer *lexer) {
    skip_whitespace_and_comments(lexer);

    size_t start_col = lexer->column;
    size_t start_line = lexer->line;
    char c = peek_char(lexer);

    if (c == '\0') {
        return token_create(TOKEN_EOF, "", start_line, start_col);
    }

    /* Identifiers and reserved words */
    if (isalpha((unsigned char)c) || c == '_') {
        return scan_identifier_or_keyword(lexer);
    }

    /* Numeric literals */
    if (isdigit((unsigned char)c)) {
        return scan_number(lexer);
    }

    /* String literals */
    if (c == '"') {
        return scan_string(lexer);
    }

    /* Multi-character and single-character operators & delimiters */
    advance_char(lexer);
    switch (c) {
        case ':':
            if (peek_char(lexer) == '=') {
                advance_char(lexer);
                return token_create(TOKEN_ASSIGN, ":=", start_line, start_col);
            }
            return token_create(TOKEN_COLON, ":", start_line, start_col);

        case '=':
            if (peek_char(lexer) == '=') {
                advance_char(lexer);
                return token_create(TOKEN_EQ, "==", start_line, start_col);
            }
            return token_create(TOKEN_EQUAL, "=", start_line, start_col);

        case '!':
            if (peek_char(lexer) == '=') {
                advance_char(lexer);
                return token_create(TOKEN_NEQ, "!=", start_line, start_col);
            }
            /* Lone '!' is unsupported in HELIX ('not' keyword is used for negation) */
            if (lexer->diag) {
                diag_report(lexer->diag, DIAG_LEXICAL_ERROR, start_line, start_col,
                            "Unsupported operator '!'. Use 'not' for logical negation or '!=' for inequality");
            }
            return token_create(TOKEN_ERROR, "!", start_line, start_col);

        case '<':
            if (peek_char(lexer) == '=') {
                advance_char(lexer);
                return token_create(TOKEN_LTE, "<=", start_line, start_col);
            }
            return token_create(TOKEN_LT, "<", start_line, start_col);

        case '>':
            if (peek_char(lexer) == '=') {
                advance_char(lexer);
                return token_create(TOKEN_GTE, ">=", start_line, start_col);
            }
            return token_create(TOKEN_GT, ">", start_line, start_col);

        case '-':
            if (peek_char(lexer) == '>') {
                advance_char(lexer);
                return token_create(TOKEN_ARROW, "->", start_line, start_col);
            }
            /* Lone '-' without digits */
            if (lexer->diag) {
                diag_report(lexer->diag, DIAG_LEXICAL_ERROR, start_line, start_col,
                            "Unsupported lone character '-' (did you mean '->'?)");
            }
            return token_create(TOKEN_ERROR, "-", start_line, start_col);

        case '.':
            return token_create(TOKEN_DOT, ".", start_line, start_col);

        case ',':
            return token_create(TOKEN_COMMA, ",", start_line, start_col);

        case '(':
            return token_create(TOKEN_LPAREN, "(", start_line, start_col);

        case ')':
            return token_create(TOKEN_RPAREN, ")", start_line, start_col);

        case '[':
            return token_create(TOKEN_LBRACKET, "[", start_line, start_col);

        case ']':
            return token_create(TOKEN_RBRACKET, "]", start_line, start_col);

        default: {
            char lexeme[2] = {c, '\0'};
            if (lexer->diag) {
                diag_report(lexer->diag, DIAG_LEXICAL_ERROR, start_line, start_col,
                            "Unrecognized character '%c' (0x%02X)", c, (unsigned char)c);
            }
            return token_create(TOKEN_ERROR, lexeme, start_line, start_col);
        }
    }
}

bool lexer_tokenize_all(Lexer *lexer, TokenList *out_tokens) {
    if (!lexer || !out_tokens) return false;
    token_list_init(out_tokens);

    bool success = true;
    while (true) {
        Token tok = lexer_next_token(lexer);
        if (tok.type == TOKEN_ERROR) {
            success = false;
        }
        token_list_append(out_tokens, tok);
        if (tok.type == TOKEN_EOF) {
            break;
        }
    }

    return success && (lexer->diag ? lexer->diag->lexical_errors == 0 : true);
}
