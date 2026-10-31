#include "parser.h"
#include "keywords.h"
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>

void parser_init(Parser *parser, const TokenList *tokens, DiagnosticEngine *diag) {
    if (!parser) return;
    parser->tokens = tokens;
    parser->current = 0;
    parser->diag = diag;
    parser->panic_mode = false;
}

static Token peek_tok(const Parser *parser) {
    if (!parser->tokens || parser->current >= parser->tokens->count) {
        return token_create(TOKEN_EOF, "", 0, 0);
    }
    return parser->tokens->items[parser->current];
}

static Token previous_tok(const Parser *parser) {
    if (!parser->tokens || parser->current == 0) {
        return token_create(TOKEN_EOF, "", 0, 0);
    }
    return parser->tokens->items[parser->current - 1];
}

static bool is_at_end(const Parser *parser) {
    return peek_tok(parser).type == TOKEN_EOF;
}

static Token advance_tok(Parser *parser) {
    if (!is_at_end(parser)) {
        parser->current++;
    }
    return previous_tok(parser);
}

static bool check_tok(const Parser *parser, TokenType type) {
    if (is_at_end(parser)) return false;
    return peek_tok(parser).type == type;
}

static bool match_tok(Parser *parser, TokenType type) {
    if (check_tok(parser, type)) {
        advance_tok(parser);
        return true;
    }
    return false;
}

static void error_at_current(Parser *parser, const char *fmt, ...) {
    if (parser->panic_mode) return;
    parser->panic_mode = true;

    Token tok = peek_tok(parser);
    char buf[512];
    va_list args;
    va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);

    if (parser->diag) {
        diag_report(parser->diag, DIAG_SYNTAX_ERROR, tok.line, tok.column, "%s", buf);
    }
}

static bool consume_tok(Parser *parser, TokenType type, const char *msg) {
    if (check_tok(parser, type)) {
        advance_tok(parser);
        return true;
    }
    error_at_current(parser, "%s. Got '%s'", msg, peek_tok(parser).lexeme);
    return false;
}

/* Panic-mode synchronization to recover from syntax errors */
static void synchronize(Parser *parser) {
    parser->panic_mode = false;

    if (!is_at_end(parser)) {
        advance_tok(parser);
    }

    while (!is_at_end(parser)) {
        TokenType t = peek_tok(parser).type;
        switch (t) {
            case TOKEN_KW_RULE:
            case TOKEN_KW_END:
            case TOKEN_KW_INTENT:
            case TOKEN_KW_SCHEDULE:
            case TOKEN_KW_TERMINOLOGY:
            case TOKEN_KW_SITE:
            case TOKEN_KW_SOURCE:
            case TOKEN_KW_BIND:
            case TOKEN_KW_LET:
            case TOKEN_KW_WHEN:
            case TOKEN_KW_THEN:
            case TOKEN_KW_ALERT:
            case TOKEN_KW_SUPPRESS:
            case TOKEN_KW_OTHERWISE:
                return;
            default:
                break;
        }
        advance_tok(parser);
    }
}

/* Forward declarations */
static bool parse_rule_decl(Parser *parser);
static bool parse_rule_element(Parser *parser);
static bool parse_intent_decl(Parser *parser);
static bool parse_schedule_decl(Parser *parser);
static bool parse_terminology_decl(Parser *parser);
static bool parse_site_decl(Parser *parser);
static bool parse_source_decl(Parser *parser);
static bool parse_bind_decl(Parser *parser);
static bool parse_let_decl(Parser *parser);
static bool parse_when_stmt(Parser *parser);
static bool parse_action_stmt(Parser *parser);
static bool parse_alert_stmt(Parser *parser);
static bool parse_suppress_stmt(Parser *parser);

static bool parse_expression(Parser *parser);
static bool parse_or_expr(Parser *parser);
static bool parse_and_expr(Parser *parser);
static bool parse_unary_expr(Parser *parser);
static bool parse_comparison_expr(Parser *parser);
static bool parse_postfix_expr(Parser *parser);
static bool parse_primary_expr(Parser *parser);
static bool parse_where_clause(Parser *parser);
static bool parse_within_clause(Parser *parser);
static bool parse_duration_expr(Parser *parser);
static bool parse_argument_list(Parser *parser);

