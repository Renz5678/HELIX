import { tokenizeHelix } from "./lexer";
import { columnTypeToValueType, type DatasetSchemaIndex } from "./schema";
import {
  MEMBER_KEYWORDS,
  type BlockNode,
  type DocumentIndex,
  type IdentifierRef,
  type LexComment,
  type LexToken,
  type SymbolEntry,
  type TerminologyOccurrence,
  type TerminologySystem,
  type TextPosition,
  type TextRange,
  type ValueType,
} from "./types";

const LARGE_FILE_BYTE_LIMIT = 262_144;

const RULE_ELEMENT_KEYWORDS = new Set([
  "intent",
  "schedule",
  "terminology",
  "site",
  "source",
  "bind",
  "let",
  "when",
  "for",
  "alert",
  "suppress",
  "latest",
]);

const STATEMENT_STOP_KEYWORDS = new Set([
  ...RULE_ELEMENT_KEYWORDS,
  "rule",
  "then",
  "otherwise",
  "end",
]);

const COMPARISON_OPERATORS = new Set(["==", "!=", "<", "<=", ">", ">=", "="]);
const ARITHMETIC_OPERATORS = new Set(["+", "-", "*", "/"]);

interface ActiveBlockMeta {
  blockIndex: number;
  varScope: Map<string, number>;
  branchVarScope: Map<string, number>;
  ruleScopedSymbols: number[];
  thenScopedSymbols: number[];
  otherwiseScopedSymbols: number[];
}

interface DocumentIndexMeta {
  declEndOffsets: number[];
  inclusiveScopeSymbols: Set<number>;
  syntheticTriggerOffsets: Map<number, number>;
}

const documentMetaCache = new WeakMap<DocumentIndex, DocumentIndexMeta>();

function tokenRange(tok: LexToken): TextRange {
  return {
    startLineNumber: tok.line,
    startColumn: tok.column,
    endLineNumber: tok.endLine,
    endColumn: tok.endColumn,
  };
}

function spanRange(start: LexToken, end: LexToken): TextRange {
  return {
    startLineNumber: start.line,
    startColumn: start.column,
    endLineNumber: end.endLine,
    endColumn: end.endColumn,
  };
}

