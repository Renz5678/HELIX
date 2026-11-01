/*
 * helix-server.c — Local HTTP server exposing the HELIX analyzer to a browser GUI.
 *
 * Serves gui/index.html and a JSON analysis API:
 *   GET  /               -> the IDE front-end (gui/index.html)
 *   GET  /api/health     -> {"ok":true}
 *   POST /api/analyze    -> body = raw HELIX source, response = tokens + diagnostics JSON
 *
 * Pure ISO C11 + Winsock (Windows system API only; no third-party libraries).
 * The lexer/parser core used here is the exact same code as the CLI.
 *
 * Usage:
 *   helix-server.exe [--port N] [--no-open] [--help]
 */
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <stdbool.h>
#include <ctype.h>
#include <time.h>
#include <dirent.h>
#include <direct.h>   /* _mkdir (Windows/MinGW) */
#include <errno.h>

/*
 * Windows' winnt.h declares an enumerator named 'TokenType', which collides
 * with HELIX's TokenType typedef. Alias ours for this translation unit only.
 * (C linkage is unaffected by typedef names, so linking stays intact.)
 */
#define TokenType HelixTokenType

#include "source.h"
#include "diagnostic.h"
#include "token.h"
#include "keywords.h"
#include "lexer.h"
#include "parser.h"

#define DEFAULT_PORT    8080
#define REQUEST_CAP     (64 * 1024)   /* max header+body bytes we read   */
#define BODY_CAP        (512 * 1024)  /* max accepted source size        */
#define INDEX_CANDIDATES { "gui/dist/index.html", "..\\gui\\dist\\index.html" }
#define STATIC_ROOT      "gui/dist"    /* built React front-end (npm run build in gui/web) */

/* Serve a file under STATIC_ROOT. Rejects traversal ('..', backslash).
 * Definition lives after read_file_all()/send_response(). */
static void serve_static(SOCKET c, const char *url_path);

/* MIME type by file extension for static assets. */
static const char *mime_type(const char *path) {
    const char *dot = strrchr(path, '.');
    if (!dot) return "application/octet-stream";
    if (strcmp(dot, ".html") == 0) return "text/html; charset=utf-8";
    if (strcmp(dot, ".js") == 0)   return "application/javascript; charset=utf-8";
    if (strcmp(dot, ".css") == 0)  return "text/css; charset=utf-8";
    if (strcmp(dot, ".json") == 0) return "application/json; charset=utf-8";
    if (strcmp(dot, ".svg") == 0)  return "image/svg+xml";
    if (strcmp(dot, ".png") == 0)  return "image/png";
    if (strcmp(dot, ".ico") == 0)  return "image/x-icon";
    if (strcmp(dot, ".map") == 0)  return "application/json";
    if (strcmp(dot, ".woff2") == 0) return "font/woff2";
    if (strcmp(dot, ".woff") == 0)  return "font/woff";
    if (strcmp(dot, ".txt") == 0)  return "text/plain; charset=utf-8";
    return "application/octet-stream";
}

/* ------------------------------------------------------------------ */
/* Growable byte buffer (for building JSON responses)                 */
/* ------------------------------------------------------------------ */
typedef struct {
    char *data;
    size_t len;
    size_t cap;
} Buf;

static bool buf_init(Buf *b, size_t cap) {
    b->data = (char *)malloc(cap);
    if (!b->data) return false;
    b->len = 0;
    b->cap = cap;
    return true;
}

static void buf_append(Buf *b, const char *s, size_t n) {
    if (b->len + n + 1 > b->cap) {
        while (b->len + n + 1 > b->cap) b->cap *= 2;
        char *grown = (char *)realloc(b->data, b->cap);
        if (!grown) return;
        b->data = grown;
    }
    memcpy(b->data + b->len, s, n);
    b->len += n;
    b->data[b->len] = '\0';
}

static void buf_puts(Buf *b, const char *s) { buf_append(b, s, strlen(s)); }

static void buf_printf(Buf *b, const char *fmt, ...) {
    char tmp[1024];
    va_list args;
    va_start(args, fmt);
    int n = vsnprintf(tmp, sizeof(tmp), fmt, args);
    va_end(args);
    if (n > 0) buf_append(b, tmp, (size_t)n < sizeof(tmp) ? (size_t)n : sizeof(tmp) - 1);
}

