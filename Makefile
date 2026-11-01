CC = gcc
CFLAGS = -std=c11 -Wall -Wextra -Wpedantic -Iinclude -O2
TEST_FLAGS = -std=c11 -Wall -Wextra -Wpedantic -Iinclude -g
DEBUG_FLAGS = -std=c11 -Wall -Wextra -Wpedantic -Iinclude -g -fsanitize=address,undefined

SRC = src/source.c src/diagnostic.c src/token.c src/keywords.c src/lexer.c src/parser.c
OBJS = $(SRC:.c=.o)
MAIN_OBJ = src/main.o

TARGET = helix
TEST_TARGET = tests/test_runner
GUI_TARGET = gui/helix-server
GUI_SRC = $(SRC) gui/server.c

# GUI server links Winsock (a Windows *system* API, no third-party libraries).
GUI_LIBS = -lws2_32

.PHONY: all clean test sanitize gui web dev

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

# Builds the local web-GUI server (run it from the project root: gui\helix-server.exe)
gui: $(GUI_TARGET)

$(GUI_TARGET): $(GUI_SRC)
	$(CC) $(CFLAGS) -o $@ $(GUI_SRC) $(GUI_LIBS)

# Builds the React/Tailwind front-end into gui/dist/ (requires Node.js).
# The C server serves gui/dist/ — run this once after changing gui/web/src.
web:
	cd gui/web && npm install && npm run build

# Front-end dev server with hot reload (start `mingw32-make gui` in another terminal first).
dev:
	cd gui/web && npm run dev

sanitize: CFLAGS = $(DEBUG_FLAGS)
sanitize: clean $(TARGET)

clean:
ifeq ($(OS),Windows_NT)
	-del /Q src\*.o $(TARGET).exe $(TEST_TARGET).exe $(GUI_TARGET).exe 2>NUL & exit 0
	-rmdir /Q /S gui\dist gui\web\node_modules 2>NUL & exit 0
else
	rm -f src/*.o $(TARGET) $(TEST_TARGET) $(GUI_TARGET)
	rm -rf gui/dist gui/web/node_modules
endif
