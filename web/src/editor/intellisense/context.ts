import {
  isOffsetInComment,
  offsetToPosition,
  positionToOffset,
} from "./lexer";
import { columnTypeToValueType, type DatasetSchemaIndex } from "./schema";
import { openBlocksAt, visibleSymbolsAt } from "./document-index";
import {
  EXECUTOR_TIME_UNITS,
  MEMBER_KEYWORDS,
  PARSER_ONLY_TIME_UNITS,
  type BlockNode,
  type DocumentIndex,
  type LexComment,
  type LexToken,
  type SymbolEntry,
  type TerminologySystem,
  type TextPosition,
  type TextRange,
  type ValueType,
} from "./types";

export type CursorContextKind =
  | "comment"
  | "string-literal"
  | "terminology-code"
  | "alert-severity-string"
  | "where-string-value"
  | "top-level"
  | "rule-name"
  | "rule-body"
  | "bind-name"
  | "bind-rhs"
  | "bind-clause"
  | "bind-site-body"
  | "source-target"
  | "source-arrow"
  | "let-name"
  | "let-rhs"
  | "where-column"
  | "where-value"
  | "member-access"
  | "when-condition-start"
  | "when-condition-after-operand"
  | "comparison-rhs"
  | "branch-body"
  | "alert-arg"
  | "suppress-operand"
  | "suppress-repeat-target"
  | "within-amount"
  | "within-unit"
  | "within-post"
  | "terminology-system"
  | "end-block";

export interface CursorContext {
  kind: CursorContextKind;
  offset: number;
  position: TextPosition;
  replaceRange: TextRange;
  prefix: string;
  openBlocks: BlockNode[];
  inRule: boolean;
  inWhen: boolean;
  inBind: boolean;
  expectedBlockEnd?: "rule" | "bind" | "when";
  memberOwner?: string;
  memberChain?: string[];
  resolvedTableName?: string;
  resolvedColumnName?: string;
  expectedType?: ValueType;
  lhsHintName?: string;
  alertArgIndex?: number;
  terminologySystem?: TerminologySystem;
  withinNumber?: number;
  bindAlias?: string;
  hasOtherwise?: boolean;
  hasThen?: boolean;
}

const VALID_TIME_UNITS = new Set<string>([
  ...EXECUTOR_TIME_UNITS,
  ...PARSER_ONLY_TIME_UNITS,
]);

const COMPARISON_OPERATORS = new Set([
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "=",
]);

const ARITHMETIC_OPERATORS = new Set(["+", "-", "*", "/"]);

const BIND_OPERATORS = new Set([":=", "=", ":", "->"]);

const GENERIC_HINT_COLUMNS = new Set([
  "value",
  "val",
  "data",
  "reading",
  "readings",
]);

const STATEMENT_START_KEYWORDS = new Set([
  "intent",
  "schedule",
  "site",
  "terminology",
  "source",
  "bind",
  "let",
  "when",
  "for",
  "alert",
  "suppress",
  "end",
]);