/* --- Expression Parsing --- */

static bool parse_primary_expr(Parser *parser) {
    if (match_tok(parser, TOKEN_IDENTIFIER)) {
        return true;
    }
    if (match_tok(parser, TOKEN_INT_LIT)) {
        return true;
    }
    if (match_tok(parser, TOKEN_FLOAT_LIT)) {
        return true;
    }
    if (match_tok(parser, TOKEN_STRING_LIT)) {
        return true;
    }
    if (match_tok(parser, TOKEN_KW_LATEST)) {
        return true;
    }
    if (match_tok(parser, TOKEN_LPAREN)) {
        if (!parse_expression(parser)) return false;
        if (!consume_tok(parser, TOKEN_RPAREN, "Expected ')' after grouped expression")) {
            return false;
        }
        return true;
    }

    error_at_current(parser, "Expected expression");
    return false;
}

static bool is_member_name_token(TokenType t) {
    return (t == TOKEN_IDENTIFIER ||
            t == TOKEN_KW_LATEST ||
            t == TOKEN_KW_SOURCE ||
            t == TOKEN_KW_SITE ||
            t == TOKEN_KW_SCHEDULE ||
            t == TOKEN_KW_TERMINOLOGY);
}

static bool parse_argument_list(Parser *parser) {
    if (!parse_expression(parser)) return false;
    while (match_tok(parser, TOKEN_COMMA)) {
        if (!parse_expression(parser)) return false;
    }
    return true;
}

static bool parse_postfix_expr(Parser *parser) {
    if (!parse_primary_expr(parser)) return false;

    while (true) {
        if (match_tok(parser, TOKEN_DOT)) {
            if (is_member_name_token(peek_tok(parser).type)) {
                advance_tok(parser);
            } else {
                error_at_current(parser, "Expected member name after '.'");
                return false;
            }
        } else if (match_tok(parser, TOKEN_ARROW)) {
            if (is_member_name_token(peek_tok(parser).type)) {
                advance_tok(parser);
            } else {
                error_at_current(parser, "Expected member name after '->'");
                return false;
            }
        } else if (match_tok(parser, TOKEN_LBRACKET)) {
            if (!parse_expression(parser)) return false;
            if (!consume_tok(parser, TOKEN_RBRACKET, "Expected ']' after index/filter expression")) {
                return false;
            }
        } else if (match_tok(parser, TOKEN_LPAREN)) {
            if (!check_tok(parser, TOKEN_RPAREN)) {
                if (!parse_argument_list(parser)) return false;
            }
            if (!consume_tok(parser, TOKEN_RPAREN, "Expected ')' after argument list")) {
                return false;
            }
        } else {
            break;
        }
    }
    return true;
}

static bool is_comp_op(TokenType t) {
    return (t == TOKEN_EQ || t == TOKEN_NEQ ||
            t == TOKEN_GT || t == TOKEN_GTE ||
            t == TOKEN_LT || t == TOKEN_LTE ||
            t == TOKEN_EQUAL);
}

static bool parse_comparison_expr(Parser *parser) {
    if (!parse_postfix_expr(parser)) return false;

    if (is_comp_op(peek_tok(parser).type)) {
        advance_tok(parser); /* Consume comparison operator */
        if (!parse_postfix_expr(parser)) {
            return false;
        }
    }

    if (check_tok(parser, TOKEN_KW_WHERE)) {
        if (!parse_where_clause(parser)) return false;
    }

    if (check_tok(parser, TOKEN_KW_WITHIN)) {
        if (!parse_within_clause(parser)) return false;
    }

    return true;
}

static bool parse_unary_expr(Parser *parser) {
    if (match_tok(parser, TOKEN_KW_NOT)) {
        return parse_unary_expr(parser);
    }
    return parse_comparison_expr(parser);
}

