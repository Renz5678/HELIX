import type { CursorContext } from "./context";
import { visibleSymbolsAt } from "./document-index";
import { extractStems } from "./ranking";
import { columnTypeToValueType, type DatasetSchemaIndex } from "./schema";
import {
  findFirstTokenIndexAtOrAfter,
  findLastTokenIndexEndingAtOrBefore,
  findUniqueNumericLetForSeries,
  isComparisonOperatorInCurrentClause,
  SHORT_MINUTE_PRESETS,
  zeroWidthRange,
} from "./token-utils";
import type {
  BlockNode,
  DocumentIndex,
  LexToken,
  SymbolEntry,
  TextPosition,
  TextRange,
} from "./types";

export interface InlinePrediction {
  insertText: string;
  range: TextRange;
}

function findLineEnd(source: string, start: number): number {
  let i = start;
  while (i < source.length) {
    const code = source.charCodeAt(i);
    if (code === 10 || code === 13) break;
    i++;
  }
  return i;
}

function getCursorLineState(
  doc: DocumentIndex,
  position: TextPosition,
): {
  lineIdx: number;
  lineStart: number;
  offset: number;
  normPos: TextPosition;
  beforeCursor: string;
  afterCursor: string;
} {
  const lineStarts = doc.lineStarts;
  const lineCount = Math.max(1, lineStarts.length);
  const rawLine = Number.isFinite(position.lineNumber)
    ? Math.max(1, Math.floor(position.lineNumber))
    : 1;
  const rawCol = Number.isFinite(position.column)
    ? Math.max(1, Math.floor(position.column))
    : 1;

  let lineIdx: number;
  let lineStart: number;
  let lineEnd: number;
  let offset: number;

  if (rawLine > lineCount) {
    lineIdx = lineCount - 1;
    lineStart = lineStarts[lineIdx] ?? 0;
    lineEnd = findLineEnd(doc.source, lineStart);
    offset = doc.source.length;
  } else {
    lineIdx = rawLine - 1;
    lineStart = lineStarts[lineIdx] ?? 0;
    lineEnd = findLineEnd(doc.source, lineStart);
    offset = Math.min(lineStart + (rawCol - 1), lineEnd);
  }

  return {
    lineIdx,
    lineStart,
    offset,
    normPos: {
      lineNumber: lineIdx + 1,
      column: offset - lineStart + 1,
    },
    beforeCursor: doc.source.slice(lineStart, offset),
    afterCursor: doc.source.slice(offset, lineEnd),
  };
}

function makePrediction(
  pos: TextPosition,
  insertText: string,
): InlinePrediction | null {
  if (!insertText) return null;
  return {
    insertText,
    range: zeroWidthRange(pos),
  };
}

function predictSuffix(
  pos: TextPosition,
  candidate: string,
  prefix: string,
): InlinePrediction | null {
  if (!prefix) return makePrediction(pos, candidate);
  if (!candidate.startsWith(prefix) || candidate.length <= prefix.length) {
    return null;
  }
  return makePrediction(pos, candidate.slice(prefix.length));
}

function findNextNonEmptyLineTrimmed(
  doc: DocumentIndex,
  lineIdx: number,
): string {
  for (let l = lineIdx + 1; l < doc.lineStarts.length; l++) {
    const start = doc.lineStarts[l];
    const end = findLineEnd(doc.source, start);
    const trimmed = doc.source.slice(start, end).trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

function hasTokensInRange(
  tokens: readonly LexToken[],
  startOffset: number,
  endOffset: number,
): boolean {
  if (endOffset <= startOffset) return false;
  const idx = findFirstTokenIndexAtOrAfter(tokens, startOffset);
  if (idx >= tokens.length) return false;
  const tok = tokens[idx];
  return tok.kind !== "eof" && tok.endOffset <= endOffset;
}

function hasUnclosedGroupingInRange(
  tokens: readonly LexToken[],
  startOffset: number,
  endOffset: number,
): boolean {
  let depth = 0;
  let idx = findFirstTokenIndexAtOrAfter(tokens, startOffset);
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok.kind === "eof" || tok.endOffset > endOffset) break;
    if (tok.kind === "delimiter") {
      if (tok.lexeme === "(" || tok.lexeme === "[") depth++;
      else if (tok.lexeme === ")" || tok.lexeme === "]") {
        depth = Math.max(0, depth - 1);
      }
    }
    idx++;
  }
  return depth > 0;
}

