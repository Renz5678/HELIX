#ifndef HELIX_JSON_H
#define HELIX_JSON_H
#include <stdbool.h>
#include <stddef.h>
typedef struct {
    char *data;
    size_t length, capacity;
    bool failed;
} JsonWriter;
void json_write(JsonWriter *w, const char *text);
void json_string(JsonWriter *w, const char *text);
void json_number(JsonWriter *w, double value);
char *json_finish(JsonWriter *w);
typedef enum { JSON_NULL, JSON_BOOL, JSON_NUMBER, JSON_STRING, JSON_ARRAY, JSON_OBJECT } JsonType;
typedef struct JsonValue {
    JsonType type;
    char *key, *string;
    double number;
    bool boolean;
    struct JsonValue **children;
    size_t count;
} JsonValue;
bool json_utf8_valid(const char *text);
JsonValue *json_parse(const char *text, char *error, size_t error_size);
JsonValue *json_get(const JsonValue *object, const char *key);
const char *json_text(const JsonValue *value);
void json_value_free(JsonValue *value);
#endif
