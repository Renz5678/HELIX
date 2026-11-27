import {
  findReferenceAtOffset,
  findTerminologyAtOffset,
  visibleSymbolsAt,
} from "./document-index";
import type { DatasetSchemaIndex } from "./schema";
import { findTerm, TERMINOLOGY_SYSTEMS } from "./terminology";
import {
  ALL_STATEMENT_START_KEYWORDS,
  CONTINUATION_OPERATORS,
  findEnclosingBindTable,
  findLastTokenIdxStartingBefore,
  findTokenAtPositionOffset,
  isDelimiter,
  isKeyword,
  isMemberNameToken,
  isStrictlyInsideComment,
  offsetFromLineStarts,
  positionFromLineStarts,
  SYNTAX_ONLY_NOTE,
  tokenRange,
  toTerminologySystem,
} from "./token-utils";
import type { Column } from "../../services/types";
import type {
  Cell,
  DocumentIndex,
  LexToken,
  SymbolEntry,
  Table,
  TextPosition,
  TextRange,
} from "./types";

export interface HoverResult {
  markdown: string;
  range: TextRange;
}

export interface SignatureParameterInfo {
  label: string;
  documentation?: string;
}

export interface SignatureInfo {
  label: string;
  documentation?: string;
  parameters: SignatureParameterInfo[];
}

export interface SignatureResult {
  signatures: SignatureInfo[];
  activeSignature: number;
  activeParameter: number;
}

interface KeywordDoc {
  signature?: string;
  description: string;
  syntaxOnly?: boolean;
}

const HELIX_KEYWORD_DOCS: Readonly<Record<string, KeywordDoc>> = {
  rule: {
    signature: "rule <Name>: ... end rule",
    description:
      "Declares a named clinical decision rule evaluated per patient.",
  },
  intent: {
    signature: 'intent: "<description>"',
    description:
      "Human-readable clinical purpose metadata for the enclosing rule.",
  },
  bind: {
    signature:
      "bind <alias> = <TableOrBinding> [where <pred>] [within <dur>] end bind",
    description:
      "Binds a filtered and windowed clinical series alias to a dataset table or binding.",
  },
  site: {
    signature: "site: <CareSetting> | bind site: <Name> ... end bind",
    description: "Declares care-site context metadata.",
    syntaxOnly: true,
  },
  source: {
    signature: "source <TableName>",
    description:
      "Binds a dataset table (or single-identifier binding) directly by name. Arrow metadata (`source X -> Y`) is syntax-only.",
  },
  terminology: {
    signature: 'terminology: LOINC("...") | SNOMED("...") | RxNorm("...")',
    description: "Attaches standard clinical terminology codes to a rule.",
  },
  schedule: {
    signature: 'schedule: "<interval>" | schedule within <duration>',
    description: "Declares the rule evaluation cadence metadata.",
  },
  when: {
    signature: "when <condition>: then: ... [otherwise: ...] end when",
    description:
      "Evaluates a three-valued condition (`TRUE` runs `then:`, `FALSE` runs `otherwise:`, `UNKNOWN` runs neither). Event trigger `when Event.name` is syntax-only.",
  },
  for: {
    signature: "when for <var> ... | for <var>: <Event>",
    description: "Event iteration binding.",
    syntaxOnly: true,
  },
  let: {
    signature: "let <name> := <expr>",
    description:
      "Declares a rule-scoped or branch-scoped immutable variable.",
  },
  latest: {
    signature: "<series>.latest",
    description:
      "Selects the most recent eligible reading at or before `evaluationTime`. Standalone `latest <ident>` queries are syntax-only.",
  },
  where: {
    signature: "where <column> <op> <value> [and|or ...]",
    description: "Row-level filter predicate on a `bind` series.",
  },
  and: {
    signature: "<expr> and <expr>",
    description: "Three-valued logical conjunction.",
  },
  or: {
    signature: "<expr> or <expr>",
    description: "Three-valued logical disjunction.",
  },
  not: {
    signature: "not <expr>",
    description: "Three-valued logical negation.",
  },
  within: {
    signature: "within <number> <unit> [before now]",
    description:
      "Restricts readings to an inclusive lookback window (`seconds`, `minutes`, `hours`, `days` / `s`, `m`, `h`, `d` are evaluated; `weeks`, `months`, `years`, and abbreviations like `min`/`hr`/`sec` are parser-only / syntax-only).",
  },
  then: {
    signature: "then:",
    description:
      "Begins the branch executed when the `when` condition is `TRUE`.",
  },
  alert: {
    signature: 'alert: "<message>", ["INFO"|"WARNING"|"CRITICAL"], ...payload',
    description:
      "Emits a clinical alert action with message, optional severity, and payload expressions. `alert level:` is syntax-only.",
  },
  suppress: {
    signature: "suppress: within <duration>",
    description:
      "Records a simulated alert suppression window. `suppress: repeat_of: <Rule>` is syntax-only.",
  },
  otherwise: {
    signature: "otherwise:",
    description:
      "Begins the branch executed when the `when` condition is `FALSE`.",
  },
  end: {
    signature: "end rule | end when | end bind",
    description: "Explicitly terminates the innermost matching block.",
  },
};

