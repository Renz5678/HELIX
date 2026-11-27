import {
  activeRuleAt,
  openBlocksAt,
  visibleSymbolsAt,
} from "./document-index";
import type { DatasetSchemaIndex } from "./schema";
import {
  ALL_STATEMENT_START_KEYWORDS,
  findEnclosingBindTable,
  findLastTokenIdxStartingBefore,
  findTokenAtPositionOffset,
  isDelimiter,
  isKeyword,
  isStrictlyInsideComment,
  positionFromLineStarts,
  spanRange,
  tokenRange,
} from "./token-utils";
import {
  HELIX_KEYWORD_SET,
  type BlockNode,
  type DocumentIndex,
  type LexToken,
  type TextRange,
} from "./types";

export interface MarkerInput {
  code?: string | { value: string };
  message: string;
  range: TextRange;
  severity?: number | string;
}

export interface QuickFixEdit {
  range: TextRange;
  text: string;
}

export interface QuickFixAction {
  title: string;
  kind: "quickfix";
  edit: QuickFixEdit;
  isPreferred?: boolean;
  diagnostics?: MarkerInput[];
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * Bounded Levenshtein edit distance with early exit when distance exceeds `maxDist`.
 */
export function levenshtein(a: string, b: string, maxDist = 3): number {
  if (a === b) return 0;
  const limit = Math.max(0, Math.floor(maxDist));
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > limit) return limit + 1;
  if (la === 0) return lb <= limit ? lb : limit + 1;
  if (lb === 0) return la <= limit ? la : limit + 1;

  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const ca = a.charCodeAt(i - 1);

    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const val = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
      curr[j] = val;
      if (val < rowMin) rowMin = val;
    }

    if (rowMin > limit) return limit + 1;
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[lb] <= limit ? prev[lb] : limit + 1;
}

interface ResolvedSpan {
  startOffset: number;
  endOffset: number;
  text: string;
}

function lineBoundsAt(
  source: string,
  lineStarts: readonly number[],
  lineIdx: number,
): { start: number; end: number } {
  const start = lineStarts[lineIdx] ?? source.length;
  const nextLineStart =
    lineIdx + 1 < lineStarts.length ? lineStarts[lineIdx + 1] : source.length;
  let end = nextLineStart;
  while (end > start) {
    const ch = source.charCodeAt(end - 1);
    if (ch === 10 || ch === 13) end--;
    else break;
  }
  return { start, end };
}

function lineIndentAt(
  source: string,
  lineStarts: readonly number[],
  lineNumber: number,
): string {
  const start = lineStarts[lineNumber - 1] ?? 0;
  let end = start;
  while (end < source.length) {
    const ch = source.charCodeAt(end);
    if (ch === 32 || ch === 9) end++;
    else break;
  }
  return source.slice(start, end);
}

function hasCodeBeforeOffsetOnLine(
  doc: DocumentIndex,
  lineNumber: number,
  offset: number,
): boolean {
  const lineStart = doc.lineStarts[lineNumber - 1] ?? 0;
  return doc.source.slice(lineStart, offset).trim().length > 0;
}

function resolveMarkerSpan(
  doc: DocumentIndex,
  range: TextRange,
): ResolvedSpan | null {
  if (
    !Number.isFinite(range.startLineNumber) ||
    !Number.isFinite(range.startColumn) ||
    !Number.isFinite(range.endLineNumber) ||
    !Number.isFinite(range.endColumn) ||
    range.startLineNumber < 1 ||
    range.startColumn < 1 ||
    range.endLineNumber < range.startLineNumber ||
    range.endLineNumber > doc.lineStarts.length
  ) {
    return null;
  }

  const startLine = lineBoundsAt(
    doc.source,
    doc.lineStarts,
    range.startLineNumber - 1,
  );
  const endLine = lineBoundsAt(
    doc.source,
    doc.lineStarts,
    range.endLineNumber - 1,
  );

  const startLineLen = startLine.end - startLine.start;
  const endLineLen = endLine.end - endLine.start;
  if (range.startColumn - 1 > startLineLen + 1) return null;
  if (range.endColumn - 1 > endLineLen + 2) return null;

  const startOffset = Math.min(
    startLine.end,
    startLine.start + (range.startColumn - 1),
  );
  const endOffset = Math.min(
    endLine.end,
    endLine.start + (range.endColumn - 1),
  );

  if (endOffset < startOffset) return null;
  return {
    startOffset,
    endOffset,
    text: doc.source.slice(startOffset, endOffset),
  };
}

