#include "json.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
void json_write(JsonWriter *w, const char *text) {
    if (w->failed)
        return;
    size_t n = strlen(text);
    if (n > 16 * 1024 * 1024 || w->length > 16 * 1024 * 1024 - n) {
        w->failed = true;
        return;
    }
    size_t need = w->length + n + 1;
    if (need > w->capacity) {
        size_t cap = w->capacity ? w->capacity : 256;
        while (cap < need)
            cap *= 2;
        char *p = realloc(w->data, cap);
        if (!p) {
            w->failed = true;
            return;
        }
        w->data = p;
        w->capacity = cap;
    }
    memcpy(w->data + w->length, text, n + 1);
    w->length += n;
}
void json_string(JsonWriter *w, const char *s) {
    if (!s) {
        json_write(w, "null");
        return;
    }
    json_write(w, "\"");
    for (; *s; s++) {
        unsigned char c = (unsigned char)*s;
        if (c == '"')
            json_write(w, "\\\"");
        else if (c == '\\')
            json_write(w, "\\\\");
        else if (c < 32) {
            char b[7];
            snprintf(b, sizeof b, "\\u%04x", c);
            json_write(w, b);
        } else if (c >= 128) {
            size_t width = c >= 0xC2 && c < 0xE0    ? 2
                           : c >= 0xE0 && c < 0xF0  ? 3
                           : c >= 0xF0 && c <= 0xF4 ? 4
                                                    : 1;
            char bytes[5] = {0};
            size_t j = 0;
            while (j < width && s[j]) {
                bytes[j] = s[j];
                j++;
            }
            if (j == width && json_utf8_valid(bytes)) {
                json_write(w, bytes);
                s += width - 1;
            } else
                json_write(w, "\\ufffd");
        } else {
            char b[2] = {(char)c, 0};
            json_write(w, b);
        }
    }
    json_write(w, "\"");
}
void json_number(JsonWriter *w, double n) {
    if (!isfinite(n)) {
        json_write(w, "null");
        return;
    }
    char b[40];
    snprintf(b, sizeof b, "%.17g", n);
    json_write(w, b);
}
char *json_finish(JsonWriter *w) {
    if (!w->data && !w->failed)
        json_write(w, "");
    if (w->failed) {
        free(w->data);
        return NULL;
    }
    return w->data;
}
