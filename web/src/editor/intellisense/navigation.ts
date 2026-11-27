import { findReferenceAtOffset } from "./document-index";
import {
  ALL_STATEMENT_START_KEYWORDS,
  isDelimiter,
  isStrictlyInsideComment,
  offsetFromLineStarts,
  spanRange,
  SYNTAX_ONLY_NOTE,
  tokenRange,
} from "./token-utils";
import type {
  BlockNode,
  DocumentIndex,
  LexToken,
  SymbolEntry,
  TextPosition,
  TextRange,
} from "./types";

export type OutlineSymbolKind =
  | "rule"
  | "source"
  | "bind"
  | "let"
  | "when"
  | "alert"
  | "suppress";

export interface OutlineSymbol {
  kind: OutlineSymbolKind;
  name: string;
  detail: string;
  range: TextRange;
  selectionRange: TextRange;
  children: OutlineSymbol[];
}

/**
 * Resolves go-to-definition for declared symbols (`bind`, `source`, `let`, `for`,
 * and `rule` via `suppress repeat_of: <RuleName>`).
 */
export function computeDefinition(
  doc: DocumentIndex,
  pos: TextPosition,
): TextRange | null {
  const offset = offsetFromLineStarts(doc.source, doc.lineStarts, pos);
  if (isStrictlyInsideComment(doc.comments, offset)) return null;
  const ref = findReferenceAtOffset(doc, offset);
  if (!ref || ref.symbolIndex === null || ref.memberOf !== undefined) {
    return null;
  }
  const sym = doc.symbols[ref.symbolIndex];
  return sym ? sym.nameRange : null;
}

/**
 * Finds all reference ranges matching the symbol at `pos` by `symbolIndex`.
 */
export function computeReferences(
  doc: DocumentIndex,
  pos: TextPosition,
  includeDeclaration: boolean,
): TextRange[] {
  const offset = offsetFromLineStarts(doc.source, doc.lineStarts, pos);
  if (isStrictlyInsideComment(doc.comments, offset)) return [];
  const ref = findReferenceAtOffset(doc, offset);
  if (!ref || ref.symbolIndex === null || ref.memberOf !== undefined) {
    return [];
  }
  const targetIdx = ref.symbolIndex;
  const out: TextRange[] = [];
  for (const r of doc.references) {
    if (r.symbolIndex !== targetIdx || r.memberOf !== undefined) continue;
    if (!includeDeclaration && r.isDeclaration) continue;
    out.push(r.range);
  }
  return out;
}

function ensureContainedRange(outer: TextRange, inner: TextRange): TextRange {
  const startBefore =
    outer.startLineNumber < inner.startLineNumber ||
    (outer.startLineNumber === inner.startLineNumber &&
      outer.startColumn <= inner.startColumn);
  const endAfter =
    outer.endLineNumber > inner.endLineNumber ||
    (outer.endLineNumber === inner.endLineNumber &&
      outer.endColumn >= inner.endColumn);
  if (startBefore && endAfter) return outer;
  return {
    startLineNumber: startBefore ? outer.startLineNumber : inner.startLineNumber,
    startColumn: startBefore ? outer.startColumn : inner.startColumn,
    endLineNumber: endAfter ? outer.endLineNumber : inner.endLineNumber,
    endColumn: endAfter ? outer.endColumn : inner.endColumn,
  };
}

function compareRanges(a: TextRange, b: TextRange): number {
  if (a.startLineNumber !== b.startLineNumber) {
    return a.startLineNumber - b.startLineNumber;
  }
  return a.startColumn - b.startColumn;
}

function sortOutlineTree(nodes: OutlineSymbol[]): void {
  nodes.sort((a, b) => compareRanges(a.range, b.range));
  for (const node of nodes) {
    if (node.children.length > 0) {
      sortOutlineTree(node.children);
    }
  }
}

