CC = gcc
CFLAGS = -std=c11 -Wall -Wextra -Wpedantic -Iinclude -O2
TEST_FLAGS = -std=c11 -Wall -Wextra -Wpedantic -Iinclude -g
DEBUG_FLAGS = -std=c11 -Wall -Wextra -Wpedantic -Iinclude -g -fsanitize=address,undefined

SRC = src/source.c src/diagnostic.c src/token.c src/keywords.c src/lexer.c src/parser.c
OBJS = $(SRC:.c=.o)
MAIN_OBJ = src/main.o

TARGET = helix
TEST_TARGET = tests/test_runner

.PHONY: all clean test sanitize

all: $(TARGET)

$(TARGET): $(OBJS) $(MAIN_OBJ)
	$(CC) $(CFLAGS) -o $@ $^

%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@

test: $(TEST_TARGET)
	@echo "Running HELIX test suite..."
	./$(TEST_TARGET)

$(TEST_TARGET): $(SRC) tests/test_runner.c
	$(CC) $(TEST_FLAGS) -o $@ $^

sanitize: CFLAGS = $(DEBUG_FLAGS)
sanitize: clean $(TARGET)

clean:
	rm -f src/*.o tests/*.o $(TARGET) $(TEST_TARGET)
