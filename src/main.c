#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "source.h"
#include "diagnostic.h"
#include "token.h"
#include "lexer.h"
#include "parser.h"

typedef enum {
    MODE_CHECK,
    MODE_TOKENS,
    MODE_HELP
} RunMode;

static void print_usage(const char *prog_name) {
    printf("HELIX Lexical Analyzer and Syntax Validator (ISO C11)\n");
    printf("Usage:\n");
    printf("  %s [options] <source-file.helix>\n\n", prog_name);
    printf("Options:\n");
    printf("  --check     Perform lexical and syntax validation (default)\n");
    printf("  --tokens    Display recognized tokens with types, lexemes, and positions\n");
    printf("  --help, -h  Display this help message\n\n");
    printf("Example:\n");
    printf("  %s examples/basic_rule.helix\n", prog_name);
    printf("  %s --tokens examples/basic_rule.helix\n", prog_name);
}

int main(int argc, char *argv[]) {
    RunMode mode = MODE_CHECK;
    const char *filepath = NULL;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            mode = MODE_HELP;
        } else if (strcmp(argv[i], "--tokens") == 0) {
            mode = MODE_TOKENS;
        } else if (strcmp(argv[i], "--check") == 0) {
            mode = MODE_CHECK;
        } else if (argv[i][0] == '-') {
            fprintf(stderr, "Error: Unknown option '%s'\n", argv[i]);
            print_usage(argv[0]);
            return EXIT_FAILURE;
        } else {
            if (filepath == NULL) {
                filepath = argv[i];
            } else {
                fprintf(stderr, "Error: Multiple input files provided ('%s' and '%s')\n", filepath, argv[i]);
                return EXIT_FAILURE;
            }
        }
    }

    if (mode == MODE_HELP) {
        print_usage(argv[0]);
        return EXIT_SUCCESS;
    }

    if (!filepath) {
        fprintf(stderr, "Error: No input file specified.\n\n");
        print_usage(argv[0]);
        return EXIT_FAILURE;
    }

    SourceBuffer source;
    if (!source_load(filepath, &source)) {
        fprintf(stderr, "Error: Failed to open or read file '%s'\n", filepath);
        return EXIT_FAILURE;
    }

    DiagnosticEngine diag;
    diag_init(&diag, &source, stderr);

    Lexer lexer;
    lexer_init(&lexer, &source, &diag);

    TokenList tokens;
    lexer_tokenize_all(&lexer, &tokens);

    int exit_code = EXIT_SUCCESS;

    if (mode == MODE_TOKENS) {
        printf("Tokens Recognized in '%s':\n", filepath);
        printf("%-5s | %-6s | %-22s | %s\n", "Line", "Column", "Token Type", "Lexeme");
        printf("------+--------+------------------------+-----------------------------------\n");
        for (size_t i = 0; i < tokens.count; i++) {
            Token *t = &tokens.items[i];
            printf("%-5zu | %-6zu | %-22s | %s\n",
                   t->line, t->column, token_type_name(t->type), t->lexeme);
        }
        printf("\nTotal tokens: %zu\n", tokens.count);
        if (diag.lexical_errors > 0) {
            printf("Lexical Errors: %zu\n", diag.lexical_errors);
            exit_code = EXIT_FAILURE;
        }
    } else {
        /* MODE_CHECK */
        Parser parser;
        parser_init(&parser, &tokens, &diag);
        parser_parse(&parser);

        printf("HELIX Lexical and Syntax Analyzer\n");
        printf("---------------------------------\n\n");
        printf("File: %s\n\n", filepath);
        printf("Lexical Analysis: %s\n", (diag.lexical_errors == 0) ? "PASSED" : "FAILED");
        printf("Syntax Analysis:  %s\n\n", (diag.syntax_errors == 0) ? "PASSED" : "FAILED");
        printf("Tokens Recognized: %zu\n", tokens.count);
        printf("Lexical Errors:    %zu\n", diag.lexical_errors);
        printf("Syntax Errors:     %zu\n\n", diag.syntax_errors);

        if (diag.lexical_errors == 0 && diag.syntax_errors == 0) {
            printf("Result: Valid HELIX program.\n");
            exit_code = EXIT_SUCCESS;
        } else {
            printf("Result: Validation failed with errors.\n");
            exit_code = EXIT_FAILURE;
        }
    }

    diag_free(&diag);
    token_list_free(&tokens);
    source_free(&source);

    return exit_code;
}
