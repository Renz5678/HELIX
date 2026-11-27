import { extractStems } from "./ranking";
import {
  MEMBER_KEYWORDS,
  type BlockNode,
  type DocumentIndex,
  type LexComment,
  type LexToken,
  type SymbolEntry,
  type Table,
  type TerminologySystem,
  type TextPosition,
  type TextRange,
} from "./types";

export const SYNTAX_ONLY_NOTE = "Syntax-only (not evaluated in Studio)";

export const COMPARISON_OPERATORS: ReadonlySet<string> = new Set([
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "=",
]);

export const ARITHMETIC_OPERATORS: ReadonlySet<string> = new Set([
  "+",
  "-",
  "*",
  "/",
]);

export const CONTINUATION_OPERATORS: ReadonlySet<string> = new Set([
  ":=",
  "=",
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "+",
  "-",
  "*",
  "/",
  "->",
]);

export const SHORT_MINUTE_PRESETS: ReadonlySet<number> = new Set([
  15, 30, 45, 60,
]);

export const ALL_STATEMENT_START_KEYWORDS: ReadonlySet<string> = new Set([
  "rule",
  "intent",
  "schedule",
  "site",
  "terminology",
  "source",
  "bind",
  "let",
  "when",
  "for",
  "then",
  "otherwise",
  "alert",
  "suppress",
  "end",
]);

export function tokenRange(tok: LexToken): TextRange {
  return {
    startLineNumber: tok.line,
    startColumn: tok.column,
    endLineNumber: tok.endLine,
    endColumn: tok.endColumn,
  };
}

export function spanRange(start: LexToken, end: LexToken): TextRange {
  return {
    startLineNumber: start.line,
    startColumn: start.column,
    endLineNumber: end.endLine,
    endColumn: end.endColumn,
  };
}

export function zeroWidthRange(pos: TextPosition): TextRange {
  return {
    startLineNumber: pos.lineNumber,
    startColumn: pos.column,
    endLineNumber: pos.lineNumber,
    endColumn: pos.column,
  };
}

