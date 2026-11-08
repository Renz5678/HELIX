#include "parser.h"
#include "keywords.h"
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int s_where_depth = 0;

void parser_init(Parser *parser, const TokenList *tokens, DiagnosticEngine *diag) {
    if (!parser)
        return;
    parser->tokens = tokens;
    parser->current = 0;
    parser->diag = diag;
    parser->panic_mode = false;
    s_where_depth = 0;
    parser->ast = NULL;
    parser->parent = NULL;
    parser->depth = 0;
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

static bool is_at_end(const Parser *parser) { return peek_tok(parser).type == TOKEN_EOF; }

static Token advance_tok(Parser *parser) {
    if (!is_at_end(parser)) {
        parser->current++;
    }
    return previous_tok(parser);
}

static bool check_tok(const Parser *parser, TokenType type) {
    if (is_at_end(parser))
        return false;
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
    if (parser->panic_mode)
        return;
    parser->panic_mode = true;

    Token tok = peek_tok(parser);
    char buf[512];
    va_list args;
    va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);

    if (parser->diag) {
        diag_report(parser->diag, DIAG_SYNTAX_ERROR, tok.line, tok.column, "%s", buf);
        if (parser->diag->count) {
            DiagnosticItem *d = &parser->diag->items[parser->diag->count - 1];
            d->start_offset = tok.start_offset;
            d->end_offset = tok.end_offset;
            d->end_column = tok.column + (tok.end_offset - tok.start_offset);
        }
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

static Token peek_next_tok(const Parser *parser) {
    if (!parser->tokens || parser->current + 1 >= parser->tokens->count) {
        return (Token){ .type = TOKEN_EOF, .lexeme = "" };
    }
    return parser->tokens->items[parser->current + 1];
}

static bool is_block_descriptor(TokenType t) {
    return (t == TOKEN_KW_RULE || t == TOKEN_KW_BIND || t == TOKEN_KW_WHEN);
}

static bool consume_block_end(Parser *parser, TokenType expected_kw, const char *block_name) {
    if (!check_tok(parser, TOKEN_KW_END)) {
        const char *got = peek_tok(parser).type == TOKEN_EOF ? "end of file" : peek_tok(parser).lexeme;
        error_at_current(parser, "Expected 'end %s' to terminate %s block. Got '%s'",
                         block_name, block_name, got);
        return false;
    }

    Token end_tok = peek_tok(parser);
    Token next_tok = peek_next_tok(parser);

    bool is_new_rule_decl = (next_tok.type == TOKEN_KW_RULE &&
                             next_tok.line > end_tok.line &&
                             parser->current + 2 < parser->tokens->count &&
                             parser->tokens->items[parser->current + 2].type == TOKEN_IDENTIFIER);

    bool is_missing_descriptor = (next_tok.type == TOKEN_EOF ||
                                  next_tok.type == TOKEN_KW_END ||
                                  (next_tok.line > end_tok.line && (!is_block_descriptor(next_tok.type) || is_new_rule_decl)));

    if (is_missing_descriptor) {
        error_at_current(parser, "Missing block descriptor after 'end': expected 'end %s'", block_name);
        return false;
    }

    if (next_tok.type == expected_kw) {
        advance_tok(parser); /* Consume 'end' */
        advance_tok(parser); /* Consume descriptor */
        return true;
    }

    if (is_block_descriptor(next_tok.type)) {
        advance_tok(parser); /* Move to descriptor token so error is anchored at it */
        error_at_current(parser, "Mismatched block terminator 'end %s': expected 'end %s'",
                         peek_tok(parser).lexeme, block_name);
        return false;
    }

    advance_tok(parser); /* Move to unknown descriptor token so error is anchored at it */
    error_at_current(parser, "Unknown block descriptor '%s' after 'end': expected 'end %s'",
                     peek_tok(parser).lexeme, block_name);
    return false;
}

/* Panic-mode synchronization to recover from syntax errors */
static void synchronize(Parser *parser) {
    parser->panic_mode = false;
    s_where_depth = 0;

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
            case TOKEN_KW_LATEST:
                return;
            default:
                break;
        }
        advance_tok(parser);
    }
}

