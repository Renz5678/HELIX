#ifndef HELIX_SOURCE_H
#define HELIX_SOURCE_H

#include <stddef.h>
#include <stdbool.h>

/**
 * Represents a source file loaded into contiguous memory.
 */
typedef struct {
    char *filename;   /* Heap-allocated copy of filename */
    char *content;    /* Heap-allocated null-terminated buffer */
    size_t length;    /* Content length in bytes (excluding null terminator) */
} SourceBuffer;

/**
 * Loads a file from path into a SourceBuffer.
 * Returns true on success, false on I/O error.
 */
bool source_load(const char *path, SourceBuffer *out);

/**
 * Initializes a SourceBuffer from an in-memory byte buffer of explicit length.
 * Returns true on success.
 */
bool source_from_memory(const char *name, const char *data, size_t len, SourceBuffer *out);

/**
 * Initializes a SourceBuffer from an in-memory string (useful for unit tests).
 * Returns true on success.
 */
bool source_from_string(const char *name, const char *str, SourceBuffer *out);

/**
 * Retrieves a pointer to the start of a given 1-indexed line and its length.
 * Does not include newline characters in the length.
 * Returns true if the line exists, false otherwise.
 */
bool source_get_line(const SourceBuffer *src, size_t line_num, const char **line_start, size_t *line_len);

/**
 * Frees memory owned by the SourceBuffer.
 */
void source_free(SourceBuffer *src);

#endif /* HELIX_SOURCE_H */