export function positionFromLineStarts(
  lineStarts: readonly number[],
  sourceLength: number,
  offset: number,
): TextPosition {
  const clamped = Number.isFinite(offset)
    ? Math.max(0, Math.min(sourceLength, Math.floor(offset)))
    : 0;
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

export function offsetFromLineStarts(
  source: string,
  lineStarts: readonly number[],
  pos: TextPosition,
): number {
  const targetLine = Number.isFinite(pos.lineNumber)
    ? Math.max(1, Math.floor(pos.lineNumber))
    : 1;
  const targetColumn = Number.isFinite(pos.column)
    ? Math.max(1, Math.floor(pos.column))
    : 1;
  if (targetLine > lineStarts.length) {
    return source.length;
  }
  const lineStart = lineStarts[targetLine - 1] ?? 0;
  const nextStart =
    targetLine < lineStarts.length ? lineStarts[targetLine] : source.length;
  let lineEnd = nextStart;
  while (lineEnd > lineStart) {
    const ch = source.charCodeAt(lineEnd - 1);
    if (ch === 10 || ch === 13) lineEnd--;
    else break;
  }
  return Math.min(lineStart + (targetColumn - 1), lineEnd);
}

export function isKeyword(tok: LexToken | undefined, lexeme: string): boolean {
  return tok !== undefined && tok.kind === "keyword" && tok.lexeme === lexeme;
}

export function isDelimiter(
  tok: LexToken | undefined,
  lexeme: string,
): boolean {
  return tok !== undefined && tok.kind === "delimiter" && tok.lexeme === lexeme;
}

export function isOperator(tok: LexToken | undefined, lexeme: string): boolean {
  return tok !== undefined && tok.kind === "operator" && tok.lexeme === lexeme;
}

export function isMemberNameToken(tok: LexToken | undefined): tok is LexToken {
  if (!tok) return false;
  return (
    tok.kind === "identifier" ||
    (tok.kind === "keyword" && MEMBER_KEYWORDS.has(tok.lexeme))
  );
}

export function toTerminologySystem(lexeme: string): TerminologySystem | null {
  switch (lexeme.toUpperCase()) {
    case "LOINC":
      return "LOINC";
    case "SNOMED":
      return "SNOMED";
    case "RXNORM":
      return "RxNorm";
    default:
      return null;
  }
}

export function isStrictlyInsideComment(
  comments: readonly LexComment[],
  offset: number,
): boolean {
  if (comments.length === 0 || !Number.isFinite(offset)) return false;
  let low = 0;
  let high = comments.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const c = comments[mid];
    if (offset <= c.startOffset) {
      high = mid - 1;
    } else if (offset > c.endOffset) {
      low = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

export function findFirstTokenIndexAtOrAfter(
  tokens: readonly LexToken[],
  offset: number,
  endIdx = tokens.length,
): number {
  let low = 0;
  let high = endIdx - 1;
  let best = endIdx;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (tokens[mid].startOffset >= offset) {
      best = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return best;
}

export function findLastTokenIndexEndingAtOrBefore(
  tokens: readonly LexToken[],
  offset: number,
): number {
  let low = 0;
  let high = tokens.length - 1;
  let best = -1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const tok = tokens[mid];
    if (tok.kind !== "eof" && tok.endOffset <= offset) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

export function findLastTokenIdxStartingBefore(
  tokens: readonly LexToken[],
  offset: number,
): number {
  let low = 0;
  let high = tokens.length - 1;
  let best = -1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const tok = tokens[mid];
    if (tok.kind === "eof") {
      high = mid - 1;
      continue;
    }
    if (tok.startOffset < offset) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

export function findTokenAtPositionOffset(
  tokens: readonly LexToken[],
  offset: number,
): { token: LexToken; index: number } | null {
  let low = 0;
  let high = tokens.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const tok = tokens[mid];
    if (tok.kind === "eof") {
      high = mid - 1;
      continue;
    }
    if (offset < tok.startOffset) {
      high = mid - 1;
    } else if (offset >= tok.endOffset) {
      low = mid + 1;
    } else {
      if (tok.kind === "delimiter" && mid > 0) {
        const prev = tokens[mid - 1];
        if (
          prev.endOffset === offset &&
          (prev.kind === "identifier" || prev.kind === "keyword")
        ) {
          return { token: prev, index: mid - 1 };
        }
      }
      return { token: tok, index: mid };
    }
  }

  low = 0;
  high = tokens.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const tok = tokens[mid];
    if (tok.kind === "eof") {
      high = mid - 1;
      continue;
    }
    if (tok.endOffset === offset) {
      return { token: tok, index: mid };
    }
    if (tok.endOffset < offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return null;
}

export function findEnclosingBindTable(
  doc: DocumentIndex,
  pos: TextPosition,
  offset: number,
): Table | undefined {
  for (const sym of doc.symbols) {
    if (sym.kind !== "bind" || !sym.resolvedTarget) continue;
    const r = sym.declarationRange;
    const afterStart =
      pos.lineNumber > r.startLineNumber ||
      (pos.lineNumber === r.startLineNumber && pos.column >= r.startColumn);
    const beforeEnd =
      pos.lineNumber < r.endLineNumber ||
      (pos.lineNumber === r.endLineNumber && pos.column <= r.endColumn);
    if (afterStart && beforeEnd) {
      return sym.resolvedTarget.table;
    }
  }
  for (let i = doc.blocks.length - 1; i >= 0; i--) {
    const b = doc.blocks[i];
    if (
      b.kind === "bind" &&
      b.openOffset <= offset &&
      (b.closeOffset === null || offset <= b.closeOffset)
    ) {
      const sym = doc.symbols.find(
        (s) =>
          s.kind === "bind" &&
          s.declarationRange.startLineNumber === b.headerRange.startLineNumber,
      );
      if (sym?.resolvedTarget) return sym.resolvedTarget.table;
    }
  }
  return undefined;
}

export function isComparisonOperatorInCurrentClause(
  doc: DocumentIndex,
  limitOffset: number,
  openBlocks: readonly BlockNode[],
): boolean {
  let innerWhenStart = 0;
  for (let i = openBlocks.length - 1; i >= 0; i--) {
    if (openBlocks[i].kind === "when") {
      innerWhenStart = openBlocks[i].openOffset;
      break;
    }
  }

  let depth = 0;
  const lastIdx = findLastTokenIndexEndingAtOrBefore(doc.tokens, limitOffset);
  for (let i = lastIdx; i >= 0; i--) {
    const t = doc.tokens[i];
    if (t.startOffset < innerWhenStart) break;
    if (t.kind === "delimiter" && (t.lexeme === ")" || t.lexeme === "]")) {
      depth++;
    } else if (
      t.kind === "delimiter" &&
      (t.lexeme === "(" || t.lexeme === "[")
    ) {
      if (depth > 0) depth--;
      else break;
    } else if (depth === 0) {
      if (
        (t.kind === "keyword" &&
          (t.lexeme === "when" ||
            t.lexeme === "and" ||
            t.lexeme === "or" ||
            t.lexeme === "not")) ||
        (t.kind === "delimiter" && (t.lexeme === ":" || t.lexeme === ","))
      ) {
        break;
      }
      if (t.kind === "operator" && COMPARISON_OPERATORS.has(t.lexeme)) {
        return true;
      }
    }
  }
  return false;
}

export function findUniqueNumericLetForSeries(
  visible: readonly SymbolEntry[],
  seriesSym: SymbolEntry,
): SymbolEntry | null {
  const numLets = visible.filter(
    (s) => s.kind === "let" && s.valueType === "Number",
  );
  if (numLets.length === 0) return null;

  const seriesStems = new Set<string>([
    ...extractStems(seriesSym.name),
    ...(seriesSym.resolvedTarget
      ? extractStems(seriesSym.resolvedTarget.columnName)
      : []),
  ]);

  if (seriesStems.size > 0) {
    const matched = numLets.filter((v) =>
      extractStems(v.name).some((stem) => seriesStems.has(stem)),
    );
    if (matched.length === 1) return matched[0];
    if (matched.length > 1) return null;
  }

  return numLets.length === 1 ? numLets[0] : null;
}