function isInWhenConditionClause(
  doc: DocumentIndex,
  limitOffset: number,
  ctx: CursorContext,
): boolean {
  if (ctx.inWhen && !ctx.hasThen) return true;
  if (ctx.inBind) return false;

  // Recover `when <series>.<partial>` where document-index treated it as `when Event.name`.
  let idx = findLastTokenIndexEndingAtOrBefore(doc.tokens, limitOffset);
  if (
    idx < 0 ||
    doc.tokens[idx].kind !== "delimiter" ||
    doc.tokens[idx].lexeme !== "."
  ) {
    return false;
  }
  idx--;
  while (idx >= 0) {
    const t = doc.tokens[idx];
    if (
      t.kind !== "identifier" &&
      !(t.kind === "keyword" && t.lexeme === "latest")
    ) {
      break;
    }
    if (
      idx >= 1 &&
      doc.tokens[idx - 1].kind === "delimiter" &&
      doc.tokens[idx - 1].lexeme === "."
    ) {
      idx -= 2;
      continue;
    }
    const prev = idx >= 1 ? doc.tokens[idx - 1] : undefined;
    const beforePrev = idx >= 2 ? doc.tokens[idx - 2] : undefined;
    return Boolean(
      prev &&
        prev.kind === "keyword" &&
        prev.lexeme === "when" &&
        !(
          beforePrev &&
          beforePrev.kind === "keyword" &&
          beforePrev.lexeme === "end"
        ),
    );
  }
  return false;
}

