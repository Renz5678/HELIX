#ifndef HELIX_DIAGNOSTIC_H
#define HELIX_DIAGNOSTIC_H

#include "source.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>

typedef enum { DIAG_LEXICAL_ERROR, DIAG_SYNTAX_ERROR, DIAG_WARNING } DiagnosticKind;

typedef struct {
    DiagnosticKind kind;
    size_t line, column, end_line, end_column;
    size_t start_offset, end_offset;
    char *message;
    char *snippet;
} DiagnosticItem;

typedef struct {
    DiagnosticItem *items;
    size_t count, capacity;
    bool allocation_failed;
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
void diag_report(DiagnosticEngine *engine, DiagnosticKind kind, size_t line, size_t column,
                 const char *fmt, ...);

/**
 * Returns true if any lexical or syntax errors were reported.
 */
void diag_free(DiagnosticEngine *engine);

bool diag_has_errors(const DiagnosticEngine *engine);

#endif /* HELIX_DIAGNOSTIC_H */