const CONTINUATION_OPERATORS = new Set([
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

function tokenRange(tok: LexToken): TextRange {
  return {
    startLineNumber: tok.line,
    startColumn: tok.column,
    endLineNumber: tok.endLine,
    endColumn: tok.endColumn,
  };
}

function zeroWidthRange(pos: TextPosition): TextRange {
  return {
    startLineNumber: pos.lineNumber,
    startColumn: pos.column,
    endLineNumber: pos.lineNumber,
    endColumn: pos.column,
  };
}

function posFromLineStarts(
  lineStarts: readonly number[],
  sourceLength: number,
  offset: number,
): TextPosition {
  const clamped = Math.max(0, Math.min(sourceLength, Math.floor(offset)));
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

function rangeFromOffsets(
  doc: DocumentIndex,
  startOffset: number,
  endOffset: number,
): TextRange {
  const start = posFromLineStarts(doc.lineStarts, doc.source.length, startOffset);
  const end = posFromLineStarts(doc.lineStarts, doc.source.length, endOffset);
  return {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
  };
}

function isKeyword(tok: LexToken | undefined, lexeme: string): boolean {
  return tok !== undefined && tok.kind === "keyword" && tok.lexeme === lexeme;
}

function isDelimiter(tok: LexToken | undefined, lexeme: string): boolean {
  return tok !== undefined && tok.kind === "delimiter" && tok.lexeme === lexeme;
}

function isOperator(tok: LexToken | undefined, lexeme: string): boolean {
  return tok !== undefined && tok.kind === "operator" && tok.lexeme === lexeme;
}

function isMemberNameToken(tok: LexToken | undefined): tok is LexToken {
  if (!tok) return false;
  return (
    tok.kind === "identifier" ||
    (tok.kind === "keyword" && MEMBER_KEYWORDS.has(tok.lexeme))
  );
}

function toTerminologySystem(lexeme: string): TerminologySystem | null {
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

/**
 * Checks whether `offset` is strictly inside a `#` comment (`startOffset < offset <= endOffset`).
 * Cursor at `comment.startOffset` (immediately before `#`) is code context, not comment.
 */
function isStrictlyInsideComment(
  comments: readonly LexComment[],
  offset: number,
): boolean {
  if (!isOffsetInComment(comments, offset)) return false;
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
  return best !== -1 && offset > comments[best].startOffset && offset <= comments[best].endOffset;
}

function findTokenAtOffset(
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
    if (offset <= tok.startOffset) {
      high = mid - 1;
    } else if (offset > tok.endOffset) {
      low = mid + 1;
    } else {
      return { token: tok, index: mid };
    }
  }
  return null;
}

function countTokensEndingAtOrBefore(
  tokens: readonly LexToken[],
  offset: number,
): number {
  let low = 0;
  let high = tokens.length - 1;
  let count = 0;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const tok = tokens[mid];
    if (tok.kind !== "eof" && tok.endOffset <= offset) {
      count = mid + 1;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return count;
}

function findFirstTokenAtOrAfter(
  tokens: readonly LexToken[],
  offset: number,
): LexToken | undefined {
  let low = 0;
  let high = tokens.length - 1;
  let best = -1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (tokens[mid].startOffset >= offset) {
      best = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return best !== -1 ? tokens[best] : undefined;
}

function firstTokenIndexAtOrAfter(
  tokens: readonly LexToken[],
  startOffset: number,
  endIndex: number,
): number {
  let low = 0;
  let high = endIndex - 1;
  let best = endIndex;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (tokens[mid].startOffset >= startOffset) {
      best = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return best;
}

/**
 * Returns open blocks enclosing `queryOffset`, recovering blocks that were
 * synthetically closed in DocumentIndex at a later trigger token (`> queryOffset`).
 */
function effectiveOpenBlocks(
  doc: DocumentIndex,
  queryOffset: number,
  activeWordStartOffset?: number,
): BlockNode[] {
  const base = openBlocksAt(doc, queryOffset);
  const seen = new Set<number>(base.map((b) => b.index));
  const combined = [...base];

  for (const block of doc.blocks) {
    if (
      !seen.has(block.index) &&
      block.syntheticClosed &&
      block.closeOffset !== null &&
      block.openOffset <= queryOffset &&
      block.closeOffset <= queryOffset
    ) {
      const triggerTok = findFirstTokenAtOrAfter(doc.tokens, block.closeOffset);
      if (
        triggerTok &&
        triggerTok.kind !== "eof" &&
        queryOffset < triggerTok.startOffset
      ) {
        combined.push(block);
        seen.add(block.index);
      }
    }
  }

  const filtered =
    activeWordStartOffset !== undefined
      ? combined.filter((b) => b.openOffset !== activeWordStartOffset)
      : combined;

  filtered.sort((a, b) => a.openOffset - b.openOffset);
  return filtered;
}

function makeBaseContext(
  kind: CursorContextKind,
  offset: number,
  position: TextPosition,
  replaceRange: TextRange,
  prefix: string,
  openBlocks: BlockNode[],
  activeWordStartOffset?: number,
): CursorContext {
  let innerWhen: BlockNode | undefined;
  let inRule = false;
  let inWhen = false;
  let inBind = false;
  for (const block of openBlocks) {
    if (block.kind === "rule") inRule = true;
    else if (block.kind === "bind" || block.kind === "bind-site") inBind = true;
    else if (block.kind === "when") {
      inWhen = true;
      innerWhen = block;
    }
  }

  const ctx: CursorContext = {
    kind,
    offset,
    position,
    replaceRange,
    prefix,
    openBlocks,
    inRule,
    inWhen,
    inBind,
  };
  if (innerWhen) {
    ctx.hasThen =
      innerWhen.thenOffset !== null &&
      activeWordStartOffset !== innerWhen.thenOffset;
    ctx.hasOtherwise =
      innerWhen.otherwiseOffset !== null &&
      activeWordStartOffset !== innerWhen.otherwiseOffset;
  }
  return ctx;
}

function findEnclosingStatementStart(tokens: readonly LexToken[]): number {
  let depth = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tok = tokens[i];
    if (isDelimiter(tok, ")") || isDelimiter(tok, "]")) {
      depth++;
      continue;
    }
    if (isDelimiter(tok, "(") || isDelimiter(tok, "[")) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;

    if (tok.kind === "keyword" && STATEMENT_START_KEYWORDS.has(tok.lexeme)) {
      const prev = i > 0 ? tokens[i - 1] : undefined;
      if (isDelimiter(prev, ".") || isOperator(prev, "->")) continue;
      if (tok.lexeme === "for" && isKeyword(prev, "when")) continue;
      return i;
    }
  }
  return -1;
}

function scopeBodyTokens(
  doc: DocumentIndex,
  allPreceding: readonly LexToken[],
  endIdx: number,
  openBlocks: readonly BlockNode[],
  scopeStartOffset: number,
  queryOffset: number,
): LexToken[] {
  const openSet = new Set(openBlocks.map((b) => b.index));
  let effectiveStart = scopeStartOffset;
  for (const block of doc.blocks) {
    if (
      !openSet.has(block.index) &&
      block.openOffset >= scopeStartOffset &&
      block.closeOffset !== null &&
      block.closeOffset <= queryOffset
    ) {
      if (block.closeOffset > effectiveStart) {
        effectiveStart = block.closeOffset;
      }
    }
  }
  const startIdx = firstTokenIndexAtOrAfter(allPreceding, effectiveStart, endIdx);
  return allPreceding.slice(startIdx, endIdx);
}

function getAfterHeaderOffset(tokens: readonly LexToken[], blockStartOffset: number): number {
  let idx = firstTokenIndexAtOrAfter(tokens, blockStartOffset, tokens.length);
  if (idx >= tokens.length) return blockStartOffset;
  const kw = tokens[idx];
  idx++;
  if (isKeyword(kw, "rule")) {
    if (idx < tokens.length && tokens[idx].kind === "identifier") {
      idx++;
    }
    if (idx < tokens.length && isDelimiter(tokens[idx], ":")) {
      idx++;
    }
  } else if (isKeyword(kw, "then") || isKeyword(kw, "otherwise")) {
    if (idx < tokens.length && isDelimiter(tokens[idx], ":")) {
      idx++;
    }
  } else if (isKeyword(kw, "bind") && isKeyword(tokens[idx], "site")) {
    const siteTok = tokens[idx];
    idx++;
    if (idx < tokens.length && isDelimiter(tokens[idx], ":")) {
      idx++;
    }
    const nameCandidate = tokens[idx];
    if (
      nameCandidate &&
      nameCandidate.line === siteTok.line &&
      (nameCandidate.kind === "identifier" || nameCandidate.kind === "string")
    ) {
      idx++;
    }
  }
  return idx > 0 ? tokens[idx - 1].endOffset : blockStartOffset;
}

function findSymbolByName(
  symbols: readonly SymbolEntry[],
  name: string,
): SymbolEntry | undefined {
  for (let i = symbols.length - 1; i >= 0; i--) {
    if (symbols[i].name === name) return symbols[i];
  }
  return undefined;
}

function resolveSeriesTarget(
  tokens: readonly LexToken[],
  doc: DocumentIndex,
  schema: DatasetSchemaIndex,
  offset: number,
): { tableName?: string; columnName?: string; columnType?: ValueType } {
  if (tokens.length === 0) return {};
  let slice = tokens;
  if (isKeyword(slice[0], "latest")) {
    slice = slice.slice(1);
  }
  if (slice.length === 0) return {};

  const path = slice.map((t) => t.lexeme).join("");
  const direct = schema.resolvePath(path);
  if (direct) {
    return {
      tableName: direct.tableName,
      columnName: direct.columnName,
      columnType: columnTypeToValueType(direct.columnType),
    };
  }

  const head = slice[0];
  if (head.kind === "identifier") {
    const sym = findSymbolByName(visibleSymbolsAt(doc, offset), head.lexeme);
    if (sym?.resolvedTarget) {
      return {
        tableName: sym.resolvedTarget.tableName,
        columnName: sym.resolvedTarget.columnName,
        columnType: columnTypeToValueType(sym.resolvedTarget.columnType),
      };
    }
  }
  return {};
}

function checkWithinTrailing(
  tokens: readonly LexToken[],
  posLine: number,
): { kind: "within-amount" | "within-unit" | "within-post"; withinNumber?: number } | null {
  let depth = 0;
  let withinIdx = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (isDelimiter(t, ")") || isDelimiter(t, "]")) depth++;
    else if (isDelimiter(t, "(") || isDelimiter(t, "[")) depth = Math.max(0, depth - 1);
    else if (depth === 0 && isKeyword(t, "within")) {
      withinIdx = i;
      break;
    }
  }
  if (withinIdx === -1) return null;

  const after = tokens.slice(withinIdx + 1);
  if (after.length === 0) {
    return { kind: "within-amount" };
  }
  if (after.length === 1) {
    const first = after[0];
    if (first.kind === "int" || first.kind === "float") {
      return { kind: "within-unit", withinNumber: Number(first.lexeme) };
    }
    if (first.kind === "string" && first.line === posLine) {
      return { kind: "within-post" };
    }
    return null;
  }

  const numTok = after[0];
  const unitTok = after[1];
  if (
    (numTok.kind === "int" || numTok.kind === "float") &&
    unitTok.kind === "identifier" &&
    VALID_TIME_UNITS.has(unitTok.lexeme)
  ) {
    const num = Number(numTok.lexeme);
    if (after.length === 2 && unitTok.line === posLine) {
      return { kind: "within-post", withinNumber: num };
    }
    if (
      after.length === 3 &&
      after[2].kind === "identifier" &&
      after[2].lexeme === "before" &&
      after[2].line === posLine
    ) {
      return { kind: "within-post", withinNumber: num };
    }
  }
  return null;
}

function unwrapOuterParens(tokens: readonly LexToken[]): readonly LexToken[] {
  let slice = tokens;
  while (
    slice.length >= 2 &&
    isDelimiter(slice[0], "(") &&
    isDelimiter(slice[slice.length - 1], ")")
  ) {
    let depth = 0;
    let matches = true;
    for (let i = 0; i < slice.length - 1; i++) {
      if (isDelimiter(slice[i], "(")) depth++;
      else if (isDelimiter(slice[i], ")")) {
        depth--;
        if (depth === 0) {
          matches = false;
          break;
        }
      }
    }
    if (!matches) break;
    slice = slice.slice(1, -1);
  }
  return slice;
}

function inferMemberColumnType(
  owner: string,
  colName: string,
  visible: readonly SymbolEntry[],
  schema: DatasetSchemaIndex,
): { expectedType: ValueType; lhsHintName: string } | null {
  const hint = GENERIC_HINT_COLUMNS.has(colName) ? owner : colName;
  const sym = findSymbolByName(visible, owner);
  const table = sym?.resolvedTarget?.table ?? schema.tablesByName.get(owner);
  const col = table?.columns?.find((c) => c.name === colName);
  if (col) {
    return { expectedType: columnTypeToValueType(col.type), lhsHintName: hint };
  }
  const direct = schema.resolvePath(`${owner}.${colName}`);
  if (direct) {
    return {
      expectedType: columnTypeToValueType(direct.columnType),
      lhsHintName: hint,
    };
  }
  return null;
}

function inferComparisonLhs(
  lhsTokens: readonly LexToken[],
  doc: DocumentIndex,
  schema: DatasetSchemaIndex,
  offset: number,
): { expectedType: ValueType; lhsHintName?: string } {
  const core = unwrapOuterParens(lhsTokens);
  if (core.length === 0) return { expectedType: "Unknown" };

  let depth = 0;
  let hasArithmetic = false;
  let firstIdent: string | undefined;
  for (const t of core) {
    if (isDelimiter(t, "(") || isDelimiter(t, "[")) depth++;
    else if (isDelimiter(t, ")") || isDelimiter(t, "]")) depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (t.kind === "identifier" && firstIdent === undefined) {
        firstIdent = t.lexeme;
      }
      if (t.kind === "operator" && ARITHMETIC_OPERATORS.has(t.lexeme)) {
        hasArithmetic = true;
      }
    }
  }
  if (hasArithmetic) {
    return { expectedType: "Number", lhsHintName: firstIdent };
  }

  const visible = visibleSymbolsAt(doc, offset);

  if (core.length === 1) {
    const only = core[0];
    if (only.kind === "int" || only.kind === "float") {
      return { expectedType: "Number" };
    }
    if (only.kind === "string" || only.kind === "unterminated_string") {
      return { expectedType: "String" };
    }
    if (only.kind === "identifier") {
      const sym = findSymbolByName(visible, only.lexeme);
      if (sym) {
        if (sym.resolvedTarget) {
          return {
            expectedType: columnTypeToValueType(sym.resolvedTarget.columnType),
            lhsHintName: only.lexeme,
          };
        }
        return {
          expectedType: sym.valueType !== "Series" ? sym.valueType : "Unknown",
          lhsHintName: only.lexeme,
        };
      }
      const direct = schema.resolvePath(only.lexeme);
      if (direct) {
        return {
          expectedType: columnTypeToValueType(direct.columnType),
          lhsHintName: only.lexeme,
        };
      }
      return { expectedType: "Unknown", lhsHintName: only.lexeme };
    }
  }

  if (
    core.length === 3 &&
    core[0].kind === "identifier" &&
    isDelimiter(core[1], ".") &&
    isKeyword(core[2], "latest")
  ) {
    const hint = core[0].lexeme;
    const sym = findSymbolByName(visible, hint);
    if (sym?.resolvedTarget) {
      return {
        expectedType: columnTypeToValueType(sym.resolvedTarget.columnType),
        lhsHintName: hint,
      };
    }
    const direct = schema.resolvePath(hint);
    if (direct) {
      return {
        expectedType: columnTypeToValueType(direct.columnType),
        lhsHintName: hint,
      };
    }
    return { expectedType: "Unknown", lhsHintName: hint };
  }

  if (
    core.length === 5 &&
    core[0].kind === "identifier" &&
    isDelimiter(core[1], ".") &&
    isMemberNameToken(core[2]) &&
    isDelimiter(core[3], ".") &&
    isKeyword(core[4], "latest")
  ) {
    const owner = core[0].lexeme;
    const colName = core[2].lexeme;
    return (
      inferMemberColumnType(owner, colName, visible, schema) ?? {
        expectedType: "Unknown",
        lhsHintName: GENERIC_HINT_COLUMNS.has(colName) ? owner : colName,
      }
    );
  }

  if (isKeyword(core[0], "latest") && core[1]?.kind === "identifier") {
    const target = resolveSeriesTarget([core[0], core[1]], doc, schema, offset);
    return {
      expectedType: target.columnType ?? "Unknown",
      lhsHintName: core[1].lexeme,
    };
  }

  if (
    core.length === 3 &&
    core[0].kind === "identifier" &&
    isDelimiter(core[1], ".") &&
    isMemberNameToken(core[2])
  ) {
    const found = inferMemberColumnType(core[0].lexeme, core[2].lexeme, visible, schema);
    if (found) return found;
  }

  return { expectedType: "Unknown", lhsHintName: firstIdent };
}

function isIncompleteFloatTail(tokens: readonly LexToken[]): boolean {
  return (
    tokens.length >= 2 &&
    tokens[tokens.length - 2].kind === "int" &&
    isDelimiter(tokens[tokens.length - 1], ".")
  );
}

function detectComparisonRhs(
  exprTokens: readonly LexToken[],
  doc: DocumentIndex,
  schema: DatasetSchemaIndex,
  offset: number,
): { expectedType: ValueType; lhsHintName?: string } | null {
  if (exprTokens.length === 0) return null;

  // Walk backwards at current paren level to find the start of this boolean/group clause.
  // Do not break on unmatched '(' / '[' so expressions like `x < (|` or `x < (10 + |`
  // still retain the enclosing comparison operator on the LHS.
  let depth = 0;
  let clauseStart = 0;
  for (let i = exprTokens.length - 1; i >= 0; i--) {
    const t = exprTokens[i];
    if (isDelimiter(t, ")") || isDelimiter(t, "]")) {
      depth++;
    } else if (isDelimiter(t, "(") || isDelimiter(t, "[")) {
      if (depth > 0) depth--;
    } else if (
      depth === 0 &&
      (isKeyword(t, "and") ||
        isKeyword(t, "or") ||
        isKeyword(t, "not") ||
        isDelimiter(t, ":") ||
        isDelimiter(t, ","))
    ) {
      clauseStart = i + 1;
      break;
    }
  }

  const rawClause = exprTokens.slice(clauseStart);
  if (rawClause.length === 0) return null;

  // Strip leading unmatched '(' / '[' (e.g. `when (sbp.latest < |` or `when (sbp.latest < (10 + |`)
  const openStack: number[] = [];
  for (let i = 0; i < rawClause.length; i++) {
    const t = rawClause[i];
    if (isDelimiter(t, "(") || isDelimiter(t, "[")) {
      openStack.push(i);
    } else if (isDelimiter(t, ")") || isDelimiter(t, "]")) {
      if (openStack.length > 0) openStack.pop();
    }
  }
  const unmatchedOpens = new Set(openStack);
  let trimStart = 0;
  while (trimStart < rawClause.length && unmatchedOpens.has(trimStart)) {
    trimStart++;
  }
  const clause = rawClause.slice(trimStart);
  if (clause.length === 0) return null;

  let cmpIdx = -1;
  let cDepth = 0;
  for (let i = 0; i < clause.length; i++) {
    const t = clause[i];
    if (isDelimiter(t, "(") || isDelimiter(t, "[")) cDepth++;
    else if (isDelimiter(t, ")") || isDelimiter(t, "]")) cDepth = Math.max(0, cDepth - 1);
    else if (cDepth === 0 && t.kind === "operator" && COMPARISON_OPERATORS.has(t.lexeme)) {
      cmpIdx = i;
      break;
    }
  }
  if (cmpIdx === -1) return null;

  const afterCmp = clause.slice(cmpIdx + 1);
  if (afterCmp.length === 0) {
    return inferComparisonLhs(clause.slice(0, cmpIdx), doc, schema, offset);
  }

  const tail = afterCmp[afterCmp.length - 1];
  if (
    (tail.kind === "operator" && ARITHMETIC_OPERATORS.has(tail.lexeme)) ||
    isDelimiter(tail, "(") ||
    isIncompleteFloatTail(afterCmp)
  ) {
    return inferComparisonLhs(clause.slice(0, cmpIdx), doc, schema, offset);
  }

  return null;
}

function findActiveWhereClause(
  tokens: readonly LexToken[],
): { whereIdx: number; seriesTokens: LexToken[] } | null {
  let depth = 0;
  let whereIdx = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (isDelimiter(t, ")") || isDelimiter(t, "]")) depth++;
    else if (isDelimiter(t, "(") || isDelimiter(t, "[")) {
      if (depth > 0) depth--;
    } else if (depth === 0) {
      if (isKeyword(t, "within") || isDelimiter(t, ":")) {
        return null;
      }
      if (isKeyword(t, "where")) {
        whereIdx = i;
        break;
      }
    }
  }
  if (whereIdx === -1) return null;

  // Extract series reference immediately before `where` (e.g. `latest hr` or `Vitals.heart_rate`)
  let start = whereIdx - 1;
  while (start >= 0) {
    const t = tokens[start];
    if (isMemberNameToken(t) || isDelimiter(t, ".")) {
      start--;
      continue;
    }
    break;
  }
  return {
    whereIdx,
    seriesTokens: tokens.slice(start + 1, whereIdx),
  };
}

function buildWhereValueResult(
  colTok: LexToken | undefined,
  tableName: string | undefined,
  schema: DatasetSchemaIndex,
): { kind: "where-value"; columnName?: string; expectedType?: ValueType } {
  const colName = isMemberNameToken(colTok) ? colTok.lexeme : undefined;
  const table = tableName ? schema.tablesByName.get(tableName) : undefined;
  const col = colName
    ? table?.columns?.find((c) => c.name === colName)
    : undefined;
  return {
    kind: "where-value",
    columnName: colName,
    expectedType: col ? columnTypeToValueType(col.type) : undefined,
  };
}

function classifyWhereTokens(
  whereTokens: readonly LexToken[],
  tableName: string | undefined,
  schema: DatasetSchemaIndex,
): {
  kind: "where-column" | "where-value" | "where-complete" | "where-after-col";
  columnName?: string;
  expectedType?: ValueType;
} {
  if (whereTokens.length === 0) {
    return { kind: "where-column" };
  }
  const last = whereTokens[whereTokens.length - 1];
  if (
    isKeyword(last, "and") ||
    isKeyword(last, "or") ||
    isKeyword(last, "not") ||
    isDelimiter(last, "(")
  ) {
    return { kind: "where-column" };
  }

  if (last.kind === "operator" && COMPARISON_OPERATORS.has(last.lexeme)) {
    return buildWhereValueResult(
      whereTokens[whereTokens.length - 2],
      tableName,
      schema,
    );
  }

  if (isIncompleteFloatTail(whereTokens)) {
    const opTok = whereTokens[whereTokens.length - 3];
    if (opTok?.kind === "operator" && COMPARISON_OPERATORS.has(opTok.lexeme)) {
      return buildWhereValueResult(
        whereTokens[whereTokens.length - 4],
        tableName,
        schema,
      );
    }
  }

  const prev = whereTokens[whereTokens.length - 2];
  if (
    isMemberNameToken(last) &&
    (whereTokens.length === 1 ||
      isKeyword(prev, "and") ||
      isKeyword(prev, "or") ||
      isKeyword(prev, "not") ||
      isDelimiter(prev, "("))
  ) {
    return { kind: "where-after-col" };
  }

  return { kind: "where-complete" };
}

function countAlertArgs(tokensAfterAlertKeyword: readonly LexToken[]): {
  argIndex: number;
  hasLevelPrefix: boolean;
} {
  let idx = 0;
  if (isDelimiter(tokensAfterAlertKeyword[idx], ":")) {
    idx++;
  }
  if (
    tokensAfterAlertKeyword[idx]?.kind === "identifier" &&
    tokensAfterAlertKeyword[idx].lexeme === "level" &&
    isDelimiter(tokensAfterAlertKeyword[idx + 1], ":")
  ) {
    return { argIndex: 0, hasLevelPrefix: true };
  }

  let depth = 0;
  let commas = 0;
  for (let i = idx; i < tokensAfterAlertKeyword.length; i++) {
    const t = tokensAfterAlertKeyword[i];
    if (isDelimiter(t, "(") || isDelimiter(t, "[")) depth++;
    else if (isDelimiter(t, ")") || isDelimiter(t, "]")) depth = Math.max(0, depth - 1);
    else if (depth === 0 && isDelimiter(t, ",")) {
      commas++;
    }
  }
  return { argIndex: commas, hasLevelPrefix: false };
}

function isStatementCompleteOnPrevLine(
  tokens: readonly LexToken[],
  posLine: number,
): boolean {
  if (tokens.length === 0) return false;
  const last = tokens[tokens.length - 1];
  if (posLine <= last.line) return false;

  let depth = 0;
  for (const t of tokens) {
    if (isDelimiter(t, "(") || isDelimiter(t, "[")) depth++;
    else if (isDelimiter(t, ")") || isDelimiter(t, "]")) depth = Math.max(0, depth - 1);
  }
  if (depth > 0) return false;

  if (
    isDelimiter(last, ":") ||
    isDelimiter(last, ",") ||
    isDelimiter(last, ".") ||
    isDelimiter(last, "(") ||
    isDelimiter(last, "[") ||
    isKeyword(last, "and") ||
    isKeyword(last, "or") ||
    isKeyword(last, "not") ||
    (last.kind === "operator" && CONTINUATION_OPERATORS.has(last.lexeme))
  ) {
    return false;
  }
  return true;
}

function classifyStringContext(
  doc: DocumentIndex,
  schema: DatasetSchemaIndex,
  strTok: LexToken,
  strIdx: number,
  offset: number,
  pos: TextPosition,
): CursorContext | null {
  const isStringLike =
    strTok.kind === "string" ||
    strTok.kind === "unterminated_string" ||
    (strTok.kind === "error" && strTok.lexeme.startsWith('"'));
  if (!isStringLike) return null;

  const isClosed =
    strTok.kind === "string" ||
    (strTok.kind === "error" &&
      strTok.lexeme.length >= 2 &&
      strTok.lexeme.endsWith('"'));

  const inside =
    strTok.startOffset < offset &&
    (isClosed ? offset <= strTok.endOffset - 1 : offset <= strTok.endOffset);
  if (!inside) return null;

  const innerStart = strTok.startOffset + 1;
  const innerEnd = isClosed ? strTok.endOffset - 1 : strTok.endOffset;
  const prefix = doc.source.slice(innerStart, offset);
  const replaceRange = rangeFromOffsets(doc, innerStart, innerEnd);
  const openBlocks = effectiveOpenBlocks(doc, strTok.startOffset);
  const tokensBefore = doc.tokens.slice(0, strIdx);

  const makeStrCtx = (kind: CursorContextKind): CursorContext =>
    makeBaseContext(kind, offset, pos, replaceRange, prefix, openBlocks);

  // 1. Terminology code inside LOINC("..." / SNOMED("..." / RxNorm("..." (and [...])
  const openParen = tokensBefore[tokensBefore.length - 1];
  const sysTok = tokensBefore[tokensBefore.length - 2];
  if (
    (isDelimiter(openParen, "(") || isDelimiter(openParen, "[")) &&
    sysTok &&
    sysTok.kind === "identifier" &&
    openParen.line === sysTok.line
  ) {
    const system = toTerminologySystem(sysTok.lexeme);
    if (system) {
      const ctx = makeStrCtx("terminology-code");
      ctx.terminologySystem = system;
      return ctx;
    }
  }

  // 2. Where string value (`where <col> <compOp> "..."`)
  const stmtStartIdx = findEnclosingStatementStart(tokensBefore);
  const stmtTokens =
    stmtStartIdx !== -1 ? tokensBefore.slice(stmtStartIdx) : tokensBefore;
  const lastBefore = tokensBefore[tokensBefore.length - 1];
  const colBefore = tokensBefore[tokensBefore.length - 2];
  if (
    lastBefore?.kind === "operator" &&
    COMPARISON_OPERATORS.has(lastBefore.lexeme) &&
    isMemberNameToken(colBefore)
  ) {
    let tableName: string | undefined;
    const innerBind = [...openBlocks].reverse().find((b) => b.kind === "bind");
    if (innerBind && isKeyword(stmtTokens[0], "bind")) {
      const hasWhere = stmtTokens.some(
        (t, idx) => idx > 0 && isKeyword(t, "where"),
      );
      if (hasWhere) {
        const pathSlice = extractBindPathTokens(stmtTokens);
        tableName = resolveSeriesTarget(pathSlice, doc, schema, strTok.startOffset).tableName;
      }
    } else {
      const activeWhere = findActiveWhereClause(stmtTokens);
      if (activeWhere) {
        tableName = resolveSeriesTarget(
          activeWhere.seriesTokens,
          doc,
          schema,
          strTok.startOffset,
        ).tableName;
      }
    }

    if (
      (innerBind && isKeyword(stmtTokens[0], "bind") && stmtTokens.some((t) => isKeyword(t, "where"))) ||
      findActiveWhereClause(stmtTokens) !== null
    ) {
      const ctx = makeStrCtx("where-string-value");
      if (tableName) ctx.resolvedTableName = tableName;
      ctx.resolvedColumnName = colBefore.lexeme;
      const col = tableName
        ? schema.tablesByName.get(tableName)?.columns?.find((c) => c.name === colBefore.lexeme)
        : undefined;
      ctx.expectedType = col ? columnTypeToValueType(col.type) : "String";
      return ctx;
    }
  }

  // 3. Alert severity string (inside alert arg index >= 1)
  if (stmtStartIdx !== -1 && isKeyword(stmtTokens[0], "alert")) {
    const { argIndex, hasLevelPrefix } = countAlertArgs(stmtTokens.slice(1));
    if (!hasLevelPrefix && argIndex >= 1) {
      const ctx = makeStrCtx("alert-severity-string");
      ctx.alertArgIndex = argIndex;
      return ctx;
    }
  }

  return makeStrCtx("string-literal");
}

function extractBindPathTokens(bindTokens: readonly LexToken[]): LexToken[] {
  let idx = 1; // skip 'bind'
  if (bindTokens[idx]?.kind === "identifier") idx++;
  if (
    bindTokens[idx] &&
    ((bindTokens[idx].kind === "operator" && BIND_OPERATORS.has(bindTokens[idx].lexeme)) ||
      isDelimiter(bindTokens[idx], ":"))
  ) {
    idx++;
  }
  if (isKeyword(bindTokens[idx], "latest")) {
    idx++;
    return bindTokens[idx]?.kind === "identifier" ? [bindTokens[idx]] : [];
  }
  const path: LexToken[] = [];
  let depth = 0;
  for (let i = idx; i < bindTokens.length; i++) {
    const t = bindTokens[i];
    if (isDelimiter(t, "(") || isDelimiter(t, "[")) depth++;
    else if (isDelimiter(t, ")") || isDelimiter(t, "]")) depth = Math.max(0, depth - 1);
    else if (depth === 0 && (isKeyword(t, "where") || isKeyword(t, "within"))) break;
    path.push(t);
  }
  return path;
}

function buildWhereContext(
  whereTokens: readonly LexToken[],
  tableName: string | undefined,
  schema: DatasetSchemaIndex,
  base: (kind: CursorContextKind) => CursorContext,
): CursorContext | null {
  const classified = classifyWhereTokens(whereTokens, tableName, schema);
  if (classified.kind === "where-column") {
    const ctx = base("where-column");
    if (tableName) ctx.resolvedTableName = tableName;
    return ctx;
  }
  if (classified.kind === "where-value") {
    const ctx = base("where-value");
    if (tableName) ctx.resolvedTableName = tableName;
    if (classified.columnName) ctx.resolvedColumnName = classified.columnName;
    if (classified.expectedType) ctx.expectedType = classified.expectedType;
    return ctx;
  }
  return null;
}

function classifyBindBlock(
  bindTokens: readonly LexToken[],
  doc: DocumentIndex,
  schema: DatasetSchemaIndex,
  base: (kind: CursorContextKind) => CursorContext,
  offset: number,
  posLine: number,
): CursorContext {
  // bindTokens starts with 'bind'
  if (bindTokens.length <= 1) {
    return base("bind-name");
  }

  const aliasTok = bindTokens[1];
  const bindAlias = aliasTok.kind === "identifier" ? aliasTok.lexeme : undefined;
  let idx = 2;
  if (
    bindTokens[idx] &&
    ((bindTokens[idx].kind === "operator" && BIND_OPERATORS.has(bindTokens[idx].lexeme)) ||
      isDelimiter(bindTokens[idx], ":"))
  ) {
    idx++;
  } else if (bindTokens.length === 2 && bindAlias) {
    const ctx = base("bind-rhs");
    ctx.bindAlias = bindAlias;
    return ctx;
  }

  const rest = bindTokens.slice(idx);
  const pathTokens: LexToken[] = [];
  let whereStart = -1;
  let withinStart = -1;
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (isDelimiter(t, "(") || isDelimiter(t, "[")) depth++;
    else if (isDelimiter(t, ")") || isDelimiter(t, "]")) depth = Math.max(0, depth - 1);
    else if (depth === 0 && isKeyword(t, "where") && whereStart === -1 && withinStart === -1) {
      whereStart = i;
    } else if (depth === 0 && isKeyword(t, "within") && withinStart === -1) {
      withinStart = i;
    } else if (whereStart === -1 && withinStart === -1) {
      pathTokens.push(t);
    }
  }

  const resolved = resolveSeriesTarget(pathTokens, doc, schema, offset);
  const applyBindMeta = (ctx: CursorContext): CursorContext => {
    if (bindAlias) ctx.bindAlias = bindAlias;
    if (resolved.tableName && !ctx.resolvedTableName) {
      ctx.resolvedTableName = resolved.tableName;
    }
    if (resolved.columnName && !ctx.resolvedColumnName) {
      ctx.resolvedColumnName = resolved.columnName;
    }
    return ctx;
  };

  if (withinStart !== -1) {
    const within = checkWithinTrailing(rest.slice(withinStart), posLine);
    if (within) {
      const ctx = applyBindMeta(base(within.kind));
      if (within.withinNumber !== undefined) ctx.withinNumber = within.withinNumber;
      return ctx;
    }
    return applyBindMeta(base("bind-clause"));
  }

  if (whereStart !== -1) {
    const whereCtx = buildWhereContext(
      rest.slice(whereStart + 1),
      resolved.tableName,
      schema,
      base,
    );
    return applyBindMeta(whereCtx ?? base("bind-clause"));
  }

  if (
    pathTokens.length === 0 ||
    (pathTokens.length === 1 && isKeyword(pathTokens[0], "latest"))
  ) {
    return applyBindMeta(base("bind-rhs"));
  }

  return applyBindMeta(base("bind-clause"));
}

function checkUnquotedTerminologySelector(
  stmtTokens: readonly LexToken[],
  posLine: number,
): TerminologySystem | null {
  const openTok = stmtTokens[stmtTokens.length - 1];
  const sysTok = stmtTokens[stmtTokens.length - 2];
  if (
    (isDelimiter(openTok, "(") || isDelimiter(openTok, "[")) &&
    sysTok?.kind === "identifier" &&
    openTok.line === sysTok.line &&
    openTok.line === posLine
  ) {
    return toTerminologySystem(sysTok.lexeme);
  }
  return null;
}

function classifyExpressionClause(
  exprTokens: readonly LexToken[],
  doc: DocumentIndex,
  schema: DatasetSchemaIndex,
  base: (kind: CursorContextKind) => CursorContext,
  offset: number,
  posLine: number,
  inWhereAllowed: boolean,
): CursorContext | null {
  const within = checkWithinTrailing(exprTokens, posLine);
  if (within) {
    const ctx = base(within.kind);
    if (within.withinNumber !== undefined) ctx.withinNumber = within.withinNumber;
    return ctx;
  }

  if (inWhereAllowed) {
    const activeWhere = findActiveWhereClause(exprTokens);
    if (activeWhere) {
      const target = resolveSeriesTarget(activeWhere.seriesTokens, doc, schema, offset);
      const whereCtx = buildWhereContext(
        exprTokens.slice(activeWhere.whereIdx + 1),
        target.tableName,
        schema,
        base,
      );
      if (whereCtx) return whereCtx;
    }
  }

  const cmp = detectComparisonRhs(exprTokens, doc, schema, offset);
  if (cmp) {
    const ctx = base("comparison-rhs");
    ctx.expectedType = cmp.expectedType;
    if (cmp.lhsHintName) ctx.lhsHintName = cmp.lhsHintName;
    return ctx;
  }

  return null;
}

function classifyStatement(
  stmtTokens: readonly LexToken[],
  defaultKind: CursorContextKind,
  doc: DocumentIndex,
  schema: DatasetSchemaIndex,
  base: (kind: CursorContextKind) => CursorContext,
  offset: number,
  posLine: number,
): CursorContext {
  if (stmtTokens.length === 0) return base(defaultKind);
  const head = stmtTokens[0];
  if (head.kind !== "keyword") return base(defaultKind);

  switch (head.lexeme) {
    case "source": {
      const rest = isDelimiter(stmtTokens[1], ":")
        ? stmtTokens.slice(2)
        : stmtTokens.slice(1);
      if (rest.length === 0 && (posLine === head.line || isDelimiter(stmtTokens[1], ":"))) {
        return base("source-target");
      }
      const last = rest[rest.length - 1];
      if (isOperator(last, "->")) {
        return base("source-arrow");
      }
      return base(defaultKind);
    }

    case "terminology": {
      const termSys = checkUnquotedTerminologySelector(stmtTokens, posLine);
      if (termSys) {
        const ctx = base("terminology-code");
        ctx.terminologySystem = termSys;
        return ctx;
      }
      const rest = isDelimiter(stmtTokens[1], ":")
        ? stmtTokens.slice(2)
        : stmtTokens.slice(1);
      if (rest.length === 0 && (posLine === head.line || isDelimiter(stmtTokens[1], ":"))) {
        return base("terminology-system");
      }
      const last = rest[rest.length - 1];
      if (isOperator(last, "->")) {
        return base("terminology-system");
      }
      return base(defaultKind);
    }

    case "let": {
      const rest = stmtTokens.slice(1);
      if (rest.length === 0 && posLine === head.line) {
        return base("let-name");
      }
      const opIdx = rest.findIndex((t) => isOperator(t, ":=") || isOperator(t, "="));
      if (opIdx === -1) {
        return base(defaultKind);
      }
      const rhs = rest.slice(opIdx + 1);
      if (rhs.length === 0) {
        return base("let-rhs");
      }
      const exprMatch = classifyExpressionClause(rhs, doc, schema, base, offset, posLine, true);
      if (exprMatch) return exprMatch;

      let unclosedDepth = 0;
      for (const t of rhs) {
        if (isDelimiter(t, "(") || isDelimiter(t, "[")) unclosedDepth++;
        else if (isDelimiter(t, ")") || isDelimiter(t, "]")) {
          unclosedDepth = Math.max(0, unclosedDepth - 1);
        }
      }

      const tail = rhs[rhs.length - 1];
      if (
        unclosedDepth > 0 ||
        isIncompleteFloatTail(rhs) ||
        (tail.kind === "operator" && CONTINUATION_OPERATORS.has(tail.lexeme)) ||
        isDelimiter(tail, "(") ||
        isKeyword(tail, "and") ||
        isKeyword(tail, "or") ||
        isKeyword(tail, "not")
      ) {
        return base("let-rhs");
      }
      return base(defaultKind);
    }

    case "alert": {
      const rest = stmtTokens.slice(1);
      if (isStatementCompleteOnPrevLine(stmtTokens, posLine)) {
        return base(defaultKind);
      }
      const { argIndex, hasLevelPrefix } = countAlertArgs(rest);
      if (!hasLevelPrefix) {
        const afterColon = isDelimiter(rest[0], ":") ? rest.slice(1) : rest;
        // Find tokens of the active last argument (after last top-level comma)
        let depth = 0;
        let lastComma = -1;
        for (let i = 0; i < afterColon.length; i++) {
          const t = afterColon[i];
          if (isDelimiter(t, "(") || isDelimiter(t, "[")) depth++;
          else if (isDelimiter(t, ")") || isDelimiter(t, "]")) depth = Math.max(0, depth - 1);
          else if (depth === 0 && isDelimiter(t, ",")) lastComma = i;
        }
        const activeArg = afterColon.slice(lastComma + 1);
        const exprMatch = classifyExpressionClause(
          activeArg,
          doc,
          schema,
          base,
          offset,
          posLine,
          false,
        );
        if (exprMatch) return exprMatch;
      }
      const ctx = base("alert-arg");
      ctx.alertArgIndex = argIndex;
      return ctx;
    }

    case "suppress": {
      const rest = isDelimiter(stmtTokens[1], ":")
        ? stmtTokens.slice(2)
        : stmtTokens.slice(1);
      if (
        rest.length >= 2 &&
        rest[rest.length - 2]?.kind === "identifier" &&
        rest[rest.length - 2].lexeme === "repeat_of" &&
        isDelimiter(rest[rest.length - 1], ":")
      ) {
        return base("suppress-repeat-target");
      }
      const within = checkWithinTrailing(rest, posLine);
      if (within) {
        const ctx = base(within.kind);
        if (within.withinNumber !== undefined) ctx.withinNumber = within.withinNumber;
        return ctx;
      }
      if (isStatementCompleteOnPrevLine(stmtTokens, posLine)) {
        return base(defaultKind);
      }
      if (rest.length === 0) {
        return base("suppress-operand");
      }
      if (
        rest.length === 3 &&
        rest[0].kind === "identifier" &&
        rest[0].lexeme === "repeat_of" &&
        isDelimiter(rest[1], ":") &&
        rest[2].kind === "identifier" &&
        posLine === rest[2].line
      ) {
        return base("suppress-operand");
      }
      return base(defaultKind);
    }

    case "schedule": {
      const within = checkWithinTrailing(stmtTokens.slice(1), posLine);
      if (within) {
        const ctx = base(within.kind);
        if (within.withinNumber !== undefined) ctx.withinNumber = within.withinNumber;
        return ctx;
      }
      return base(defaultKind);
    }

    case "when": {
      // Event-trigger form (`when Event.name`) without a `when` BlockNode:
      // On the same line as the operand, treat as condition-after-operand; on a new line, it was complete.
      const last = stmtTokens[stmtTokens.length - 1];
      if (posLine === last.line && stmtTokens.length >= 4) {
        const ctx = base("when-condition-after-operand");
        ctx.inWhen = true;
        ctx.hasThen = false;
        ctx.hasOtherwise = false;
        return ctx;
      }
      return base(defaultKind);
    }

    default:
      return base(defaultKind);
  }
}

function classifyWhenCondition(
  condTokens: readonly LexToken[],
  doc: DocumentIndex,
  schema: DatasetSchemaIndex,
  base: (kind: CursorContextKind) => CursorContext,
  offset: number,
  posLine: number,
): CursorContext {
  // condTokens starts with 'when'
  let startIdx = 1;
  if (isKeyword(condTokens[startIdx], "for")) {
    startIdx++;
    if (condTokens[startIdx]?.kind === "identifier") {
      startIdx++;
    } else {
      return base("when-condition-start");
    }
  }

  const exprTokens = condTokens.slice(startIdx);
  if (exprTokens.length === 0) {
    return base("when-condition-start");
  }

  const last = exprTokens[exprTokens.length - 1];
  if (isDelimiter(last, ":")) {
    return base("when-condition-after-operand");
  }

  const termSys = checkUnquotedTerminologySelector(exprTokens, posLine);
  if (termSys) {
    const ctx = base("terminology-code");
    ctx.terminologySystem = termSys;
    return ctx;
  }

  const exprMatch = classifyExpressionClause(
    exprTokens,
    doc,
    schema,
    base,
    offset,
    posLine,
    true,
  );
  if (exprMatch) return exprMatch;

  if (
    isDelimiter(last, "(") ||
    isKeyword(last, "and") ||
    isKeyword(last, "or") ||
    isKeyword(last, "not") ||
    (last.kind === "operator" && CONTINUATION_OPERATORS.has(last.lexeme))
  ) {
    return base("when-condition-start");
  }

  return base("when-condition-after-operand");
}

function isWordLikeToken(tok: LexToken): boolean {
  return (
    tok.kind === "identifier" ||
    tok.kind === "keyword" ||
    tok.kind === "int" ||
    tok.kind === "float" ||
    (tok.kind === "error" && /^[A-Za-z0-9_]+$/.test(tok.lexeme))
  );
}

function collectMemberChain(preceding: readonly LexToken[]): string[] {
  const chain: string[] = [];
  let idx = preceding.length - 2; // token immediately before '.'
  while (idx >= 0) {
    const tok = preceding[idx];
    if (!isMemberNameToken(tok)) break;
    chain.unshift(tok.lexeme);
    if (idx >= 2 && isDelimiter(preceding[idx - 1], ".")) {
      idx -= 2;
      continue;
    }
    break;
  }
  return chain;
}

/**
 * Classifies the syntactic and semantic slot of the cursor inside a HELIX document,
 * handling comments, strings (quoted/unterminated), member chains, block closers, and LHS types.
 */
export function analyzeCursorContext(
  doc: DocumentIndex,
  schema: DatasetSchemaIndex,
  position: TextPosition,
): CursorContext {
  const offset = positionToOffset(doc.source, position);
  const normPos = offsetToPosition(doc.source, offset);
  const zeroRange = zeroWidthRange(normPos);

  if (isStrictlyInsideComment(doc.comments, offset)) {
    const open = effectiveOpenBlocks(doc, offset);
    return makeBaseContext("comment", offset, normPos, zeroRange, "", open);
  }

  const touching = findTokenAtOffset(doc.tokens, offset);
  if (touching) {
    const strCtx = classifyStringContext(
      doc,
      schema,
      touching.token,
      touching.index,
      offset,
      normPos,
    );
    if (strCtx) return strCtx;
  }

  const activeWord =
    touching && isWordLikeToken(touching.token) ? touching : null;
  const prefix = activeWord
    ? doc.source.slice(activeWord.token.startOffset, offset)
    : "";
  const replaceRange = activeWord ? tokenRange(activeWord.token) : zeroRange;
  const precedingEndIdx = activeWord
    ? activeWord.index
    : countTokensEndingAtOrBefore(doc.tokens, offset);
  const allPreceding = doc.tokens.slice(0, precedingEndIdx);
  const queryOffset = activeWord ? activeWord.token.startOffset : offset;
  const openBlocks = effectiveOpenBlocks(
    doc,
    queryOffset,
    activeWord?.token.startOffset,
  );

  const base = (
    kind: CursorContextKind,
    blocks: BlockNode[] = openBlocks,
  ): CursorContext =>
    makeBaseContext(
      kind,
      offset,
      normPos,
      replaceRange,
      prefix,
      blocks,
      activeWord?.token.startOffset,
    );

  const lastTok = allPreceding[allPreceding.length - 1];

  // 1. Preceded by '.' -> member-access (skip non-member prefixes like `1.` decimal entry)
  if (isDelimiter(lastTok, ".")) {
    const chain = collectMemberChain(allPreceding);
    if (chain.length > 0) {
      const ctx = base("member-access");
      const owner = chain.join(".");
      ctx.memberOwner = owner;
      ctx.memberChain = chain;

      if (chain.length === 1) {
        const sym = findSymbolByName(visibleSymbolsAt(doc, queryOffset), chain[0]);
        if (sym?.resolvedTarget) {
          ctx.resolvedTableName = sym.resolvedTarget.tableName;
          ctx.resolvedColumnName = sym.resolvedTarget.columnName;
          ctx.expectedType = columnTypeToValueType(sym.resolvedTarget.columnType);
        } else {
          const table = schema.tablesByName.get(chain[0]);
          if (table) ctx.resolvedTableName = table.name;
        }
      } else {
        const direct = schema.resolvePath(owner);
        if (direct) {
          ctx.resolvedTableName = direct.tableName;
          ctx.resolvedColumnName = direct.columnName;
          ctx.expectedType = columnTypeToValueType(direct.columnType);
        } else {
          const sym = findSymbolByName(visibleSymbolsAt(doc, queryOffset), chain[0]);
          const table = sym?.resolvedTarget?.table;
          const col = table?.columns?.find((c) => c.name === chain[1]);
          if (table) ctx.resolvedTableName = table.name;
          if (col) {
            ctx.resolvedColumnName = col.name;
            ctx.expectedType = columnTypeToValueType(col.type);
          }
        }
      }
      return ctx;
    }
  }

  // 2. Preceded by 'end' on the same line -> end-block
  if (isKeyword(lastTok, "end") && lastTok.line === normPos.lineNumber) {
    const blocksAtEnd = effectiveOpenBlocks(doc, lastTok.startOffset);
    const innerAtEnd = blocksAtEnd[blocksAtEnd.length - 1];
    const ctx = base("end-block", blocksAtEnd);
    if (innerAtEnd) {
      ctx.expectedBlockEnd =
        innerAtEnd.kind === "bind-site" ? "bind" : innerAtEnd.kind;
    }
    return ctx;
  }

  const innerBlock = openBlocks[openBlocks.length - 1];

  // 3. Inside 'bind' block
  if (innerBlock?.kind === "bind") {
    const startIdx = firstTokenIndexAtOrAfter(
      allPreceding,
      innerBlock.openOffset,
      allPreceding.length,
    );
    const bindTokens = allPreceding.slice(startIdx);
    return classifyBindBlock(bindTokens, doc, schema, base, queryOffset, normPos.lineNumber);
  }

  const classifyScopeBody = (
    scopeStartOffset: number,
    defaultKind: CursorContextKind,
  ): CursorContext => {
    const bodyTokens = scopeBodyTokens(
      doc,
      allPreceding,
      allPreceding.length,
      openBlocks,
      scopeStartOffset,
      queryOffset,
    );
    const stmtStart = findEnclosingStatementStart(bodyTokens);
    const stmtTokens = stmtStart !== -1 ? bodyTokens.slice(stmtStart) : [];
    return classifyStatement(
      stmtTokens,
      defaultKind,
      doc,
      schema,
      base,
      queryOffset,
      normPos.lineNumber,
    );
  };

  // 4. Inside 'bind-site' block
  if (innerBlock?.kind === "bind-site") {
    const headerEnd = getAfterHeaderOffset(allPreceding, innerBlock.openOffset);
    return classifyScopeBody(headerEnd, "bind-site-body");
  }

  // 5. Inside 'when' block
  if (innerBlock?.kind === "when") {
    if (innerBlock.thenOffset === null || queryOffset <= innerBlock.thenOffset) {
      const startIdx = firstTokenIndexAtOrAfter(
        allPreceding,
        innerBlock.openOffset,
        allPreceding.length,
      );
      const condTokens = allPreceding.slice(startIdx);
      return classifyWhenCondition(
        condTokens,
        doc,
        schema,
        base,
        queryOffset,
        normPos.lineNumber,
      );
    }

    const branchKeywordOffset =
      innerBlock.otherwiseOffset !== null &&
      queryOffset > innerBlock.otherwiseOffset
        ? innerBlock.otherwiseOffset
        : innerBlock.thenOffset;
    const branchStart = getAfterHeaderOffset(allPreceding, branchKeywordOffset);
    return classifyScopeBody(branchStart, "branch-body");
  }

  // 6. Inside 'rule' block
  if (innerBlock?.kind === "rule") {
    const ruleStartIdx = firstTokenIndexAtOrAfter(
      allPreceding,
      innerBlock.openOffset,
      allPreceding.length,
    );
    const ruleTokens = allPreceding.slice(ruleStartIdx);
    if (ruleTokens.length === 1 && isKeyword(ruleTokens[0], "rule")) {
      return base("rule-name");
    }

    const bodyStart = getAfterHeaderOffset(allPreceding, innerBlock.openOffset);
    return classifyScopeBody(bodyStart, "rule-body");
  }

  // 7. Top-level
  return classifyScopeBody(0, "top-level");
}
