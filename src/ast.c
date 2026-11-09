#include "ast.h"
#include <stdlib.h>
AstNode *ast_node_new(AstProgram *p, AstKind kind, size_t start) {
    if (++p->node_count > 100000) {
        p->failed = true;
        return NULL;
    }
    AstNode *n = calloc(1, sizeof(*n));
    if (!n) {
        p->failed = true;
        return NULL;
    }
    n->kind = kind;
    n->start = start;
    return n;
}
bool ast_append(AstNode *p, AstNode *n) {
    if (p->count == p->capacity) {
        size_t c = p->capacity ? p->capacity * 2 : 4;
        AstNode **a = realloc(p->children, c * sizeof(*a));
        if (!a)
            return false;
        p->children = a;
        p->capacity = c;
    }
    p->children[p->count++] = n;
    return true;
}
void ast_node_free(AstNode *n) {
    if (!n)
        return;
    for (size_t i = 0; i < n->count; i++)
        ast_node_free(n->children[i]);
    free(n->children);
    free(n);
}
void ast_program_free(AstProgram *p) {
    if (!p)
        return;
    ast_node_free(p->root);
    token_list_free(&p->tokens);
    free(p);
}
