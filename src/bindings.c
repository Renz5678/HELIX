#include "bindings.h"
#include <stdio.h>
#include <string.h>
bool binding_resolve(DataStore *s, const char *path, BindingTarget *out) {
    memset(out, 0, sizeof(*out));
    JsonValue *v = json_get(json_get(s->root, "Bindings"), path);
    if (v) {
        const char *name = json_text(v);
        if (v->type == JSON_OBJECT) {
            name = json_text(json_get(v, "table"));
            out->column = json_text(json_get(v, "column"));
        }
        out->table = data_table_find(s, name);
    } else {
        char name[256];
        snprintf(name, sizeof name, "%s", path);
        char *dot = strrchr(name, '.');
        if (dot) {
            *dot = 0;
            out->table = data_table_find(s, name);
            if (out->table) {
                const ColumnSchema *c = data_column(out->table, dot + 1);
                if (c)
                    out->column = c->name;
                else
                    return false;
            }
        } else
            out->table = data_table_find(s, name);
    }
    if (!out->table)
        return false;
    if (!out->column)
        out->column = out->table->default_value_column;
    return data_column(out->table, out->column) != NULL;
}
