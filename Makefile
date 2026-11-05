CC ?= gcc
EMCC ?= emcc
CFLAGS ?= -O2
CPPFLAGS += -Iinclude
WARN = -std=c11 -Wall -Wextra -Wpedantic
ENGINE = $(filter-out src/main.c,$(wildcard src/*.c))
OBJS = $(patsubst src/%.c,build/native/%.o,$(ENGINE))
SAN_CC ?= $(CC)
SAN_FLAGS = -g -O1 -fsanitize=address,undefined -fno-omit-frame-pointer

GUI_TARGET = gui/helix-server
GUI_SRC = src/source.c src/diagnostic.c src/token.c src/keywords.c src/lexer.c src/parser.c gui/server.c
GUI_LIBS = -lws2_32

.PHONY: all test test-api test-sanitize sanitize wasm clean test-fault test-wasm gui web dev

all: build/native/helix build/native/libhelix.so

build/native/%.o: src/%.c
	@mkdir -p $(@D)
	$(CC) $(CPPFLAGS) $(WARN) $(CFLAGS) -fPIC -MMD -MP -c $< -o $@

build/native/helix: $(OBJS) build/native/main.o
	$(CC) $(CFLAGS) -o $@ $^ -lm

build/native/libhelix.so: $(OBJS)
	$(CC) -shared -o $@ $^ -lm

build/native/test_runner: $(OBJS) tests/test_runner.c
	$(CC) $(CPPFLAGS) $(WARN) $(CFLAGS) -o $@ $^ -lm

test: build/native/test_runner build/native/test_studio test-api
	./build/native/test_runner
	./build/native/test_studio

test-api: build/native/libhelix.so
	python3 -m unittest discover -s tests/studio -v

build/sanitize/test_runner: $(ENGINE) tests/test_runner.c $(wildcard include/*.h)
	@mkdir -p $(@D)
	$(SAN_CC) $(CPPFLAGS) $(WARN) $(SAN_FLAGS) $(ENGINE) tests/test_runner.c -o $@ -lm

test-sanitize: build/sanitize/test_runner build/sanitize/test_studio
	ASAN_OPTIONS=detect_leaks=1 ./build/sanitize/test_runner
	ASAN_OPTIONS=detect_leaks=1 ./build/sanitize/test_studio

sanitize: test-sanitize

wasm:
	@mkdir -p web/public/wasm
	$(EMCC) $(CPPFLAGS) $(WARN) -O2 $(ENGINE) -o web/public/wasm/helix_engine.mjs -sMODULARIZE=1 -sEXPORT_ES6=1 -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1048576 -sEXPORTED_FUNCTIONS='["_helix_analyze","_helix_evaluate","_helix_free_result","_malloc","_free"]' -sEXPORTED_RUNTIME_METHODS='["UTF8ToString","stringToUTF8","lengthBytesUTF8"]' -sENVIRONMENT=web,worker,node

gui: $(GUI_TARGET)

$(GUI_TARGET): $(GUI_SRC)
	$(CC) $(CPPFLAGS) $(WARN) $(CFLAGS) -o $@ $(GUI_SRC) $(GUI_LIBS) -lm

web:
	cd gui/web && npm install && npm run build

dev:
	cd gui/web && npm run dev

clean:
ifeq ($(OS),Windows_NT)
	-del /Q src\*.o $(GUI_TARGET).exe 2>NUL & exit 0
	-rmdir /Q /S gui\dist gui\web\node_modules build 2>NUL & exit 0
else
	rm -rf build gui/dist gui/web/node_modules $(GUI_TARGET)
endif

-include $(wildcard build/native/*.d)

build/native/fault_driver: $(ENGINE) tests/studio/fault_driver.c $(wildcard include/*.h)
	@mkdir -p $(@D)
	$(CC) $(CPPFLAGS) $(WARN) -O0 -o $@ $(ENGINE) tests/studio/fault_driver.c -Wl,--wrap=malloc -Wl,--wrap=calloc -Wl,--wrap=realloc -lm

test-fault: build/native/fault_driver
	python3 tests/studio/check_faults.py

build/native/test_studio: $(OBJS) tests/test_studio.c
	$(CC) $(CPPFLAGS) $(WARN) $(CFLAGS) -o $@ $^ -lm

build/sanitize/test_studio: $(ENGINE) tests/test_studio.c $(wildcard include/*.h)
	@mkdir -p $(@D)
	$(SAN_CC) $(CPPFLAGS) $(WARN) $(SAN_FLAGS) $(ENGINE) tests/test_studio.c -o $@ -lm

test-wasm: all wasm
	node web/tests/wasm-parity.mjs
