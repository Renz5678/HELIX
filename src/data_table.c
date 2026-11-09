#include "data_table.h"
#include <math.h>
#include <stdio.h>
#include <string.h>
static bool error(DataStore *s, const char *msg) {
    snprintf(s->error, sizeof s->error, "%s", msg);
    return false;
}
static const char *text_default(JsonValue *v, const char *key, const char *d) {
    const char *x = json_text(json_get(v, key));
    return x ? x : d;
}
const ColumnSchema *data_column(const DataTable *t, const char *name) {
    if (!name)
        return NULL;
    for (size_t i = 0; i < t->column_count; i++)
        if (!strcmp(t->columns[i].name, name))
            return &t->columns[i];
    return NULL;
}
DataTable *data_table_find(DataStore *s, const char *name) {
    if (!name)
        return NULL;
    for (size_t i = 0; i < s->count; i++)
        if (!strcmp(s->tables[i].name, name))
            return &s->tables[i];
    return NULL;
}
Value data_value(const DataTable *t, const DataRow *row, const char *name) {
    Value v = {0};
    const ColumnSchema *col = data_column(t, name);
    JsonValue *x = json_get(row, name);
    if (!col || !x || x->type == JSON_NULL)
        return v;
    v.type = col->type;
    v.string = x->string;
    v.number = x->number;
    v.boolean = x->boolean;
    if (v.type == VAL_DATETIME && !value_datetime(v.string, &v.number))
        v.type = VAL_MISSING;
    return v;
}
bool data_store_parse(DataStore *s, const char *text) {
    memset(s, 0, sizeof(*s));
    s->root = json_parse(text, s->error, sizeof s->error);
    if (!s->root)
        return false;
    JsonValue *version = json_get(s->root, "schemaVersion");
    if (version && (version->type != JSON_NUMBER || version->number != 1))
        return error(s, "Unsupported schemaVersion");
    s->evaluation_time = json_text(json_get(s->root, "evaluationTime"));
    if (!value_datetime(s->evaluation_time, &s->clock))
        return error(s, "evaluationTime must be a valid timezone-qualified timestamp");
    JsonValue *tables = json_get(s->root, "tables");
    if (!tables || tables->type != JSON_ARRAY || tables->count > 32)
        return error(s, "tables must contain at most 32 tables");
    size_t total_rows = 0;
    for (size_t i = 0; i < tables->count; i++) {
        JsonValue *j = tables->children[i];
        DataTable *t = &s->tables[s->count];
        t->name = json_text(json_get(j, "name"));
        s->error_table = t->name;
        s->has_error_row = false;
        s->error_column = NULL;
        if (!t->name || !t->name[0] || data_table_find(s, t->name))
            return error(s, "Missing or duplicate table name");
        t->patient_id_column = text_default(j, "patientIdColumn", "patient_id");
        t->timestamp_column = text_default(j, "timestampColumn", "timestamp");
        t->default_value_column = text_default(j, "defaultValueColumn", "value");
        JsonValue *cols = json_get(j, "columns");
        if (!cols || cols->type != JSON_ARRAY || !cols->count || cols->count > 64)
            return error(s, "columns must contain 1 to 64 entries");
        for (size_t c = 0; c < cols->count; c++) {
            const char *name = json_text(json_get(cols->children[c], "name")),
                       *type = json_text(json_get(cols->children[c], "type"));
            if (!name || !name[0] || !type || data_column(t, name))
                return error(s, "Invalid or duplicate column schema");
            ValueType vt = !strcmp(type, "String")     ? VAL_STRING
                           : !strcmp(type, "Integer")  ? VAL_INT
                           : !strcmp(type, "Float")    ? VAL_FLOAT
                           : !strcmp(type, "Boolean")  ? VAL_BOOL
                           : !strcmp(type, "DateTime") ? VAL_DATETIME
                                                       : VAL_MISSING;
            if (vt == VAL_MISSING)
                return error(s, "Unknown column type");
            t->columns[t->column_count++] = (ColumnSchema){name, vt};
        }
        const ColumnSchema *pid = data_column(t, t->patient_id_column),
                           *timestamp = data_column(t, t->timestamp_column);
        if (!pid || pid->type != VAL_STRING || !timestamp || timestamp->type != VAL_DATETIME ||
            !data_column(t, t->default_value_column))
            return error(s, "Invalid patient/timestamp/default-value schema references");
        t->rows = json_get(j, "rows");
        if (!t->rows || t->rows->type != JSON_ARRAY || (total_rows += t->rows->count) > 10000)
            return error(s, "Rows must be an array; total limit is 10000");
        for (size_t r = 0; r < t->rows->count; r++) {
            JsonValue *row = t->rows->children[r];
            s->error_row = r;
            s->has_error_row = true;
            s->error_column = t->patient_id_column;
            const char *patient = json_text(json_get(row, t->patient_id_column));
            if (row->type != JSON_OBJECT || !patient || !patient[0])
                return error(s, "Every row requires a nonempty String patient ID");
            for (size_t c = 0; c < row->count; c++) {
                JsonValue *v = row->children[c];
                s->error_column = v->key;
                const ColumnSchema *col = data_column(t, v->key);
                if (!col)
                    return error(s, "Row contains an undeclared column");
                if (v->type == JSON_NULL)
                    continue;
                bool valid = false;
                double instant;
                if (col->type == VAL_STRING)
                    valid = v->type == JSON_STRING;
                else if (col->type == VAL_DATETIME)
                    valid = v->type == JSON_STRING && value_datetime(v->string, &instant);
                else if (col->type == VAL_BOOL)
                    valid = v->type == JSON_BOOL;
                else
                    valid = v->type == JSON_NUMBER && isfinite(v->number) &&
                            (col->type != VAL_INT || (fabs(v->number) <= 9007199254740991.0 &&
                                                      floor(v->number) == v->number));
                if (!valid) {
                    snprintf(s->error, sizeof s->error,
                             "Table %s row %zu column %s has an invalid typed value", t->name, r,
                             v->key);
                    return false;
                }
            }
        }
        s->count++;
    }
    JsonValue *b = json_get(s->root, "Bindings");
    if (b && b->type != JSON_OBJECT)
        return error(s, "Bindings must be an object");
    s->error_table = NULL;
    s->error_column = NULL;
    s->has_error_row = false;
    return true;
}
void data_store_free(DataStore *s) {
    json_value_free(s->root);
    s->root = NULL;
}
