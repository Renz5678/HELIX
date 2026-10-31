#ifndef HELIX_VALUE_H
#define HELIX_VALUE_H
#include <stdbool.h>
typedef enum { VAL_MISSING, VAL_STRING, VAL_INT, VAL_FLOAT, VAL_BOOL, VAL_DATETIME } ValueType;
typedef enum { TRUTH_FALSE, TRUTH_TRUE, TRUTH_UNKNOWN } TruthValue;
typedef struct {
    ValueType type;
    const char *string;
    double number;
    bool boolean;
} Value;
bool value_datetime(const char *text, double *milliseconds);
TruthValue truth_and(TruthValue a, TruthValue b);
TruthValue truth_or(TruthValue a, TruthValue b);
TruthValue truth_not(TruthValue a);
#endif