function formatSampleValue(value: Cell): string {
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function renderColumnHover(
  schema: DatasetSchemaIndex,
  table: Table,
  column: Column,
  headingPrefix?: string,
): string {
  const rowCount = Array.isArray(table.rows) ? table.rows.length : 0;
  const samples = schema.getColumnSamples(table.name, column.name);
  const lines: string[] = [
    headingPrefix
      ? `${headingPrefix} → \`${table.name}.${column.name}\` (\`${column.type}\`)`
      : `**column** \`${table.name}.${column.name}\` (\`${column.type}\`)`,
    "",
    `- Rows: ${rowCount} (non-null sampled: ${samples.nonNullCount})`,
  ];
  if (samples.min !== undefined && samples.max !== undefined) {
    lines.push(`- Range: ${samples.min} – ${samples.max}`);
  }
  if (samples.values.length > 0) {
    lines.push(
      `- Samples: ${samples.values.slice(0, 4).map(formatSampleValue).join(", ")}`,
    );
  }
  return lines.join("\n");
}

function renderTableHover(table: Table): string {
  const rowCount = Array.isArray(table.rows) ? table.rows.length : 0;
  const cols = (table.columns ?? [])
    .map((c) => `\`${c.name}\` (${c.type})`)
    .join(", ");
  return [
    `**table** \`${table.name}\` (${rowCount} ${rowCount === 1 ? "row" : "rows"})`,
    "",
    `- Patient ID column: \`${table.patientIdColumn}\``,
    `- Timestamp column: \`${table.timestampColumn}\``,
    `- Default value column: \`${table.defaultValueColumn}\``,
    cols ? `- Columns: ${cols}` : "- Columns: _(none)_",
  ].join("\n");
}

function describeLetScope(doc: DocumentIndex, sym: SymbolEntry): string {
  for (let i = doc.blocks.length - 1; i >= 0; i--) {
    const b = doc.blocks[i];
    if (b.kind === "when") {
      if (b.thenOffset !== null && sym.scopeStartOffset === b.thenOffset) {
        return "`when` (`then:` branch)";
      }
      if (
        b.otherwiseOffset !== null &&
        sym.scopeStartOffset === b.otherwiseOffset
      ) {
        return "`when` (`otherwise:` branch)";
      }
    }
    if (b.kind === "rule" && b.openOffset === sym.scopeStartOffset) {
      return b.name ? `rule \`${b.name}\`` : "enclosing rule";
    }
  }
  return "local scope";
}

function renderSymbolHover(
  doc: DocumentIndex,
  schema: DatasetSchemaIndex,
  sym: SymbolEntry,
): string {
  switch (sym.kind) {
    case "bind":
    case "source": {
      if (sym.syntaxOnly) {
        return [
          `**${sym.kind}** \`${sym.name}\``,
          "",
          SYNTAX_ONLY_NOTE,
          sym.sourcePath ? `\nDeclaration: \`${sym.sourcePath}\`` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }

      const lines: string[] = [`**${sym.kind}** \`${sym.name}\` — \`Series\``];
      if (sym.resolvedTarget) {
        const target = sym.resolvedTarget;
        const targetPath = `${target.tableName}.${target.columnName}`;
        if (sym.sourcePath && sym.sourcePath !== targetPath) {
          lines.push(`- Binding: \`${sym.sourcePath}\``);
        }
        lines.push(`- Target: \`${targetPath}\` (\`${target.columnType}\`)`);
        if (sym.whereText) lines.push(`- Filter: \`where ${sym.whereText}\``);
        if (sym.withinText) lines.push(`- Window: \`within ${sym.withinText}\``);

        const rowCount = Array.isArray(target.table.rows)
          ? target.table.rows.length
          : 0;
        const samples = schema.getColumnSamples(
          target.tableName,
          target.columnName,
        );
        lines.push(
          `- Rows: ${rowCount} (non-null sampled: ${samples.nonNullCount})`,
        );
        if (samples.min !== undefined && samples.max !== undefined) {
          lines.push(`- Range: ${samples.min} – ${samples.max}`);
        }
        if (samples.values.length > 0) {
          lines.push(
            `- Samples: ${samples.values.slice(0, 4).map(formatSampleValue).join(", ")}`,
          );
        }
      } else {
        if (sym.sourcePath) lines.push(`- Path: \`${sym.sourcePath}\``);
        if (sym.whereText) lines.push(`- Filter: \`where ${sym.whereText}\``);
        if (sym.withinText) lines.push(`- Window: \`within ${sym.withinText}\``);
        lines.push("- Status: _(unresolved in active dataset)_");
      }
      return lines.join("\n");
    }

    case "let": {
      const lines: string[] = [
        `**let** \`${sym.name}\`: \`${sym.valueType}\``,
        "",
        `- Scope: ${describeLetScope(doc, sym)}`,
      ];
      if (sym.initializerPreview) {
        lines.push(`- Initializer: \`${sym.initializerPreview}\``);
      }
      return lines.join("\n");
    }

    case "rule": {
      const matching = doc.blocks.find(
        (b) =>
          b.kind === "rule" &&
          b.name === sym.name &&
          b.headerRange.startLineNumber ===
            sym.declarationRange.startLineNumber,
      );
      const startLine =
        matching?.fullRange.startLineNumber ??
        sym.declarationRange.startLineNumber;
      const endLine =
        matching?.fullRange.endLineNumber ?? sym.declarationRange.endLineNumber;
      const status =
        matching && (matching.closeOffset === null || matching.syntheticClosed)
          ? "unclosed"
          : "closed";
      return `**rule** \`${sym.name}\`\n\n- Span: lines ${startLine}–${endLine} (${status})`;
    }

    case "for":
      return [
        `**for** \`${sym.name}\`${sym.sourcePath ? `: \`${sym.sourcePath}\`` : ""}`,
        "",
        `${SYNTAX_ONLY_NOTE} — Event iteration variable.`,
      ].join("\n");
  }
}

function renderKeywordHover(
  keyword: string,
  extraContext?: string,
): string | null {
  const docEntry = HELIX_KEYWORD_DOCS[keyword];
  if (!docEntry) return null;
  const lines: string[] = [`**keyword** \`${keyword}\``];
  if (docEntry.signature) {
    lines.push("", `\`${docEntry.signature}\``);
  }
  lines.push("", docEntry.description);
  if (extraContext) {
    lines.push("", extraContext);
  }
  if (docEntry.syntaxOnly) {
    lines.push("", `_${SYNTAX_ONLY_NOTE}_`);
  }
  return lines.join("\n");
}

function resolveDottedChainPrefix(
  tokens: readonly LexToken[],
  tokIdx: number,
): string | null {
  const tok = tokens[tokIdx];
  if (!isMemberNameToken(tok)) return null;
  const parts: string[] = [tok.lexeme];
  let idx = tokIdx;
  while (
    idx >= 2 &&
    isDelimiter(tokens[idx - 1], ".") &&
    isMemberNameToken(tokens[idx - 2])
  ) {
    parts.unshift(tokens[idx - 2].lexeme);
    idx -= 2;
  }
  return parts.join(".");
}

/**
 * Computes rich Markdown hover documentation for terminology codes, symbol references,
 * dataset tables/bindings/columns, and HELIX keywords.
 */
export function computeHover(
  doc: DocumentIndex,
  schema: DatasetSchemaIndex,
  pos: TextPosition,
): HoverResult | null {
  const offset = offsetFromLineStarts(doc.source, doc.lineStarts, pos);
  if (isStrictlyInsideComment(doc.comments, offset)) {
    return null;
  }
  const normPos = positionFromLineStarts(
    doc.lineStarts,
    doc.source.length,
    offset,
  );

  // 1. Terminology call at offset
  const term = findTerminologyAtOffset(doc, offset);
  if (term) {
    const sysInfo = TERMINOLOGY_SYSTEMS[term.system];
    const entry = term.code ? findTerm(term.system, term.code) : null;
    if (entry) {
      const parts = [
        `**${sysInfo.label}** \`${entry.code}\``,
        "",
        entry.description,
      ];
      if (entry.deprecated) {
        parts.push(
          "",
          `> **Deprecated:** This ${sysInfo.label} code is marked deprecated.`,
        );
      }
      if (entry.aliases && entry.aliases.length > 0) {
        parts.push(
          "",
          `Aliases: ${entry.aliases.map((a) => `\`${a}\``).join(", ")}`,
        );
      }
      parts.push("", `System URI: \`${sysInfo.uri}\``);
      return { markdown: parts.join("\n"), range: term.range };
    }

    return {
      markdown: [
        `**${sysInfo.label}** ${term.code ? `\`${term.code}\`` : "_(empty code)_"}`,
        "",
        `Unlisted ${sysInfo.label} code (not in curated catalog).`,
        "",
        `System URI: \`${sysInfo.uri}\``,
      ].join("\n"),
      range: term.range,
    };
  }

  // 1b. If cursor is inside a `bind ... where <col>` reference, resolve column before outer variables
  const bindTableInWhere = findEnclosingBindTable(doc, normPos, offset);
  const prelimTok = findTokenAtPositionOffset(doc.tokens, offset);
  if (bindTableInWhere && prelimTok && isMemberNameToken(prelimTok.token)) {
    let inWhereClause = false;
    for (let k = prelimTok.index - 1; k >= 0; k--) {
      const t = doc.tokens[k];
      if (isKeyword(t, "where")) {
        inWhereClause = true;
        break;
      }
      if (
        isKeyword(t, "bind") ||
        isKeyword(t, "within") ||
        isKeyword(t, "rule") ||
        isKeyword(t, "when") ||
        isKeyword(t, "let") ||
        isKeyword(t, "end")
      ) {
        break;
      }
    }
    if (inWhereClause) {
      const whereCol = bindTableInWhere.columns?.find(
        (c) => c.name === prelimTok.token.lexeme,
      );
      const prevTok =
        prelimTok.index > 0 ? doc.tokens[prelimTok.index - 1] : undefined;
      if (whereCol && !isDelimiter(prevTok, ".")) {
        return {
          markdown: renderColumnHover(schema, bindTableInWhere, whereCol),
          range: tokenRange(prelimTok.token),
        };
      }
    }
  }

  // 2. Symbol reference at offset
  const ref = findReferenceAtOffset(doc, offset);
  if (ref && ref.symbolIndex !== null) {
    const sym = doc.symbols[ref.symbolIndex];
    if (sym) {
      if (ref.name === "latest" && ref.memberOf !== undefined) {
        const extra = sym.resolvedTarget
          ? `Resolves latest reading from \`${sym.resolvedTarget.tableName}.${sym.resolvedTarget.columnName}\` (\`${sym.resolvedTarget.columnType}\`).`
          : `Selects latest reading of \`${ref.memberOf}\`.`;
        const kwMd = renderKeywordHover("latest", extra);
        return kwMd ? { markdown: kwMd, range: ref.range } : null;
      }

      if (ref.memberOf === undefined) {
        return {
          markdown: renderSymbolHover(doc, schema, sym),
          range: ref.range,
        };
      }

      if (sym.resolvedTarget) {
        const col = sym.resolvedTarget.table.columns?.find(
          (c) => c.name === ref.name,
        );
        if (col) {
          return {
            markdown: renderColumnHover(schema, sym.resolvedTarget.table, col),
            range: ref.range,
          };
        }
      }
    }
  }

  const foundTok = prelimTok ?? findTokenAtPositionOffset(doc.tokens, offset);
  if (!foundTok) return null;
  const { token: tok, index: tokIdx } = foundTok;

  // 3. Dataset table / binding / column identifier (including `<localBindAlias>.<column>`)
  if (isMemberNameToken(tok)) {
    const chainPrefix = resolveDottedChainPrefix(doc.tokens, tokIdx);
    if (chainPrefix) {
      if (chainPrefix.includes(".")) {
        const resolved = schema.resolvePath(chainPrefix);
        if (resolved) {
          const col = resolved.table.columns?.find(
            (c) => c.name === resolved.columnName,
          );
          if (col) {
            const prefix =
              resolved.path !== `${resolved.tableName}.${resolved.columnName}`
                ? `**binding** \`${resolved.path}\``
                : undefined;
            return {
              markdown: renderColumnHover(schema, resolved.table, col, prefix),
              range: tokenRange(tok),
            };
          }
        }

        const parts = chainPrefix.split(".");
        if (parts.length === 2) {
          const ownerSym = visibleSymbolsAt(doc, offset).find(
            (s) =>
              s.name === parts[0] &&
              (s.kind === "bind" || s.kind === "source") &&
              s.resolvedTarget !== undefined,
          );
          const col = ownerSym?.resolvedTarget?.table.columns?.find(
            (c) => c.name === parts[1],
          );
          if (ownerSym?.resolvedTarget && col) {
            return {
              markdown: renderColumnHover(
                schema,
                ownerSym.resolvedTarget.table,
                col,
              ),
              range: tokenRange(tok),
            };
          }
        }
      } else {
        const table = schema.tablesByName.get(chainPrefix);
        if (table) {
          return {
            markdown: renderTableHover(table),
            range: tokenRange(tok),
          };
        }

        const bindingGroup = schema.bindingPrefixes.get(chainPrefix);
        if (bindingGroup && bindingGroup.length > 0) {
          const items = bindingGroup
            .map(
              (b) =>
                `- \`${b.fullPath}\` → \`${b.target.tableName}.${b.target.columnName}\` (${b.target.columnType})`,
            )
            .join("\n");
          return {
            markdown: `**binding namespace** \`${chainPrefix}.*\`\n\n${items}`,
            range: tokenRange(tok),
          };
        }

        const directBinding = schema.bindings.get(chainPrefix);
        if (directBinding) {
          const col = directBinding.table.columns?.find(
            (c) => c.name === directBinding.columnName,
          );
          if (col) {
            return {
              markdown: renderColumnHover(
                schema,
                directBinding.table,
                col,
                `**binding** \`${chainPrefix}\``,
              ),
              range: tokenRange(tok),
            };
          }
        }

        const whereCol = bindTableInWhere?.columns?.find(
          (c) => c.name === tok.lexeme,
        );
        if (bindTableInWhere && whereCol) {
          return {
            markdown: renderColumnHover(schema, bindTableInWhere, whereCol),
            range: tokenRange(tok),
          };
        }
      }
    }
  }

  // 4. HELIX keyword reference
  if (tok.kind === "keyword") {
    const kwMd = renderKeywordHover(tok.lexeme);
    if (kwMd) {
      return { markdown: kwMd, range: tokenRange(tok) };
    }
  }

  return null;
}

