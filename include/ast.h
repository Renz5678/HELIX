#ifndef HELIX_AST_H
#define HELIX_AST_H
#include "token.h"
/* Ordered grammar nodes, with exclusive token spans. The program owns all tokens. */
typedef enum {
    AST_PROGRAM,
    AST_RULE,
    AST_INTENT,
    AST_SCHEDULE,
    AST_TERMINOLOGY,
    AST_SITE,
    AST_SOURCE,
    AST_BIND,
    AST_LET,
    AST_WHEN,
    AST_ALERT,
    AST_SUPPRESS,
    AST_EXPRESSION,
    AST_OR,
    AST_AND,
    AST_UNARY,
    AST_COMPARISON,
    AST_POSTFIX,
    AST_PRIMARY,
    AST_WHERE,
    AST_WITHIN,
    AST_DURATION,
    AST_ARGUMENTS,
    AST_BRANCH_STMT,
    AST_ACTION
} AstKind;
typedef struct AstNode {
    AstKind kind;
    size_t start, end;
    struct AstNode **children;
    size_t count, capacity;
} AstNode;
typedef struct {
    AstNode *root;
    TokenList tokens;
    size_t node_count;
    bool failed;
} AstProgram;
AstNode *ast_node_new(AstProgram *program, AstKind kind, size_t start);
bool ast_append(AstNode *parent, AstNode *child);
void ast_node_free(AstNode *node);
void ast_program_free(AstProgram *program);
#endif
