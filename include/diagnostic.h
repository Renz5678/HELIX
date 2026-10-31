#ifndef HELIX_DIAGNOSTIC_H
#define HELIX_DIAGNOSTIC_H

#include <stddef.h>
#include <stdbool.h>
#include <stdio.h>
#include "source.h"

typedef enum {
    DIAG_LEXICAL_ERROR,
    DIAG_SYNTAX_ERROR,
    DIAG_WARNING
} DiagnosticKind;

typedef struct {
    const SourceBuffer *source;
    size_t lexical_errors;
    size_t syntax_errors;
    size_t warnings;
    FILE *out_stream;
} DiagnosticEngine;

/**
 * Initializes a DiagnosticEngine tied to a given SourceBuffer.
 */
void diag_init(DiagnosticEngine *engine, const SourceBuffer *source, FILE *out_stream);

/**
 * Emits a formatted diagnostic message with source line visual context and caret pointer.
 */
void diag_report(DiagnosticEngine *engine, DiagnosticKind kind, size_t line, size_t column, const char *fmt, ...);

/**
 * Returns true if any lexical or syntax errors were reported.
 */
bool diag_has_errors(const DiagnosticEngine *engine);

#endif /* HELIX_DIAGNOSTIC_H */