function markerCodeString(code: MarkerInput["code"]): string {
  if (typeof code === "string") return code;
  if (code && typeof code === "object" && typeof code.value === "string") {
    return code.value;
  }
  return "";
}

function isWholeWordSpan(
  source: string,
  startOffset: number,
  endOffset: number,
): boolean {
  const before = startOffset > 0 ? source[startOffset - 1] : "";
  const after = endOffset < source.length ? source[endOffset] : "";
  return !/[A-Za-z0-9_.]/.test(before) && !/[A-Za-z0-9_.]/.test(after);
}

function extractTargetPathFromSpan(
  doc: DocumentIndex,
  span: ResolvedSpan,
  code: string,
  range: TextRange,
): {
  token: string;
  range: TextRange;
  startOffset: number;
  endOffset: number;
} | null {
  if (
    PATH_RE.test(span.text) &&
    isWholeWordSpan(doc.source, span.startOffset, span.endOffset)
  ) {
    return {
      token: span.text,
      range,
      startOffset: span.startOffset,
      endOffset: span.endOffset,
    };
  }

  const sub = doc.tokens.filter(
    (t) =>
      t.kind !== "eof" &&
      t.startOffset >= span.startOffset &&
      t.endOffset <= span.endOffset,
  );

  if (code === "SOURCE_NOT_FOUND" && isKeyword(sub[0], "source")) {
    let idx = 1;
    if (isDelimiter(sub[idx], ":")) idx++;
    const nameTok = sub[idx];
    if (nameTok && nameTok.kind === "identifier") {
      return {
        token: nameTok.lexeme,
        range: tokenRange(nameTok),
        startOffset: nameTok.startOffset,
        endOffset: nameTok.endOffset,
      };
    }
  }

  if (code === "BINDING_NOT_FOUND" && isKeyword(sub[0], "bind")) {
    let idx = 1;
    if (sub[idx]?.kind === "identifier") idx++;
    if (
      sub[idx] &&
      ((sub[idx].kind === "operator" &&
        (sub[idx].lexeme === "=" ||
          sub[idx].lexeme === ":=" ||
          sub[idx].lexeme === "->")) ||
        isDelimiter(sub[idx], ":"))
    ) {
      idx++;
    }
    const pathTokens: LexToken[] = [];
    for (let k = idx; k < sub.length; k++) {
      const t = sub[k];
      if (
        isKeyword(t, "where") ||
        isKeyword(t, "within") ||
        isKeyword(t, "end")
      ) {
        break;
      }
      if (t.kind === "identifier" || isDelimiter(t, ".")) {
        pathTokens.push(t);
      } else {
        break;
      }
    }
    if (pathTokens.length > 0) {
      const first = pathTokens[0];
      const last = pathTokens[pathTokens.length - 1];
      const text = doc.source.slice(first.startOffset, last.endOffset);
      if (PATH_RE.test(text)) {
        return {
          token: text,
          range: spanRange(first, last),
          startOffset: first.startOffset,
          endOffset: last.endOffset,
        };
      }
    }
  }

  return null;
}

function rankTypoCandidates(
  token: string,
  candidates: Iterable<string>,
  maxDist = 3,
): string[] {
  const tokenLower = token.toLowerCase();
  const scored: { candidate: string; score: number }[] = [];
  const seen = new Set<string>();

  for (const cand of candidates) {
    if (!cand || cand === token || seen.has(cand)) continue;
    seen.add(cand);
    const exactDist = levenshtein(token, cand, maxDist);
    if (exactDist <= maxDist) {
      scored.push({ candidate: cand, score: exactDist });
      continue;
    }
    const lowerDist = levenshtein(tokenLower, cand.toLowerCase(), maxDist);
    if (lowerDist <= maxDist) {
      scored.push({ candidate: cand, score: lowerDist + 0.5 });
    }
  }

  scored.sort((a, b) =>
    a.score !== b.score
      ? a.score - b.score
      : a.candidate.localeCompare(b.candidate),
  );
  return scored.slice(0, 3).map((s) => s.candidate);
}

