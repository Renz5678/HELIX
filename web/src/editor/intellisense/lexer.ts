import {
  HELIX_KEYWORD_SET,
  type LexComment,
  type LexResult,
  type LexToken,
  type LexTokenKind,
  type TextPosition,
} from "./types";

interface LexerState {
  readonly source: string;
  readonly length: number;
  cursor: number;
  line: number;
  column: number;
  readonly lineStarts: number[];
  readonly comments: LexComment[];
}

function isAsciiAlpha(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isIdentStart(code: number): boolean {
  return isAsciiAlpha(code) || code === 95; // _
}

function isIdentContinue(code: number): boolean {
  return isAsciiAlpha(code) || isDigit(code) || code === 95;
}

function isValidEscape(code: number): boolean {
  // \n \t \r \\ \"
  return (
    code === 110 ||
    code === 116 ||
    code === 114 ||
    code === 92 ||
    code === 34
  );
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isAtEnd(state: LexerState): boolean {
  return state.cursor >= state.length;
}

function peekCode(state: LexerState): number {
  return state.cursor < state.length ? state.source.charCodeAt(state.cursor) : -1;
}

function peekNextCode(state: LexerState): number {
  return state.cursor + 1 < state.length
    ? state.source.charCodeAt(state.cursor + 1)
    : -1;
}

function advance(state: LexerState): number {
  if (state.cursor >= state.length) return -1;
  const code = state.source.charCodeAt(state.cursor);
  state.cursor++;
  if (code === 10 || (code === 13 && peekCode(state) !== 10)) {
    state.line++;
    state.column = 1;
    state.lineStarts.push(state.cursor);
  } else {
    state.column++;
  }
  return code;
}

function makeToken(
  state: LexerState,
  kind: LexTokenKind,
  lexeme: string,
  startOffset: number,
  startLine: number,
  startColumn: number
): LexToken {
  return {
    kind,
    lexeme,
    startOffset,
    endOffset: state.cursor,
    line: startLine,
    column: startColumn,
    endLine: state.line,
    endColumn: state.column,
  };
}

function skipWhitespaceAndComments(state: LexerState): void {
  const src = state.source;
  const len = state.length;
  while (state.cursor < len) {
    const code = src.charCodeAt(state.cursor);
    if (code === 32 || code === 9) {
      state.cursor++;
      state.column++;
    } else if (code === 13 || code === 10) {
      advance(state);
    } else if (code === 35) {
      // '#' comment: stop before NUL, CR, LF, or EOF
      const startOffset = state.cursor;
      const startLine = state.line;
      const startColumn = state.column;
      while (state.cursor < len) {
        const ch = src.charCodeAt(state.cursor);
        if (ch === 0 || ch === 10 || ch === 13) {
          break;
        }
        state.cursor++;
        state.column++;
      }
      state.comments.push({
        startOffset,
        endOffset: state.cursor,
        line: startLine,
        column: startColumn,
        text: src.slice(startOffset, state.cursor),
      });
    } else {
      break;
    }
  }
}

function scanIdentifierOrKeyword(state: LexerState): LexToken {
  const startOffset = state.cursor;
  const startLine = state.line;
  const startColumn = state.column;
  const src = state.source;
  const len = state.length;

  let cursor = startOffset + 1;
  while (cursor < len && isIdentContinue(src.charCodeAt(cursor))) {
    cursor++;
  }
  state.column += cursor - startOffset;
  state.cursor = cursor;

  const lexeme = src.slice(startOffset, cursor);
  const kind: LexTokenKind = HELIX_KEYWORD_SET.has(lexeme)
    ? "keyword"
    : "identifier";
  return makeToken(state, kind, lexeme, startOffset, startLine, startColumn);
}

function scanNumber(state: LexerState): LexToken {
  const startOffset = state.cursor;
  const startLine = state.line;
  const startColumn = state.column;
  const src = state.source;
  const len = state.length;
  let cursor = startOffset;

  while (cursor < len && isDigit(src.charCodeAt(cursor))) {
    cursor++;
  }

  let isFloat = false;
  if (
    cursor + 1 < len &&
    src.charCodeAt(cursor) === 46 &&
    isDigit(src.charCodeAt(cursor + 1))
  ) {
    isFloat = true;
    cursor++; // consume '.'
    while (cursor < len && isDigit(src.charCodeAt(cursor))) {
      cursor++;
    }
  }

  // Malformed trailing identifier characters, e.g. 123abc
  const next = cursor < len ? src.charCodeAt(cursor) : -1;
  if (isAsciiAlpha(next) || next === 95) {
    while (cursor < len && isIdentContinue(src.charCodeAt(cursor))) {
      cursor++;
    }
    state.column += cursor - startOffset;
    state.cursor = cursor;
    return makeToken(
      state,
      "error",
      src.slice(startOffset, cursor),
      startOffset,
      startLine,
      startColumn
    );
  }

  // Malformed multiple decimal points, e.g. 12.34.56
  if (isFloat && next === 46) {
    while (
      cursor < len &&
      (isDigit(src.charCodeAt(cursor)) || src.charCodeAt(cursor) === 46)
    ) {
      cursor++;
    }
    state.column += cursor - startOffset;
    state.cursor = cursor;
    return makeToken(
      state,
      "error",
      src.slice(startOffset, cursor),
      startOffset,
      startLine,
      startColumn
    );
  }

  state.column += cursor - startOffset;
  state.cursor = cursor;
  return makeToken(
    state,
    isFloat ? "float" : "int",
    src.slice(startOffset, cursor),
    startOffset,
    startLine,
    startColumn
  );
}

function scanString(state: LexerState): LexToken {
  const startOffset = state.cursor;
  const startLine = state.line;
  const startColumn = state.column;
  let hadError = false;
  let hasNul = false;

  advance(state); // opening '"'

  while (true) {
    const code = peekCode(state);
    if (code === -1 || code === 10 || code === 13) {
      // Leave CR/LF unconsumed so line/column tracking stays exact
      return makeToken(
        state,
        "unterminated_string",
        state.source.slice(startOffset, state.cursor),
        startOffset,
        startLine,
        startColumn
      );
    }

    if (code === 0) {
      hadError = true;
      hasNul = true;
      advance(state);
      continue;
    }

    if (code === 34) {
      advance(state); // closing '"'
      break;
    }

    if (code === 92) {
      advance(state); // consume '\'
      const esc = peekCode(state);
      if (esc === -1 || esc === 0 || esc === 10 || esc === 13) {
        // Backslash before line break/NUL/EOF is not a continuation
        continue;
      }
      if (!isValidEscape(esc)) {
        hadError = true;
      }
      advance(state);
      continue;
    }

    advance(state);
  }

  const raw = state.source.slice(startOffset, state.cursor);
  const lexeme = hasNul ? raw.replace(/\0/g, " ") : raw;
  return makeToken(
    state,
    hadError ? "error" : "string",
    lexeme,
    startOffset,
    startLine,
    startColumn
  );
}

function scanOperatorOrDelimiter(state: LexerState): LexToken {
  const startOffset = state.cursor;
  const startLine = state.line;
  const startColumn = state.column;
  const src = state.source;
  const len = state.length;
  const code = src.charCodeAt(startOffset);
  state.cursor = startOffset + 1;
  state.column = startColumn + 1;
  const nextCode = state.cursor < len ? src.charCodeAt(state.cursor) : -1;

  switch (code) {
    case 58: // ':'
      if (nextCode === 61) {
        state.cursor++;
        state.column++;
        return makeToken(state, "operator", ":=", startOffset, startLine, startColumn);
      }
      return makeToken(state, "delimiter", ":", startOffset, startLine, startColumn);

    case 61: // '='
      if (nextCode === 61) {
        state.cursor++;
        state.column++;
        return makeToken(state, "operator", "==", startOffset, startLine, startColumn);
      }
      return makeToken(state, "operator", "=", startOffset, startLine, startColumn);

    case 33: // '!'
      if (nextCode === 61) {
        state.cursor++;
        state.column++;
        return makeToken(state, "operator", "!=", startOffset, startLine, startColumn);
      }
      return makeToken(state, "error", "!", startOffset, startLine, startColumn);

    case 60: // '<'
      if (nextCode === 61) {
        state.cursor++;
        state.column++;
        return makeToken(state, "operator", "<=", startOffset, startLine, startColumn);
      }
      return makeToken(state, "operator", "<", startOffset, startLine, startColumn);

    case 62: // '>'
      if (nextCode === 61) {
        state.cursor++;
        state.column++;
        return makeToken(state, "operator", ">=", startOffset, startLine, startColumn);
      }
      return makeToken(state, "operator", ">", startOffset, startLine, startColumn);

    case 43: // '+'
      return makeToken(state, "operator", "+", startOffset, startLine, startColumn);

    case 45: // '-'
      if (nextCode === 62) {
        state.cursor++;
        state.column++;
        return makeToken(state, "operator", "->", startOffset, startLine, startColumn);
      }
      return makeToken(state, "operator", "-", startOffset, startLine, startColumn);

    case 42: // '*'
      return makeToken(state, "operator", "*", startOffset, startLine, startColumn);

    case 47: // '/'
      return makeToken(state, "operator", "/", startOffset, startLine, startColumn);

    case 46: // '.'
      return makeToken(state, "delimiter", ".", startOffset, startLine, startColumn);

    case 44: // ','
      return makeToken(state, "delimiter", ",", startOffset, startLine, startColumn);

    case 40: // '('
      return makeToken(state, "delimiter", "(", startOffset, startLine, startColumn);

    case 41: // ')'
      return makeToken(state, "delimiter", ")", startOffset, startLine, startColumn);

    case 91: // '['
      return makeToken(state, "delimiter", "[", startOffset, startLine, startColumn);

    case 93: // ']'
      return makeToken(state, "delimiter", "]", startOffset, startLine, startColumn);

    default: {
      if (code === 0) {
        return makeToken(state, "error", "\\x00", startOffset, startLine, startColumn);
      }
      if (isHighSurrogate(code) && isLowSurrogate(nextCode)) {
        state.cursor++;
        state.column++;
      }
      return makeToken(
        state,
        "error",
        src.slice(startOffset, state.cursor),
        startOffset,
        startLine,
        startColumn
      );
    }
  }
}

/**
 * Error-tolerant HELIX lexer matching src/lexer.c token rules,
 * capturing comments and UTF-16 lineStarts in a single linear pass.
 */
export function tokenizeHelix(source: string): LexResult {
  const state: LexerState = {
    source,
    length: source.length,
    cursor: 0,
    line: 1,
    column: 1,
    lineStarts: [0],
    comments: [],
  };

  const tokens: LexToken[] = [];

  while (true) {
    skipWhitespaceAndComments(state);

    if (isAtEnd(state)) {
      tokens.push(
        makeToken(state, "eof", "", state.cursor, state.line, state.column)
      );
      break;
    }

    const code = peekCode(state);
    if (isIdentStart(code)) {
      tokens.push(scanIdentifierOrKeyword(state));
    } else if (isDigit(code)) {
      tokens.push(scanNumber(state));
    } else if (code === 34) {
      tokens.push(scanString(state));
    } else {
      tokens.push(scanOperatorOrDelimiter(state));
    }
  }

  return {
    tokens,
    comments: state.comments,
    lineStarts: state.lineStarts,
  };
}

function computeLineStarts(source: string): number[] {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    if (code === 10 || (code === 13 && source.charCodeAt(i + 1) !== 10)) {
      lineStarts.push(i + 1);
    }
  }
  return lineStarts;
}

/**
 * Converts a 1-based UTF-16 TextPosition to a clamped 0-based UTF-16 offset.
 */
export function positionToOffset(source: string, pos: TextPosition): number {
  const targetLine = Number.isFinite(pos.lineNumber)
    ? Math.max(1, Math.floor(pos.lineNumber))
    : 1;
  const targetColumn = Number.isFinite(pos.column)
    ? Math.max(1, Math.floor(pos.column))
    : 1;

  let line = 1;
  let lineStart = 0;
  let i = 0;

  while (i < source.length && line < targetLine) {
    const code = source.charCodeAt(i);
    i++;
    if (code === 10 || (code === 13 && source.charCodeAt(i) !== 10)) {
      line++;
      lineStart = i;
    }
  }

  if (line < targetLine) {
    return source.length;
  }

  let lineEnd = lineStart;
  while (lineEnd < source.length) {
    const code = source.charCodeAt(lineEnd);
    if (code === 10 || code === 13) break;
    lineEnd++;
  }

  return Math.min(lineStart + (targetColumn - 1), lineEnd);
}

/**
 * Converts a 0-based UTF-16 offset to a 1-based TextPosition using binary search.
 */
export function offsetToPosition(source: string, offset: number): TextPosition {
  const clamped = Number.isFinite(offset)
    ? Math.max(0, Math.min(source.length, Math.floor(offset)))
    : 0;
  const lineStarts = computeLineStarts(source);

  let low = 0;
  let high = lineStarts.length - 1;
  let best = 0;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (lineStarts[mid] <= clamped) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return {
    lineNumber: best + 1,
    column: clamped - lineStarts[best] + 1,
  };
}

/**
 * Returns true if the given 0-based UTF-16 offset falls inside a `#` comment.
 */
export function isOffsetInComment(
  comments: readonly LexComment[],
  offset: number
): boolean {
  if (comments.length === 0 || !Number.isFinite(offset)) {
    return false;
  }

  let low = 0;
  let high = comments.length - 1;
  let best = -1;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (comments[mid].startOffset <= offset) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best !== -1 && offset <= comments[best].endOffset;
}