function extractActionOutlineItems(
  doc: DocumentIndex,
): { offset: number; symbol: OutlineSymbol }[] {
  const items: { offset: number; symbol: OutlineSymbol }[] = [];
  const tokens = doc.tokens;
  let i = 0;

  while (i < tokens.length && tokens[i].kind !== "eof") {
    const tok = tokens[i];
    if (
      tok.kind === "keyword" &&
      (tok.lexeme === "alert" || tok.lexeme === "suppress")
    ) {
      const kind: "alert" | "suppress" = tok.lexeme;
      let j = i + 1;
      if (isDelimiter(tokens[j], ":")) j++;

      const bodyStartIdx = j;
      let depth = 0;
      let lastTok: LexToken = isDelimiter(tokens[i + 1], ":")
        ? tokens[i + 1]
        : tok;

      while (j < tokens.length && tokens[j].kind !== "eof") {
        const cur = tokens[j];
        const prev = tokens[j - 1];
        const afterMember =
          isDelimiter(prev, ".") ||
          (prev?.kind === "operator" && prev.lexeme === "->");
        if (
          !afterMember &&
          depth === 0 &&
          cur.kind === "keyword" &&
          (ALL_STATEMENT_START_KEYWORDS.has(cur.lexeme) ||
            (cur.lexeme === "latest" && cur.line > lastTok.endLine))
        ) {
          break;
        }
        if (isDelimiter(cur, "(") || isDelimiter(cur, "[")) depth++;
        else if (isDelimiter(cur, ")") || isDelimiter(cur, "]")) {
          depth = Math.max(0, depth - 1);
        }
        lastTok = cur;
        j++;
      }

      const rawDetail =
        j > bodyStartIdx
          ? doc.source
              .slice(tokens[bodyStartIdx].startOffset, lastTok.endOffset)
              .replace(/\s+/g, " ")
              .trim()
          : "";
      const detail =
        rawDetail.length > 80 ? `${rawDetail.slice(0, 77)}...` : rawDetail;

      const range = spanRange(tok, lastTok);
      const selectionRange = tokenRange(tok);
      items.push({
        offset: tok.startOffset,
        symbol: {
          kind,
          name: kind,
          detail,
          range: ensureContainedRange(range, selectionRange),
          selectionRange,
          children: [],
        },
      });
      i = j;
      continue;
    }
    i++;
  }

  return items;
}

/**
 * Builds hierarchical document outline symbols (`rule` -> `source`/`bind`/`let`/`when`
 * -> nested `alert`/`suppress`/`let`/`when`) in a linear O(N) pass.
 */
