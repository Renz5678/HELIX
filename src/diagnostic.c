#include "diagnostic.h"
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

void diag_init(DiagnosticEngine *engine, const SourceBuffer *source, FILE *out_stream) {
    if (!engine)
        return;
    memset(engine, 0, sizeof(*engine));
    engine->source = source;
    engine->out_stream = out_stream;
}

void diag_free(DiagnosticEngine *engine) {
    if (!engine)
        return;
    for (size_t i = 0; i < engine->count; i++) {
        free(engine->items[i].message);
        free(engine->items[i].snippet);
    }
    free(engine->items);
    engine->items = NULL;
    engine->count = engine->capacity = 0;

    free(engine->entries);
    engine->entries = NULL;
    engine->entry_count = engine->entry_capacity = 0;
}

size_t diag_entry_count(const DiagnosticEngine *engine) {
    if (!engine)
        return 0;
    return engine->entry_count;
}

const DiagnosticEntry *diag_get_entry(const DiagnosticEngine *engine, size_t index) {
    if (!engine || index >= engine->entry_count)
        return NULL;
    return &engine->entries[index];
}

static bool diag_record(DiagnosticEngine *engine, DiagnosticKind kind,
                        size_t line, size_t column, const char *message) {
    if (engine->entry_count >= engine->entry_capacity) {
        size_t new_cap = (engine->entry_capacity == 0) ? 8 : engine->entry_capacity * 2;
        DiagnosticEntry *grown =
            (DiagnosticEntry *)realloc(engine->entries, new_cap * sizeof(DiagnosticEntry));
        if (!grown)
            return false;
        engine->entries = grown;
        engine->entry_capacity = new_cap;
    }

    DiagnosticEntry *entry = &engine->entries[engine->entry_count++];
    entry->kind = kind;
    entry->line = line;
    entry->column = column;
    strncpy(entry->message, message, DIAG_MESSAGE_MAX - 1);
    entry->message[DIAG_MESSAGE_MAX - 1] = '\0';
    return true;
}

static char *copy(const char *s, size_t n) {
    char *p = malloc(n + 1);
    if (p) {
        for (size_t i = 0; i < n; i++)
            p[i] = s[i] ? s[i] : ' ';
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

    diag_record(e, kind, line, column, message);

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
        fprintf(e->out_stream, "%s:%zu:%zu: %s: %s\n    ",
                e->source && e->source->filename ? e->source->filename : "<input>", line, column,
                label, message);
        for (size_t i = 0; i < len; i++)
            fputc(start[i] ? start[i] : ' ', e->out_stream);
        fprintf(e->out_stream, "\n    ");
        for (size_t i = 1; i < column; i++)
            fputc(i <= len && start[i - 1] == '\t' ? '\t' : ' ', e->out_stream);
        fprintf(e->out_stream, "^\n");
    }
}

bool diag_has_errors(const DiagnosticEngine *e) {
    return e && (e->lexical_errors || e->syntax_errors || e->allocation_failed);
}
