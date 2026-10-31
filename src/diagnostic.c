#include "diagnostic.h"
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

void diag_init(DiagnosticEngine *e, const SourceBuffer *source, FILE *out) {
    if (!e)
        return;
    memset(e, 0, sizeof(*e));
    e->source = source;
    e->out_stream = out;
}
static char *copy(const char *s, size_t n) {
    char *p = malloc(n + 1);
    if (p) {
        memcpy(p, s, n);
        p[n] = 0;
    }
    return p;
}
void diag_report(DiagnosticEngine *e, DiagnosticKind kind, size_t line, size_t column,
                 const char *fmt, ...) {
    if (!e)
        return;
    const char *label = "Warning";
    if (kind == DIAG_LEXICAL_ERROR) {
        e->lexical_errors++;
        label = "Lexical Error";
    } else if (kind == DIAG_SYNTAX_ERROR) {
        e->syntax_errors++;
        label = "Syntax Error";
    } else
        e->warnings++;
    char message[1024];
    va_list args;
    va_start(args, fmt);
    vsnprintf(message, sizeof(message), fmt, args);
    va_end(args);
    const char *start = "";
    size_t len = 0;
    if (e->source)
        source_get_line(e->source, line, &start, &len);
    if (e->count < 256) {
        if (e->count == e->capacity) {
            size_t cap = e->capacity ? e->capacity * 2 : 8;
            DiagnosticItem *items = realloc(e->items, cap * sizeof(*items));
            if (!items)
                e->allocation_failed = true;
            else {
                e->items = items;
                e->capacity = cap;
            }
        }
        if (!e->allocation_failed) {
            DiagnosticItem d = {0};
            d.kind = kind;
            d.line = line;
            d.column = column;
            d.end_line = line;
            d.end_column = column + 1;
            d.message = copy(message, strlen(message));
            d.snippet = copy(start, len);
            if (e->source && start >= e->source->content &&
                start <= e->source->content + e->source->length)
                d.start_offset = (size_t)(start - e->source->content) + (column ? column - 1 : 0);
            if (e->source && d.start_offset > e->source->length)
                d.start_offset = e->source->length;
            d.end_offset =
                d.start_offset + (e->source && d.start_offset < e->source->length ? 1 : 0);
            if (!d.message || !d.snippet) {
                free(d.message);
                free(d.snippet);
                e->allocation_failed = true;
            } else
                e->items[e->count++] = d;
        }
    }
    if (e->out_stream) {
        fprintf(e->out_stream, "%s:%zu:%zu: %s: %s\n",
                e->source && e->source->filename ? e->source->filename : "<input>", line, column,
                label, message);
        fprintf(e->out_stream, "    %.*s\n    ", (int)len, start);
        for (size_t i = 1; i < column; i++)
            fputc(i <= len && start[i - 1] == '\t' ? '\t' : ' ', e->out_stream);
        fprintf(e->out_stream, "^\n");
    }
}
void diag_free(DiagnosticEngine *e) {
    if (!e)
        return;
    for (size_t i = 0; i < e->count; i++) {
        free(e->items[i].message);
        free(e->items[i].snippet);
    }
    free(e->items);
    e->items = NULL;
    e->count = e->capacity = 0;
}
bool diag_has_errors(const DiagnosticEngine *e) {
    return e && (e->lexical_errors || e->syntax_errors || e->allocation_failed);
}
