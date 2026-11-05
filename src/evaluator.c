#include "evaluator.h"
#include "ast.h"
#include "bindings.h"
#include "json.h"
#include "lexer.h"
#include "parser.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct {
    const char *name;
    Value value;
    bool series;
    BindingTarget target;
    AstNode *filter;
    double window;
} Variable;
typedef struct {
    const char *raw;
    size_t a, b;
    char *text;
} StringMemo;
typedef struct {
    StringMemo *memo;
    size_t memo_count, string_bytes;
    const DiagnosticItem *raw_diagnostic;
    AstProgram *program;
    DataStore *store;
    const char *source, *patient;
    Variable vars[128];
    size_t count;
    DataTable *row_table;
    DataRow *row;
    char **strings;
    size_t string_count;
    JsonWriter diagnostics, conditions, actions, resolved;
    size_t diagnostic_count, condition_count, action_count, resolved_count, rule_index,
        condition_sequence;
    bool failed, validating, allocation_failed;
    const char *active_condition;
    double window;
} Context;
static AstNode *unwrap(AstNode *n) {
    while (n && (n->kind == AST_BRANCH_STMT || n->kind == AST_ACTION) && n->count == 1)
        n = n->children[0];
    return n;
}
static Token *token(Context *c, size_t i) { return &c->program->tokens.items[i]; }
static AstNode *child(AstNode *n, AstKind k) {
    for (size_t i = 0; i < n->count; i++)
        if (n->children[i]->kind == k)
            return n->children[i];
    return NULL;
}
static AstNode *find(AstNode *n, AstKind k) {
    if (n->kind == k)
        return n;
    for (size_t i = 0; i < n->count; i++) {
        AstNode *r = find(n->children[i], k);
        if (r)
            return r;
    }
    return NULL;
}
static void diagnostic(Context *c, const char *category, const char *code, const char *message,
                       AstNode *n) {
    c->failed = true;
    if (c->diagnostic_count >= 256)
        return;
    if (c->diagnostic_count++)
        json_write(&c->diagnostics, ",");
    json_write(&c->diagnostics, "{\"severity\":\"error\",\"category\":");
    json_string(&c->diagnostics, category);
    json_write(&c->diagnostics, ",\"code\":");
    json_string(&c->diagnostics, code);
    json_write(&c->diagnostics, ",\"message\":");
    json_string(&c->diagnostics, message);
    if (n) {
        Token *t = token(c, n->start);
        json_write(&c->diagnostics, ",\"startOffset\":");
        json_number(&c->diagnostics, (double)t->start_offset);
        json_write(&c->diagnostics, ",\"endOffset\":");
        json_number(&c->diagnostics,
                    (double)token(c, n->end > n->start ? n->end - 1 : n->start)->end_offset);
    }
    if (c->raw_diagnostic) {
        const DiagnosticItem *d = c->raw_diagnostic;
        json_write(&c->diagnostics, ",\"startOffset\":");
        json_number(&c->diagnostics, (double)d->start_offset);
        json_write(&c->diagnostics, ",\"endOffset\":");
        json_number(&c->diagnostics, (double)d->end_offset);
        json_write(&c->diagnostics, ",\"line\":");
        json_number(&c->diagnostics, (double)d->line);
        json_write(&c->diagnostics, ",\"column\":");
        json_number(&c->diagnostics, (double)d->column);
    }
    if (!strcmp(category, "data") && c->store && c->store->error_table) {
        json_write(&c->diagnostics, ",\"tableName\":");
        json_string(&c->diagnostics, c->store->error_table);
        if (c->store->has_error_row) {
            json_write(&c->diagnostics, ",\"rowIndex\":");
            json_number(&c->diagnostics, (double)c->store->error_row);
        }
        if (c->store->error_column) {
            json_write(&c->diagnostics, ",\"columnName\":");
            json_string(&c->diagnostics, c->store->error_column);
        }
    }
    json_write(&c->diagnostics, "}");
}
static void information(Context *c, const char *code, const char *message) {
    if (c->diagnostic_count >= 256)
        return;
    if (c->diagnostic_count++)
        json_write(&c->diagnostics, ",");
    json_write(&c->diagnostics, "{\"severity\":\"info\",\"category\":\"evaluation\",\"code\":");
    json_string(&c->diagnostics, code);
    json_write(&c->diagnostics, ",\"message\":");
    json_string(&c->diagnostics, message);
    json_write(&c->diagnostics, "}");
}
static char *remember(Context *c, char *s) {
    if (!s) {
        c->allocation_failed = true;
        return NULL;
    }
    size_t length = strlen(s) + 1;
    if (length > 8 * 1024 * 1024 || c->string_bytes > 8 * 1024 * 1024 - length) {
        free(s);
        c->allocation_failed = true;
        return NULL;
    }
    char **a = realloc(c->strings, (c->string_count + 1) * sizeof(*a));
    if (!a) {
        free(s);
        c->allocation_failed = true;
        return NULL;
    }
    c->strings = a;
    c->strings[c->string_count++] = s;
    c->string_bytes += length;
    return s;
}
static char *memoize(Context *c, const char *raw, size_t a, size_t b, char *s) {
    char *saved = remember(c, s);
    if (!saved)
        return NULL;
    StringMemo *items = realloc(c->memo, (c->memo_count + 1) * sizeof(*items));
    if (!items) {
        c->allocation_failed = true;
        return NULL;
    }
    c->memo = items;
    c->memo[c->memo_count++] = (StringMemo){raw, a, b, saved};
    return saved;
}
static char *slice(Context *c, size_t a, size_t b) {
    for (size_t i = 0; i < c->memo_count; i++)
        if (!c->memo[i].raw && c->memo[i].a == a && c->memo[i].b == b)
            return c->memo[i].text;
    if (b < a)
        b = a;
    char *s = malloc(b - a + 1);
    if (s) {
        memcpy(s, c->source + a, b - a);
        s[b - a] = 0;
    }
    return memoize(c, NULL, a, b, s);
}
static const char *literal(Context *c, const char *raw) {
    for (size_t i = 0; i < c->memo_count; i++)
        if (c->memo[i].raw == raw)
            return c->memo[i].text;
    char error[100];
    JsonValue *j = json_parse(raw, error, sizeof error);
    if (!j || j->type != JSON_STRING) {
        json_value_free(j);
        diagnostic(c, "semantic", "STRING_ESCAPE", "Invalid string escape or allocation failure",
                   NULL);
        return "";
    }
    char *s = j->string;
    j->string = NULL;
    json_value_free(j);
    const char *r = memoize(c, raw, 0, 0, s);
    return r ? r : "";
}
static Variable *variable(Context *c, const char *name) {
    for (size_t i = c->count; i > 0; i--)
        if (!strcmp(c->vars[i - 1].name, name))
            return &c->vars[i - 1];
    return NULL;
}
static bool add_var(Context *c, Variable v, AstNode *n, size_t scope) {
    for (size_t i = scope; i < c->count; i++)
        if (!strcmp(c->vars[i].name, v.name)) {
            diagnostic(c, "semantic", "DUPLICATE_NAME", "Duplicate declaration in scope", n);
            return false;
        }
    if (c->count >= 128) {
        diagnostic(c, "engine", "VARIABLE_LIMIT", "Variable limit exceeded", n);
        return false;
    }
    c->vars[c->count++] = v;
    return true;
}
static Value bool_value(TruthValue t) {
    Value v = {0};
    if (t != TRUTH_UNKNOWN) {
        v.type = VAL_BOOL;
        v.boolean = t == TRUTH_TRUE;
    }
    return v;
}
static TruthValue truth(Value v) {
    return v.type == VAL_MISSING ? TRUTH_UNKNOWN
           : v.type == VAL_BOOL  ? (v.boolean ? TRUTH_TRUE : TRUTH_FALSE)
                                 : TRUTH_UNKNOWN;
}
static void write_value(JsonWriter *w, Value v) {
    if (v.type == VAL_MISSING)
        json_write(w, "null");
    else if (v.type == VAL_STRING || v.type == VAL_DATETIME)
        json_string(w, v.string);
    else if (v.type == VAL_BOOL)
        json_write(w, v.boolean ? "true" : "false");
    else
        json_number(w, v.number);
}
static const char *value_type(Value v) {
    return v.type == VAL_MISSING    ? "Missing"
           : v.type == VAL_STRING   ? "String"
           : v.type == VAL_BOOL     ? "Boolean"
           : v.type == VAL_DATETIME ? "DateTime"
           : v.type == VAL_INT      ? "Integer"
                                    : "Float";
}
static double duration(Context *c, AstNode *n) {
    AstNode *d = find(n, AST_DURATION);
    if (!d)
        return -1;
    Token *t = token(c, d->start);
    double amount = 0;
    const char *unit = NULL;
    char b[128];
    if (t->type == TOKEN_STRING_LIT) {
        const char *s = literal(c, t->lexeme);
        char *end;
        amount = strtod(s, &end);
        while (*end == ' ')
            end++;
        snprintf(b, sizeof b, "%s", end);
        unit = b;
    } else if (t->type == TOKEN_IDENTIFIER) {
        Variable *v = variable(c, t->lexeme);
        if (c->validating && v && !v->series && v->value.type == VAL_MISSING)
            return -1;
        if (v && v->value.type == VAL_STRING) {
            char *end;
            amount = strtod(v->value.string, &end);
            while (*end == ' ')
                end++;
            snprintf(b, sizeof b, "%s", end);
            unit = b;
        }
    } else {
        amount = strtod(t->lexeme, NULL);
        if (d->end > d->start + 1)
            unit = token(c, d->start + 1)->lexeme;
    }
    double scale = 0;
    if (unit) {
        if (!strcmp(unit, "s") || !strcmp(unit, "second") || !strcmp(unit, "seconds"))
            scale = 1000;
        else if (!strcmp(unit, "m") || !strcmp(unit, "minute") || !strcmp(unit, "minutes"))
            scale = 60000;
        else if (!strcmp(unit, "h") || !strcmp(unit, "hour") || !strcmp(unit, "hours"))
            scale = 3600000;
        else if (!strcmp(unit, "d") || !strcmp(unit, "day") || !strcmp(unit, "days"))
            scale = 86400000;
    }
    if (amount <= 0 || !scale || !isfinite(amount * scale)) {
        diagnostic(c, "semantic", "DURATION", "Expected a positive duration with recognized units",
                   n);
        return -1;
    }
    return amount * scale;
}
/* Resolve a scalar selection without evaluating row filters. */
static bool selected_series(Context *c, AstNode *n, Variable *out) {
    if (n->kind != AST_POSTFIX)
        return false;
    size_t size = n->end - n->start;
    if (size != 3 && size != 5)
        return false;
    Variable *v = variable(c, token(c, n->start)->lexeme);
    if (!v || !v->series || token(c, n->start + 1)->type != TOKEN_DOT)
        return false;
    *out = *v;
    if (size == 3)
        return token(c, n->start + 2)->type == TOKEN_KW_LATEST;
    if (token(c, n->start + 3)->type != TOKEN_DOT ||
        token(c, n->start + 4)->type != TOKEN_KW_LATEST)
        return false;
    const ColumnSchema *col = data_column(v->target.table, token(c, n->start + 2)->lexeme);
    if (!col)
        return false;
    out->target.column = col->name;
    return true;
}
static Value expression(Context *c, AstNode *n);
static Value latest(Context *c, Variable *v, AstNode *n) {
    DataTable *t = v->target.table;
    DataRow *selected = NULL;
    size_t row_index = 0;
    double best = -INFINITY;
    double window = v->window;
    if (c->window >= 0 && (window < 0 || c->window < window))
        window = c->window;
    for (size_t i = 0; i < t->rows->count && !c->allocation_failed; i++) {
        DataRow *row = t->rows->children[i];
        const char *pid = json_text(json_get(row, t->patient_id_column));
        if (strcmp(pid, c->patient))
            continue;
        Value timestamp = data_value(t, row, t->timestamp_column);
        if (timestamp.type == VAL_MISSING || timestamp.number > c->store->clock ||
            (window >= 0 && timestamp.number < c->store->clock - window))
            continue;
        if (v->filter) {
            DataRow *old = c->row;
            DataTable *ot = c->row_table;
            c->row = row;
            c->row_table = t;
            AstNode *filter = child(v->filter, AST_EXPRESSION);
            Value result = expression(c, filter);
            c->row = old;
            c->row_table = ot;
            if (truth(result) != TRUTH_TRUE)
                continue;
        }
        if (timestamp.number >= best) {
            best = timestamp.number;
            selected = row;
            row_index = i;
        }
    }
    Value value = selected ? data_value(t, selected, v->target.column) : (Value){0};
    if (c->active_condition) {
        if (c->resolved_count++)
            json_write(&c->resolved, ",");
        json_write(&c->resolved, "{\"expression\":");
        json_string(&c->resolved,
                    slice(c, token(c, n->start)->start_offset, token(c, n->end - 1)->end_offset));
        json_write(&c->resolved, ",\"table\":");
        json_string(&c->resolved, t->name);
        json_write(&c->resolved, ",\"column\":");
        json_string(&c->resolved, v->target.column);
        json_write(&c->resolved, ",\"rowIndex\":");
        if (selected)
            json_number(&c->resolved, (double)row_index);
        else
            json_write(&c->resolved, "null");
        json_write(&c->resolved, ",\"timestamp\":");
        json_string(&c->resolved,
                    selected ? json_text(json_get(selected, t->timestamp_column)) : NULL);
        json_write(&c->resolved, ",\"type\":");
        json_string(&c->resolved, value_type(value));
        json_write(&c->resolved, ",\"value\":");
        write_value(&c->resolved, value);
        if (value.type == VAL_MISSING) {
            json_write(&c->resolved, ",\"reason\":");
            json_string(&c->resolved, selected
                                          ? "Latest eligible row has a missing value"
                                          : "No eligible timestamped row in the requested window");
        }
        json_write(&c->resolved, "}");
    }
    return value;
}
static Value compare(Context *c, Value a, Value b, TokenType op, AstNode *n) {
    if (a.type == VAL_MISSING || b.type == VAL_MISSING)
        return (Value){0};
    int order = 0;
    bool an = a.type == VAL_INT || a.type == VAL_FLOAT,
         bn = b.type == VAL_INT || b.type == VAL_FLOAT;
    if (an && bn)
        order = a.number < b.number ? -1 : a.number > b.number ? 1 : 0;
    else if (a.type == b.type && a.type == VAL_STRING)
        order = strcmp(a.string, b.string);
    else if (a.type == b.type && a.type == VAL_DATETIME)
        order = a.number < b.number ? -1 : a.number > b.number ? 1 : 0;
    else if (a.type == VAL_BOOL && b.type == VAL_BOOL &&
             (op == TOKEN_EQ || op == TOKEN_EQUAL || op == TOKEN_NEQ))
        order = (int)a.boolean - (int)b.boolean;
    else {
        diagnostic(c, "evaluation", "TYPE_MISMATCH", "Incompatible comparison operands", n);
        return (Value){0};
    }
    bool result = op == TOKEN_EQ || op == TOKEN_EQUAL ? order == 0
                  : op == TOKEN_NEQ                   ? order != 0
                  : op == TOKEN_GT                    ? order > 0
                  : op == TOKEN_GTE                   ? order >= 0
                  : op == TOKEN_LT                    ? order < 0
                                                      : order <= 0;
    return bool_value(result ? TRUTH_TRUE : TRUTH_FALSE);
}
static Value expression(Context *c, AstNode *n) {
    if (!n || c->allocation_failed)
        return (Value){0};
    if (n->kind == AST_EXPRESSION || n->kind == AST_WHERE)
        return expression(c, n->count ? n->children[0] : NULL);
    if (n->kind == AST_OR || n->kind == AST_AND) {
        Value v = expression(c, n->children[0]);
        for (size_t i = 1; i < n->count; i++) {
            TruthValue a = truth(v);
            if ((n->kind == AST_OR && a == TRUTH_TRUE) || (n->kind == AST_AND && a == TRUTH_FALSE))
                break;
            Value b = expression(c, n->children[i]);
            if ((v.type != VAL_MISSING && v.type != VAL_BOOL) ||
                (b.type != VAL_MISSING && b.type != VAL_BOOL))
                diagnostic(c, "evaluation", "LOGICAL_TYPE", "Logical operands must be Boolean", n);
            v = bool_value(n->kind == AST_OR ? truth_or(a, truth(b)) : truth_and(a, truth(b)));
        }
        return v;
    }
    if (n->kind == AST_UNARY) {
        Value v = expression(c, n->children[0]);
        if (token(c, n->start)->type == TOKEN_KW_NOT) {
            if (v.type != VAL_MISSING && v.type != VAL_BOOL)
                diagnostic(c, "evaluation", "LOGICAL_TYPE", "NOT requires Boolean", n);
            return bool_value(truth_not(truth(v)));
        }
        return v;
    }
    if (n->kind == AST_COMPARISON) {
        double old = c->window;
        AstNode *within = child(n, AST_WITHIN);
        if (within && !c->row)
            c->window = duration(c, within);
        Value a = expression(c, n->children[0]);
        if (n->count > 1 && n->children[1]->kind == AST_POSTFIX) {
            Value b = expression(c, n->children[1]);
            a = compare(c, a, b, token(c, n->children[0]->end)->type, n);
        }
        c->window = old;
        return a;
    }
    if (n->kind == AST_PRIMARY) {
        Token *t = token(c, n->start);
        if (t->type == TOKEN_LPAREN)
            return expression(c, n->children[0]);
        Value v = {0};
        if (t->type == TOKEN_INT_LIT || t->type == TOKEN_FLOAT_LIT) {
            v.type = t->type == TOKEN_INT_LIT ? VAL_INT : VAL_FLOAT;
            v.number = strtod(t->lexeme, NULL);
        } else if (t->type == TOKEN_STRING_LIT) {
            v.type = VAL_STRING;
            v.string = literal(c, t->lexeme);
        } else {
            if (c->row && data_column(c->row_table, t->lexeme))
                return data_value(c->row_table, c->row, t->lexeme);
            Variable *var = variable(c, t->lexeme);
            if (var && !var->series)
                return var->value;
            diagnostic(c, "semantic", "UNKNOWN_IDENTIFIER",
                       "Unknown identifier or series used without .latest", n);
        }
        return v;
    }
    if (n->kind == AST_POSTFIX) {
        if (n->count == 1 && n->end == n->children[0]->end)
            return expression(c, n->children[0]);
        Variable selection;
        if (selected_series(c, n, &selection))
            return latest(c, &selection, n);
        diagnostic(c, "semantic", "UNSUPPORTED_EXPRESSION",
                   "Use a bound series followed by .latest", n);
        return (Value){0};
    }
    diagnostic(c, "semantic", "UNSUPPORTED_EXPRESSION", "Unsupported expression form", n);
    return (Value){0};
}
static const char *decl_name(Context *c, AstNode *n) {
    size_t i = n->start + 1;
    if (token(c, i)->type == TOKEN_COLON)
        i++;
    return token(c, i)->lexeme;
}
static void declare_series(Context *c, AstNode *n) {
    Variable v = {0};
    v.name = decl_name(c, n);
    v.series = true;
    v.window = -1;
    char path[512] = {0};
    if (n->kind == AST_SOURCE) {
        snprintf(path, sizeof path, "%s", v.name);
        if (!binding_resolve(c->store, path, &v.target)) {
            bool metadata = false;
            for (size_t i = n->start; i < n->end; i++)
                if (token(c, i)->type == TOKEN_ARROW)
                    metadata = true;
            if (!metadata)
                diagnostic(c, "semantic", "SOURCE_NOT_FOUND", "Source table is not mapped", n);
            return;
        }
    } else {
        AstNode *p = child(n, AST_POSTFIX);
        if (!p) {
            diagnostic(c, "semantic", "BINDING", "Missing binding expression", n);
            return;
        }
        for (size_t i = p->start; i < p->end; i++) {
            const char *part = token(c, i)->lexeme;
            if (strlen(path) + strlen(part) >= sizeof path) {
                diagnostic(c, "semantic", "BINDING", "Binding path too long", n);
                return;
            }
            strcat(path, part);
        }
        if (!binding_resolve(c->store, path, &v.target)) {
            diagnostic(c, "semantic", "BINDING_NOT_FOUND",
                       "Binding must resolve to a declared table and column", n);
            return;
        }
        v.filter = child(n, AST_WHERE);
        AstNode *within = find(n, AST_WITHIN);
        if (within)
            v.window = duration(c, within);
    }
    add_var(c, v, n, 0);
}
static size_t series_count(Context *c, AstNode *n) {
    Variable selection;
    if (selected_series(c, n, &selection))
        return 1;
    size_t total = 0;
    for (size_t i = 0; i < n->count; i++)
        total += series_count(c, n->children[i]);
    return total;
}
static void validate_expression(Context *c, AstNode *n, bool row) {
    if (!n)
        return;
    if (n->kind == AST_POSTFIX) {
        AstNode *p = n->children[0];
        if (row && n->end != p->end) {
            diagnostic(c, "semantic", "FILTER_SERIES",
                       "Row filters cannot select series or invoke calls", n);
            return;
        }
        if (n->end != p->end) {
            Variable selection;
            bool valid = selected_series(c, n, &selection);
            if (!valid)
                diagnostic(
                    c, "semantic", "UNSUPPORTED_EXPRESSION",
                    "Executable calls, indexing, arrows, and unselected series are not supported",
                    n);
            return;
        }
    }
    if (n->kind == AST_PRIMARY) {
        Token *t = token(c, n->start);
        if (t->type == TOKEN_STRING_LIT)
            literal(c, t->lexeme);
        if (t->type == TOKEN_INT_LIT || t->type == TOKEN_FLOAT_LIT) {
            double number = strtod(t->lexeme, NULL);
            if (!isfinite(number) ||
                (t->type == TOKEN_INT_LIT && fabs(number) > 9007199254740991.0))
                diagnostic(c, "semantic", "NUMERIC_RANGE",
                           "Numeric literal is outside the finite exact supported range", n);
        }
        if (t->type == TOKEN_IDENTIFIER) {
            Variable *var = variable(c, t->lexeme);
            bool exists = var && !var->series;
            if (row && c->row_table && data_column(c->row_table, t->lexeme))
                exists = true;
            if (!exists)
                diagnostic(c, "semantic", "UNKNOWN_IDENTIFIER", "Unknown identifier", n);
        } else if (t->type == TOKEN_KW_LATEST)
            diagnostic(c, "semantic", "UNSUPPORTED_EXPRESSION",
                       "Standalone latest requires a bound series", n);
    }
    if (n->kind == AST_COMPARISON && child(n, AST_WHERE))
        diagnostic(c, "semantic", "UNSUPPORTED_FILTER", "Use where on a bind declaration", n);
    if (n->kind == AST_COMPARISON && child(n, AST_WITHIN) && !row) {
        if (series_count(c, n) != 1)
            diagnostic(c, "semantic", "AMBIGUOUS_WINDOW",
                       "A condition window requires exactly one series reference", n);
        duration(c, child(n, AST_WITHIN));
    }
    for (size_t i = 0; i < n->count; i++)
        validate_expression(c, n->children[i], row);
}
static size_t branch_boundary(Context *c, AstNode *n, AstNode *expr) {
    for (size_t i = expr->end; i < n->end; i++)
        if (token(c, i)->type == TOKEN_KW_OTHERWISE) {
            bool nested = false;
            for (size_t j = 0; j < n->count; j++) {
                AstNode *b = n->children[j];
                if (b->kind == AST_BRANCH_STMT && b->start < i && b->end > i)
                    nested = true;
            }
            if (!nested)
                return i;
        }
    return n->end;
}
static void statements(Context *c, AstNode *parent, size_t scope);
static void statement(Context *c, AstNode *node, size_t scope) {
    AstNode *n = unwrap(node);
    if (!n || c->allocation_failed || c->diagnostic_count >= 256)
        return;
    if (n->kind == AST_SOURCE || n->kind == AST_BIND) {
        declare_series(c, n);
        if (n->kind == AST_BIND) {
            AstNode *filter = child(n, AST_WHERE);
            if (filter && c->validating) {
                DataTable *old = c->row_table;
                Variable *v = variable(c, decl_name(c, n));
                c->row_table = v && v->series ? v->target.table : NULL;
                validate_expression(c, child(filter, AST_EXPRESSION), true);
                c->row_table = old;
            }
        }
        return;
    }
    if (n->kind == AST_LET) {
        AstNode *expr = child(n, AST_EXPRESSION);
        if (c->validating)
            validate_expression(c, expr, false);
        Value value = c->validating && series_count(c, expr) > 0 ? (Value){0} : expression(c, expr);
        add_var(c, (Variable){.name = decl_name(c, n), .value = value, .window = -1}, n, scope);
        return;
    }
    if (n->kind == AST_WHEN) {
        if (token(c, n->start + 1)->type == TOKEN_KW_FOR)
            diagnostic(c, "semantic", "UNSUPPORTED_FOR",
                       "when for is syntax-valid but not supported by the evaluator", n);
        AstNode *expr = child(n, AST_EXPRESSION);
        if (c->validating) {
            validate_expression(c, expr, false);
            size_t base = c->count;
            size_t boundary = branch_boundary(c, n, expr);
            bool in_otherwise = false;
            for (size_t i = 0; i < n->count; i++)
                if (n->children[i]->kind == AST_BRANCH_STMT) {
                    if (!in_otherwise && n->children[i]->start > boundary) {
                        c->count = base;
                        in_otherwise = true;
                    }
                    statement(c, n->children[i], base);
                }
            c->count = base;
            return;
        }
        char id[80];
        snprintf(id, sizeof id, "rule:%zu/when:%zu", c->rule_index, n->start);
        const char *old = c->active_condition;
        c->active_condition = id;
        JsonWriter outer = c->resolved;
        size_t outer_count = c->resolved_count;
        c->resolved = (JsonWriter){0};
        c->resolved_count = 0;
        Value value = expression(c, expr);
        if (value.type != VAL_BOOL && value.type != VAL_MISSING)
            diagnostic(c, "evaluation", "CONDITION_TYPE",
                       "Condition must produce Boolean or UNKNOWN", expr);
        TruthValue outcome = truth(value);
        if (c->condition_count++)
            json_write(&c->conditions, ",");
        json_write(&c->conditions, "{\"conditionId\":");
        json_string(&c->conditions, id);
        json_write(&c->conditions, ",\"conditionText\":");
        json_string(&c->conditions, slice(c, token(c, expr->start)->start_offset,
                                          token(c, expr->end - 1)->end_offset));
        json_write(&c->conditions, ",\"outcome\":");
        json_string(&c->conditions, outcome == TRUTH_TRUE    ? "TRUE"
                                    : outcome == TRUTH_FALSE ? "FALSE"
                                                             : "UNKNOWN");
        json_write(&c->conditions, ",\"startOffset\":");
        json_number(&c->conditions, (double)token(c, expr->start)->start_offset);
        json_write(&c->conditions, ",\"endOffset\":");
        json_number(&c->conditions, (double)token(c, expr->end - 1)->end_offset);
        json_write(&c->conditions, ",\"resolvedValues\":[");
        json_write(&c->conditions, c->resolved.data ? c->resolved.data : "");
        json_write(&c->conditions, "]}");
        c->allocation_failed = c->allocation_failed || c->resolved.failed;
        free(c->resolved.data);
        c->resolved = outer;
        c->resolved_count = outer_count;
        size_t otherwise = branch_boundary(c, n, expr);
        size_t base = c->count;
        for (size_t i = 0; i < n->count; i++) {
            AstNode *b = n->children[i];
            if (b->kind == AST_BRANCH_STMT && ((outcome == TRUTH_TRUE && b->start < otherwise) ||
                                               (outcome == TRUTH_FALSE && b->start > otherwise)))
                statement(c, b, base);
        }
        c->count = base;
        c->active_condition = old;
        return;
    }
    if (n->kind == AST_ALERT) {
        if (c->validating) {
            for (size_t i = 0; i < n->count; i++)
                validate_expression(c, n->children[i], false);
            return;
        }
        Value message = expression(c, n->children[0]);
        if (message.type != VAL_STRING) {
            diagnostic(c, "evaluation", "ALERT_MESSAGE",
                       "Alert message must be a nonmissing String", n);
            return;
        }
        const char *severity = "WARNING";
        size_t payload_start = 1;
        Value second = {0};
        if (n->count > 1) {
            second = expression(c, n->children[1]);
            if (second.type == VAL_STRING &&
                (!strcmp(second.string, "INFO") || !strcmp(second.string, "WARNING") ||
                 !strcmp(second.string, "CRITICAL"))) {
                severity = second.string;
                payload_start = 2;
            }
        }
        if (c->action_count++)
            json_write(&c->actions, ",");
        json_write(&c->actions, "{\"kind\":\"alert\",\"conditionId\":");
        json_string(&c->actions, c->active_condition);
        json_write(&c->actions, ",\"message\":");
        json_string(&c->actions, message.string);
        json_write(&c->actions, ",\"severity\":");
        json_string(&c->actions, severity);
        json_write(&c->actions, ",\"payload\":[");
        for (size_t i = payload_start; i < n->count; i++) {
            if (i > payload_start)
                json_write(&c->actions, ",");
            write_value(&c->actions, i == 1 ? second : expression(c, n->children[i]));
        }
        json_write(&c->actions, "]}");
        return;
    }
    if (n->kind == AST_SUPPRESS) {
        AstNode *d = find(n, AST_DURATION);
        double ms = -1;
        const char *reason = NULL;
        size_t index = n->start + 1;
        if (index < c->program->tokens.count && token(c, index)->type == TOKEN_COLON)
            index++;
        if (index + 2 < c->program->tokens.count &&
            !strcmp(token(c, index)->lexeme, "repeat_of") &&
            token(c, index + 1)->type == TOKEN_COLON &&
            token(c, index + 2)->type == TOKEN_IDENTIFIER) {
            reason = token(c, index + 2)->lexeme;
        }
        if (d || child(n, AST_WITHIN))
            ms = duration(c, n);
        else if (!reason) {
            Token *t = token(c, index);
            if (t->type == TOKEN_STRING_LIT)
                reason = literal(c, t->lexeme);
            else {
                Variable *v = variable(c, t->lexeme);
                if (!v)
                    diagnostic(c, "semantic", "UNKNOWN_IDENTIFIER", "Unknown suppression operand",
                               n);
                else if (v->value.type == VAL_STRING)
                    reason = v->value.string;
                else if (!c->validating || v->value.type != VAL_MISSING)
                    diagnostic(c, "evaluation", "SUPPRESS_TYPE",
                               "Suppression operand must be a String reason or duration", n);
            }
        }
        if (!c->validating) {
            if (c->action_count++)
                json_write(&c->actions, ",");
            json_write(&c->actions, "{\"kind\":\"suppress\",\"simulated\":true,\"conditionId\":");
            json_string(&c->actions, c->active_condition);
            json_write(&c->actions, ",\"durationMs\":");
            if (ms >= 0)
                json_number(&c->actions, ms);
            else
                json_write(&c->actions, "null");
            json_write(&c->actions, ",\"reason\":");
            json_string(&c->actions, reason);
            json_write(&c->actions, "}");
        }
        return;
    }
}
static void statements(Context *c, AstNode *parent, size_t scope) {
    for (size_t i = 0; i < parent->count; i++)
        statement(c, parent->children[i], scope);
}
static int patient_compare(const void *a, const void *b) {
    return strcmp(*(const char *const *)a, *(const char *const *)b);
}
char *evaluator_run(const char *source, const char *tables) {
    SourceBuffer input = {0};
    DiagnosticEngine diag;
    TokenList tokens;
    AstProgram *program = NULL;
    DataStore *store = calloc(1, sizeof(*store));
    Context c = {0};
    JsonWriter results = {0}, output = {0};
    bool analysis = false;
    size_t result_count = 0;
    if (!store)
        return NULL;
    if (!source || strlen(source) > 1024 * 1024 || !json_utf8_valid(source) ||
        !source_from_string("studio.helix", source, &input)) {
        diagnostic(&c, "engine", "INPUT_LIMIT", "Invalid source input", NULL);
        goto finish_no_source;
    }
    diag_init(&diag, &input, NULL);
    Lexer lexer;
    lexer_init(&lexer, &input, &diag);
    bool lexed = lexer_tokenize_all(&lexer, &tokens);
    Parser parser;
    parser_init(&parser, &tokens, &diag);
    program = parser_build_ast(&parser);
    analysis = lexed && program && !diag_has_errors(&diag);
    if (!analysis) {
        for (size_t i = 0; i < diag.count; i++) {
            c.raw_diagnostic = &diag.items[i];
            diagnostic(&c, diag.items[i].kind == DIAG_LEXICAL_ERROR ? "lexical" : "syntax",
                       "ANALYSIS_ERROR", diag.items[i].message, NULL);
        }
        c.raw_diagnostic = NULL;
        if (!diag.count)
            diagnostic(&c, "engine", "ALLOCATION", "Unable to build AST", NULL);
        goto finish;
    }
    c.program = program;
    c.source = source;
    c.store = store;
    c.window = -1;
    if (!data_store_parse(store, tables)) {
        diagnostic(&c, "data", "INVALID_DATA", store->error, NULL);
        goto finish;
    }
    /* Validate every executable branch before any patient executes. */
    for (size_t r = 0; r < program->root->count; r++) {
        c.count = 0;
        c.validating = true;
        statements(&c, program->root->children[r], 0);
        bool has_table = false;
        for (size_t v = 0; v < c.count; v++)
            if (c.vars[v].series)
                has_table = true;
        if (!has_table)
            diagnostic(&c, "semantic", "NO_SOURCE", "Rule requires a resolved execution table",
                       program->root->children[r]);
    }
    c.validating = false;
    if (c.failed)
        goto finish;
    for (size_t r = 0; r < program->root->count; r++) {
        AstNode *rule = program->root->children[r];
        c.count = 0;
        c.validating = true;
        statements(&c, rule, 0);
        c.validating = false;
        const char **patients = calloc(10000, sizeof(*patients));
        if (!patients) {
            diagnostic(&c, "engine", "ALLOCATION", "Patient allocation failed", rule);
            break;
        }
        size_t patient_count = 0;
        for (size_t v = 0; v < c.count; v++)
            if (c.vars[v].series) {
                DataTable *t = c.vars[v].target.table;
                for (size_t row = 0; row < t->rows->count; row++) {
                    const char *id =
                        json_text(json_get(t->rows->children[row], t->patient_id_column));
                    bool seen = false;
                    for (size_t p = 0; p < patient_count; p++)
                        if (!strcmp(patients[p], id))
                            seen = true;
                    if (!seen)
                        patients[patient_count++] = id;
                }
            }
        if (!patient_count)
            information(&c, "EMPTY_PATIENT_POPULATION", "Resolved rule tables contain no patients");
        qsort(patients, patient_count, sizeof(*patients), patient_compare);
        for (size_t p = 0; p < patient_count && !c.allocation_failed && !results.failed; p++) {
            c.patient = patients[p];
            c.count = 0;
            c.rule_index = r;
            c.condition_sequence = 0;
            c.condition_count = 0;
            c.action_count = 0;
            c.conditions = (JsonWriter){0};
            c.actions = (JsonWriter){0};
            statements(&c, rule, 0);
            if (result_count++)
                json_write(&results, ",");
            json_write(&results, "{\"ruleId\":\"rule:");
            json_number(&results, (double)r);
            json_write(&results, "\",\"ruleName\":");
            json_string(&results, decl_name(&c, rule));
            json_write(&results, ",\"patientId\":");
            json_string(&results, c.patient);
            json_write(&results, ",\"conditions\":[");
            json_write(&results, c.conditions.data ? c.conditions.data : "");
            json_write(&results, "],\"actions\":[");
            json_write(&results, c.actions.data ? c.actions.data : "");
            json_write(&results, "],\"diagnostics\":[]}");
            c.allocation_failed = c.allocation_failed || c.conditions.failed || c.actions.failed;
            free(c.conditions.data);
            free(c.actions.data);
            c.conditions = (JsonWriter){0};
            c.actions = (JsonWriter){0};
        }
        free(patients);
    }
finish:
    diag_free(&diag);
    token_list_free(&tokens);
    source_free(&input);
finish_no_source:
    json_write(&output, "{\"schemaVersion\":1,\"success\":");
    json_write(&output, c.failed ? "false" : "true");
    json_write(&output, ",\"analysisSuccess\":");
    json_write(&output, analysis ? "true" : "false");
    json_write(&output, ",\"evaluationTime\":");
    json_string(&output, store->evaluation_time);
    json_write(&output, ",\"results\":[");
    json_write(&output, results.data ? results.data : "");
    json_write(&output, "],\"diagnostics\":[");
    json_write(&output, c.diagnostics.data ? c.diagnostics.data : "");
    json_write(&output, "]}");
    c.allocation_failed =
        c.allocation_failed || results.failed || c.diagnostics.failed || c.resolved.failed;
    free(results.data);
    free(c.diagnostics.data);
    free(c.resolved.data);
    for (size_t i = 0; i < c.string_count; i++)
        free(c.strings[i]);
    free(c.strings);
    free(c.memo);
    ast_program_free(program);
    data_store_free(store);
    free(store);
    if (c.allocation_failed)
        output.failed = true;
    return json_finish(&output);
}