const ALERT_SIGNATURE: SignatureInfo = {
  label: "alert: message, severity?, ...payload",
  documentation:
    "Emits a clinical alert action with a message string, optional severity level, and optional payload expressions.",
  parameters: [
    {
      label: "message: String",
      documentation: "Primary alert message string.",
    },
    {
      label: 'severity?: "INFO" | "WARNING" | "CRITICAL"',
      documentation: "Optional severity classification string.",
    },
    {
      label: "...payload: Expr",
      documentation: "Optional trailing data expressions attached to the alert.",
    },
  ],
};

function buildTerminologySignature(
  tokens: readonly LexToken[],
  delimIdx: number,
  delim: "(" | "[",
): SignatureResult | null {
  const t = tokens[delimIdx];
  const sysTok = delimIdx > 0 ? tokens[delimIdx - 1] : undefined;
  const sys =
    sysTok && sysTok.kind === "identifier" && sysTok.line === t.line
      ? toTerminologySystem(sysTok.lexeme)
      : null;
  if (!sys) return null;

  const info = TERMINOLOGY_SYSTEMS[sys];
  const label = delim === "(" ? `${sys}("code")` : `${sys}[code]`;
  const paramDoc =
    delim === "("
      ? `Standard ${info.label} code string.`
      : `Standard ${info.label} code identifier or string.`;
  return {
    signatures: [
      {
        label,
        documentation: `${info.label} clinical terminology reference (${info.uri}).`,
        parameters: [{ label: "code: String", documentation: paramDoc }],
      },
    ],
    activeSignature: 0,
    activeParameter: 0,
  };
}

