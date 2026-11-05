#include "diagnostic.h"
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

void diag_init(DiagnosticEngine *engine, const SourceBuffer *source, FILE *out_stream) {
    if (!engine) return;
    engine->source = source;
    engine->lexical_errors = 0;
    engine->syntax_errors = 0;
    engine->warnings = 0;
    engine->out_stream = out_stream;
    engine->entries = NULL;
    engine->entry_count = 0;
    engine->entry_capacity = 0;
}

void diag_free(DiagnosticEngine *engine) {
    if (!engine) return;
    free(engine->entries);
    engine->entries = NULL;
    engine->entry_count = 0;
    engine->entry_capacity = 0;
}

size_t diag_entry_count(const DiagnosticEngine *engine) {
    if (!engine) return 0;
    return engine->entry_count;
}

const DiagnosticEntry *diag_get_entry(const DiagnosticEngine *engine, size_t index) {
    if (!engine || index >= engine->entry_count) return NULL;
    return &engine->entries[index];
}

/* Appends a structured entry; returns false on allocation failure. */
static bool diag_record(DiagnosticEngine *engine, DiagnosticKind kind,
                        size_t line, size_t column, const char *message) {
    if (engine->entry_count >= engine->entry_capacity) {
        size_t new_cap = (engine->entry_capacity == 0) ? 8 : engine->entry_capacity * 2;
        DiagnosticEntry *grown =
            (DiagnosticEntry *)realloc(engine->entries, new_cap * sizeof(DiagnosticEntry));
        if (!grown) return false;
        engine->entries = grown;
        engine->entry_capacity = new_cap;
    }

    DiagnosticEntry *entry = &engine->entries[engine->entry_count++];
    entry->kind = kind;
    entry->line = line;
    entry->column = column;
    /* Truncating copy into fixed buffer (vsnprintf-style safety). */
    strncpy(entry->message, message, DIAG_MESSAGE_MAX - 1);
    entry->message[DIAG_MESSAGE_MAX - 1] = '\0';
    return true;
}

void diag_report(DiagnosticEngine *engine, DiagnosticKind kind, size_t line, size_t column, const char *fmt, ...) {
    if (!engine) return;

    const char *kind_str = "Error";
    if (kind == DIAG_LEXICAL_ERROR) {
        kind_str = "Lexical Error";
        engine->lexical_errors++;
    } else if (kind == DIAG_SYNTAX_ERROR) {
        kind_str = "Syntax Error";
        engine->syntax_errors++;
    } else if (kind == DIAG_WARNING) {
        kind_str = "Warning";
        engine->warnings++;
    }

    /* Format once; keep a structured copy for programmatic consumers. */
    char message[DIAG_MESSAGE_MAX];
    va_list msg_args;
    va_start(msg_args, fmt);
    vsnprintf(message, sizeof(message), fmt, msg_args);
    va_end(msg_args);
    diag_record(engine, kind, line, column, message);

    const char *fname = (engine->source && engine->source->filename) ? engine->source->filename : "<input>";
    FILE *out = engine->out_stream;

    if (!out) {
        return;
    }

    fprintf(out, "%s:%zu:%zu: %s: ", fname, line, column, kind_str);
    fprintf(out, "%s\n", message);

    /* Print source snippet and caret */
    if (engine->source && line > 0) {
        const char *line_start = NULL;
        size_t line_len = 0;
        if (source_get_line(engine->source, line, &line_start, &line_len)) {
            fprintf(out, "    %.*s\n", (int)line_len, line_start);
            fprintf(out, "    ");
            for (size_t i = 1; i < column; i++) {
                /* If character is a tab, indent by tab size or space */
                if (i <= line_len && line_start[i - 1] == '\t') {
                    fputc('\t', out);
                } else {
                    fputc(' ', out);
                }
            }
            fprintf(out, "^\n");
        }
    }
}

bool diag_has_errors(const DiagnosticEngine *engine) {
    if (!engine) return false;
    return (engine->lexical_errors > 0 || engine->syntax_errors > 0);
}
