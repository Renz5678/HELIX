#ifndef HELIX_WASM_API_H
#define HELIX_WASM_API_H
char *helix_analyze(const char *source);
char *helix_evaluate(const char *source, const char *table_data_json);
void helix_free_result(char *result);
#endif
