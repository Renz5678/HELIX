#ifndef HELIX_BINDINGS_H
#define HELIX_BINDINGS_H
#include "data_table.h"
typedef struct {
    DataTable *table;
    const char *column;
} BindingTarget;
bool binding_resolve(DataStore *store, const char *path, BindingTarget *target);
#endif
