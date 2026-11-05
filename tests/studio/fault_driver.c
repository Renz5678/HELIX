#include "wasm_api.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static int counter;
void *__real_malloc(size_t);
void *__real_calloc(size_t, size_t);
void *__real_realloc(void *, size_t);
static int fail(void) { return counter > 0 && --counter == 0; }
void *__wrap_malloc(size_t n) { return fail() ? NULL : __real_malloc(n); }
void *__wrap_calloc(size_t n, size_t z) { return fail() ? NULL : __real_calloc(n, z); }
void *__wrap_realloc(void *p, size_t n) { return fail() ? NULL : __real_realloc(p, n); }
int main(int argc, char **argv) {
    if (argc != 3)
        return 2;
    counter = atoi(argv[2]);
    char *result =
        strcmp(argv[1], "analyze") == 0
            ? helix_analyze("rule X: end rule")
            : helix_evaluate("rule X: source t when t.latest > 1 then alert \"a\" end when end rule",
                             "{\"evaluationTime\":\"2026-10-31T12:00:00Z\",\"tables\":[{\"name\":"
                             "\"t\",\"columns\":[{\"name\":\"patient_id\",\"type\":\"String\"},{"
                             "\"name\":\"timestamp\",\"type\":\"DateTime\"},{\"name\":\"value\","
                             "\"type\":\"Float\"}],\"rows\":[{\"patient_id\":\"P1\",\"timestamp\":"
                             "\"2026-10-31T11:00:00Z\",\"value\":2}]}]}");
    counter = 0;
    puts(result ? result : "null");
    helix_free_result(result);
    return 0;
}