function posAtOffset(
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

function isKeyword(tok: LexToken | undefined, lexeme: string): boolean {
  return tok !== undefined && tok.kind === "keyword" && tok.lexeme === lexeme;
}

function isDotOrArrow(tok: LexToken | undefined): boolean {
  return (
    tok !== undefined &&
    ((tok.kind === "delimiter" && tok.lexeme === ".") ||
      (tok.kind === "operator" && tok.lexeme === "->"))
  );
}

function isMemberNameToken(tok: LexToken | undefined): boolean {
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

function sliceCollapsed(source: string, start: number, end: number): string | undefined {
  if (end <= start) return undefined;
  const raw = source.slice(start, end);
  const trimmed = /[\r\n\t]| {2}/.test(raw) ? raw.replace(/\s+/g, " ").trim() : raw.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

/**
 * Mirrors is_event_trigger_ahead in src/parser.c (plus EOF / rule boundary):
 * `when Event.name` immediately followed by a rule-element keyword, `end`, `rule`, or `eof`.
 */
function isEventTriggerAhead(tokens: readonly LexToken[], whenIdx: number): boolean {
  if (!isKeyword(tokens[whenIdx], "when")) return false;

  let i = whenIdx + 1;
  if (tokens[i]?.kind !== "identifier") return false;
  i++;

  let dots = 0;
  while (
    i + 1 < tokens.length &&
    tokens[i]?.kind === "delimiter" &&
    tokens[i].lexeme === "." &&
    isMemberNameToken(tokens[i + 1])
  ) {
    dots++;
    i += 2;
  }
  if (dots === 0 || i >= tokens.length) return false;

  const after = tokens[i];
  if (after.kind === "eof") return true;
  if (after.kind !== "keyword") return false;
  return (
    after.lexeme === "end" ||
    after.lexeme === "rule" ||
    RULE_ELEMENT_KEYWORDS.has(after.lexeme)
  );
}

function unwrapOuterParens(tokens: readonly LexToken[]): readonly LexToken[] {
  let slice = tokens;
  while (
    slice.length >= 2 &&
    slice[0].kind === "delimiter" &&
    slice[0].lexeme === "(" &&
    slice[slice.length - 1].kind === "delimiter" &&
    slice[slice.length - 1].lexeme === ")"
  ) {
    let depth = 0;
    let matchesEnd = true;
    for (let idx = 0; idx < slice.length - 1; idx++) {
      if (slice[idx].kind === "delimiter" && slice[idx].lexeme === "(") depth++;
      else if (slice[idx].kind === "delimiter" && slice[idx].lexeme === ")") {
        depth--;
        if (depth === 0) {
          matchesEnd = false;
          break;
        }
      }
    }
    if (!matchesEnd) break;
    slice = slice.slice(1, -1);
  }
  return slice;
}

function sliceBeforeWhereOrWithin(tokens: readonly LexToken[]): readonly LexToken[] {
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === "delimiter" && (t.lexeme === "(" || t.lexeme === "[")) depth++;
    else if (t.kind === "delimiter" && (t.lexeme === ")" || t.lexeme === "]")) {
      depth = Math.max(0, depth - 1);
    } else if (
      depth === 0 &&
      t.kind === "keyword" &&
      (t.lexeme === "where" || t.lexeme === "within")
    ) {
      return tokens.slice(0, i);
    }
  }
  return tokens;
}

function inferLetValueType(
  rhsTokens: readonly LexToken[],
  lookupVisibleVar: (name: string) => number | null,
  symbols: readonly SymbolEntry[],
): ValueType {
  const core = unwrapOuterParens(sliceBeforeWhereOrWithin(rhsTokens));
  if (core.length === 0) return "Unknown";

  let depth = 0;
  let hasArithmetic = false;
  for (const t of core) {
    if (t.kind === "delimiter" && (t.lexeme === "(" || t.lexeme === "[")) depth++;
    else if (t.kind === "delimiter" && (t.lexeme === ")" || t.lexeme === "]")) {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      if (
        (t.kind === "keyword" &&
          (t.lexeme === "and" || t.lexeme === "or" || t.lexeme === "not")) ||
        (t.kind === "operator" && COMPARISON_OPERATORS.has(t.lexeme))
      ) {
        return "Boolean";
      }
      if (t.kind === "operator" && ARITHMETIC_OPERATORS.has(t.lexeme)) {
        hasArithmetic = true;
      }
    }
  }
  if (hasArithmetic) return "Number";

  if (core.length === 1) {
    const only = core[0];
    if (only.kind === "int" || only.kind === "float") return "Number";
    if (only.kind === "string" || only.kind === "unterminated_string") return "String";
    if (only.kind === "identifier") {
      const idx = lookupVisibleVar(only.lexeme);
      return idx !== null ? symbols[idx].valueType : "Unknown";
    }
  }

  if (
    core.length === 3 &&
    core[0].kind === "identifier" &&
    core[1].kind === "delimiter" &&
    core[1].lexeme === "." &&
    isKeyword(core[2], "latest")
  ) {
    const idx = lookupVisibleVar(core[0].lexeme);
    const target = idx !== null ? symbols[idx].resolvedTarget : undefined;
    return target ? columnTypeToValueType(target.columnType) : "Unknown";
  }

  if (
    core.length === 5 &&
    core[0].kind === "identifier" &&
    core[1].kind === "delimiter" &&
    core[1].lexeme === "." &&
    core[2].kind === "identifier" &&
    core[3].kind === "delimiter" &&
    core[3].lexeme === "." &&
    isKeyword(core[4], "latest")
  ) {
    const idx = lookupVisibleVar(core[0].lexeme);
    const table = idx !== null ? symbols[idx].resolvedTarget?.table : undefined;
    const col = table?.columns?.find((c) => c.name === core[2].lexeme);
    return col ? columnTypeToValueType(col.type) : "Unknown";
  }

  return "Unknown";
}

function parseTerminologyCall(
  tokens: readonly LexToken[],
  startIdx: number,
  source: string,
  lineStarts: readonly number[],
): { nextIdx: number; occurrence: TerminologyOccurrence } | null {
  const sysTok = tokens[startIdx];
  if (!sysTok || sysTok.kind !== "identifier") return null;
  const openTok = tokens[startIdx + 1];
  if (
    !openTok ||
    openTok.kind !== "delimiter" ||
    (openTok.lexeme !== "(" && openTok.lexeme !== "[") ||
    openTok.line !== sysTok.line
  ) {
    return null;
  }
  const system = toTerminologySystem(sysTok.lexeme);
  if (!system) return null;

  const expectedClose = openTok.lexeme === "(" ? ")" : "]";
  let j = startIdx + 2;
  let code = "";
  let codeRange: TextRange = {
    startLineNumber: openTok.endLine,
    startColumn: openTok.endColumn,
    endLineNumber: openTok.endLine,
    endColumn: openTok.endColumn,
  };
  let endTok: LexToken = openTok;

  const firstArg = tokens[j];
  if (firstArg && firstArg.kind !== "eof" && firstArg.line === openTok.line) {
    if (firstArg.kind === "delimiter" && firstArg.lexeme === expectedClose) {
      endTok = firstArg;
      j++;
    } else if (
      firstArg.kind === "string" ||
      firstArg.kind === "unterminated_string" ||
      (firstArg.kind === "error" && firstArg.lexeme.startsWith('"'))
    ) {
      const isClosed =
        firstArg.kind !== "unterminated_string" &&
        firstArg.lexeme.length >= 2 &&
        firstArg.lexeme.endsWith('"');
      const cStart = firstArg.startOffset + 1;
      const cEnd = isClosed ? firstArg.endOffset - 1 : firstArg.endOffset;
      code = cEnd > cStart ? source.slice(cStart, cEnd) : "";
      const startPos = posAtOffset(lineStarts, source.length, cStart);
      const endPos = posAtOffset(lineStarts, source.length, Math.max(cStart, cEnd));
      codeRange = {
        startLineNumber: startPos.lineNumber,
        startColumn: startPos.column,
        endLineNumber: endPos.lineNumber,
        endColumn: endPos.column,
      };
      endTok = firstArg;
      j++;
      while (j < tokens.length && tokens[j].kind !== "eof" && tokens[j].line === openTok.line) {
        const cur = tokens[j];
        if (cur.kind === "delimiter" && cur.lexeme === expectedClose) {
          endTok = cur;
          j++;
          break;
        }
        if (cur.kind === "keyword") break;
        endTok = cur;
        j++;
      }
    } else {
      const argStartTok = firstArg;
      let argEndTok: LexToken | null = null;
      while (j < tokens.length && tokens[j].kind !== "eof" && tokens[j].line === openTok.line) {
        const cur = tokens[j];
        if (cur.kind === "delimiter" && cur.lexeme === expectedClose) {
          endTok = cur;
          j++;
          break;
        }
        if (cur.kind === "delimiter" && cur.lexeme === ",") {
          j++;
          while (j < tokens.length && tokens[j].kind !== "eof" && tokens[j].line === openTok.line) {
            const tail = tokens[j];
            if (tail.kind === "delimiter" && tail.lexeme === expectedClose) {
              endTok = tail;
              j++;
              break;
            }
            if (tail.kind === "keyword") break;
            endTok = tail;
            j++;
          }
          break;
        }
        if (cur.kind === "keyword") break;
        argEndTok = cur;
        endTok = cur;
        j++;
      }
      if (argEndTok) {
        code = source.slice(argStartTok.startOffset, argEndTok.endOffset).trim();
        codeRange = spanRange(argStartTok, argEndTok);
      }
    }
  }

  return {
    nextIdx: j,
    occurrence: {
      system,
      code,
      range: spanRange(sysTok, endTok),
      codeRange,
      startOffset: sysTok.startOffset,
      endOffset: endTok.endOffset,
    },
  };
}

function skipWithinDurationInTokens(tokens: readonly LexToken[], withinIdx: number): number {
  const next = tokens[withinIdx + 1];
  if (!next) return withinIdx;
  if (next.kind === "int" || next.kind === "float") {
    let end = withinIdx + 1;
    if (tokens[end + 1]?.kind === "identifier" && tokens[end + 1].line === next.line) {
      end++;
      if (
        tokens[end + 1]?.kind === "identifier" &&
        tokens[end + 1].lexeme === "before" &&
        tokens[end + 2]?.kind === "identifier" &&
        tokens[end + 2].lexeme === "now"
      ) {
        end += 2;
      }
    }
    return end;
  }
  if (next.kind === "string") return withinIdx + 1;
  return withinIdx;
}

function getDeclOffsets(doc: DocumentIndex, sym: SymbolEntry): { start: number; end: number } {
  const start =
    (doc.lineStarts[sym.declarationRange.startLineNumber - 1] ?? 0) +
    (sym.declarationRange.startColumn - 1);
  const end =
    (doc.lineStarts[sym.declarationRange.endLineNumber - 1] ?? 0) +
    (sym.declarationRange.endColumn - 1);
  return { start, end };
}

const shouldStopLetRhs = (
  cur: LexToken,
  collected: readonly LexToken[],
  depth: number,
): boolean => {
  if (depth !== 0) return false;
  if (cur.kind === "delimiter" && cur.lexeme === ":") return true;
  if (cur.kind !== "keyword") return false;
  if (
    cur.lexeme === "latest" &&
    collected.length > 0 &&
    cur.line > collected[collected.length - 1].line
  ) {
    const prevExprTok = collected[collected.length - 1];
    const continuesExpr =
      (prevExprTok.kind === "delimiter" &&
        (prevExprTok.lexeme === "." ||
          prevExprTok.lexeme === "(" ||
          prevExprTok.lexeme === "[")) ||
      prevExprTok.kind === "operator" ||
      (prevExprTok.kind === "keyword" &&
        (prevExprTok.lexeme === "and" ||
          prevExprTok.lexeme === "or" ||
          prevExprTok.lexeme === "not"));
    return !continuesExpr;
  }
  return (
    cur.lexeme !== "latest" &&
    cur.lexeme !== "where" &&
    cur.lexeme !== "within" &&
    cur.lexeme !== "and" &&
    cur.lexeme !== "or" &&
    cur.lexeme !== "not" &&
    STATEMENT_STOP_KEYWORDS.has(cur.lexeme)
  );
};

class DocumentIndexer {
  private readonly tokens: LexToken[];
  private readonly comments: LexComment[];
  private readonly lineStarts: number[];
  private readonly largeFileDegraded: boolean;
  private readonly eofTok: LexToken;

  private readonly blocks: BlockNode[] = [];
  private readonly blockStack: ActiveBlockMeta[] = [];
  private readonly symbols: SymbolEntry[] = [];
  private readonly terminologyCalls: TerminologyOccurrence[] = [];
  private readonly references: IdentifierRef[] = [];
  private readonly declEndOffsets: number[] = [];
  private readonly inclusiveScopeSymbols = new Set<number>();
  private readonly syntheticTriggerOffsets = new Map<number, number>();
  private readonly pendingRepeatOfRefs: { refIndex: number; ruleName: string }[] = [];
  private readonly ruleSymbolMap = new Map<string, number>();

  private i = 0;

  constructor(
    private readonly source: string,
    private readonly schema: DatasetSchemaIndex,
    skipDeepRefs: boolean,
  ) {
    const lexed = tokenizeHelix(source);
    this.tokens = lexed.tokens;
    this.comments = lexed.comments;
    this.lineStarts = lexed.lineStarts;
    this.largeFileDegraded = source.length > LARGE_FILE_BYTE_LIMIT || skipDeepRefs;
    this.eofTok = this.tokens[this.tokens.length - 1] ?? {
      kind: "eof",
      lexeme: "",
      startOffset: source.length,
      endOffset: source.length,
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 1,
    };
  }

  run(): DocumentIndex {
    while (this.i < this.tokens.length && this.tokens[this.i].kind !== "eof") {
      const tok = this.tokens[this.i];
      const prevTok = this.i > 0 ? this.tokens[this.i - 1] : undefined;

      if (tok.kind === "keyword") {
        switch (tok.lexeme) {
          case "rule":
            this.handleRule(tok, prevTok);
            continue;
          case "end":
            this.handleEnd(tok, prevTok);
            continue;
          case "bind":
            this.handleBind(tok, prevTok);
            continue;
          case "when":
            this.handleWhen(tok, prevTok);
            continue;
          case "then":
            this.handleThen(tok, prevTok);
            continue;
          case "otherwise":
            this.handleOtherwise(tok, prevTok);
            continue;
          case "let":
            this.handleLet(tok, prevTok);
            continue;
          case "source":
            this.handleSource(tok, prevTok);
            continue;
          case "for":
            this.handleFor(tok, prevTok);
            continue;
          case "site":
          case "terminology":
            this.handleSiteOrTerminology(tok, prevTok);
            continue;
          case "suppress":
            this.handleSuppress(tok, prevTok);
            continue;
          case "within":
            this.i = skipWithinDurationInTokens(this.tokens, this.i) + 1;
            continue;
          default:
            if (
              tok.lexeme === "intent" ||
              tok.lexeme === "schedule" ||
              tok.lexeme === "alert" ||
              tok.lexeme === "latest"
            ) {
              this.closeOpenBinds(prevTok, tok.startOffset, false);
            }
            this.i++;
            continue;
        }
      }

      const term = parseTerminologyCall(
        this.tokens,
        this.i,
        this.source,
        this.lineStarts,
      );
      if (term) {
        this.recordRef(tok, null, false);
        this.terminologyCalls.push(term.occurrence);
        this.i = term.nextIdx;
        continue;
      }

      if (tok.kind === "identifier") {
        this.consumeDottedIdentifierRef();
        continue;
      }

      this.i++;
    }

    for (const meta of this.blockStack) {
      const block = this.blocks[meta.blockIndex];
      for (const idx of meta.ruleScopedSymbols) this.inclusiveScopeSymbols.add(idx);
      if (block.otherwiseOffset === null) {
        for (const idx of meta.thenScopedSymbols) this.inclusiveScopeSymbols.add(idx);
      }
      for (const idx of meta.otherwiseScopedSymbols) this.inclusiveScopeSymbols.add(idx);
    }

    for (const pending of this.pendingRepeatOfRefs) {
      const resolvedRuleIdx = this.ruleSymbolMap.get(pending.ruleName);
      if (resolvedRuleIdx !== undefined) {
        this.references[pending.refIndex].symbolIndex = resolvedRuleIdx;
      }
    }

    const doc: DocumentIndex = {
      source: this.source,
      tokens: this.tokens,
      comments: this.comments,
      lineStarts: this.lineStarts,
      blocks: this.blocks,
      symbols: this.symbols,
      terminologyCalls: this.terminologyCalls,
      references: this.references,
      largeFileDegraded: this.largeFileDegraded,
    };

    documentMetaCache.set(doc, {
      declEndOffsets: this.declEndOffsets,
      inclusiveScopeSymbols: this.inclusiveScopeSymbols,
      syntheticTriggerOffsets: this.syntheticTriggerOffsets,
    });

    return doc;
  }

  private currentBlockMeta(): ActiveBlockMeta | undefined {
    return this.blockStack[this.blockStack.length - 1];
  }

  private findEnclosingRuleMeta(): ActiveBlockMeta | undefined {
    for (let k = this.blockStack.length - 1; k >= 0; k--) {
      if (this.blocks[this.blockStack[k].blockIndex].kind === "rule") {
        return this.blockStack[k];
      }
    }
    return undefined;
  }

  private lookupVisibleVar = (name: string): number | null => {
    for (let k = this.blockStack.length - 1; k >= 0; k--) {
      const meta = this.blockStack[k];
      const branchHit = meta.branchVarScope.get(name);
      if (branchHit !== undefined) return branchHit;
      const hit = meta.varScope.get(name);
      if (hit !== undefined) return hit;
    }
    return null;
  };

  private recordRef(
    tok: LexToken,
    symbolIndex: number | null,
    isDeclaration: boolean,
    memberOf?: string,
  ): number {
    if (this.largeFileDegraded && !isDeclaration) return -1;
    const ref: IdentifierRef = {
      name: tok.lexeme,
      range: tokenRange(tok),
      startOffset: tok.startOffset,
      endOffset: tok.endOffset,
      symbolIndex,
      isDeclaration,
    };
    if (memberOf !== undefined) ref.memberOf = memberOf;
    this.references.push(ref);
    return this.references.length - 1;
  }

  private pushSymbol(
    fullEntry: SymbolEntry,
    declEndOffset: number,
    scopeBucket?: number[],
    varScopeMap?: Map<string, number>,
  ): SymbolEntry {
    const index = fullEntry.index;
    this.symbols.push(fullEntry);
    this.declEndOffsets.push(declEndOffset);
    if (!scopeBucket && fullEntry.scopeEndOffset === this.source.length) {
      this.inclusiveScopeSymbols.add(index);
    }
    if (scopeBucket) scopeBucket.push(index);

    if (varScopeMap) {
      varScopeMap.set(fullEntry.name, index);
    } else if (fullEntry.kind === "rule") {
      this.ruleSymbolMap.set(fullEntry.name, index);
    }
    return fullEntry;
  }

  private resolveVarScopeMap(): Map<string, number> | undefined {
    const top = this.currentBlockMeta();
    if (top && this.blocks[top.blockIndex].kind === "when") {
      const whenBlock = this.blocks[top.blockIndex];
      return whenBlock.thenOffset !== null || whenBlock.otherwiseOffset !== null
        ? top.branchVarScope
        : top.varScope;
    }
    const ruleMeta = this.findEnclosingRuleMeta();
    if (ruleMeta) return ruleMeta.varScope;
    return top?.varScope;
  }

  private finalizeSymbols(
    symIndices: readonly number[],
    endOffset: number,
    inclusive: boolean,
  ): void {
    for (const idx of symIndices) {
      this.symbols[idx].scopeEndOffset = endOffset;
      if (inclusive) this.inclusiveScopeSymbols.add(idx);
      else this.inclusiveScopeSymbols.delete(idx);
    }
  }

  private closeTopBlock(
    closeOffset: number,
    endLine: number,
    endColumn: number,
    synthetic: boolean,
    triggerOffset?: number,
  ): void {
    const meta = this.blockStack.pop();
    if (!meta) return;
    const block = this.blocks[meta.blockIndex];
    block.closeOffset = closeOffset;
    block.fullRange = {
      startLineNumber: block.fullRange.startLineNumber,
      startColumn: block.fullRange.startColumn,
      endLineNumber: endLine,
      endColumn,
    };
    if (synthetic) {
      block.syntheticClosed = true;
      if (triggerOffset !== undefined) {
        this.syntheticTriggerOffsets.set(block.index, triggerOffset);
      }
    }

    if (block.kind === "rule" || block.kind === "bind-site") {
      this.finalizeSymbols(meta.ruleScopedSymbols, closeOffset, synthetic);
    } else if (block.kind === "when") {
      if (block.otherwiseOffset === null) {
        this.finalizeSymbols(meta.thenScopedSymbols, closeOffset, synthetic);
      }
      this.finalizeSymbols(meta.otherwiseScopedSymbols, closeOffset, synthetic);
    }
  }

  private closeOpenBinds(
    prevTok: LexToken | undefined,
    triggerOffset: number,
    valueBindOnly: boolean,
  ): void {
    while (this.blockStack.length > 0) {
      const kind = this.blocks[this.blockStack[this.blockStack.length - 1].blockIndex].kind;
      if (kind !== "bind" && (valueBindOnly || kind !== "bind-site")) break;
      const closeOff = prevTok ? prevTok.endOffset : 0;
      const endLine = prevTok ? prevTok.endLine : 1;
      const endCol = prevTok ? prevTok.endColumn : 1;
      this.closeTopBlock(closeOff, endLine, endCol, true, triggerOffset);
    }
  }

  private pushBlockMeta(block: Omit<BlockNode, "index">): ActiveBlockMeta {
    const blockIndex = this.blocks.length;
    this.blocks.push({ index: blockIndex, ...block });
    const meta: ActiveBlockMeta = {
      blockIndex,
      varScope: new Map(),
      branchVarScope: new Map(),
      ruleScopedSymbols: [],
      thenScopedSymbols: [],
      otherwiseScopedSymbols: [],
    };
    this.blockStack.push(meta);
    return meta;
  }

  private consumeDottedIdentifierRef(): void {
    const headTok = this.tokens[this.i];
    const symIdx = this.lookupVisibleVar(headTok.lexeme);
    let chainPrefix = headTok.lexeme;
    this.recordRef(headTok, symIdx, false);
    this.i++;
    while (
      this.i + 1 < this.tokens.length &&
      isDotOrArrow(this.tokens[this.i]) &&
      isMemberNameToken(this.tokens[this.i + 1])
    ) {
      const memberTok = this.tokens[this.i + 1];
      this.recordRef(memberTok, symIdx, false, chainPrefix);
      chainPrefix = `${chainPrefix}.${memberTok.lexeme}`;
      this.i += 2;
    }
  }

  private recordExprRefs(exprTokens: readonly LexToken[]): void {
    if (this.largeFileDegraded) return;
    let chainPrefix: string | undefined;
    let chainSymbolIdx: number | null = null;

    for (let k = 0; k < exprTokens.length; k++) {
      const t = exprTokens[k];
      const prev = k > 0 ? exprTokens[k - 1] : undefined;

      if (isDotOrArrow(prev) && isMemberNameToken(t)) {
        const memberSym = chainPrefix !== undefined ? chainSymbolIdx : null;
        this.recordRef(t, memberSym, false, chainPrefix);
        chainPrefix = chainPrefix ? `${chainPrefix}.${t.lexeme}` : t.lexeme;
        continue;
      }

      if (isKeyword(t, "within")) {
        k = skipWithinDurationInTokens(exprTokens, k);
        chainPrefix = undefined;
        chainSymbolIdx = null;
        continue;
      }

      if (t.kind === "identifier") {
        const nextTok = k + 1 < exprTokens.length ? exprTokens[k + 1] : undefined;
        const isTerm =
          nextTok?.kind === "delimiter" &&
          (nextTok.lexeme === "(" || nextTok.lexeme === "[") &&
          nextTok.line === t.line &&
          toTerminologySystem(t.lexeme) !== null;
        if (isTerm) {
          this.recordRef(t, null, false);
          const expectedClose = nextTok.lexeme === "(" ? ")" : "]";
          k++; // move to '(' / '['
          while (
            k + 1 < exprTokens.length &&
            exprTokens[k + 1].line === nextTok.line &&
            exprTokens[k + 1].kind !== "keyword"
          ) {
            k++;
            if (exprTokens[k].kind === "delimiter" && exprTokens[k].lexeme === expectedClose) {
              break;
            }
          }
          chainPrefix = undefined;
          chainSymbolIdx = null;
          continue;
        }

        const symIdx = this.lookupVisibleVar(t.lexeme);
        this.recordRef(t, symIdx, false);
        chainPrefix = t.lexeme;
        chainSymbolIdx = symIdx;
      } else if (!isDotOrArrow(t)) {
        chainPrefix = undefined;
        chainSymbolIdx = null;
      }
    }
  }

  /**
   * Collects expression tokens until `shouldStop(cur, collected, depth)` returns true,
   * automatically capturing inline terminology calls and preserving member-keyword access.
   */
  private collectExprTokens(
    shouldStop: (cur: LexToken, collected: readonly LexToken[], depth: number) => boolean,
  ): LexToken[] {
    const collected: LexToken[] = [];
    let depth = 0;
    while (this.i < this.tokens.length && this.tokens[this.i].kind !== "eof") {
      const cur = this.tokens[this.i];
      const prevCollected = collected[collected.length - 1];
      const afterMemberOp = isDotOrArrow(prevCollected) && isMemberNameToken(cur);
      if (!afterMemberOp && shouldStop(cur, collected, depth)) {
        break;
      }

      if (cur.kind === "identifier") {
        const term = parseTerminologyCall(
          this.tokens,
          this.i,
          this.source,
          this.lineStarts,
        );
        if (term) {
          this.terminologyCalls.push(term.occurrence);
          for (let k = this.i; k < term.nextIdx; k++) {
            collected.push(this.tokens[k]);
          }
          this.i = term.nextIdx;
          continue;
        }
      }

      if (cur.kind === "delimiter" && (cur.lexeme === "(" || cur.lexeme === "[")) depth++;
      else if (cur.kind === "delimiter" && (cur.lexeme === ")" || cur.lexeme === "]")) {
        depth = Math.max(0, depth - 1);
      }
      collected.push(cur);
      this.i++;
    }
    return collected;
  }

  private handleRule(tok: LexToken, prevTok: LexToken | undefined): void {
    while (this.blockStack.length > 0) {
      const closeOff = prevTok ? prevTok.endOffset : 0;
      const endLine = prevTok ? prevTok.endLine : 1;
      const endCol = prevTok ? prevTok.endColumn : 1;
      this.closeTopBlock(closeOff, endLine, endCol, true, tok.startOffset);
    }

    this.i++;
    let nameTok: LexToken | undefined;
    let headerEndTok: LexToken = tok;
    if (this.tokens[this.i]?.kind === "identifier") {
      nameTok = this.tokens[this.i];
      headerEndTok = nameTok;
      this.i++;
      if (this.tokens[this.i]?.kind === "delimiter" && this.tokens[this.i].lexeme === ":") {
        headerEndTok = this.tokens[this.i];
        this.i++;
      }
    }

    this.pushBlockMeta({
      kind: "rule",
      name: nameTok?.lexeme,
      openOffset: tok.startOffset,
      closeOffset: null,
      headerRange: spanRange(tok, headerEndTok),
      fullRange: spanRange(tok, this.eofTok),
      thenOffset: null,
      otherwiseOffset: null,
      parentIndex: null,
    });

    if (nameTok) {
      const ruleSym = this.pushSymbol(
        {
          index: this.symbols.length,
          kind: "rule",
          name: nameTok.lexeme,
          nameRange: tokenRange(nameTok),
          declarationRange: spanRange(tok, headerEndTok),
          scopeStartOffset: 0,
          scopeEndOffset: this.source.length,
          valueType: "Unknown",
        },
        headerEndTok.endOffset,
      );
      this.recordRef(nameTok, ruleSym.index, true);
    }
  }

  private handleEnd(tok: LexToken, prevTok: LexToken | undefined): void {
    const nextTok = this.tokens[this.i + 1];
    if (
      nextTok &&
      nextTok.line === tok.line &&
      nextTok.kind === "keyword" &&
      (nextTok.lexeme === "rule" ||
        nextTok.lexeme === "bind" ||
        nextTok.lexeme === "when")
    ) {
      const descriptor = nextTok.lexeme;
      let matchPos = -1;
      for (let k = this.blockStack.length - 1; k >= 0; k--) {
        const kind = this.blocks[this.blockStack[k].blockIndex].kind;
        if (
          (descriptor === "rule" && kind === "rule") ||
          (descriptor === "when" && kind === "when") ||
          (descriptor === "bind" && (kind === "bind" || kind === "bind-site"))
        ) {
          matchPos = k;
          break;
        }
      }
      if (matchPos !== -1) {
        while (this.blockStack.length - 1 > matchPos) {
          const closeOff = prevTok ? prevTok.endOffset : tok.startOffset;
          const endLine = prevTok ? prevTok.endLine : tok.line;
          const endCol = prevTok ? prevTok.endColumn : tok.column;
          this.closeTopBlock(closeOff, endLine, endCol, true, tok.startOffset);
        }
        this.closeTopBlock(
          nextTok.endOffset,
          nextTok.endLine,
          nextTok.endColumn,
          false,
        );
      }
      this.i += 2;
    } else {
      this.i++;
    }
  }

  private handleBind(tok: LexToken, prevTok: LexToken | undefined): void {
    this.closeOpenBinds(prevTok, tok.startOffset, false);
    const parentMeta = this.currentBlockMeta();
    const parentIndex = parentMeta ? parentMeta.blockIndex : null;
    this.i++;

    if (isKeyword(this.tokens[this.i], "site")) {
      const siteTok = this.tokens[this.i];
      this.i++;
      let headerEndTok: LexToken = siteTok;
      if (this.tokens[this.i]?.kind === "delimiter" && this.tokens[this.i].lexeme === ":") {
        headerEndTok = this.tokens[this.i];
        this.i++;
      }
      let siteName: string | undefined;
      const candidate = this.tokens[this.i];
      if (
        candidate &&
        candidate.line === siteTok.line &&
        (candidate.kind === "identifier" || candidate.kind === "string")
      ) {
        siteName =
          candidate.kind === "string" ? candidate.lexeme.slice(1, -1) : candidate.lexeme;
        headerEndTok = candidate;
        if (candidate.kind === "identifier") this.recordRef(candidate, null, false);
        this.i++;
      }

      this.pushBlockMeta({
        kind: "bind-site",
        name: siteName,
        openOffset: tok.startOffset,
        closeOffset: null,
        headerRange: spanRange(tok, headerEndTok),
        fullRange: spanRange(tok, this.eofTok),
        thenOffset: null,
        otherwiseOffset: null,
        parentIndex,
      });
      return;
    }

    let nameTok: LexToken | undefined;
    let lastContentTok: LexToken = tok;
    let declRefIdx = -1;
    if (this.tokens[this.i]?.kind === "identifier") {
      nameTok = this.tokens[this.i];
      lastContentTok = nameTok;
      declRefIdx = this.recordRef(nameTok, -1, true);
      this.i++;
    }

    const bindMeta = this.pushBlockMeta({
      kind: "bind",
      name: nameTok?.lexeme,
      openOffset: tok.startOffset,
      closeOffset: null,
      headerRange: spanRange(tok, lastContentTok),
      fullRange: spanRange(tok, this.eofTok),
      thenOffset: null,
      otherwiseOffset: null,
      parentIndex,
    });

    const op = this.tokens[this.i];
    if (
      op &&
      ((op.kind === "operator" &&
        (op.lexeme === ":=" || op.lexeme === "=" || op.lexeme === "->")) ||
        (op.kind === "delimiter" && op.lexeme === ":"))
    ) {
      lastContentTok = op;
      this.i++;
    }

    let sourcePath = "";
    let targetTokens: LexToken[] = [];
    if (isKeyword(this.tokens[this.i], "latest")) {
      lastContentTok = this.tokens[this.i];
      this.i++;
      if (this.tokens[this.i]?.kind === "identifier") {
        const obsTok = this.tokens[this.i];
        sourcePath = obsTok.lexeme;
        targetTokens = [obsTok];
        lastContentTok = obsTok;
        this.i++;
      }
    } else {
      targetTokens = this.collectExprTokens(
        (cur, _collected, depth) =>
          depth === 0 &&
          cur.kind === "keyword" &&
          (cur.lexeme === "where" ||
            cur.lexeme === "within" ||
            STATEMENT_STOP_KEYWORDS.has(cur.lexeme)),
      );
      if (targetTokens.length > 0) {
        lastContentTok = targetTokens[targetTokens.length - 1];
        sourcePath = this.source
          .slice(targetTokens[0].startOffset, lastContentTok.endOffset)
          .replace(/\s+/g, "");
      }
    }
    this.recordExprRefs(targetTokens);

    let whereText: string | undefined;
    if (isKeyword(this.tokens[this.i], "where")) {
      lastContentTok = this.tokens[this.i];
      this.i++;
      const whereTokens = this.collectExprTokens((cur, collected, depth) => {
        if (depth !== 0 || cur.kind !== "keyword") return false;
        if (cur.lexeme === "within") return true;
        if (
          cur.lexeme === "latest" &&
          collected.length > 0 &&
          cur.line === collected[collected.length - 1].line
        ) {
          return false;
        }
        return STATEMENT_STOP_KEYWORDS.has(cur.lexeme);
      });
      this.recordExprRefs(whereTokens);
      if (whereTokens.length > 0) {
        lastContentTok = whereTokens[whereTokens.length - 1];
        whereText = sliceCollapsed(
          this.source,
          whereTokens[0].startOffset,
          lastContentTok.endOffset,
        );
      }
    }

    let withinText: string | undefined;
    if (isKeyword(this.tokens[this.i], "within")) {
      lastContentTok = this.tokens[this.i];
      this.i++;
      const withinTokens: LexToken[] = [];
      while (this.i < this.tokens.length && this.tokens[this.i].kind !== "eof") {
        const cur = this.tokens[this.i];
        if (cur.kind === "keyword" && STATEMENT_STOP_KEYWORDS.has(cur.lexeme)) break;
        if (
          withinTokens.length > 0 &&
          cur.line > withinTokens[withinTokens.length - 1].line
        ) {
          break;
        }
        withinTokens.push(cur);
        lastContentTok = cur;
        this.i++;
      }
      if (withinTokens.length === 1 && withinTokens[0].kind === "identifier") {
        const symIdx = this.lookupVisibleVar(withinTokens[0].lexeme);
        if (symIdx !== null) this.recordRef(withinTokens[0], symIdx, false);
      }
      if (withinTokens.length > 0) {
        withinText = sliceCollapsed(
          this.source,
          withinTokens[0].startOffset,
          withinTokens[withinTokens.length - 1].endOffset,
        );
      }
    }

    this.blocks[bindMeta.blockIndex].headerRange = spanRange(tok, lastContentTok);

    if (nameTok) {
      const ruleMeta = this.findEnclosingRuleMeta();
      const resolvedTarget =
        sourcePath && !sourcePath.endsWith(".")
          ? this.schema.resolvePath(sourcePath) ?? undefined
          : undefined;
      const sym = this.pushSymbol(
        {
          index: this.symbols.length,
          kind: "bind",
          name: nameTok.lexeme,
          nameRange: tokenRange(nameTok),
          declarationRange: spanRange(tok, lastContentTok),
          scopeStartOffset: ruleMeta
            ? this.blocks[ruleMeta.blockIndex].openOffset
            : tok.startOffset,
          scopeEndOffset: this.source.length,
          valueType: "Series",
          resolvedTarget,
          sourcePath: sourcePath || undefined,
          whereText,
          withinText,
        },
        lastContentTok.endOffset,
        ruleMeta?.ruleScopedSymbols,
        this.resolveVarScopeMap(),
      );
      if (declRefIdx !== -1) this.references[declRefIdx].symbolIndex = sym.index;
    }
  }

  private handleWhen(tok: LexToken, prevTok: LexToken | undefined): void {
    this.closeOpenBinds(prevTok, tok.startOffset, false);
    if (isEventTriggerAhead(this.tokens, this.i)) {
      this.i++;
      this.consumeDottedIdentifierRef();
      return;
    }

    const parentMeta = this.currentBlockMeta();
    const parentIndex = parentMeta ? parentMeta.blockIndex : null;
    this.i++;

    let forVarTok: LexToken | undefined;
    let forDeclRefIdx = -1;
    if (isKeyword(this.tokens[this.i], "for")) {
      this.i++;
      if (this.tokens[this.i]?.kind === "identifier") {
        forVarTok = this.tokens[this.i];
        forDeclRefIdx = this.recordRef(forVarTok, -1, true);
        this.i++;
      }
    }

    const whenMeta = this.pushBlockMeta({
      kind: "when",
      openOffset: tok.startOffset,
      closeOffset: null,
      headerRange: spanRange(tok, forVarTok ?? tok),
      fullRange: spanRange(tok, this.eofTok),
      thenOffset: null,
      otherwiseOffset: null,
      parentIndex,
    });

    if (forVarTok) {
      const forSym = this.pushSymbol(
        {
          index: this.symbols.length,
          kind: "for",
          name: forVarTok.lexeme,
          nameRange: tokenRange(forVarTok),
          declarationRange: spanRange(tok, forVarTok),
          scopeStartOffset: tok.startOffset,
          scopeEndOffset: this.source.length,
          valueType: "Unknown",
          syntaxOnly: true,
        },
        forVarTok.endOffset,
        whenMeta.otherwiseScopedSymbols,
        whenMeta.varScope,
      );
      if (forDeclRefIdx !== -1) this.references[forDeclRefIdx].symbolIndex = forSym.index;
    }

    let colonTok: LexToken | undefined;
    const condTokens = this.collectExprTokens((cur, _collected, depth) => {
      if (depth !== 0) return false;
      if (cur.kind === "delimiter" && cur.lexeme === ":") {
        colonTok = cur;
        this.i++;
        return true;
      }
      return (
        cur.kind === "keyword" &&
        cur.lexeme !== "latest" &&
        cur.lexeme !== "where" &&
        cur.lexeme !== "within" &&
        cur.lexeme !== "and" &&
        cur.lexeme !== "or" &&
        cur.lexeme !== "not" &&
        STATEMENT_STOP_KEYWORDS.has(cur.lexeme)
      );
    });

    this.recordExprRefs(condTokens);

    const headerEndTok =
      colonTok ?? condTokens[condTokens.length - 1] ?? forVarTok ?? tok;
    const whenBlock = this.blocks[whenMeta.blockIndex];
    whenBlock.headerRange = spanRange(tok, headerEndTok);
    whenBlock.conditionPreview =
      condTokens.length > 0
        ? sliceCollapsed(
            this.source,
            condTokens[0].startOffset,
            condTokens[condTokens.length - 1].endOffset,
          )
        : undefined;
  }

  private handleThen(tok: LexToken, prevTok: LexToken | undefined): void {
    this.closeOpenBinds(prevTok, tok.startOffset, false);
    const top = this.currentBlockMeta();
    if (
      top &&
      this.blocks[top.blockIndex].kind === "when" &&
      this.blocks[top.blockIndex].thenOffset === null
    ) {
      this.blocks[top.blockIndex].thenOffset = tok.startOffset;
    }
    this.i++;
    if (this.tokens[this.i]?.kind === "delimiter" && this.tokens[this.i].lexeme === ":") {
      this.i++;
    }
  }

  private handleOtherwise(tok: LexToken, prevTok: LexToken | undefined): void {
    this.closeOpenBinds(prevTok, tok.startOffset, false);
    let targetPos = -1;
    for (let k = this.blockStack.length - 1; k >= 0; k--) {
      const b = this.blocks[this.blockStack[k].blockIndex];
      if (b.kind === "when" && b.otherwiseOffset === null) {
        targetPos = k;
        break;
      }
      if (b.kind === "rule") break;
    }
    if (targetPos !== -1) {
      while (this.blockStack.length - 1 > targetPos) {
        const closeOff = prevTok ? prevTok.endOffset : tok.startOffset;
        const endLine = prevTok ? prevTok.endLine : tok.line;
        const endCol = prevTok ? prevTok.endColumn : tok.column;
        this.closeTopBlock(closeOff, endLine, endCol, true, tok.startOffset);
      }
      const whenMeta = this.blockStack[targetPos];
      const whenBlock = this.blocks[whenMeta.blockIndex];
      this.finalizeSymbols(whenMeta.thenScopedSymbols, tok.startOffset, false);
      whenMeta.branchVarScope.clear();
      whenBlock.otherwiseOffset = tok.startOffset;
    }
    this.i++;
    if (this.tokens[this.i]?.kind === "delimiter" && this.tokens[this.i].lexeme === ":") {
      this.i++;
    }
  }

  private handleLet(tok: LexToken, prevTok: LexToken | undefined): void {
    this.closeOpenBinds(prevTok, tok.startOffset, false);
    this.i++;
    if (this.tokens[this.i]?.kind !== "identifier") return;

    const nameTok = this.tokens[this.i];
    const declRefIdx = this.recordRef(nameTok, -1, true);
    let declEndTok: LexToken = nameTok;
    this.i++;

    let rhsTokens: LexToken[] = [];
    const opTok = this.tokens[this.i];
    if (
      opTok &&
      opTok.kind === "operator" &&
      (opTok.lexeme === ":=" || opTok.lexeme === "=")
    ) {
      declEndTok = opTok;
      this.i++;
      rhsTokens = this.collectExprTokens(shouldStopLetRhs);
      if (rhsTokens.length > 0) declEndTok = rhsTokens[rhsTokens.length - 1];
    }

    // Resolve RHS refs and infer type BEFORE inserting the new `let` into varScope
    this.recordExprRefs(rhsTokens);
    const valueType = inferLetValueType(rhsTokens, this.lookupVisibleVar, this.symbols);
    const initializerPreview =
      rhsTokens.length > 0
        ? sliceCollapsed(
            this.source,
            rhsTokens[0].startOffset,
            rhsTokens[rhsTokens.length - 1].endOffset,
          )
        : undefined;

    const top = this.currentBlockMeta();
    const topBlock = top ? this.blocks[top.blockIndex] : undefined;
    const ruleMeta = this.findEnclosingRuleMeta();

    let scopeStartOffset: number;
    let scopeBucket: number[] | undefined;
    let varScopeMap: Map<string, number> | undefined;
    if (
      top &&
      topBlock?.kind === "when" &&
      (topBlock.otherwiseOffset !== null || topBlock.thenOffset !== null)
    ) {
      if (topBlock.otherwiseOffset !== null) {
        scopeStartOffset = topBlock.otherwiseOffset;
        scopeBucket = top.otherwiseScopedSymbols;
      } else {
        scopeStartOffset = topBlock.thenOffset!;
        scopeBucket = top.thenScopedSymbols;
      }
      varScopeMap = top.branchVarScope;
    } else if (ruleMeta) {
      scopeStartOffset = this.blocks[ruleMeta.blockIndex].openOffset;
      scopeBucket = ruleMeta.ruleScopedSymbols;
      varScopeMap = ruleMeta.varScope;
    } else {
      scopeStartOffset = tok.startOffset;
      varScopeMap = top?.varScope;
    }

    const letSym = this.pushSymbol(
      {
        index: this.symbols.length,
        kind: "let",
        name: nameTok.lexeme,
        nameRange: tokenRange(nameTok),
        declarationRange: spanRange(tok, declEndTok),
        scopeStartOffset,
        scopeEndOffset: this.source.length,
        valueType,
        initializerPreview,
      },
      declEndTok.endOffset,
      scopeBucket,
      varScopeMap,
    );
    if (declRefIdx !== -1) this.references[declRefIdx].symbolIndex = letSym.index;
  }

  private handleSource(tok: LexToken, prevTok: LexToken | undefined): void {
    this.closeOpenBinds(prevTok, tok.startOffset, true);
    this.i++;
    if (this.tokens[this.i]?.kind === "delimiter" && this.tokens[this.i].lexeme === ":") {
      this.i++;
    }
    if (this.tokens[this.i]?.kind !== "identifier") return;

    const nameTok = this.tokens[this.i];
    const declRefIdx = this.recordRef(nameTok, -1, true);
    let declEndTok: LexToken = nameTok;
    this.i++;

    let isMetadata = false;
    if (this.tokens[this.i]?.kind === "operator" && this.tokens[this.i].lexeme === "->") {
      isMetadata = true;
      declEndTok = this.tokens[this.i];
      this.i++;
      if (this.tokens[this.i]?.kind === "identifier") {
        this.recordRef(this.tokens[this.i], null, false);
        declEndTok = this.tokens[this.i];
        this.i++;
      }
    }

    if (
      this.tokens[this.i]?.kind === "delimiter" &&
      this.tokens[this.i].lexeme === "(" &&
      this.tokens[this.i].line === declEndTok.line
    ) {
      let depth = 0;
      while (this.i < this.tokens.length && this.tokens[this.i].kind !== "eof") {
        const cur = this.tokens[this.i];
        if (cur.kind === "delimiter" && cur.lexeme === "(") depth++;
        else if (cur.kind === "delimiter" && cur.lexeme === ")") {
          depth--;
          declEndTok = cur;
          this.i++;
          if (depth <= 0) break;
          continue;
        }
        declEndTok = cur;
        this.i++;
      }
    }

    const top = this.currentBlockMeta();
    const ruleMeta = this.findEnclosingRuleMeta();
    const scopeMeta =
      top && this.blocks[top.blockIndex].kind === "bind-site" ? top : ruleMeta;
    const scopeStartOffset = scopeMeta
      ? this.blocks[scopeMeta.blockIndex].openOffset
      : tok.startOffset;
    const sourcePath = this.source
      .slice(nameTok.startOffset, declEndTok.endOffset)
      .replace(/\s+/g, " ")
      .trim();
    const resolvedTarget = !isMetadata
      ? this.schema.resolvePath(nameTok.lexeme) ?? undefined
      : undefined;

    const sourceSym = this.pushSymbol(
      {
        index: this.symbols.length,
        kind: "source",
        name: nameTok.lexeme,
        nameRange: tokenRange(nameTok),
        declarationRange: spanRange(tok, declEndTok),
        scopeStartOffset,
        scopeEndOffset: this.source.length,
        valueType: isMetadata ? "Unknown" : "Series",
        resolvedTarget,
        sourcePath,
        syntaxOnly: isMetadata,
      },
      declEndTok.endOffset,
      scopeMeta?.ruleScopedSymbols,
      this.resolveVarScopeMap(),
    );
    if (declRefIdx !== -1) this.references[declRefIdx].symbolIndex = sourceSym.index;
  }

  private handleFor(tok: LexToken, prevTok: LexToken | undefined): void {
    this.closeOpenBinds(prevTok, tok.startOffset, false);
    this.i++;
    if (this.tokens[this.i]?.kind !== "identifier") return;

    const varTok = this.tokens[this.i];
    const declRefIdx = this.recordRef(varTok, -1, true);
    let declEndTok: LexToken = varTok;
    this.i++;

    if (this.tokens[this.i]?.kind === "delimiter" && this.tokens[this.i].lexeme === ":") {
      declEndTok = this.tokens[this.i];
      this.i++;
    }
    let typeName: string | undefined;
    if (this.tokens[this.i]?.kind === "identifier" && this.tokens[this.i].line === varTok.line) {
      typeName = this.tokens[this.i].lexeme;
      this.recordRef(this.tokens[this.i], null, false);
      declEndTok = this.tokens[this.i];
      this.i++;
    }

    const ruleMeta = this.findEnclosingRuleMeta();
    const scopeStartOffset = ruleMeta
      ? this.blocks[ruleMeta.blockIndex].openOffset
      : tok.startOffset;
    const forSym = this.pushSymbol(
      {
        index: this.symbols.length,
        kind: "for",
        name: varTok.lexeme,
        nameRange: tokenRange(varTok),
        declarationRange: spanRange(tok, declEndTok),
        scopeStartOffset,
        scopeEndOffset: this.source.length,
        valueType: "Unknown",
        sourcePath: typeName,
        syntaxOnly: true,
      },
      declEndTok.endOffset,
      ruleMeta?.ruleScopedSymbols,
      this.resolveVarScopeMap(),
    );
    if (declRefIdx !== -1) this.references[declRefIdx].symbolIndex = forSym.index;
  }

  private handleSiteOrTerminology(tok: LexToken, prevTok: LexToken | undefined): void {
    this.closeOpenBinds(prevTok, tok.startOffset, true);
    this.i++;
    if (this.tokens[this.i]?.kind === "delimiter" && this.tokens[this.i].lexeme === ":") {
      this.i++;
    }
    const stmtTokens = this.collectExprTokens(
      (cur, _collected, depth) =>
        depth === 0 && cur.kind === "keyword" && STATEMENT_STOP_KEYWORDS.has(cur.lexeme),
    );
    this.recordExprRefs(stmtTokens);
  }

  private handleSuppress(tok: LexToken, prevTok: LexToken | undefined): void {
    this.closeOpenBinds(prevTok, tok.startOffset, false);
    this.i++;
    if (this.tokens[this.i]?.kind === "delimiter" && this.tokens[this.i].lexeme === ":") {
      this.i++;
    }
    if (
      this.tokens[this.i]?.kind === "identifier" &&
      this.tokens[this.i].lexeme === "repeat_of" &&
      this.tokens[this.i + 1]?.kind === "delimiter" &&
      this.tokens[this.i + 1].lexeme === ":"
    ) {
      this.recordRef(this.tokens[this.i], null, false);
      this.i += 2;
      if (this.tokens[this.i]?.kind === "identifier") {
        const targetTok = this.tokens[this.i];
        const existingRuleIdx = this.ruleSymbolMap.get(targetTok.lexeme) ?? null;
        const refIdx = this.recordRef(targetTok, existingRuleIdx, false);
        if (refIdx !== -1 && existingRuleIdx === null) {
          this.pendingRepeatOfRefs.push({ refIndex: refIdx, ruleName: targetTok.lexeme });
        }
        this.i++;
      }
    }
  }
}

/**
 * Performs a single-pass, error-tolerant parse and scope/symbol/reference/terminology index
 * over a HELIX source document. Never throws on incomplete or invalid input.
 */
export function indexDocument(
  source: string,
  schema: DatasetSchemaIndex,
  options?: { skipDeepRefs?: boolean },
): DocumentIndex {
  return new DocumentIndexer(source, schema, Boolean(options?.skipDeepRefs)).run();
}

function isBlockOpenAt(
  block: BlockNode,
  offset: number,
  meta?: DocumentIndexMeta,
): boolean {
  if (offset < block.openOffset) return false;
  if (block.closeOffset === null) return true;
  if (block.syntheticClosed) {
    const triggerOffset = meta?.syntheticTriggerOffsets.get(block.index);
    if (triggerOffset !== undefined && triggerOffset === block.closeOffset) {
      return offset < block.closeOffset;
    }
    return offset <= block.closeOffset;
  }
  return offset < block.closeOffset;
}

/**
 * Returns the stack of open BlockNodes (outer-to-inner) enclosing `offset`.
 */
export function openBlocksAt(doc: DocumentIndex, offset: number): BlockNode[] {
  if (!Number.isFinite(offset) || offset < 0 || offset > doc.source.length) {
    return [];
  }
  const meta = documentMetaCache.get(doc);
  const open: BlockNode[] = [];
  for (const block of doc.blocks) {
    if (isBlockOpenAt(block, offset, meta)) {
      open.push(block);
    }
  }
  return open;
}

/**
 * Returns the innermost open `rule` block enclosing `offset`, or `null` if none.
 */
export function activeRuleAt(doc: DocumentIndex, offset: number): BlockNode | null {
  const open = openBlocksAt(doc, offset);
  for (let i = open.length - 1; i >= 0; i--) {
    if (open[i].kind === "rule") return open[i];
  }
  return null;
}

/**
 * Returns symbols declared before `offset` whose lexical/branch scope contains `offset`.
 * Rule-local symbols never leak across rule boundaries; branch-scoped `let` variables
 * stay isolated to their `then` or `otherwise` branch.
 */
export function visibleSymbolsAt(doc: DocumentIndex, offset: number): SymbolEntry[] {
  if (!Number.isFinite(offset) || offset < 0 || offset > doc.source.length) {
    return [];
  }
  const meta = documentMetaCache.get(doc);
  const visible = new Map<string, SymbolEntry>();

  for (const sym of doc.symbols) {
    if (offset < sym.scopeStartOffset) continue;
    const inclusiveEnd = meta
      ? meta.inclusiveScopeSymbols.has(sym.index)
      : sym.scopeEndOffset === doc.source.length ||
        doc.blocks.some((b) => b.syntheticClosed && b.closeOffset === sym.scopeEndOffset);
    if (inclusiveEnd ? offset > sym.scopeEndOffset : offset >= sym.scopeEndOffset) {
      continue;
    }

    const declEnd = meta
      ? meta.declEndOffsets[sym.index]
      : getDeclOffsets(doc, sym).end;
    if (declEnd > offset) continue;

    const key = sym.kind === "rule" ? `rule:${sym.name}` : `var:${sym.name}`;
    visible.set(key, sym);
  }

  return Array.from(visible.values());
}

/**
 * Binary-searches `doc.references` for an IdentifierRef covering `offset`.
 */
export function findReferenceAtOffset(
  doc: DocumentIndex,
  offset: number,
): IdentifierRef | null {
  if (!Number.isFinite(offset) || offset < 0 || offset > doc.source.length) {
    return null;
  }
  const refs = doc.references;
  let low = 0;
  let high = refs.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const ref = refs[mid];
    if (offset < ref.startOffset) {
      high = mid - 1;
    } else if (offset > ref.endOffset) {
      low = mid + 1;
    } else {
      return ref;
    }
  }
  return null;
}

/**
 * Binary-searches `doc.terminologyCalls` for a TerminologyOccurrence covering `offset`.
 */
export function findTerminologyAtOffset(
  doc: DocumentIndex,
  offset: number,
): TerminologyOccurrence | null {
  if (!Number.isFinite(offset) || offset < 0 || offset > doc.source.length) {
    return null;
  }
  const calls = doc.terminologyCalls;
  let low = 0;
  let high = calls.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const call = calls[mid];
    if (offset < call.startOffset) {
      high = mid - 1;
    } else if (offset > call.endOffset) {
      low = mid + 1;
    } else {
      return call;
    }
  }
  return null;
}