/* ------------------------------------------------------------------ */
/* JSON helpers                                                        */
/* ------------------------------------------------------------------ */
static void json_escape_into(Buf *b, const char *s) {
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        unsigned char c = *p;
        switch (c) {
            case '"':  buf_puts(b, "\\\""); break;
            case '\\': buf_puts(b, "\\\\"); break;
            case '\n': buf_puts(b, "\\n");  break;
            case '\r': buf_puts(b, "\\r");  break;
            case '\t': buf_puts(b, "\\t");  break;
            default:
                if (c < 0x20) {
                    char esc[8];
                    snprintf(esc, sizeof(esc), "\\u%04x", c);
                    buf_puts(b, esc);
                } else {
                    buf_append(b, (const char *)p, 1); /* UTF-8 bytes pass through */
                }
        }
    }
}

/* Maps a TokenType to the compact "kind" the front-end uses for coloring. */
static const char *token_kind(TokenType t) {
    switch (t) {
        case TOKEN_IDENTIFIER:  return "identifier";
        case TOKEN_INT_LIT:
        case TOKEN_FLOAT_LIT:   return "number";
        case TOKEN_STRING_LIT:  return "string";
        case TOKEN_ASSIGN: case TOKEN_EQUAL: case TOKEN_EQ: case TOKEN_NEQ:
        case TOKEN_GT: case TOKEN_GTE: case TOKEN_LT: case TOKEN_LTE:
        case TOKEN_ARROW:       return "operator";
        case TOKEN_COLON: case TOKEN_DOT: case TOKEN_COMMA:
        case TOKEN_LPAREN: case TOKEN_RPAREN:
        case TOKEN_LBRACKET: case TOKEN_RBRACKET: return "delimiter";
        case TOKEN_EOF:         return "eof";
        case TOKEN_ERROR:       return "error";
        default:                return token_is_keyword(t) ? "keyword" : "identifier";
    }
}

static const char *diag_severity(DiagnosticKind k) {
    switch (k) {
        case DIAG_LEXICAL_ERROR: return "lexical";
        case DIAG_SYNTAX_ERROR:  return "syntax";
        default:                 return "warning";
    }
}

/* ------------------------------------------------------------------ */
/* The analysis pipeline: source -> lexer -> parser -> JSON            */
/* ------------------------------------------------------------------ */
static char *analyze_to_json(const char *code, size_t code_len, size_t *out_len) {
    SourceBuffer src;
    if (!source_from_string("input.helix", code, &src)) return NULL;

    DiagnosticEngine diag;
    diag_init(&diag, &src, NULL);           /* record structured entries, no console I/O */

    Lexer lexer;
    lexer_init(&lexer, &src, &diag);
    TokenList tokens;
    lexer_tokenize_all(&lexer, &tokens);

    Parser parser;
    parser_init(&parser, &tokens, &diag);
    parser_parse(&parser);

    size_t rules = 0;
    for (size_t i = 0; i < tokens.count; i++) {
        if (tokens.items[i].type == TOKEN_KW_RULE) rules++;
    }

    size_t lines = 0;
    for (size_t i = 0; i < code_len; i++) if (code[i] == '\n') lines++;
    if (code_len > 0) lines++;

    bool valid = (diag.lexical_errors == 0 && diag.syntax_errors == 0);

    Buf b = {NULL, 0, 0};
    if (!buf_init(&b, 4096)) goto cleanup;

    buf_puts(&b, "{\"ok\":true,\"stats\":{");
    buf_printf(&b, "\"tokens\":%zu,\"lexicalErrors\":%zu,\"syntaxErrors\":%zu,"
                   "\"warnings\":%zu,\"rules\":%zu,\"bytes\":%zu,\"lines\":%zu,"
                   "\"valid\":%s}",
               tokens.count, diag.lexical_errors, diag.syntax_errors,
               diag.warnings, rules, code_len, lines, valid ? "true" : "false");

    buf_puts(&b, ",\"tokens\":[");
    for (size_t i = 0; i < tokens.count; i++) {
        const Token *t = &tokens.items[i];
        if (i) buf_puts(&b, ",");
        buf_printf(&b, "{\"line\":%zu,\"column\":%zu,\"type\":\"%s\",\"kind\":\"%s\","
                       "\"error\":%s,\"lexeme\":\"",
                   t->line, t->column, token_type_name(t->type), token_kind(t->type),
                   t->type == TOKEN_ERROR ? "true" : "false");
        json_escape_into(&b, t->lexeme);
        buf_puts(&b, "\"}");
    }
    buf_puts(&b, "]");

    buf_puts(&b, ",\"diagnostics\":[");
    size_t entry_count = diag_entry_count(&diag);
    for (size_t i = 0; i < entry_count; i++) {
        const DiagnosticEntry *e = diag_get_entry(&diag, i);
        if (i) buf_puts(&b, ",");
        buf_printf(&b, "{\"severity\":\"%s\",\"line\":%zu,\"column\":%zu,\"message\":\"",
                   diag_severity(e->kind), e->line, e->column);
        json_escape_into(&b, e->message);
        buf_puts(&b, "\"}");
    }
    buf_puts(&b, "]}");

cleanup:
    token_list_free(&tokens);
    diag_free(&diag);
    source_free(&src);
    if (!b.data) return NULL;
    *out_len = b.len;
    return b.data;
}