export function computeDocumentSymbols(doc: DocumentIndex): OutlineSymbol[] {
  const roots: OutlineSymbol[] = [];
  const blockNodes = new Map<number, OutlineSymbol>();

  const ruleSymbolsByStart = new Map<number, SymbolEntry>();
  const bindSymbolsByLineCol = new Map<string, SymbolEntry>();
  for (const sym of doc.symbols) {
    if (sym.kind === "rule") {
      ruleSymbolsByStart.set(sym.declarationRange.startLineNumber, sym);
    } else if (sym.kind === "bind") {
      bindSymbolsByLineCol.set(
        `${sym.declarationRange.startLineNumber}:${sym.declarationRange.startColumn}`,
        sym,
      );
    }
  }

  for (const block of doc.blocks) {
    let node: OutlineSymbol | null = null;

    if (block.kind === "rule") {
      const ruleSym = ruleSymbolsByStart.get(block.headerRange.startLineNumber);
      const sel = ruleSym?.nameRange ?? block.headerRange;
      node = {
        kind: "rule",
        name: block.name ?? "<rule>",
        detail:
          block.closeOffset === null || block.syntheticClosed
            ? "rule (unclosed)"
            : "rule",
        range: ensureContainedRange(block.fullRange, sel),
        selectionRange: sel,
        children: [],
      };
    } else if (block.kind === "when") {
      node = {
        kind: "when",
        name: block.conditionPreview ? `when ${block.conditionPreview}` : "when",
        detail: block.otherwiseOffset !== null ? "then / otherwise" : "then",
        range: ensureContainedRange(block.fullRange, block.headerRange),
        selectionRange: block.headerRange,
        children: [],
      };
    } else if (block.kind === "bind") {
      const bindSym = bindSymbolsByLineCol.get(
        `${block.headerRange.startLineNumber}:${block.headerRange.startColumn}`,
      );
      const sel = bindSym?.nameRange ?? block.headerRange;
      const detail = bindSym?.resolvedTarget
        ? `${bindSym.resolvedTarget.tableName}.${bindSym.resolvedTarget.columnName} (${bindSym.resolvedTarget.columnType})`
        : bindSym?.sourcePath ?? "unresolved";
      node = {
        kind: "bind",
        name: bindSym?.name ?? block.name ?? "<bind>",
        detail,
        range: ensureContainedRange(block.fullRange, sel),
        selectionRange: sel,
        children: [],
      };
    } else if (block.kind === "bind-site") {
      node = {
        kind: "bind",
        name: block.name ? `site: ${block.name}` : "bind site",
        detail: SYNTAX_ONLY_NOTE,
        range: ensureContainedRange(block.fullRange, block.headerRange),
        selectionRange: block.headerRange,
        children: [],
      };
    }

    if (!node) continue;
    blockNodes.set(block.index, node);

    const parent =
      block.parentIndex !== null ? blockNodes.get(block.parentIndex) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const leafItems: { offset: number; symbol: OutlineSymbol }[] = [];

  for (const sym of doc.symbols) {
    if (sym.kind !== "source" && sym.kind !== "let") continue;
    const startOffset =
      (doc.lineStarts[sym.declarationRange.startLineNumber - 1] ?? 0) +
      (sym.declarationRange.startColumn - 1);

    if (sym.kind === "source") {
      const detail = sym.syntaxOnly
        ? SYNTAX_ONLY_NOTE
        : sym.resolvedTarget
          ? `${sym.resolvedTarget.tableName}.${sym.resolvedTarget.columnName} (${sym.resolvedTarget.columnType})`
          : sym.sourcePath ?? "unresolved";
      leafItems.push({
        offset: startOffset,
        symbol: {
          kind: "source",
          name: sym.name,
          detail,
          range: ensureContainedRange(sym.declarationRange, sym.nameRange),
          selectionRange: sym.nameRange,
          children: [],
        },
      });
    } else {
      const detail = sym.initializerPreview
        ? `${sym.valueType} := ${sym.initializerPreview}`
        : sym.valueType;
      leafItems.push({
        offset: startOffset,
        symbol: {
          kind: "let",
          name: sym.name,
          detail,
          range: ensureContainedRange(sym.declarationRange, sym.nameRange),
          selectionRange: sym.nameRange,
          children: [],
        },
      });
    }
  }

  for (const action of extractActionOutlineItems(doc)) {
    leafItems.push(action);
  }

  leafItems.sort((a, b) => a.offset - b.offset);

  const activeStack: BlockNode[] = [];
  let bIdx = 0;

  const isOpenAt = (b: BlockNode, off: number): boolean => {
    if (off < b.openOffset) return false;
    if (b.closeOffset === null) return true;
    return b.syntheticClosed ? off <= b.closeOffset : off < b.closeOffset;
  };

  for (const item of leafItems) {
    while (
      activeStack.length > 0 &&
      !isOpenAt(activeStack[activeStack.length - 1], item.offset)
    ) {
      activeStack.pop();
    }
    while (
      bIdx < doc.blocks.length &&
      doc.blocks[bIdx].openOffset <= item.offset
    ) {
      const b = doc.blocks[bIdx++];
      if (
        (b.kind === "rule" || b.kind === "when" || b.kind === "bind-site") &&
        isOpenAt(b, item.offset)
      ) {
        activeStack.push(b);
      }
    }

    const parentBlock = activeStack[activeStack.length - 1];
    const parentNode = parentBlock ? blockNodes.get(parentBlock.index) : undefined;
    if (parentNode) {
      parentNode.children.push(item.symbol);
    } else {
      roots.push(item.symbol);
    }
  }

  sortOutlineTree(roots);
  return roots;
}