static bool parse_and_expr(Parser *parser) {
    if (!parse_unary_expr(parser)) return false;

    while (match_tok(parser, TOKEN_KW_AND)) {
        if (!parse_unary_expr(parser)) return false;
    }
    return true;
}

static bool parse_or_expr(Parser *parser) {
    if (!parse_and_expr(parser)) return false;

    while (match_tok(parser, TOKEN_KW_OR)) {
        if (!parse_and_expr(parser)) return false;
    }
    return true;
}

static bool parse_expression(Parser *parser) {
    return parse_or_expr(parser);
}

static bool parse_where_clause(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_WHERE, "Expected 'where'")) return false;
    return parse_expression(parser);
}

static bool parse_duration_expr(Parser *parser) {
    if (match_tok(parser, TOKEN_INT_LIT) || match_tok(parser, TOKEN_FLOAT_LIT)) {
        /* Optional unit identifier e.g. 'hours', 'minutes', 'days', 'm' */
        if (check_tok(parser, TOKEN_IDENTIFIER)) {
            advance_tok(parser);
        }
        return true;
    }
    if (match_tok(parser, TOKEN_STRING_LIT)) {
        return true;
    }
    if (match_tok(parser, TOKEN_IDENTIFIER)) {
        return true;
    }
    error_at_current(parser, "Expected duration expression (e.g. 24 hours, \"30m\")");
    return false;
}

static bool parse_within_clause(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_WITHIN, "Expected 'within'")) return false;
    return parse_duration_expr(parser);
}

/* --- Declarations & Statements --- */

static bool parse_intent_decl(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_INTENT, "Expected 'intent'")) return false;
    match_tok(parser, TOKEN_COLON); /* Optional colon */
    if (!consume_tok(parser, TOKEN_STRING_LIT, "Expected string literal after 'intent'")) {
        return false;
    }
    return true;
}

static bool parse_schedule_decl(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_SCHEDULE, "Expected 'schedule'")) return false;
    match_tok(parser, TOKEN_COLON); /* Optional colon */
    if (check_tok(parser, TOKEN_STRING_LIT)) {
        advance_tok(parser);
        return true;
    }
    return parse_duration_expr(parser);
}

static bool parse_terminology_decl(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_TERMINOLOGY, "Expected 'terminology'")) return false;
    match_tok(parser, TOKEN_COLON); /* Optional colon */
    if (!consume_tok(parser, TOKEN_IDENTIFIER, "Expected terminology system name (e.g. LOINC, SNOMED)")) {
        return false;
    }
    if (match_tok(parser, TOKEN_LPAREN)) {
        if (!check_tok(parser, TOKEN_RPAREN)) {
            if (!parse_argument_list(parser)) return false;
        }
        if (!consume_tok(parser, TOKEN_RPAREN, "Expected ')' after terminology arguments")) {
            return false;
        }
    }
    if (check_tok(parser, TOKEN_STRING_LIT)) {
        advance_tok(parser);
    }
    return true;
}

static bool parse_site_decl(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_SITE, "Expected 'site'")) return false;
    match_tok(parser, TOKEN_COLON); /* Optional colon */
    if (match_tok(parser, TOKEN_IDENTIFIER) || match_tok(parser, TOKEN_STRING_LIT)) {
        return true;
    }
    error_at_current(parser, "Expected site name or string after 'site'");
    return false;
}

static bool parse_source_decl(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_SOURCE, "Expected 'source'")) return false;
    match_tok(parser, TOKEN_COLON); /* Optional colon */
    if (!consume_tok(parser, TOKEN_IDENTIFIER, "Expected source name")) {
        return false;
    }
    if (match_tok(parser, TOKEN_ARROW)) {
        if (!consume_tok(parser, TOKEN_IDENTIFIER, "Expected target system after '->'")) {
            return false;
        }
    }
    if (match_tok(parser, TOKEN_LPAREN)) {
        if (!check_tok(parser, TOKEN_RPAREN)) {
            if (!parse_argument_list(parser)) return false;
        }
        if (!consume_tok(parser, TOKEN_RPAREN, "Expected ')' after source arguments")) {
            return false;
        }
    }
    return true;
}