function findUnclosedBlockForEnd(
  doc: DocumentIndex,
  expectedKind: "rule" | "when" | "bind",
  beforeOrAtOffset: number,
  atEof: boolean,
): BlockNode | null {
  const matchesKind = (b: BlockNode): boolean =>
    b.kind === expectedKind ||
    (expectedKind === "bind" && b.kind === "bind-site");

  for (let i = doc.blocks.length - 1; i >= 0; i--) {
    const b = doc.blocks[i];
    if (!matchesKind(b)) continue;
    if (b.openOffset > beforeOrAtOffset) continue;
    if (b.closeOffset === null) return b;
    if (!atEof && b.syntheticClosed) {
      const nextIdx = findLastTokenIdxStartingBefore(
        doc.tokens,
        beforeOrAtOffset,
      );
      const prevTokenBeforeMarker =
        nextIdx >= 0 ? doc.tokens[nextIdx] : undefined;
      if (
        !prevTokenBeforeMarker ||
        prevTokenBeforeMarker.endOffset <= b.closeOffset
      ) {
        return b;
      }
    }
  }
  return null;
}

function findEnclosingStatementStartOnLine(
  doc: DocumentIndex,
  offset: number,
  lineNumber: number,
): LexToken | null {
  const idx = findLastTokenIdxStartingBefore(doc.tokens, offset);
  let depth = 0;
  for (let i = idx; i >= 0; i--) {
    const t = doc.tokens[i];
    if (t.line < lineNumber) break;
    if (isDelimiter(t, ")") || isDelimiter(t, "]")) {
      depth++;
      continue;
    }
    if (isDelimiter(t, "(") || isDelimiter(t, "[")) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;
    if (
      t.kind === "keyword" &&
      ALL_STATEMENT_START_KEYWORDS.has(t.lexeme) &&
      t.lexeme !== "rule" &&
      t.lexeme !== "then" &&
      t.lexeme !== "otherwise"
    ) {
      const prev = i > 0 ? doc.tokens[i - 1] : undefined;
      if (isDelimiter(prev, ".")) continue;
      return t;
    }
  }
  return null;
}

function emitTypoReplacements(
  matches: readonly string[],
  range: TextRange,
  marker: MarkerInput,
  pushAction: (action: QuickFixAction) => void,
): void {
  for (let i = 0; i < matches.length; i++) {
    pushAction({
      title: `Replace with '${matches[i]}'`,
      kind: "quickfix",
      isPreferred: i === 0,
      diagnostics: [marker],
      edit: { range, text: matches[i] },
    });
  }
}

/**
 * Generates validated Quick Fixes across all 5 diagnostic categories,
 * rejecting any stale or shifted markers whose source text no longer matches.
 */