function matchesAliasCandidate(
  candidate: string,
  aliasLower: string,
  aliasStems: readonly string[],
  suffixOnlyForDotted: boolean,
): boolean {
  const dotIdx = candidate.lastIndexOf(".");
  const suffix = dotIdx !== -1 ? candidate.slice(dotIdx + 1) : candidate;
  if (
    candidate.toLowerCase() === aliasLower ||
    suffix.toLowerCase() === aliasLower
  ) {
    return true;
  }

  const targetText =
    suffixOnlyForDotted && dotIdx !== -1 ? suffix : candidate;
  const targetStems = extractStems(targetText);
  if (aliasStems.length === 0 || targetStems.length === 0) return false;

  for (const a of aliasStems) {
    if (targetStems.includes(a)) return true;
    if (a.length >= 3 && targetStems.some((stem) => stem.startsWith(a))) {
      return true;
    }
    if (a.length >= 2) {
      for (let start = 0; start < targetStems.length; start++) {
        let initials = "";
        for (let end = start; end < targetStems.length; end++) {
          initials += targetStems[end][0];
          if (initials === a) return true;
        }
        if (
          start + 1 < targetStems.length &&
          targetStems[start][0] + targetStems[start + 1] === a
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function findUniqueBindPathMatch(
  schema: DatasetSchemaIndex,
  bindAlias: string,
): string | null {
  const aliasLower = bindAlias.toLowerCase();
  const aliasStems = extractStems(bindAlias);
  const bindingKeys = Array.from(schema.bindings.keys());

  const suffixBindingMatches = bindingKeys.filter((k) =>
    matchesAliasCandidate(k, aliasLower, aliasStems, true),
  );
  if (suffixBindingMatches.length === 1) return suffixBindingMatches[0];
  if (suffixBindingMatches.length > 1) return null;

  const tableMatches = schema.tableNames.filter((t) =>
    matchesAliasCandidate(t, aliasLower, aliasStems, false),
  );
  if (tableMatches.length === 1) return tableMatches[0];
  if (tableMatches.length > 1) return null;

  const fullBindingMatches = bindingKeys.filter((k) =>
    matchesAliasCandidate(k, aliasLower, aliasStems, false),
  );
  return fullBindingMatches.length === 1 ? fullBindingMatches[0] : null;
}

function getAfterBranchHeaderOffset(
  tokens: readonly LexToken[],
  branchKeywordOffset: number,
): number {
  const idx = findFirstTokenIndexAtOrAfter(tokens, branchKeywordOffset);
  if (idx >= tokens.length) return branchKeywordOffset;
  let endOff = tokens[idx].endOffset;
  const next = tokens[idx + 1];
  if (next && next.kind === "delimiter" && next.lexeme === ":") {
    endOff = next.endOffset;
  }
  return endOff;
}

function isBlockUnclosed(block: BlockNode): boolean {
  return block.closeOffset === null || Boolean(block.syntheticClosed);
}

/**
 * Computes deterministic single- or multi-token inline ghost-text predictions
 * for the cursor slot without interfering with mid-line edits, comments,
 * string literals, or already-present block closers.
 */
export function computeInlinePrediction(
  doc: DocumentIndex,
  schema: DatasetSchemaIndex,
  ctx: CursorContext,
  position: TextPosition,
  enabled: boolean,
): InlinePrediction | null {
  if (!enabled) return null;
  if (ctx.kind === "comment" || ctx.kind === "string-literal") return null;

  const { lineIdx, lineStart, offset, normPos, beforeCursor, afterCursor } =
    getCursorLineState(doc, position);
  if (/\S/.test(afterCursor)) return null;

  const prefixStartOffset = offset - ctx.prefix.length;

  // 1. end-block with expectedBlockEnd
  if (ctx.kind === "end-block") {
    if (!ctx.expectedBlockEnd) return null;
    return predictSuffix(normPos, ctx.expectedBlockEnd, ctx.prefix);
  }

  // 2. member-access on a bound/source series
  if (ctx.kind === "member-access") {
    if (ctx.inBind) return null;
    const chain =
      ctx.memberChain ??
      (ctx.memberOwner ? ctx.memberOwner.split(".") : []);
    if (chain[chain.length - 1] === "latest") return null;
    const visible = visibleSymbolsAt(doc, offset);
    const headName = chain[0] ?? ctx.memberOwner ?? "";
    const ownerSym = visible.find(
      (s) =>
        s.name === headName && (s.kind === "bind" || s.kind === "source"),
    );
    if (!ownerSym || ownerSym.syntaxOnly) {
      return null;
    }

    let candidate = "latest";
    if (chain.length <= 1) {
      const targetType = ownerSym.resolvedTarget
        ? columnTypeToValueType(ownerSym.resolvedTarget.columnType)
        : "Unknown";
      if (
        isInWhenConditionClause(doc, prefixStartOffset, ctx) &&
        (targetType === "Number" || targetType === "Unknown") &&
        !isComparisonOperatorInCurrentClause(
          doc,
          prefixStartOffset,
          ctx.openBlocks,
        )
      ) {
        const matchedLet = findUniqueNumericLetForSeries(visible, ownerSym);
        if (matchedLet) {
          candidate = `latest > ${matchedLet.name}`;
        }
      }
    }

    return predictSuffix(normPos, candidate, ctx.prefix);
  }

  // 3. bind-rhs with bindAlias
  if (ctx.kind === "bind-rhs") {
    if (!ctx.bindAlias) return null;
    const prevIdx = findLastTokenIndexEndingAtOrBefore(
      doc.tokens,
      prefixStartOffset,
    );
    const prevTok = prevIdx >= 0 ? doc.tokens[prevIdx] : undefined;
    const hasBindOp =
      prevTok !== undefined &&
      ((prevTok.kind === "operator" &&
        (prevTok.lexeme === "=" ||
          prevTok.lexeme === ":=" ||
          prevTok.lexeme === "->")) ||
        (prevTok.kind === "delimiter" && prevTok.lexeme === ":"));
    if (!hasBindOp) return null;

    const match = findUniqueBindPathMatch(schema, ctx.bindAlias);
    return match ? predictSuffix(normPos, match, ctx.prefix) : null;
  }

  // 4. where-value (outside quotes)
  if (ctx.kind === "where-value") {
    if (!ctx.resolvedTableName || !ctx.resolvedColumnName) return null;
    const prevIdx = findLastTokenIndexEndingAtOrBefore(
      doc.tokens,
      prefixStartOffset,
    );
    if (
      prevIdx >= 1 &&
      doc.tokens[prevIdx].kind === "delimiter" &&
      doc.tokens[prevIdx].lexeme === "." &&
      doc.tokens[prevIdx - 1].kind === "int"
    ) {
      return null;
    }

    const samples = schema.getColumnSamples(
      ctx.resolvedTableName,
      ctx.resolvedColumnName,
    );
    const first = samples.values[0];
    if (first === undefined || first === null) return null;

    const col = schema.tablesByName
      .get(ctx.resolvedTableName)
      ?.columns?.find((c) => c.name === ctx.resolvedColumnName);
    if (col?.type === "Boolean" || typeof first === "boolean") return null;
    const literal =
      col?.type === "String" || typeof first === "string"
        ? JSON.stringify(String(first))
        : String(first);
    return predictSuffix(normPos, literal, ctx.prefix);
  }

  // 5. within-unit
  if (ctx.kind === "within-unit") {
    const unit =
      ctx.withinNumber !== undefined && SHORT_MINUTE_PRESETS.has(ctx.withinNumber)
        ? "minutes"
        : "hours";
    return predictSuffix(normPos, unit, ctx.prefix);
  }

  // 6. alert-arg at alertArgIndex === 1
  if (ctx.kind === "alert-arg" && ctx.alertArgIndex === 1) {
    const prevIdx = findLastTokenIndexEndingAtOrBefore(
      doc.tokens,
      prefixStartOffset,
    );
    const prevTok = prevIdx >= 0 ? doc.tokens[prevIdx] : undefined;
    if (!prevTok || prevTok.kind !== "delimiter" || prevTok.lexeme !== ",") {
      return null;
    }
    return predictSuffix(normPos, '"WARNING"', ctx.prefix);
  }

  // 7. suppress-operand
  if (ctx.kind === "suppress-operand") {
    return predictSuffix(normPos, "within 4 hours", ctx.prefix);
  }

  const innerBlock = ctx.openBlocks[ctx.openBlocks.length - 1];
  const isBlankIndentedLine = /^[ \t]+$/.test(beforeCursor);

  // 8. Blank indented line inside unclosed `when` without `then:`
  if (
    isBlankIndentedLine &&
    ctx.kind === "when-condition-after-operand" &&
    innerBlock?.kind === "when" &&
    isBlockUnclosed(innerBlock) &&
    innerBlock.thenOffset === null &&
    innerBlock.otherwiseOffset === null &&
    !ctx.hasThen &&
    !ctx.hasOtherwise &&
    Boolean(innerBlock.conditionPreview) &&
    !hasUnclosedGroupingInRange(doc.tokens, innerBlock.openOffset, offset)
  ) {
    const nextLineTrimmed = findNextNonEmptyLineTrimmed(doc, lineIdx);
    if (
      !/^(?:then|otherwise)\b/.test(nextLineTrimmed) &&
      !/^end\s+when\b/.test(nextLineTrimmed)
    ) {
      const enclosingRule = [...ctx.openBlocks]
        .reverse()
        .find((b) => b.kind === "rule");
      const ruleName = enclosingRule?.name || "Alert";
      const indent = beforeCursor;
      return makePrediction(
        normPos,
        `then:\n${indent}    alert: "${ruleName} triggered", "WARNING"\n${indent}end when`,
      );
    }
  }

  // 9. Blank indented line inside unclosed `bind` (after RHS path)
  if (
    isBlankIndentedLine &&
    innerBlock?.kind === "bind" &&
    (ctx.kind === "bind-clause" || ctx.kind === "within-post") &&
    isBlockUnclosed(innerBlock) &&
    !hasUnclosedGroupingInRange(doc.tokens, innerBlock.openOffset, offset)
  ) {
    const nextLineTrimmed = findNextNonEmptyLineTrimmed(doc, lineIdx);
    if (!/^(?:end\s+bind|where|within)\b/.test(nextLineTrimmed)) {
      return makePrediction(normPos, "end bind");
    }
  }

  // 10. Indented `en` / `end` prefix inside unclosed `when` branch after >= 1 statement
  if (
    ctx.kind === "branch-body" &&
    (ctx.prefix === "en" || ctx.prefix === "end") &&
    innerBlock?.kind === "when" &&
    isBlockUnclosed(innerBlock)
  ) {
    const beforePrefix = doc.source.slice(lineStart, prefixStartOffset);
    if (/^[ \t]+$/.test(beforePrefix)) {
      const nextLineTrimmed = findNextNonEmptyLineTrimmed(doc, lineIdx);
      if (!/^end\s+when\b/.test(nextLineTrimmed)) {
        const branchKwOffset =
          innerBlock.otherwiseOffset !== null &&
          prefixStartOffset > innerBlock.otherwiseOffset
            ? innerBlock.otherwiseOffset
            : innerBlock.thenOffset;
        if (branchKwOffset !== null) {
          const afterBranchHeader = getAfterBranchHeaderOffset(
            doc.tokens,
            branchKwOffset,
          );
          if (hasTokensInRange(doc.tokens, afterBranchHeader, prefixStartOffset)) {
            return predictSuffix(normPos, "end when", ctx.prefix);
          }
        }
      }
    }
  }

  // 11. Blank indented line inside empty unclosed `rule`
  if (
    isBlankIndentedLine &&
    ctx.kind === "rule-body" &&
    innerBlock?.kind === "rule" &&
    Boolean(innerBlock.name) &&
    isBlockUnclosed(innerBlock)
  ) {
    const nextLineTrimmed = findNextNonEmptyLineTrimmed(doc, lineIdx);
    if (!/^end\s+rule\b/.test(nextLineTrimmed)) {
      const headerEndOffset =
        (doc.lineStarts[innerBlock.headerRange.endLineNumber - 1] ?? 0) +
        (innerBlock.headerRange.endColumn - 1);
      if (!hasTokensInRange(doc.tokens, headerEndOffset, offset)) {
        const firstTable =
          schema.tableNames[0] ??
          schema.bindings.values().next().value?.tableName;
        if (!firstTable) return null;
        const ruleLineStart =
          doc.lineStarts[innerBlock.headerRange.startLineNumber - 1] ?? 0;
        const rulePrefix = doc.source.slice(ruleLineStart, innerBlock.openOffset);
        const ruleIndent = /^[ \t]*$/.test(rulePrefix) ? rulePrefix : "";
        return makePrediction(
          normPos,
          `source ${firstTable}\n${ruleIndent}end rule`,
        );
      }
    }
  }

  return null;
}