/* ------------------------------------------------------------------ */
/* File helper: read a whole file into a malloc'd NUL-terminated buf   */
/* ------------------------------------------------------------------ */
static char *read_file_all(const char *path, size_t *out_len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    rewind(f);
    if (size < 0) { fclose(f); return NULL; }
    char *buf = (char *)malloc((size_t)size + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t got = fread(buf, 1, (size_t)size, f);
    fclose(f);
    buf[got] = '\0';
    if (out_len) *out_len = got;
    return buf;
}

/* ------------------------------------------------------------------ */
/* Clinical module library: browse .helix files on disk                */
/* ------------------------------------------------------------------ */
static void collect_dir(const char *real_dir, const char *display_dir,
                        bool read_only, Buf *out_json, size_t *count) {
    DIR *d = opendir(real_dir);
    if (!d) return;
    struct dirent *ent;
    while ((ent = readdir(d)) != NULL) {
        const char *nm = ent->d_name;
        size_t l = strlen(nm);
        if (l < 7 || strcmp(nm + l - 6, ".helix") != 0) continue;

        char full[512];
        if (strcmp(real_dir, ".") == 0)
            snprintf(full, sizeof(full), "%s", nm);
        else
            snprintf(full, sizeof(full), "%s/%s", real_dir, nm);

        if (*count) buf_puts(out_json, ",");
        buf_puts(out_json, "{\"path\":\"");
        json_escape_into(out_json, full);
        buf_puts(out_json, "\",\"name\":\"");
        json_escape_into(out_json, nm);
        buf_puts(out_json, "\",\"dir\":\"");
        json_escape_into(out_json, display_dir);
        buf_puts(out_json, "\",\"ro\":");
        buf_puts(out_json, read_only ? "true" : "false");
        buf_puts(out_json, "}");
        (*count)++;
    }
    closedir(d);
}

/* Minimal %XX URL decoding in place. */
static void url_decode(char *s) {
    char *o = s;
    while (*s) {
        if (*s == '%' && s[1] && s[2]) {
            char hex[3] = { s[1], s[2], '\0' };
            *o++ = (char)strtol(hex, NULL, 16);
            s += 3;
        } else {
            *o++ = *s++;
        }
    }
    *o = '\0';
}

/* Only paths inside these project folders may be read. */
static bool is_safe_module_path(const char *p) {
    if (strstr(p, "..")) return false;
    return strncmp(p, "examples/", 9) == 0 || strncmp(p, "tests/", 6) == 0 ||
           strncmp(p, "workspace/", 10) == 0;
}

/* Filesystem mutations are confined to the user workspace. */
static bool is_safe_write_path(const char *p) {
    if (strstr(p, "..")) return false;
    return strncmp(p, "workspace/", 10) == 0;
}

/* Extracts a decoded ?name=value query parameter (value written into out). */
static bool query_param(const char *url, const char *name, char *out, size_t outcap) {
    const char *s = strchr(url, '?');
    if (!s) return false;
    s++;
    size_t nlen = strlen(name);
    while (*s) {
        if (strncmp(s, name, nlen) == 0 && s[nlen] == '=') {
            const char *v = s + nlen + 1;
            size_t i = 0;
            while (v[i] && v[i] != '&' && i + 1 < outcap) {
                out[i] = v[i];
                i++;
            }
            out[i] = '\0';
            url_decode(out);
            return true;
        }
        while (*s && *s != '&') s++;
        if (*s == '&') s++;
    }
    return false;
}

/* ------------------------------------------------------------------ */
/* HTTP plumbing                                                       */
/* ------------------------------------------------------------------ */
static void send_all(SOCKET s, const char *buf, size_t len) {
    size_t sent = 0;
    while (sent < len) {
        int n = send(s, buf + sent, (int)(len - sent), 0);
        if (n <= 0) return;
        sent += (size_t)n;
    }
}

static void send_response(SOCKET s, const char *status, const char *ctype,
                          const char *body, size_t body_len) {
    char header[256];
    int n = snprintf(header, sizeof(header),
                     "HTTP/1.1 %s\r\n"
                     "Content-Type: %s\r\n"
                     "Content-Length: %zu\r\n"
                     "Cache-Control: no-store\r\n"
                     "Connection: close\r\n"
                     "X-Content-Type-Options: nosniff\r\n"
                     "\r\n",
                     status, ctype, body_len);
    send_all(s, header, (size_t)n);
    send_all(s, body, body_len);
}

static void send_json(SOCKET s, const char *status, const char *json, size_t len) {
    send_response(s, status, "application/json; charset=utf-8", json, len);
}

/* Serve a static file under STATIC_ROOT (the built React front-end).
 * Rejects any path with ".." or backslashes before touching the disk. */
static void serve_static(SOCKET c, const char *url_path) {
    if (strstr(url_path, "..") || strchr(url_path, '\\')) {
        send_response(c, "403 Forbidden", "text/plain; charset=utf-8",
                      "Forbidden", 9);
        return;
    }
    char file[512];
    snprintf(file, sizeof(file), "%s%s", STATIC_ROOT, url_path);
    size_t len = 0;
    char *content = read_file_all(file, &len);
    if (!content) {
        const char *msg = "Not found - build the front-end (mingw32-make web)";
        send_response(c, "404 Not Found", "text/plain; charset=utf-8",
                      msg, strlen(msg));
        return;
    }
    send_response(c, "200 OK", mime_type(file), content, len);
    free(content);
}

/* Case-insensitive header lookup: returns pointer after ':' or NULL. */
static const char *find_header_value(const char *headers, const char *name) {
    size_t name_len = strlen(name);
    for (const char *p = headers; *p; p++) {
        size_t i = 0;
        while (i < name_len && p[i] &&
               tolower((unsigned char)p[i]) == tolower((unsigned char)name[i])) i++;
        if (i == name_len && p[i] == ':') {
            const char *v = p + i + 1;
            while (*v == ' ' || *v == '\t') v++;
            return v;
        }
        /* advance to start of next line */
        while (*p && *p != '\n') p++;
        if (!*p) break;
    }
    return NULL;
}

/* Reads one HTTP request. Returns total bytes stored, or -1 on error. */
static long read_request(SOCKET c, char *buf, size_t cap) {
    size_t total = 0;
    size_t header_end = 0;      /* offset just past "\r\n\r\n" (0 = not found yet) */
    long content_length = 0;

    while (total < cap) {
        int n = recv(c, buf + total, (int)(cap - total), 0);
        if (n <= 0) break;
        total += (size_t)n;
        buf[total] = '\0';

        if (!header_end) {
            char *found = strstr(buf, "\r\n\r\n");
            if (!found) continue;
            header_end = (size_t)(found - buf) + 4;

            const char *cl = find_header_value(buf, "Content-Length");
            if (cl) content_length = strtol(cl, NULL, 10);
            if (content_length < 0) content_length = 0;
            if (content_length > BODY_CAP) return -2; /* 413 */
        }
        if (header_end && (long)total >= (long)header_end + content_length) {
            return (long)total;
        }
    }
    return (long)total;
}

/* ------------------------------------------------------------------ */
/* Request handling                                                    */
/* ------------------------------------------------------------------ */
static void handle_client(SOCKET c) {
    char *req = (char *)malloc(REQUEST_CAP + 1);
    if (!req) return;

    long got = read_request(c, req, REQUEST_CAP);
    if (got <= 0) { free(req); return; }

    char method[8] = {0};
    char path[256] = {0};
    if (sscanf(req, "%7s %255s", method, path) != 2) {
        send_response(c, "400 Bad Request", "text/plain; charset=utf-8",
                      "Bad request", 11);
        free(req); return;
    }

    char *headers_end = strstr(req, "\r\n\r\n");
    char *body = headers_end ? headers_end + 4 : req + got;
    size_t body_len = (size_t)got - (size_t)(body - req);

    if (strcmp(method, "GET") == 0 &&
        (strcmp(path, "/") == 0 || strcmp(path, "/index.html") == 0)) {
        size_t html_len = 0;
        char *html = NULL;
        const char *candidates[] = INDEX_CANDIDATES;
        for (size_t i = 0; i < sizeof(candidates) / sizeof(candidates[0]) && !html; i++) {
            html = read_file_all(candidates[i], &html_len);
        }
        if (html) {
            send_response(c, "200 OK", "text/html; charset=utf-8", html, html_len);
            free(html);
        } else {
            const char *msg = "gui/index.html not found - run from the project root";
            send_response(c, "500 Internal Server Error", "text/plain; charset=utf-8",
                          msg, strlen(msg));
        }
    } else if (strcmp(method, "GET") == 0 && strcmp(path, "/favicon.ico") == 0) {
        send_response(c, "204 No Content", "text/plain", "", 0);
    } else if (strcmp(method, "GET") == 0 && strncmp(path, "/api/", 5) != 0) {
        /* Static asset from the built front-end (gui/dist/assets/..., etc.) */
        char clean[256];
        snprintf(clean, sizeof(clean), "%s", path);
        char *q = strchr(clean, '?');
        if (q) *q = '\0'; /* drop query string */
        if (strcmp(clean, "/index.html") == 0) {
            /* fall through to the index handler below via serve_static root */
            size_t html_len = 0;
            char *html = NULL;
            const char *candidates[] = INDEX_CANDIDATES;
            for (size_t i = 0; i < sizeof(candidates) / sizeof(candidates[0]) && !html; i++) {
                html = read_file_all(candidates[i], &html_len);
            }
            if (html) {
                send_response(c, "200 OK", "text/html; charset=utf-8", html, html_len);
                free(html);
            } else {
                const char *msg = "Front-end not built - run 'mingw32-make web'";
                send_response(c, "500 Internal Server Error", "text/plain; charset=utf-8",
                              msg, strlen(msg));
            }
        } else {
            serve_static(c, clean);
        }
    } else if (strcmp(method, "GET") == 0 && strcmp(path, "/api/health") == 0) {
        send_json(c, "200 OK", "{\"ok\":true}", 12);
    } else if (strcmp(method, "GET") == 0 && strcmp(path, "/api/library") == 0) {
        Buf b = {NULL, 0, 0};
        if (buf_init(&b, 2048)) {
            size_t count = 0;
            buf_puts(&b, "{\"ok\":true,\"files\":[");

            /* User workspace folders (writable) — dynamic sub-directories */
            DIR *ws = opendir("workspace");
            if (ws) {
                struct dirent *ent;
                while ((ent = readdir(ws)) != NULL) {
                    if (ent->d_name[0] == '.') continue;
                    char sub[300];
                    snprintf(sub, sizeof(sub), "workspace/%s", ent->d_name);
                    collect_dir(sub, ent->d_name, false, &b, &count);
                }
                closedir(ws);
            }

            /* Project fixtures (read-only — protected test data) */
            collect_dir("examples", "examples", true, &b, &count);
            collect_dir("tests/parser", "tests", true, &b, &count);
            collect_dir("tests/invalid", "tests", true, &b, &count);
            buf_puts(&b, "]}");
            send_json(c, "200 OK", b.data, b.len);
            free(b.data);
        } else {
            send_json(c, "500 Internal Server Error",
                      "{\"ok\":false}", 12);
        }
    } else if (strcmp(method, "POST") == 0 && strncmp(path, "/api/fs?", 8) == 0) {
        /* Filesystem operations, confined to workspace/ */
        char op[32] = {0}, rel[512] = {0}, to[512] = {0}, kind[16] = {0};
        query_param(path, "op", op, sizeof(op));
        query_param(path, "path", rel, sizeof(rel));
        query_param(path, "to", to, sizeof(to));
        query_param(path, "kind", kind, sizeof(kind));

        const char *resp = "{\"ok\":true}";
        const char *status = "200 OK";

        if (!op[0] || !is_safe_write_path(rel)) {
            status = "403 Forbidden";
            resp = "{\"ok\":false,\"error\":\"invalid path\"}";
        } else if (strcmp(op, "mkdir") == 0) {
            /* Only direct children of workspace/ */
            const char *leaf = rel + 10;
            if (!leaf[0] || strchr(leaf, '/') || strstr(rel, "..")) {
                status = "400 Bad Request";
                resp = "{\"ok\":false,\"error\":\"invalid folder name\"}";
            } else if (_mkdir(rel) == 0 || errno == EEXIST) {
                resp = "{\"ok\":true}";
            } else {
                status = "500 Internal Server Error";
                resp = "{\"ok\":false,\"error\":\"mkdir failed\"}";
            }
        } else if (strcmp(op, "create") == 0 || strcmp(op, "write") == 0) {
            if (strcmp(kind, "dir") == 0) {
                if (_mkdir(rel) == 0 || errno == EEXIST) resp = "{\"ok\":true}";
                else { status = "500 Internal Server Error";
                       resp = "{\"ok\":false,\"error\":\"mkdir failed\"}"; }
            } else {
                FILE *f = fopen(rel, "wb");
                if (!f) {
                    status = "500 Internal Server Error";
                    resp = "{\"ok\":false,\"error\":\"cannot create file\"}";
                } else {
                    if (body_len > 0) fwrite(body, 1, body_len, f);
                    fclose(f);
                    resp = "{\"ok\":true}";
                }
            }
        } else if (strcmp(op, "rename") == 0) {
            if (!is_safe_write_path(to)) {
                status = "403 Forbidden";
                resp = "{\"ok\":false,\"error\":\"invalid target path\"}";
            } else if (rename(rel, to) == 0) {
                resp = "{\"ok\":true}";
            } else {
                status = "500 Internal Server Error";
                resp = "{\"ok\":false,\"error\":\"rename failed\"}";
            }
        } else if (strcmp(op, "delete") == 0) {
            if (remove(rel) == 0) {
                resp = "{\"ok\":true}";
            } else {
                status = "500 Internal Server Error";
                resp = "{\"ok\":false,\"error\":\"delete failed\"}";
            }
        } else {
            status = "400 Bad Request";
            resp = "{\"ok\":false,\"error\":\"unknown op\"}";
        }
        send_json(c, status, resp, strlen(resp));
    } else if (strcmp(method, "GET") == 0 &&
               strncmp(path, "/api/library/file?", 18) == 0) {
        const char *q = strstr(path, "path=");
        char rel[512] = {0};
        if (q) {
            snprintf(rel, sizeof(rel), "%s", q + 5);
            url_decode(rel);
        }
        if (!rel[0] || !is_safe_module_path(rel)) {
            send_response(c, "403 Forbidden", "text/plain; charset=utf-8",
                          "Invalid module path", 18);
        } else {
            size_t len = 0;
            char *content = read_file_all(rel, &len);
            if (content) {
                send_response(c, "200 OK", "text/plain; charset=utf-8", content, len);
                free(content);
            } else {
                send_response(c, "404 Not Found", "text/plain; charset=utf-8",
                              "Module not found", 16);
            }
        }
    } else if (strcmp(method, "POST") == 0 && strcmp(path, "/api/analyze") == 0) {
        /* Strip UTF-8 BOM if the browser included one. */
        if (body_len >= 3 && (unsigned char)body[0] == 0xEF &&
            (unsigned char)body[1] == 0xBB && (unsigned char)body[2] == 0xBF) {
            body += 3; body_len -= 3;
        }
        if (body_len == 0) {
            const char *msg = "{\"ok\":false,\"error\":\"empty request body\"}";
            send_json(c, "400 Bad Request", msg, strlen(msg));
        } else {
            size_t json_len = 0;
            char *json = analyze_to_json(body, body_len, &json_len);
            if (json) {
                send_json(c, "200 OK", json, json_len);
                free(json);
            } else {
                const char *msg = "{\"ok\":false,\"error\":\"analysis failed\"}";
                send_json(c, "500 Internal Server Error", msg, strlen(msg));
            }
        }
    } else {
        send_response(c, "404 Not Found", "text/plain; charset=utf-8",
                      "Not found", 9);
    }

    free(req);
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */
static void print_usage(const char *prog) {
    printf("HELIX Analyzer GUI server\n");
    printf("Usage: %s [--port N] [--no-open] [--help]\n", prog);
    printf("  --port N    Listen on port N (default %d)\n", DEFAULT_PORT);
    printf("  --no-open   Do not auto-open the browser\n");
}

int main(int argc, char *argv[]) {
    int port = DEFAULT_PORT;
    bool open_browser = true;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--port") == 0 && i + 1 < argc) {
            port = atoi(argv[++i]);
            if (port <= 0 || port > 65535) {
                fprintf(stderr, "Error: invalid port '%s'\n", argv[i]);
                return EXIT_FAILURE;
            }
        } else if (strcmp(argv[i], "--no-open") == 0) {
            open_browser = false;
        } else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            print_usage(argv[0]);
            return EXIT_SUCCESS;
        } else {
            fprintf(stderr, "Error: unknown option '%s'\n", argv[i]);
            print_usage(argv[0]);
            return EXIT_FAILURE;
        }
    }

    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        fprintf(stderr, "Error: WSAStartup failed\n");
        return EXIT_FAILURE;
    }

    /* Bootstrap the user workspace (safe write area for the IDE explorer). */
    _mkdir("workspace");
    _mkdir("workspace/rules");
    _mkdir("workspace/terminologies");

    SOCKET srv = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (srv == INVALID_SOCKET) {
        fprintf(stderr, "Error: socket() failed\n");
        WSACleanup();
        return EXIT_FAILURE;
    }

    BOOL opt = TRUE;
    setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, (const char *)&opt, sizeof(opt));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); /* localhost only */
    addr.sin_port = htons((unsigned short)port);

    if (bind(srv, (struct sockaddr *)&addr, sizeof(addr)) == SOCKET_ERROR) {
        fprintf(stderr, "Error: cannot bind to port %d "
                        "(already in use? try --port N)\n", port);
        closesocket(srv);
        WSACleanup();
        return EXIT_FAILURE;
    }

    if (listen(srv, 8) == SOCKET_ERROR) {
        fprintf(stderr, "Error: listen() failed\n");
        closesocket(srv);
        WSACleanup();
        return EXIT_FAILURE;
    }

    printf("HELIX Analyzer GUI\n");
    printf("  -> http://localhost:%d\n", port);
    printf("  Press Ctrl+C to stop.\n");

    if (open_browser) {
        char cmd[64];
        snprintf(cmd, sizeof(cmd), "start http://localhost:%d", port);
        system(cmd);
    }

    for (;;) {
        SOCKET c = accept(srv, NULL, NULL);
        if (c == INVALID_SOCKET) continue;

        /* Bound I/O time so a stalled browser can't wedge the loop. */
        DWORD timeout = 5000;
        setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout, sizeof(timeout));
        setsockopt(c, SOL_SOCKET, SO_SNDTIMEO, (const char *)&timeout, sizeof(timeout));

        handle_client(c);
        closesocket(c);
    }

    /* Unreachable, but kept for completeness. */
    closesocket(srv);
    WSACleanup();
    return EXIT_SUCCESS;
}
