#include "diagnostic.h"
#include <stdarg.h>
#include <string.h>

void diag_init(DiagnosticEngine *engine, const SourceBuffer *source, FILE *out_stream) {
    if (!engine) return;
    engine->source = source;
    engine->lexical_errors = 0;
    engine->syntax_errors = 0;
    engine->warnings = 0;
    engine->out_stream = out_stream ? out_stream : stderr;
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

    const char *fname = (engine->source && engine->source->filename) ? engine->source->filename : "<input>";
    FILE *out = engine->out_stream ? engine->out_stream : stderr;

    fprintf(out, "%s:%zu:%zu: %s: ", fname, line, column, kind_str);

    va_list args;
    va_start(args, fmt);
    vfprintf(out, fmt, args);
    va_end(args);
    fprintf(out, "\n");

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
