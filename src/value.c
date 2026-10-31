#include "value.h"
#include <ctype.h>
#include <string.h>
static int digits(const char *s, int n) {
    int v = 0;
    for (int i = 0; i < n; i++) {
        if (!s[i] || !isdigit((unsigned char)s[i]))
            return -1;
        v = v * 10 + s[i] - '0';
    }
    return v;
}
bool value_datetime(const char *s, double *out) {
    if (!s || strlen(s) < 20)
        return false;
    int y = digits(s, 4), m = digits(s + 5, 2), d = digits(s + 8, 2), h = digits(s + 11, 2),
        mi = digits(s + 14, 2), sec = digits(s + 17, 2);
    if (s[4] != '-' || s[7] != '-' || s[10] != 'T' || s[13] != ':' || s[16] != ':' || y < 1 ||
        m < 1 || m > 12 || d < 1 || h < 0 || h > 23 || mi < 0 || mi > 59 || sec < 0 || sec > 59)
        return false;
    int md[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    if (y % 4 == 0 && (y % 100 != 0 || y % 400 == 0))
        md[1] = 29;
    if (d > md[m - 1])
        return false;
    const char *p = s + 19;
    double fraction = 0;
    if (*p == '.') {
        p++;
        int n = 0;
        double scale = 100;
        while (isdigit((unsigned char)*p)) {
            if (++n > 3)
                return false;
            fraction += (*p++ - '0') * scale;
            scale /= 10;
        }
        if (!n)
            return false;
    }
    int offset = 0;
    if (*p == 'Z')
        p++;
    else if (*p == '+' || *p == '-') {
        int sign = *p++ == '+' ? 1 : -1;
        if (strlen(p) != 5 || p[2] != ':')
            return false;
        int oh = digits(p, 2), om = digits(p + 3, 2);
        if (oh < 0 || oh > 14 || om < 0 || om > 59 || (oh == 14 && om))
            return false;
        offset = sign * (oh * 60 + om);
        p += 5;
    } else
        return false;
    if (*p)
        return false;
    int yy = y - (m <= 2);
    int era = (yy >= 0 ? yy : yy - 399) / 400;
    unsigned yoe = (unsigned)(yy - era * 400);
    unsigned mp = (unsigned)(m + (m > 2 ? -3 : 9));
    unsigned doy = (153 * mp + 2) / 5 + (unsigned)d - 1;
    unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    long long days = (long long)era * 146097 + (long long)doe - 719468;
    *out =
        (double)days * 86400000 + h * 3600000 + mi * 60000 + sec * 1000 + fraction - offset * 60000;
    return true;
}
TruthValue truth_and(TruthValue a, TruthValue b) {
    if (a == TRUTH_FALSE || b == TRUTH_FALSE)
        return TRUTH_FALSE;
    if (a == TRUTH_UNKNOWN || b == TRUTH_UNKNOWN)
        return TRUTH_UNKNOWN;
    return TRUTH_TRUE;
}
TruthValue truth_or(TruthValue a, TruthValue b) {
    if (a == TRUTH_TRUE || b == TRUTH_TRUE)
        return TRUTH_TRUE;
    if (a == TRUTH_UNKNOWN || b == TRUTH_UNKNOWN)
        return TRUTH_UNKNOWN;
    return TRUTH_FALSE;
}
TruthValue truth_not(TruthValue a) {
    return a == TRUTH_UNKNOWN ? a : a == TRUTH_TRUE ? TRUTH_FALSE : TRUTH_TRUE;
}