/* Forward declarations */
static bool is_rule_element_start(TokenType t);
static bool is_member_name_token(TokenType t);
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
static bool parse_add_expr(Parser *parser);
static bool parse_mul_expr(Parser *parser);
static bool parse_neg_expr(Parser *parser);
static bool parse_postfix_expr(Parser *parser);
static bool parse_primary_expr(Parser *parser);
static bool parse_latest_query(Parser *parser);
static bool parse_where_clause(Parser *parser);
static bool parse_within_clause(Parser *parser);
static bool parse_duration_expr(Parser *parser);
static bool parse_argument_list(Parser *parser);

static bool impl_parse_primary_expr(Parser *parser);
static bool parse_primary_expr(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_PRIMARY, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_primary_expr(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_argument_list(Parser *parser);
static bool parse_argument_list(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_ARGUMENTS, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_argument_list(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_postfix_expr(Parser *parser);
static bool parse_postfix_expr(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_POSTFIX, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_postfix_expr(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_neg_expr(Parser *parser);
static bool parse_neg_expr(Parser *parser) {
    if (!check_tok(parser, TOKEN_MINUS))
        return parse_postfix_expr(parser);
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_UNARY, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_neg_expr(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_mul_expr(Parser *parser);
static bool parse_mul_expr(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_MUL, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_mul_expr(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_add_expr(Parser *parser);
static bool parse_add_expr(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_ADD, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_add_expr(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_comparison_expr(Parser *parser);
static bool parse_comparison_expr(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_COMPARISON, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_comparison_expr(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_unary_expr(Parser *parser);
static bool parse_unary_expr(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_UNARY, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_unary_expr(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_and_expr(Parser *parser);
static bool parse_and_expr(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_AND, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_and_expr(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_or_expr(Parser *parser);
static bool parse_or_expr(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_OR, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_or_expr(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_expression(Parser *parser);
static bool parse_expression(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_EXPRESSION, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_expression(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_where_clause(Parser *parser);
static bool parse_where_clause(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_WHERE, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_where_clause(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_duration_expr(Parser *parser);
static bool parse_duration_expr(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_DURATION, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_duration_expr(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_within_clause(Parser *parser);
static bool parse_within_clause(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_WITHIN, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_within_clause(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_intent_decl(Parser *parser);
static bool parse_intent_decl(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_INTENT, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_intent_decl(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_schedule_decl(Parser *parser);
static bool parse_schedule_decl(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_SCHEDULE, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_schedule_decl(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_terminology_decl(Parser *parser);
static bool parse_terminology_decl(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_TERMINOLOGY, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_terminology_decl(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_site_decl(Parser *parser);
static bool parse_site_decl(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_SITE, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_site_decl(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_source_decl(Parser *parser);
static bool parse_source_decl(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_SOURCE, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_source_decl(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_bind_decl(Parser *parser);
static bool parse_bind_decl(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_BIND, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_bind_decl(parser);
    if (node) {
        if (node->count > 0 && node->children[0]->kind == AST_SITE)
            node->kind = AST_SITE;
        node->end = parser->current;
    }
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_let_decl(Parser *parser);
static bool parse_let_decl(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_LET, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_let_decl(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_alert_stmt(Parser *parser);
static bool parse_alert_stmt(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_ALERT, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_alert_stmt(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_suppress_stmt(Parser *parser);
static bool parse_suppress_stmt(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_SUPPRESS, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_suppress_stmt(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_action_stmt(Parser *parser);
static bool parse_action_stmt(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_ACTION, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_action_stmt(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_statement_in_branch(Parser *parser);
static bool parse_statement_in_branch(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_BRANCH_STMT, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_statement_in_branch(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_when_stmt(Parser *parser);
static bool parse_when_stmt(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_WHEN, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_when_stmt(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_rule_element(Parser *parser);
static bool parse_rule_element(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_BRANCH_STMT, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_rule_element(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
static bool impl_parse_rule_decl(Parser *parser);
static bool parse_rule_decl(Parser *parser) {
    if (++parser->depth > 256) {
        --parser->depth;
        error_at_current(parser, "Parser nesting limit exceeded");
        return false;
    }
    AstNode *parent = parser->parent, *node = NULL;
    if (parser->ast) {
        node = ast_node_new(parser->ast, AST_RULE, parser->current);
        if (!node || !ast_append(parent, node)) {
            ast_node_free(node);
            parser->ast->failed = true;
            --parser->depth;
            return false;
        }
        parser->parent = node;
    }
    bool ok = impl_parse_rule_decl(parser);
    if (node)
        node->end = parser->current;
    parser->parent = parent;
    --parser->depth;
    return ok;
}
/* --- Expression Parsing --- */

static bool impl_parse_primary_expr(Parser *parser) {
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
    if (check_tok(parser, TOKEN_KW_LATEST)) {
        return parse_latest_query(parser);
    }
    if (match_tok(parser, TOKEN_LPAREN)) {
        if (!parse_expression(parser))
            return false;
        if (!consume_tok(parser, TOKEN_RPAREN, "Expected ')' after grouped expression")) {
            return false;
        }
        return true;
    }

    error_at_current(parser, "Expected expression");
    return false;
}

static bool is_member_name_token(TokenType t) {
    return (t == TOKEN_IDENTIFIER || t == TOKEN_KW_LATEST || t == TOKEN_KW_SOURCE ||
            t == TOKEN_KW_SITE || t == TOKEN_KW_SCHEDULE || t == TOKEN_KW_TERMINOLOGY);
}

static bool impl_parse_argument_list(Parser *parser) {
    if (!parse_expression(parser))
        return false;
    while (match_tok(parser, TOKEN_COMMA)) {
        if (!parse_expression(parser))
            return false;
    }
    return true;
}

static bool impl_parse_postfix_expr(Parser *parser) {
    if (!parse_primary_expr(parser))
        return false;

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
            if (!parse_expression(parser))
                return false;
            if (!consume_tok(parser, TOKEN_RBRACKET,
                             "Expected ']' after index/filter expression")) {
                return false;
            }
        } else if (match_tok(parser, TOKEN_LPAREN)) {
            if (!check_tok(parser, TOKEN_RPAREN)) {
                if (!parse_argument_list(parser))
                    return false;
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

static bool impl_parse_neg_expr(Parser *parser) {
    if (match_tok(parser, TOKEN_MINUS)) {
        return parse_neg_expr(parser);
    }
    return parse_postfix_expr(parser);
}

static bool impl_parse_mul_expr(Parser *parser) {
    if (!parse_neg_expr(parser))
        return false;

    while (match_tok(parser, TOKEN_STAR) || match_tok(parser, TOKEN_SLASH)) {
        if (!parse_neg_expr(parser))
            return false;
    }
    return true;
}

static bool impl_parse_add_expr(Parser *parser) {
    if (!parse_mul_expr(parser))
        return false;

    while (match_tok(parser, TOKEN_PLUS) || match_tok(parser, TOKEN_MINUS)) {
        if (!parse_mul_expr(parser))
            return false;
    }
    return true;
}

static bool is_comp_op(TokenType t) {
    return (t == TOKEN_EQ || t == TOKEN_NEQ || t == TOKEN_GT || t == TOKEN_GTE || t == TOKEN_LT ||
            t == TOKEN_LTE || t == TOKEN_EQUAL);
}

static bool impl_parse_comparison_expr(Parser *parser) {
    if (!parse_add_expr(parser))
        return false;

    if (is_comp_op(peek_tok(parser).type)) {
        advance_tok(parser); /* Consume comparison operator */
        if (!parse_add_expr(parser)) {
            return false;
        }
    }

    if (s_where_depth == 0) {
        if (check_tok(parser, TOKEN_KW_WHERE)) {
            if (!parse_where_clause(parser)) return false;
        }

        if (check_tok(parser, TOKEN_KW_WITHIN)) {
            if (!parse_within_clause(parser)) return false;
        }
    }

    return true;
}

static bool impl_parse_unary_expr(Parser *parser) {
    if (match_tok(parser, TOKEN_KW_NOT)) {
        return parse_unary_expr(parser);
    }
    return parse_comparison_expr(parser);
}

static bool impl_parse_and_expr(Parser *parser) {
    if (!parse_unary_expr(parser))
        return false;

    while (match_tok(parser, TOKEN_KW_AND)) {
        if (!parse_unary_expr(parser))
            return false;
    }
    return true;
}

static bool impl_parse_or_expr(Parser *parser) {
    if (!parse_and_expr(parser))
        return false;

    while (match_tok(parser, TOKEN_KW_OR)) {
        if (!parse_and_expr(parser))
            return false;
    }
    return true;
}

static bool impl_parse_expression(Parser *parser) { return parse_or_expr(parser); }

static bool impl_parse_where_clause(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_WHERE, "Expected 'where'")) return false;
    if (check_tok(parser, TOKEN_KW_WITHIN) || check_tok(parser, TOKEN_KW_THEN) ||
        check_tok(parser, TOKEN_KW_END) || is_at_end(parser)) {
        error_at_current(parser, "Expected condition after 'where'");
        return false;
    }
    s_where_depth++;
    bool ok = parse_expression(parser);
    s_where_depth--;
    return ok;
}

static bool is_valid_time_unit(const char *unit) {
    if (!unit) return false;
    static const char *const VALID_UNITS[] = {
        "s", "sec", "secs", "second", "seconds",
        "m", "min", "mins", "minute", "minutes",
        "h", "hr", "hrs", "hour", "hours",
        "d", "day", "days",
        "w", "wk", "wks", "week", "weeks",
        "month", "months",
        "year", "years"
    };
    size_t count = sizeof(VALID_UNITS) / sizeof(VALID_UNITS[0]);
    for (size_t i = 0; i < count; i++) {
        if (strcmp(unit, VALID_UNITS[i]) == 0) return true;
    }
    return false;
}

static bool impl_parse_duration_expr(Parser *parser) {
    if (match_tok(parser, TOKEN_INT_LIT) || match_tok(parser, TOKEN_FLOAT_LIT)) {
        if (check_tok(parser, TOKEN_IDENTIFIER)) {
            const char *unit = peek_tok(parser).lexeme;
            if (is_valid_time_unit(unit)) {
                advance_tok(parser);
                return true;
            }
            if (strcmp(unit, "before") == 0) {
                error_at_current(parser, "Expected time unit after duration number (e.g. 'hours', 'minutes', 'days')");
                return false;
            }
            error_at_current(parser, "Invalid time unit '%s'. Expected 'hours', 'minutes', 'days', etc.", unit);
            return false;
        }
        error_at_current(parser, "Expected time unit after duration number (e.g. 'hours', 'minutes', 'days')");
        return false;
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

static bool impl_parse_within_clause(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_WITHIN, "Expected 'within'")) return false;
    if (!parse_duration_expr(parser)) return false;

    /* Optional temporal reference e.g. 'before now' */
    if (check_tok(parser, TOKEN_IDENTIFIER) && strcmp(peek_tok(parser).lexeme, "before") == 0) {
        advance_tok(parser);
        if (check_tok(parser, TOKEN_IDENTIFIER) && strcmp(peek_tok(parser).lexeme, "now") == 0) {
            advance_tok(parser);
        } else {
            error_at_current(parser, "Expected 'now' after 'before'");
            return false;
        }
    }

    return true;
}

static bool parse_latest_query(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_LATEST, "Expected 'latest'")) return false;

    if (!consume_tok(parser, TOKEN_IDENTIFIER, "Expected observation type after 'latest'")) {
        return false;
    }

    if (!check_tok(parser, TOKEN_KW_WHERE)) {
        error_at_current(parser, "Expected 'where' clause in latest observation query");
        return false;
    }
    if (!parse_where_clause(parser)) {
        return false;
    }

    if (!check_tok(parser, TOKEN_KW_WITHIN)) {
        error_at_current(parser, "Expected 'within' clause in latest observation query");
        return false;
    }
    if (!parse_within_clause(parser)) {
        return false;
    }

    return true;
}

/* --- Declarations & Statements --- */

static bool impl_parse_intent_decl(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_INTENT, "Expected 'intent'"))
        return false;
    match_tok(parser, TOKEN_COLON); /* Optional colon */
    if (!consume_tok(parser, TOKEN_STRING_LIT, "Expected string literal after 'intent'")) {
        return false;
    }
    return true;
}

static bool impl_parse_schedule_decl(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_SCHEDULE, "Expected 'schedule'"))
        return false;
    match_tok(parser, TOKEN_COLON); /* Optional colon */
    if (match_tok(parser, TOKEN_STRING_LIT) || match_tok(parser, TOKEN_IDENTIFIER)) {
        return true;
    }
    return parse_duration_expr(parser);
}

static bool parse_terminology_selector(Parser *parser) {
    if (match_tok(parser, TOKEN_LPAREN)) {
        if (!check_tok(parser, TOKEN_RPAREN)) {
            if (!parse_argument_list(parser))
                return false;
        }
        return consume_tok(parser, TOKEN_RPAREN, "Expected ')' after terminology arguments");
    }
    if (match_tok(parser, TOKEN_LBRACKET)) {
        if (!parse_expression(parser))
            return false;
        return consume_tok(parser, TOKEN_RBRACKET, "Expected ']' after terminology reference");
    }
    return true;
}

static bool impl_parse_terminology_decl(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_TERMINOLOGY, "Expected 'terminology'"))
        return false;
    match_tok(parser, TOKEN_COLON); /* Optional colon */
        /* HELIX-22: mapping list: name -> SYSTEM["term"] */
    if (check_tok(parser, TOKEN_IDENTIFIER) && peek_next_tok(parser).type == TOKEN_ARROW) {
        while (check_tok(parser, TOKEN_IDENTIFIER) && peek_next_tok(parser).type == TOKEN_ARROW) {
            advance_tok(parser); /* name */
            advance_tok(parser); /* -> */
            if (!parse_postfix_expr(parser))
                return false;
        }
        return true;
    }
    if (!consume_tok(parser, TOKEN_IDENTIFIER,
                     "Expected terminology concept or system name (e.g. potassium, LOINC, SNOMED)")) {
        return false;
    }
    if (match_tok(parser, TOKEN_ARROW)) {
        if (!consume_tok(parser, TOKEN_IDENTIFIER,
                         "Expected terminology system name after '->' (e.g. LOINC, SNOMED)")) {
            return false;
        }
        if (!parse_terminology_selector(parser))
            return false;
        while (check_tok(parser, TOKEN_IDENTIFIER) && peek_next_tok(parser).type == TOKEN_ARROW) {
            advance_tok(parser); /* Consume local concept identifier */
            advance_tok(parser); /* Consume '->' */
            if (!consume_tok(parser, TOKEN_IDENTIFIER,
                             "Expected terminology system name after '->' (e.g. LOINC, SNOMED)")) {
                return false;
            }
            if (!parse_terminology_selector(parser))
                return false;
        }
        return true;
    }
    if (!parse_terminology_selector(parser))
        return false;
    if (check_tok(parser, TOKEN_STRING_LIT)) {
        advance_tok(parser);
    }
    return true;
}

static bool impl_parse_site_decl(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_SITE, "Expected 'site'"))
        return false;
    match_tok(parser, TOKEN_COLON); /* Optional colon */
    if (match_tok(parser, TOKEN_IDENTIFIER) || match_tok(parser, TOKEN_STRING_LIT)) {
        return true;
    }
    error_at_current(parser, "Expected site name or string after 'site'");
    return false;
}

static bool impl_parse_source_decl(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_SOURCE, "Expected 'source'"))
        return false;
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
            if (!parse_argument_list(parser))
                return false;
        }
        if (!consume_tok(parser, TOKEN_RPAREN, "Expected ')' after source arguments")) {
            return false;
        }
    }
    return true;
}

static bool impl_parse_bind_decl(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_BIND, "Expected 'bind'"))
        return false;
    if (check_tok(parser, TOKEN_KW_SITE)) {
        /* Configuration block: site/source/terminology declarations until 'end bind' */
        while (!is_at_end(parser) && !check_tok(parser, TOKEN_KW_END)) {
            TokenType t = peek_tok(parser).type;
            bool ok;
            if (t == TOKEN_KW_SITE) ok = parse_site_decl(parser);
            else if (t == TOKEN_KW_SOURCE) ok = parse_source_decl(parser);
            else if (t == TOKEN_KW_TERMINOLOGY) ok = parse_terminology_decl(parser);
            else {
                error_at_current(parser, "Unexpected token '%s' in 'bind site' block",
                                 peek_tok(parser).lexeme);
                ok = false;
            }
            if (!ok) return false;
        }
        return consume_block_end(parser, TOKEN_KW_BIND, "bind");
    }
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
        if (!parse_where_clause(parser))
            return false;
    }
    if (check_tok(parser, TOKEN_KW_WITHIN)) {
        if (!parse_within_clause(parser))
            return false;
    }
    return consume_block_end(parser, TOKEN_KW_BIND, "bind");
}

static bool impl_parse_let_decl(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_LET, "Expected 'let'"))
        return false;
    if (!consume_tok(parser, TOKEN_IDENTIFIER, "Expected variable name after 'let'")) {
        return false;
    }
    if (!match_tok(parser, TOKEN_ASSIGN) && !match_tok(parser, TOKEN_EQUAL)) {
        error_at_current(parser, "Expected ':=' or '=' in let assignment");
        return false;
    }
    return parse_expression(parser);
}

static bool impl_parse_alert_stmt(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_ALERT, "Expected 'alert'"))
        return false;
    match_tok(parser, TOKEN_COLON); /* Optional colon */
        /* HELIX-22: alert level : <name | "text"> */
    if (check_tok(parser, TOKEN_IDENTIFIER) && strcmp(peek_tok(parser).lexeme, "level") == 0 &&
        peek_next_tok(parser).type == TOKEN_COLON) {
        advance_tok(parser); /* level */
        advance_tok(parser); /* : */
        if (match_tok(parser, TOKEN_IDENTIFIER) || match_tok(parser, TOKEN_STRING_LIT))
            return true;
        error_at_current(parser, "Expected alert level name after 'level :'");
        return false;
    }
    if (!parse_expression(parser))
        return false;
    while (match_tok(parser, TOKEN_COMMA)) {
        if (!parse_expression(parser))
            return false;
    }
    return true;
}

static bool impl_parse_suppress_stmt(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_SUPPRESS, "Expected 'suppress'"))
        return false;
    match_tok(parser, TOKEN_COLON); /* Optional colon */
    if (check_tok(parser, TOKEN_KW_WITHIN)) {
        return parse_within_clause(parser);
    }
    if (match_tok(parser, TOKEN_STRING_LIT) || match_tok(parser, TOKEN_IDENTIFIER)) {
        Token target = previous_tok(parser);
        /* repeat_of is contextual; keep it usable as an ordinary identifier. */
        if (target.type == TOKEN_IDENTIFIER && strcmp(target.lexeme, "repeat_of") == 0 &&
            match_tok(parser, TOKEN_COLON)) {
            if (!consume_tok(parser, TOKEN_IDENTIFIER, "Expected rule name after 'repeat_of :'")) {
                return false;
            }
            if (check_tok(parser, TOKEN_KW_WITHIN)) return parse_within_clause(parser);
        }
        return true;
    }
    return parse_duration_expr(parser);
}

static bool impl_parse_action_stmt(Parser *parser) {
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
    return (t == TOKEN_KW_LET || t == TOKEN_KW_ALERT || t == TOKEN_KW_SUPPRESS ||
            t == TOKEN_KW_WHEN);
}

static bool impl_parse_statement_in_branch(Parser *parser) {
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

static bool impl_parse_when_stmt(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_WHEN, "Expected 'when'"))
        return false;

    if (match_tok(parser, TOKEN_KW_FOR)) {
        if (!consume_tok(parser, TOKEN_IDENTIFIER, "Expected identifier after 'for'")) {
            return false;
        }
    }

    if (!parse_expression(parser))
        return false;

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

    return consume_block_end(parser, TOKEN_KW_WHEN, "when");
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
            t == TOKEN_KW_FOR ||
            t == TOKEN_KW_ALERT ||
            t == TOKEN_KW_SUPPRESS ||
            t == TOKEN_KW_LATEST);
}

/* HELIX-22: 'when Event.name' with no 'then' is an event trigger */
static bool is_event_trigger_ahead(const Parser *parser) {
    const TokenList *tl = parser->tokens;
    size_t i = parser->current;
    size_t dots = 0;
    if (!tl || i >= tl->count || tl->items[i].type != TOKEN_KW_WHEN)
        return false;
    i++;
    if (i >= tl->count || tl->items[i].type != TOKEN_IDENTIFIER)
        return false;
    i++;
    while (i + 1 < tl->count && tl->items[i].type == TOKEN_DOT &&
           is_member_name_token(tl->items[i + 1].type)) {
        dots++;
        i += 2;
    }
    if (dots == 0 || i >= tl->count)
        return false;
    return tl->items[i].type == TOKEN_KW_END || is_rule_element_start(tl->items[i].type);
}

static bool parse_event_trigger(Parser *parser) {
    advance_tok(parser); /* when */
    advance_tok(parser); /* event source name */
    while (match_tok(parser, TOKEN_DOT))
        advance_tok(parser); /* member name */
    return true;
}

/* HELIX-22: for <var> [:] <Type> */
static bool parse_for_decl(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_FOR, "Expected 'for'"))
        return false;
    if (!consume_tok(parser, TOKEN_IDENTIFIER, "Expected variable name after 'for'"))
        return false;
    match_tok(parser, TOKEN_COLON); /* Optional colon */
    return consume_tok(parser, TOKEN_IDENTIFIER, "Expected type name after 'for <name> :'");
}

static bool impl_parse_rule_element(Parser *parser) {
    switch (peek_tok(parser).type) {
        case TOKEN_KW_INTENT:      return parse_intent_decl(parser);
        case TOKEN_KW_SCHEDULE:    return parse_schedule_decl(parser);
        case TOKEN_KW_TERMINOLOGY: return parse_terminology_decl(parser);
        case TOKEN_KW_SITE:        return parse_site_decl(parser);
        case TOKEN_KW_SOURCE:      return parse_source_decl(parser);
        case TOKEN_KW_BIND:        return parse_bind_decl(parser);
        case TOKEN_KW_LET:         return parse_let_decl(parser);
        case TOKEN_KW_WHEN:
            if (is_event_trigger_ahead(parser))
                return parse_event_trigger(parser);
            return parse_when_stmt(parser);
        case TOKEN_KW_FOR:         return parse_for_decl(parser);
        case TOKEN_KW_ALERT:
        case TOKEN_KW_SUPPRESS:    return parse_action_stmt(parser);
        case TOKEN_KW_LATEST:      return parse_latest_query(parser);
        default:
            error_at_current(parser, "Unexpected token '%s' in rule body", peek_tok(parser).lexeme);
            return false;
    }
}

static bool impl_parse_rule_decl(Parser *parser) {
    if (!consume_tok(parser, TOKEN_KW_RULE, "Expected 'rule'"))
        return false;
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
            error_at_current(parser, "Unexpected token '%s' in rule declaration",
                             peek_tok(parser).lexeme);
            synchronize(parser);
        }
    }

    return consume_block_end(parser, TOKEN_KW_RULE, "rule");
}

bool parser_parse(Parser *parser) {
    if (!parser)
        return false;

    parser->depth = 0;

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
            error_at_current(parser, "Expected 'rule' declaration. Found '%s'",
                             peek_tok(parser).lexeme);
            advance_tok(parser);
            while (!is_at_end(parser) && !check_tok(parser, TOKEN_KW_RULE)) {
                advance_tok(parser);
            }
            parser->panic_mode = false;
        }
    }

    return (parser->diag ? parser->diag->syntax_errors == 0 : true);
}

AstProgram *parser_build_ast(Parser *parser) {
    AstProgram *p = calloc(1, sizeof(*p));
    if (!p)
        return NULL;
    token_list_init(&p->tokens);
    for (size_t i = 0; i < parser->tokens->count; i++) {
        Token old = parser->tokens->items[i];
        Token t = token_create(old.type, old.lexeme, old.line, old.column);
        t.start_offset = old.start_offset;
        t.end_offset = old.end_offset;
        if (!t.lexeme || !token_list_append(&p->tokens, t)) {
            token_free(&t);
            ast_program_free(p);
            return NULL;
        }
    }
    p->root = ast_node_new(p, AST_PROGRAM, 0);
    if (!p->root) {
        ast_program_free(p);
        return NULL;
    }
    parser->ast = p;
    parser->parent = p->root;
    bool ok = parser_parse(parser);
    p->root->end = parser->current;
    parser->ast = NULL;
    parser->parent = NULL;
    if (!ok || p->failed) {
        ast_program_free(p);
        return NULL;
    }
    return p;
}
