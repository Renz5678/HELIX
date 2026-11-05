#include "json.h"
#include <ctype.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct {
    const char *p;
    size_t depth, nodes;
    char *error;
    size_t error_size;
} Reader;
static void fail(Reader *r, const char *s) {
    if (r->error_size && !r->error[0])
        snprintf(r->error, r->error_size, "%s", s);
}
static void space(Reader *r) {
    while (*r->p == ' ' || *r->p == '\r' || *r->p == '\n' || *r->p == '\t')
        r->p++;
}
void json_value_free(JsonValue *v) {
    if (!v)
        return;
    for (size_t i = 0; i < v->count; i++)
        json_value_free(v->children[i]);
    free(v->children);
    free(v->string);
    free(v->key);
    free(v);
}
static int hex(char c) {
    if (c >= '0' && c <= '9')
        return c - '0';
    if (c >= 'a' && c <= 'f')
        return c - 'a' + 10;
    if (c >= 'A' && c <= 'F')
        return c - 'A' + 10;
    return -1;
}
static unsigned unicode(Reader *r) {
    unsigned v = 0;
    for (int i = 0; i < 4; i++) {
        int h = hex(*r->p);
        if (h < 0) {
            fail(r, "Invalid Unicode escape");
            return 0;
        }
        v = v * 16 + (unsigned)h;
        r->p++;
    }
    return v;
}
static char *string(Reader *r) {
    if (*r->p != '"') {
        fail(r, "Expected JSON string");
        return NULL;
    }
    r->p++;
    JsonWriter w = {0};
    while (*r->p && *r->p != '"') {
        unsigned char c = (unsigned char)*r->p++;
        if (c < 32) {
            fail(r, "Control character in JSON string");
            break;
        }
        if (c == '\\') {
            char e = *r->p;
            if (!e) {
                fail(r, "Incomplete escape");
                break;
            }
            r->p++;
            if (e == 'u') {
                unsigned u = unicode(r);
                if (u >= 0xD800 && u <= 0xDBFF) {
                    if (r->p[0] != '\\' || r->p[1] != 'u') {
                        fail(r, "Unpaired surrogate");
                        break;
                    }
                    r->p += 2;
                    unsigned lo = unicode(r);
                    if (lo < 0xDC00 || lo > 0xDFFF) {
                        fail(r, "Unpaired surrogate");
                        break;
                    }
                    u = 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00);
                } else if (u >= 0xDC00 && u <= 0xDFFF) {
                    fail(r, "Unpaired surrogate");
                    break;
                }
                if (!u) {
                    fail(r, "Embedded NUL is unsupported");
                    break;
                }
                char b[5] = {0};
                if (u < 128)
                    b[0] = (char)u;
                else if (u < 2048) {
                    b[0] = (char)(0xc0 | (u >> 6));
                    b[1] = (char)(0x80 | (u & 63));
                } else if (u < 65536) {
                    b[0] = (char)(0xe0 | (u >> 12));
                    b[1] = (char)(0x80 | ((u >> 6) & 63));
                    b[2] = (char)(0x80 | (u & 63));
                } else {
                    b[0] = (char)(0xf0 | (u >> 18));
                    b[1] = (char)(0x80 | ((u >> 12) & 63));
                    b[2] = (char)(0x80 | ((u >> 6) & 63));
                    b[3] = (char)(0x80 | (u & 63));
                }
                json_write(&w, b);
                continue;
            }
            if (e == 'n')
                c = '\n';
            else if (e == 'r')
                c = '\r';
            else if (e == 't')
                c = '\t';
            else if (e == 'b')
                c = '\b';
            else if (e == 'f')
                c = '\f';
            else if (e == '"' || e == '\\' || e == '/')
                c = (unsigned char)e;
            else {
                fail(r, "Invalid JSON escape");
                break;
            }
        }
        char b[2] = {(char)c, 0};
        json_write(&w, b);
    }
    if (*r->p != '"')
        fail(r, "Unterminated JSON string");
    else
        r->p++;
    char *s = json_finish(&w);
    if (!s)
        fail(r, "Allocation failure");
    return s;
}
static JsonValue *value(Reader *r) {
    space(r);
    if (++r->depth > 64 || ++r->nodes > 250000) {
        fail(r, "JSON complexity limit exceeded");
        r->depth--;
        return NULL;
    }
    JsonValue *v = calloc(1, sizeof(*v));
    if (!v) {
        fail(r, "Allocation failure");
        r->depth--;
        return NULL;
    }
    char c = *r->p;
    if (c == '{' || c == '[') {
        v->type = c == '{' ? JSON_OBJECT : JSON_ARRAY;
        r->p++;
        space(r);
        char close = c == '{' ? '}' : ']';
        if (*r->p != close)
            for (;;) {
                char *key = NULL;
                if (c == '{') {
                    key = string(r);
                    space(r);
                    if (*r->p != ':') {
                        free(key);
                        fail(r, "Expected colon");
                        break;
                    }
                    r->p++;
                }
                JsonValue *child = value(r);
                if (!child) {
                    free(key);
                    break;
                }
                child->key = key;
                if (key)
                    for (size_t i = 0; i < v->count; i++)
                        if (!strcmp(v->children[i]->key, key))
                            fail(r, "Duplicate JSON key");
                JsonValue **a = realloc(v->children, (v->count + 1) * sizeof(*a));
                if (!a) {
                    json_value_free(child);
                    fail(r, "Allocation failure");
                    break;
                }
                v->children = a;
                v->children[v->count++] = child;
                space(r);
                if (*r->p != ',')
                    break;
                r->p++;
                space(r);
            }
        space(r);
        if (*r->p != close)
            fail(r, "Expected closing delimiter");
        else
            r->p++;
    } else if (c == '"') {
        v->type = JSON_STRING;
        v->string = string(r);
    } else if (!strncmp(r->p, "true", 4)) {
        v->type = JSON_BOOL;
        v->boolean = true;
        r->p += 4;
    } else if (!strncmp(r->p, "false", 5)) {
        v->type = JSON_BOOL;
        r->p += 5;
    } else if (!strncmp(r->p, "null", 4)) {
        r->p += 4;
    } else if (c == '-' || (c >= '0' && c <= '9')) {
        const char *start = r->p;
        if (*r->p == '-')
            r->p++;
        if (*r->p == '0')
            r->p++;
        else if (*r->p >= '1' && *r->p <= '9')
            while (isdigit((unsigned char)*r->p))
                r->p++;
        else
            fail(r, "Invalid JSON number");
        if (*r->p == '.') {
            r->p++;
            if (!isdigit((unsigned char)*r->p))
                fail(r, "Invalid fraction");
            while (isdigit((unsigned char)*r->p))
                r->p++;
        }
        if (*r->p == 'e' || *r->p == 'E') {
            r->p++;
            if (*r->p == '+' || *r->p == '-')
                r->p++;
            if (!isdigit((unsigned char)*r->p))
                fail(r, "Invalid exponent");
            while (isdigit((unsigned char)*r->p))
                r->p++;
        }
        v->type = JSON_NUMBER;
        v->number = strtod(start, NULL);
        if (!isfinite(v->number))
            fail(r, "Nonfinite JSON number");
    } else
        fail(r, "Expected JSON value");
    r->depth--;
    if (r->error[0]) {
        json_value_free(v);
        return NULL;
    }
    return v;
}
bool json_utf8_valid(const char *text) {
    if (!text)
        return false;
    const unsigned char *p = (const unsigned char *)text;
    while (*p) {
        unsigned code;
        int extra;
        unsigned char first = *p++;
        if (first < 128)
            continue;
        if (first >= 0xC2 && first <= 0xDF) {
            code = first & 31;
            extra = 1;
        } else if (first >= 0xE0 && first <= 0xEF) {
            code = first & 15;
            extra = 2;
        } else if (first >= 0xF0 && first <= 0xF4) {
            code = first & 7;
            extra = 3;
        } else
            return false;
        for (int i = 0; i < extra; i++) {
            if ((*p & 0xC0) != 0x80)
                return false;
            code = (code << 6) | (*p++ & 63);
        }
        if ((extra == 2 && code < 0x800) || (extra == 3 && code < 0x10000) ||
            (code >= 0xD800 && code <= 0xDFFF) || code > 0x10FFFF)
            return false;
    }
    return true;
}
JsonValue *json_parse(const char *text, char *error, size_t size) {
    if (!error || !size)
        return NULL;
    error[0] = 0;
    if (!text || strlen(text) > 8 * 1024 * 1024 || !json_utf8_valid(text)) {
        snprintf(error, size, "JSON input limit exceeded");
        return NULL;
    }
    Reader r = {text, 0, 0, error, size};
    JsonValue *v = value(&r);
    space(&r);
    if (*r.p)
        fail(&r, "Trailing JSON data");
    if (error[0]) {
        json_value_free(v);
        return NULL;
    }
    return v;
}
JsonValue *json_get(const JsonValue *v, const char *key) {
    if (!v || v->type != JSON_OBJECT)
        return NULL;
    for (size_t i = 0; i < v->count; i++)
        if (!strcmp(v->children[i]->key, key))
            return v->children[i];
    return NULL;
}
const char *json_text(const JsonValue *v) { return v && v->type == JSON_STRING ? v->string : NULL; }