function detectTerminologySignature(
  tokens: readonly LexToken[],
  lastIdx: number,
  offset: number,
  cursorLine: number,
): SignatureResult | null {
  let parenDepth = 0;
  let bracketDepth = 0;

  for (let i = lastIdx; i >= 0; i--) {
    const t = tokens[i];
    if (t.line < cursorLine) break;
    if (t.kind === "delimiter") {
      if (t.lexeme === ")" && t.endOffset <= offset) {
        parenDepth++;
        continue;
      }
      if (t.lexeme === "]" && t.endOffset <= offset) {
        bracketDepth++;
        continue;
      }
      if (t.lexeme === "(") {
        if (parenDepth > 0) {
          parenDepth--;
          continue;
        }
        return buildTerminologySignature(tokens, i, "(");
      }
      if (t.lexeme === "[") {
        if (bracketDepth > 0) {
          bracketDepth--;
          continue;
        }
        return buildTerminologySignature(tokens, i, "[");
      }
    }
    if (
      t.kind === "keyword" &&
      ALL_STATEMENT_START_KEYWORDS.has(t.lexeme) &&
      !isKeyword(t, "latest")
    ) {
      break;
    }
  }
  return null;
}

/**
 * Computes active parameter signature help inside `alert:` statements
 * and `LOINC`/`SNOMED`/`RxNorm` terminology calls.
 */
