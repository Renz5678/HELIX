#define _POSIX_C_SOURCE 200809L
#include "source.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char *duplicate_string(const char *s) {
    if (!s) return NULL;
    size_t len = strlen(s);
    char *copy = (char *)malloc(len + 1);
    if (copy) {
        memcpy(copy, s, len + 1);
    }
    return copy;
}

bool source_load(const char *path, SourceBuffer *out) {
    if (!path || !out) return false;
    out->filename = NULL;
    out->content = NULL;
    out->length = 0;

    FILE *f = fopen(path, "rb");
    if (!f) return false;

    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        return false;
    }
    long size = ftell(f);
    if (size < 0) {
        fclose(f);
        return false;
    }
    rewind(f);

    char *buf = (char *)malloc((size_t)size + 1);
    if (!buf) {
        fclose(f);
        return false;
    }

    size_t read_bytes = fread(buf, 1, (size_t)size, f);
    fclose(f);
    buf[read_bytes] = '\0';

    out->filename = duplicate_string(path);
    out->content = buf;
    out->length = read_bytes;
    return true;
}

bool source_from_string(const char *name, const char *str, SourceBuffer *out) {
    if (!str || !out) return false;
    out->filename = duplicate_string(name ? name : "<string>");
    if (!out->filename) { out->content=NULL; out->length=0; return false; }
    size_t len = strlen(str);
    out->content = (char *)malloc(len + 1);
    if (!out->content) {
        free(out->filename);
        out->filename = NULL;
        return false;
    }
    memcpy(out->content, str, len + 1);
    out->length = len;
    return true;
}

bool source_get_line(const SourceBuffer *src, size_t line_num, const char **line_start, size_t *line_len) {
    if (!src || !src->content || line_num == 0) return false;

    size_t cur_line = 1;
    const char *p = src->content;
    const char *start = p;

    while (*p != '\0') {
        if (cur_line == line_num) {
            start = p;
            while (*p != '\0' && *p != '\n' && *p != '\r') {
                p++;
            }
            *line_start = start;
            *line_len = (size_t)(p - start);
            return true;
        }

        if (*p == '\n') {
            cur_line++;
        } else if (*p == '\r') {
            if (*(p + 1) == '\n') {
                p++;
            }
            cur_line++;
        }
        p++;
    }

    if (cur_line == line_num && p >= start) {
        *line_start = p;
        *line_len = 0;
        return true;
    }

    return false;
}

void source_free(SourceBuffer *src) {
    if (!src) return;
    if (src->filename) {
        free(src->filename);
        src->filename = NULL;
    }
    if (src->content) {
        free(src->content);
        src->content = NULL;
    }
    src->length = 0;
}