static bool parse_bind_decl(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_BIND, "Expected 'bind'")) return false;
    if (!consume_tok(parser, TOKEN_IDENTIFIER, "Expected identifier after 'bind'")) {
        return false;
    }
    /* Delimiter between name and expression: :=, =, :, -> */
    if (match_tok(parser, TOKEN_ASSIGN) || match_tok(parser, TOKEN_EQUAL) ||
        match_tok(parser, TOKEN_COLON) || match_tok(parser, TOKEN_ARROW)) {
        /* Consumed delimiter */
    }
    if (!parse_postfix_expr(parser)) {
        return false;
    }
    if (check_tok(parser, TOKEN_KW_WHERE)) {
        if (!parse_where_clause(parser)) return false;
    }
    if (check_tok(parser, TOKEN_KW_WITHIN)) {
        if (!parse_within_clause(parser)) return false;
    }
    return true;
}

static bool parse_let_decl(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_LET, "Expected 'let'")) return false;
    if (!consume_tok(parser, TOKEN_IDENTIFIER, "Expected variable name after 'let'")) {
        return false;
    }
    if (!match_tok(parser, TOKEN_ASSIGN) && !match_tok(parser, TOKEN_EQUAL)) {
        error_at_current(parser, "Expected ':=' or '=' in let assignment");
        return false;
    }
    return parse_expression(parser);
}

static bool parse_alert_stmt(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_ALERT, "Expected 'alert'")) return false;
    match_tok(parser, TOKEN_COLON); /* Optional colon */
    if (!parse_expression(parser)) return false;
    while (match_tok(parser, TOKEN_COMMA)) {
        if (!parse_expression(parser)) return false;
    }
    return true;
}

static bool parse_suppress_stmt(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_SUPPRESS, "Expected 'suppress'")) return false;
    match_tok(parser, TOKEN_COLON); /* Optional colon */
    if (check_tok(parser, TOKEN_KW_WITHIN)) {
        return parse_within_clause(parser);
    }
    if (match_tok(parser, TOKEN_STRING_LIT) || match_tok(parser, TOKEN_IDENTIFIER)) {
        return true;
    }
    return parse_duration_expr(parser);
}

static bool parse_action_stmt(Parser *parser) {
    if (check_tok(parser, TOKEN_KW_ALERT)) {
        return parse_alert_stmt(parser);
    }
    if (check_tok(parser, TOKEN_KW_SUPPRESS)) {
        return parse_suppress_stmt(parser);
    }
    error_at_current(parser, "Expected action statement ('alert' or 'suppress')");
    return false;
}

static bool is_statement_start(TokenType t) {
    return (t == TOKEN_KW_LET || t == TOKEN_KW_ALERT ||
            t == TOKEN_KW_SUPPRESS || t == TOKEN_KW_WHEN);
}

static bool parse_statement_in_branch(Parser *parser) {
    if (check_tok(parser, TOKEN_KW_LET)) {
        return parse_let_decl(parser);
    }
    if (check_tok(parser, TOKEN_KW_ALERT) || check_tok(parser, TOKEN_KW_SUPPRESS)) {
        return parse_action_stmt(parser);
    }
    if (check_tok(parser, TOKEN_KW_WHEN)) {
        return parse_when_stmt(parser);
    }
    error_at_current(parser, "Expected statement inside branch");
    return false;
}

