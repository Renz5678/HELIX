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

/** Maximum stored length (including NUL) for a recorded diagnostic message. */
#define DIAG_MESSAGE_MAX 256

/**
 * A single recorded diagnostic (structured form, for programmatic access
 * such as tests, JSON APIs, or GUI front-ends).
 */
typedef struct {
    DiagnosticKind kind;
    size_t line;
    size_t column;
    char message[DIAG_MESSAGE_MAX];
} DiagnosticEntry;

typedef struct {
    const SourceBuffer *source;
    size_t lexical_errors;
    size_t syntax_errors;
    size_t warnings;
    FILE *out_stream;
    /* Structured record of every reported diagnostic (owned; freed by diag_free). */
    DiagnosticEntry *entries;
    size_t entry_count;
    size_t entry_capacity;
} DiagnosticEngine;

/**
 * Initializes a DiagnosticEngine tied to a given SourceBuffer.
 */
void diag_init(DiagnosticEngine *engine, const SourceBuffer *source, FILE *out_stream);

/**
 * Frees the structured diagnostic record owned by the engine.
 */
void diag_free(DiagnosticEngine *engine);

/**
 * Returns the number of recorded diagnostic entries.
 */
size_t diag_entry_count(const DiagnosticEngine *engine);

/**
 * Returns a pointer to the i-th recorded entry, or NULL if out of range.
 */
const DiagnosticEntry *diag_get_entry(const DiagnosticEngine *engine, size_t index);

/**
 * Emits a formatted diagnostic message with source line visual context and caret pointer.
 */
void diag_report(DiagnosticEngine *engine, DiagnosticKind kind, size_t line, size_t column, const char *fmt, ...);

/**
 * Returns true if any lexical or syntax errors were reported.
 */
bool diag_has_errors(const DiagnosticEngine *engine);

#endif /* HELIX_DIAGNOSTIC_H */
