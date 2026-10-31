#ifndef HELIX_DATA_TABLE_H
#define HELIX_DATA_TABLE_H
#include "json.h"
#include "value.h"
typedef struct {
    const char *name;
    ValueType type;
} ColumnSchema;
typedef JsonValue DataRow;
typedef struct {
    const char *name, *patient_id_column, *timestamp_column, *default_value_column;
    ColumnSchema columns[64];
    size_t column_count;
    JsonValue *rows;
} DataTable;
typedef struct {
    JsonValue *root;
    DataTable tables[32];
    size_t count;
    double clock;
    const char *evaluation_time;
    char error[512];
    const char *error_table, *error_column;
    size_t error_row;
    bool has_error_row;
} DataStore;
bool data_store_parse(DataStore *store, const char *json);
void data_store_free(DataStore *store);
DataTable *data_table_find(DataStore *store, const char *name);
const ColumnSchema *data_column(const DataTable *table, const char *name);
Value data_value(const DataTable *table, const DataRow *row, const char *column);
#endif