static bool parse_when_stmt(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_WHEN, "Expected 'when'")) return false;

    if (match_tok(parser, TOKEN_KW_FOR)) {
        if (!consume_tok(parser, TOKEN_IDENTIFIER, "Expected identifier after 'for'")) {
            return false;
        }
    }

    if (!parse_expression(parser)) return false;

    match_tok(parser, TOKEN_COLON); /* Optional colon before then */

    if (!consume_tok(parser, TOKEN_KW_THEN, "Expected 'then' after when condition")) {
        return false;
    }
    match_tok(parser, TOKEN_COLON); /* Optional colon after then */

    /* Consume statements in 'then' branch */
    bool had_stmt = false;
    while (!is_at_end(parser) && is_statement_start(peek_tok(parser).type)) {
        had_stmt = true;
        if (!parse_statement_in_branch(parser)) {
            synchronize(parser);
        }
    }

    if (!had_stmt) {
        error_at_current(parser, "Expected at least one statement in 'then' branch");
        return false;
    }

    /* Optional otherwise branch */
    if (match_tok(parser, TOKEN_KW_OTHERWISE)) {
        match_tok(parser, TOKEN_COLON); /* Optional colon */
        bool had_otherwise_stmt = false;
        while (!is_at_end(parser) && is_statement_start(peek_tok(parser).type)) {
            had_otherwise_stmt = true;
            if (!parse_statement_in_branch(parser)) {
                synchronize(parser);
            }
        }
        if (!had_otherwise_stmt) {
            error_at_current(parser, "Expected at least one statement in 'otherwise' branch");
            return false;
        }
    }

    return true;
}

static bool is_rule_element_start(TokenType t) {
    return (t == TOKEN_KW_INTENT ||
            t == TOKEN_KW_SCHEDULE ||
            t == TOKEN_KW_TERMINOLOGY ||
            t == TOKEN_KW_SITE ||
            t == TOKEN_KW_SOURCE ||
            t == TOKEN_KW_BIND ||
            t == TOKEN_KW_LET ||
            t == TOKEN_KW_WHEN ||
            t == TOKEN_KW_ALERT ||
            t == TOKEN_KW_SUPPRESS);
}

static bool parse_rule_element(Parser *parser) {
    switch (peek_tok(parser).type) {
        case TOKEN_KW_INTENT:      return parse_intent_decl(parser);
        case TOKEN_KW_SCHEDULE:    return parse_schedule_decl(parser);
        case TOKEN_KW_TERMINOLOGY: return parse_terminology_decl(parser);
        case TOKEN_KW_SITE:        return parse_site_decl(parser);
        case TOKEN_KW_SOURCE:      return parse_source_decl(parser);
        case TOKEN_KW_BIND:        return parse_bind_decl(parser);
        case TOKEN_KW_LET:         return parse_let_decl(parser);
        case TOKEN_KW_WHEN:        return parse_when_stmt(parser);
        case TOKEN_KW_ALERT:
        case TOKEN_KW_SUPPRESS:    return parse_action_stmt(parser);
        default:
            error_at_current(parser, "Unexpected token '%s' in rule body", peek_tok(parser).lexeme);
            return false;
    }
}

static bool parse_rule_decl(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_RULE, "Expected 'rule'")) return false;
    if (!consume_tok(parser, TOKEN_IDENTIFIER, "Expected rule name identifier")) {
        return false;
    }

    match_tok(parser, TOKEN_COLON); /* Optional colon */

    while (!is_at_end(parser) && !check_tok(parser, TOKEN_KW_END)) {
        if (is_rule_element_start(peek_tok(parser).type)) {
            if (!parse_rule_element(parser)) {
                synchronize(parser);
            }
        } else {
            error_at_current(parser, "Unexpected token '%s' in rule declaration", peek_tok(parser).lexeme);
            synchronize(parser);
        }
    }

    if (!consume_tok(parser, TOKEN_KW_END, "Expected 'end' to terminate rule declaration")) {
        return false;
    }

    return true;
}

bool parser_parse(Parser *parser) {
    if (!parser) return false;

    if (is_at_end(parser)) {
        error_at_current(parser, "Empty program: expected at least one rule declaration");
        return false;
    }

    while (!is_at_end(parser)) {
        if (check_tok(parser, TOKEN_KW_RULE)) {
            if (!parse_rule_decl(parser)) {
                synchronize(parser);
            }
        } else {
            error_at_current(parser, "Expected 'rule' declaration. Found '%s'", peek_tok(parser).lexeme);
            advance_tok(parser);
            while (!is_at_end(parser) && !check_tok(parser, TOKEN_KW_RULE)) {
                advance_tok(parser);
            }
            parser->panic_mode = false;
        }
    }

    return (parser->diag ? parser->diag->syntax_errors == 0 : true);
}