export function computeQuickFixes(
  doc: DocumentIndex,
  schema: DatasetSchemaIndex,
  markers: readonly MarkerInput[],
): QuickFixAction[] {
  const actions: QuickFixAction[] = [];
  const dedupeKeys = new Set<string>();

  const pushAction = (action: QuickFixAction) => {
    const r = action.edit.range;
    const key = `${action.title}\0${r.startLineNumber}:${r.startColumn}-${r.endLineNumber}:${r.endColumn}\0${action.edit.text}`;
    if (dedupeKeys.has(key)) return;
    dedupeKeys.add(key);
    actions.push(action);
  };

  for (const marker of markers) {
    const span = resolveMarkerSpan(doc, marker.range);
    if (!span) continue;

    const code = markerCodeString(marker.code);
    const msg = marker.message ?? "";

    // 1a. Missing block descriptor after 'end'
    const missingDescMatch =
      /Missing block descriptor after 'end': expected 'end (rule|when|bind)'/.exec(
        msg,
      );
    if (missingDescMatch) {
      if (isStrictlyInsideComment(doc.comments, span.startOffset)) continue;
      const expected = missingDescMatch[1];
      const tokHit = findTokenAtPositionOffset(doc.tokens, span.startOffset);
      const endTok =
        tokHit && isKeyword(tokHit.token, "end") ? tokHit.token : undefined;
      if (!endTok) continue;

      const nextTok = doc.tokens[tokHit!.index + 1];
      if (
        nextTok &&
        nextTok.line === endTok.line &&
        nextTok.kind === "keyword" &&
        (nextTok.lexeme === "rule" ||
          nextTok.lexeme === "when" ||
          nextTok.lexeme === "bind")
      ) {
        continue;
      }

      pushAction({
        title: `Complete block terminator 'end ${expected}'`,
        kind: "quickfix",
        isPreferred: true,
        diagnostics: [marker],
        edit: {
          range: {
            startLineNumber: endTok.endLine,
            startColumn: endTok.endColumn,
            endLineNumber: endTok.endLine,
            endColumn: endTok.endColumn,
          },
          text: ` ${expected}`,
        },
      });
      continue;
    }

    // 1b. Missing block terminator: Expected 'end (rule|when|bind)'
    const expectedEndMatch =
      /Expected 'end (rule|when|bind)' to terminate \w+ block(?:\.\s*Got '([^']+)')?/.exec(
        msg,
      );
    if (expectedEndMatch) {
      const expected = expectedEndMatch[1] as "rule" | "when" | "bind";
      const got = expectedEndMatch[2];
      const isEof = got === "end of file";

      if (isEof) {
        if (doc.source.slice(span.endOffset).trim() !== "") continue;
        const openBlock = findUnclosedBlockForEnd(
          doc,
          expected,
          span.startOffset,
          true,
        );
        if (!openBlock) continue;

        const indent = lineIndentAt(
          doc.source,
          doc.lineStarts,
          openBlock.headerRange.startLineNumber,
        );
        const eofPos = positionFromLineStarts(
          doc.lineStarts,
          doc.source.length,
          doc.source.length,
        );
        const insertText =
          doc.source.length === 0 ||
          doc.source.endsWith("\n") ||
          doc.source.endsWith("\r")
            ? `${indent}end ${expected}\n`
            : `\n${indent}end ${expected}`;

        pushAction({
          title: `Insert 'end ${expected}'`,
          kind: "quickfix",
          isPreferred: true,
          diagnostics: [marker],
          edit: {
            range: {
              startLineNumber: eofPos.lineNumber,
              startColumn: eofPos.column,
              endLineNumber: eofPos.lineNumber,
              endColumn: eofPos.column,
            },
            text: insertText,
          },
        });
      } else {
        if (isStrictlyInsideComment(doc.comments, span.startOffset)) continue;
        if (got && !doc.source.slice(span.startOffset).startsWith(got)) {
          continue;
        }
        const openBlock = findUnclosedBlockForEnd(
          doc,
          expected,
          span.startOffset,
          false,
        );
        if (!openBlock) continue;

        const targetLine = marker.range.startLineNumber;
        const inlineRule = hasCodeBeforeOffsetOnLine(
          doc,
          targetLine,
          span.startOffset,
        );
        const blockIndent = lineIndentAt(
          doc.source,
          doc.lineStarts,
          openBlock.headerRange.startLineNumber,
        );
        pushAction({
          title: `Insert 'end ${expected}'`,
          kind: "quickfix",
          isPreferred: true,
          diagnostics: [marker],
          edit: {
            range: {
              startLineNumber: targetLine,
              startColumn: inlineRule ? marker.range.startColumn : 1,
              endLineNumber: targetLine,
              endColumn: inlineRule ? marker.range.startColumn : 1,
            },
            text: inlineRule
              ? `end ${expected} `
              : `${blockIndent}end ${expected}\n`,
          },
        });
      }
      continue;
    }

    // 2. Mismatched (or unknown) block terminator
    const mismatchMatch =
      /(?:Mismatched block terminator 'end (\w+)'|Unknown block descriptor '(\w+)' after 'end'): expected 'end (rule|when|bind)'/.exec(
        msg,
      );
    if (mismatchMatch) {
      if (isStrictlyInsideComment(doc.comments, span.startOffset)) continue;
      const wrong = mismatchMatch[1] ?? mismatchMatch[2];
      const expected = mismatchMatch[3];
      if (!wrong || span.text !== wrong) continue;

      const tokHit = findTokenAtPositionOffset(doc.tokens, span.startOffset);
      if (!tokHit || tokHit.index === 0) continue;
      const prevTok = doc.tokens[tokHit.index - 1];
      if (!isKeyword(prevTok, "end") || prevTok.line !== tokHit.token.line) {
        continue;
      }

      const enclosing = openBlocksAt(doc, prevTok.startOffset);
      const innerExpected = findUnclosedBlockForEnd(
        doc,
        expected as "rule" | "when" | "bind",
        prevTok.startOffset,
        false,
      );
      const hasOuterMatchingWrong = enclosing.some(
        (b) =>
          b !== innerExpected &&
          (b.kind === wrong || (wrong === "bind" && b.kind === "bind-site")),
      );

      if (hasOuterMatchingWrong && innerExpected) {
        const inlineRule = hasCodeBeforeOffsetOnLine(
          doc,
          prevTok.line,
          prevTok.startOffset,
        );
        const blockIndent = lineIndentAt(
          doc.source,
          doc.lineStarts,
          innerExpected.headerRange.startLineNumber,
        );
        pushAction({
          title: `Insert 'end ${expected}' before 'end ${wrong}'`,
          kind: "quickfix",
          isPreferred: true,
          diagnostics: [marker],
          edit: {
            range: {
              startLineNumber: prevTok.line,
              startColumn: inlineRule ? prevTok.column : 1,
              endLineNumber: prevTok.line,
              endColumn: inlineRule ? prevTok.column : 1,
            },
            text: inlineRule
              ? `end ${expected} `
              : `${blockIndent}end ${expected}\n`,
          },
        });
      }

      pushAction({
        title: `Replace 'end ${wrong}' with 'end ${expected}'`,
        kind: "quickfix",
        isPreferred: !hasOuterMatchingWrong || !innerExpected,
        diagnostics: [marker],
        edit: {
          range: marker.range,
          text: expected,
        },
      });
      continue;
    }

    if (isStrictlyInsideComment(doc.comments, span.startOffset)) continue;
    const tokAtSpan = findTokenAtPositionOffset(doc.tokens, span.startOffset);
    if (
      tokAtSpan &&
      (tokAtSpan.token.kind === "string" ||
        tokAtSpan.token.kind === "unterminated_string")
    ) {
      continue;
    }

    // 3. Unknown source / binding
    if (
      code === "SOURCE_NOT_FOUND" ||
      code === "BINDING_NOT_FOUND" ||
      /source table is not mapped|binding must resolve/i.test(msg)
    ) {
      const target = extractTargetPathFromSpan(doc, span, code, marker.range);
      if (!target || HELIX_KEYWORD_SET.has(target.token)) continue;
      if (schema.resolvePath(target.token)) continue;

      const isBindingDiag =
        code === "BINDING_NOT_FOUND" || /binding/i.test(msg);
      // C11 `source` only parses a single IDENTIFIER (no dots); dotted bindings apply only to `bind`.
      const pool: string[] = [...schema.tableNames];
      for (const key of schema.bindings.keys()) {
        if (isBindingDiag || !key.includes(".")) {
          pool.push(key);
        }
      }
      if (isBindingDiag) {
        for (const tableName of schema.tableNames) {
          const table = schema.tablesByName.get(tableName);
          for (const col of table?.columns ?? []) {
            pool.push(`${tableName}.${col.name}`);
          }
        }
      }

      emitTypoReplacements(
        rankTypoCandidates(target.token, pool, 3),
        target.range,
        marker,
        pushAction,
      );
      continue;
    }

    // 4 & 5. Unknown identifier / series used without .latest
    const isIdentifierDiag =
      code === "UNKNOWN_IDENTIFIER" ||
      code === "UNSUPPORTED_EXPRESSION" ||
      /unknown identifier|series used without \.latest|followed by \.latest/i.test(
        msg,
      );
    if (!isIdentifierDiag) continue;

    let targetText = span.text;
    let targetRange = marker.range;
    let targetStart = span.startOffset;
    let targetEnd = span.endOffset;

    if (
      targetEnd - targetStart <= 1 &&
      tokAtSpan &&
      tokAtSpan.token.kind === "identifier" &&
      tokAtSpan.token.startOffset === targetStart
    ) {
      targetText = tokAtSpan.token.lexeme;
      targetRange = tokenRange(tokAtSpan.token);
      targetStart = tokAtSpan.token.startOffset;
      targetEnd = tokAtSpan.token.endOffset;
    }

    if (
      !IDENTIFIER_RE.test(targetText) ||
      HELIX_KEYWORD_SET.has(targetText) ||
      !isWholeWordSpan(doc.source, targetStart, targetEnd)
    ) {
      continue;
    }

    const ident = targetText;
    const visible = visibleSymbolsAt(doc, targetStart);
    const visibleSeries = visible.find(
      (s) =>
        s.name === ident &&
        (s.kind === "bind" || s.kind === "source") &&
        !s.syntaxOnly,
    );

    // 4. Series used without .latest
    if (visibleSeries) {
      const trailing = doc.source.slice(targetEnd);
      if (/^\s*\.\s*latest\b/.test(trailing)) continue;

      pushAction({
        title: `Add '.latest' to '${ident}'`,
        kind: "quickfix",
        isPreferred: true,
        diagnostics: [marker],
        edit: {
          range: {
            startLineNumber: targetRange.endLineNumber,
            startColumn: targetRange.endColumn,
            endLineNumber: targetRange.endLineNumber,
            endColumn: targetRange.endColumn,
          },
          text: ".latest",
        },
      });
      continue;
    }

    if (visible.some((s) => s.name === ident)) {
      continue;
    }

    const enclosingBlocks = openBlocksAt(doc, targetStart);
    const enclosingBind = [...enclosingBlocks]
      .reverse()
      .find((b) => b.kind === "bind" || b.kind === "bind-site");

    // Check if inside `bind ... where <col>` (column typo)
    const bindTable = findEnclosingBindTable(
      doc,
      positionFromLineStarts(doc.lineStarts, doc.source.length, targetStart),
      targetStart,
    );
    if (enclosingBind && bindTable) {
      if (bindTable.columns?.some((c) => c.name === ident)) continue;
      const colNames = (bindTable.columns ?? []).map((c) => c.name);
      emitTypoReplacements(
        rankTypoCandidates(ident, colNames, 3),
        targetRange,
        marker,
        pushAction,
      );
      continue;
    }

    // 3b. Fuzzy typo replacement against visible symbols
    const typoMatches = rankTypoCandidates(
      ident,
      visible.filter((s) => s.kind !== "rule").map((s) => s.name),
      3,
    );
    emitTypoReplacements(typoMatches, targetRange, marker, pushAction);

    // 5. Declare `let <ident> := 0` above enclosing `when` (or rule statement)
    const enclosingRule = activeRuleAt(doc, targetStart);
    if (enclosingRule && !enclosingBind) {
      const enclosingWhen = [...enclosingBlocks]
        .reverse()
        .find((b) => b.kind === "when");
      const stmtTok = enclosingWhen
        ? null
        : findEnclosingStatementStartOnLine(
            doc,
            targetStart,
            targetRange.startLineNumber,
          );
      const insertLine = enclosingWhen
        ? enclosingWhen.headerRange.startLineNumber
        : stmtTok
          ? stmtTok.line
          : targetRange.startLineNumber;
      const anchorCol = enclosingWhen
        ? enclosingWhen.headerRange.startColumn
        : stmtTok
          ? stmtTok.column
          : targetRange.startColumn;
      const anchorOffset = enclosingWhen
        ? enclosingWhen.openOffset
        : stmtTok
          ? stmtTok.startOffset
          : targetStart;
      const inlineRule = hasCodeBeforeOffsetOnLine(
        doc,
        insertLine,
        anchorOffset,
      );
      const indent = lineIndentAt(doc.source, doc.lineStarts, insertLine);

      pushAction({
        title: `Declare 'let ${ident} := 0'`,
        kind: "quickfix",
        isPreferred: typoMatches.length === 0,
        diagnostics: [marker],
        edit: {
          range: {
            startLineNumber: insertLine,
            startColumn: inlineRule ? anchorCol : 1,
            endLineNumber: insertLine,
            endColumn: inlineRule ? anchorCol : 1,
          },
          text: inlineRule
            ? `let ${ident} := 0 `
            : `${indent}let ${ident} := 0\n`,
        },
      });
    }
  }

  return actions;
}