export function computeSignatureHelp(
  doc: DocumentIndex,
  pos: TextPosition,
): SignatureResult | null {
  const offset = offsetFromLineStarts(doc.source, doc.lineStarts, pos);
  if (isStrictlyInsideComment(doc.comments, offset)) {
    return null;
  }

  const lastIdx = findLastTokenIdxStartingBefore(doc.tokens, offset);
  if (lastIdx < 0) return null;

  const normPos = positionFromLineStarts(
    doc.lineStarts,
    doc.source.length,
    offset,
  );
  const termSig = detectTerminologySignature(
    doc.tokens,
    lastIdx,
    offset,
    normPos.lineNumber,
  );
  if (termSig) return termSig;

  let depth = 0;
  let stmtStartIdx = -1;
  for (let i = lastIdx; i >= 0; i--) {
    const t = doc.tokens[i];
    if (isDelimiter(t, ")") || isDelimiter(t, "]")) {
      depth++;
      continue;
    }
    if (isDelimiter(t, "(") || isDelimiter(t, "[")) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;

    if (t.kind === "keyword" && ALL_STATEMENT_START_KEYWORDS.has(t.lexeme)) {
      const prev = i > 0 ? doc.tokens[i - 1] : undefined;
      if (isDelimiter(prev, ".")) continue;
      if (t.lexeme === "for" && isKeyword(prev, "when")) continue;
      stmtStartIdx = i;
      break;
    }
  }

  if (stmtStartIdx === -1 || !isKeyword(doc.tokens[stmtStartIdx], "alert")) {
    return null;
  }

  const alertTok = doc.tokens[stmtStartIdx];
  if (offset <= alertTok.endOffset) {
    return null;
  }

  const stmtTokens = doc.tokens.slice(stmtStartIdx + 1, lastIdx + 1);
  let argCursor = 0;
  if (isDelimiter(stmtTokens[0], ":")) {
    argCursor = 1;
  }

  if (
    stmtTokens[argCursor]?.kind === "identifier" &&
    stmtTokens[argCursor].lexeme === "level" &&
    isDelimiter(stmtTokens[argCursor + 1], ":")
  ) {
    return null;
  }

  const lastTok = doc.tokens[lastIdx];
  if (normPos.lineNumber > lastTok.endLine) {
    let openGrouping = 0;
    for (const t of stmtTokens) {
      if (isDelimiter(t, "(") || isDelimiter(t, "[")) openGrouping++;
      else if (isDelimiter(t, ")") || isDelimiter(t, "]")) {
        openGrouping = Math.max(0, openGrouping - 1);
      }
    }
    const expectsMore =
      openGrouping > 0 ||
      isDelimiter(lastTok, ":") ||
      isDelimiter(lastTok, ",") ||
      isDelimiter(lastTok, "(") ||
      isDelimiter(lastTok, "[") ||
      (lastTok.kind === "operator" &&
        CONTINUATION_OPERATORS.has(lastTok.lexeme));
    if (!expectsMore) {
      return null;
    }
  }

  let commas = 0;
  let innerDepth = 0;
  for (let i = argCursor; i < stmtTokens.length; i++) {
    const t = stmtTokens[i];
    if (isDelimiter(t, "(") || isDelimiter(t, "[")) innerDepth++;
    else if (isDelimiter(t, ")") || isDelimiter(t, "]")) {
      innerDepth = Math.max(0, innerDepth - 1);
    } else if (
      innerDepth === 0 &&
      isDelimiter(t, ",") &&
      t.endOffset <= offset
    ) {
      commas++;
    }
  }

  return {
    signatures: [ALERT_SIGNATURE],
    activeSignature: 0,
    activeParameter: Math.min(commas, 2),
  };
}
