import {
  activeRuleAt,
  findReferenceAtOffset,
  findTerminologyAtOffset,
  openBlocksAt,
  visibleSymbolsAt,
} from "./document-index";
import { offsetToPosition, positionToOffset } from "./lexer";
import type { DatasetSchemaIndex } from "./schema";
import { findTerm, TERMINOLOGY_SYSTEMS } from "./terminology";
import type { Column } from "../../services/types";
import {
  HELIX_KEYWORD_SET,
  MEMBER_KEYWORDS,
  type BlockNode,
  type Cell,
  type DocumentIndex,
  type LexComment,
  type LexToken,
  type SymbolEntry,
  type Table,
  type TerminologySystem,
  type TextPosition,
  type TextRange,
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

interface KeywordDoc {
  signature?: string;
  description: string;
  syntaxOnly?: boolean;
}

const SYNTAX_ONLY_NOTE = "Syntax-only (not evaluated in Studio)";

const HELIX_KEYWORD_DOCS: Readonly<Record<string, KeywordDoc>> = {
  rule: {
    signature: "rule <Name>: ... end rule",
    description: "Declares a named clinical decision rule evaluated per patient.",
  },
  intent: {
    signature: 'intent: "<description>"',
    description: "Human-readable clinical purpose metadata for the enclosing rule.",
  },
  bind: {
    signature: "bind <alias> = <TableOrBinding> [where <pred>] [within <dur>] end bind",
    description:
      "Binds a filtered and windowed clinical series alias to a dataset table or binding.",
  },
  site: {
    signature: "site: <CareSetting> | bind site: <Name> ... end bind",
    description: "Declares care-site context metadata.",
    syntaxOnly: true,
  },
  source: {
    signature: "source <TableOrBinding>",
    description:
      "Binds a dataset table or explicit binding directly by name. Arrow metadata (`source X -> Y`) is syntax-only.",
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
      "Restricts readings to an inclusive lookback window (`seconds`, `minutes`, `hours`, `days`, `weeks`; `months`/`years` are syntax-only).",
  },
  then: {
    signature: "then:",
    description: "Begins the branch executed when the `when` condition is `TRUE`.",
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
    description: "Begins the branch executed when the `when` condition is `FALSE`.",
  },
  end: {
    signature: "end rule | end when | end bind",
    description: "Explicitly terminates the innermost matching block.",
  },
};

const STATEMENT_START_KEYWORDS = new Set([
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

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

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

function isKeyword(tok: LexToken | undefined, lexeme: string): boolean {
  return tok !== undefined && tok.kind === "keyword" && tok.lexeme === lexeme;
}

function isDelimiter(tok: LexToken | undefined, lexeme: string): boolean {
  return tok !== undefined && tok.kind === "delimiter" && tok.lexeme === lexeme;
}

function isChainToken(tok: LexToken | undefined): boolean {
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

function isStrictlyInsideComment(
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

function findTokenAtPositionOffset(
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
      // If cursor is on a delimiter (like `.` or `)`), prefer an immediately preceding word token.
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

  // Fallback for cursor right at the end of a token before whitespace or EOF
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
      if (b.otherwiseOffset !== null && sym.scopeStartOffset === b.otherwiseOffset) {
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
        lines.push(`- Rows: ${rowCount} (non-null sampled: ${samples.nonNullCount})`);
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
          b.headerRange.startLineNumber === sym.declarationRange.startLineNumber,
      );
      const startLine = matching?.fullRange.startLineNumber ?? sym.declarationRange.startLineNumber;
      const endLine = matching?.fullRange.endLineNumber ?? sym.declarationRange.endLineNumber;
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

function renderKeywordHover(keyword: string, extraContext?: string): string | null {
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

function findEnclosingBindTable(
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

function resolveDottedChainPrefix(
  tokens: readonly LexToken[],
  tokIdx: number,
): string | null {
  const tok = tokens[tokIdx];
  if (!isChainToken(tok)) return null;
  const parts: string[] = [tok.lexeme];
  let idx = tokIdx;
  while (
    idx >= 2 &&
    isDelimiter(tokens[idx - 1], ".") &&
    isChainToken(tokens[idx - 2])
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
  const offset = positionToOffset(doc.source, pos);
  if (isStrictlyInsideComment(doc.comments, offset)) {
    return null;
  }

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
  const bindTableInWhere = findEnclosingBindTable(doc, pos, offset);
  const prelimTok = findTokenAtPositionOffset(doc.tokens, offset);
  if (bindTableInWhere && prelimTok && isChainToken(prelimTok.token)) {
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
    }
  }

  const foundTok = findTokenAtPositionOffset(doc.tokens, offset);
  if (!foundTok) return null;
  const { token: tok, index: tokIdx } = foundTok;

  // 3. Dataset table / binding / column identifier
  if (isChainToken(tok)) {
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

        // Column inside `bind ... where <col>` clause
        const bindTable = findEnclosingBindTable(
          doc,
          offsetToPosition(doc.source, offset),
          offset,
        );
        const whereCol = bindTable?.columns?.find((c) => c.name === tok.lexeme);
        if (bindTable && whereCol) {
          return {
            markdown: renderColumnHover(schema, bindTable, whereCol),
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

function findLastTokenIdxStartingBefore(
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
      STATEMENT_START_KEYWORDS.has(t.lexeme) &&
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
  const offset = positionToOffset(doc.source, pos);
  if (isStrictlyInsideComment(doc.comments, offset)) {
    return null;
  }

  const lastIdx = findLastTokenIdxStartingBefore(doc.tokens, offset);
  if (lastIdx < 0) return null;

  const normPos = offsetToPosition(doc.source, offset);
  const termSig = detectTerminologySignature(
    doc.tokens,
    lastIdx,
    offset,
    normPos.lineNumber,
  );
  if (termSig) return termSig;

  // Walk backward at depth 0 to find enclosing statement keyword
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

    if (t.kind === "keyword" && STATEMENT_START_KEYWORDS.has(t.lexeme)) {
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

  // `alert level: <...>` is syntax-only and does not take message/severity/payload args
  if (
    stmtTokens[argCursor]?.kind === "identifier" &&
    stmtTokens[argCursor].lexeme === "level" &&
    isDelimiter(stmtTokens[argCursor + 1], ":")
  ) {
    return null;
  }

  // If previous line already completed `alert`, don't show signature help on subsequent line
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
      (lastTok.kind === "operator" && CONTINUATION_OPERATORS.has(lastTok.lexeme));
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
    } else if (innerDepth === 0 && isDelimiter(t, ",") && t.endOffset <= offset) {
      commas++;
    }
  }

  return {
    signatures: [ALERT_SIGNATURE],
    activeSignature: 0,
    activeParameter: Math.min(commas, 2),
  };
}

/**
 * Resolves go-to-definition for declared symbols (`bind`, `source`, `let`, `for`,
 * and `rule` via `suppress repeat_of: <RuleName>`).
 */
export function computeDefinition(
  doc: DocumentIndex,
  pos: TextPosition,
): TextRange | null {
  const offset = positionToOffset(doc.source, pos);
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
  const offset = positionToOffset(doc.source, pos);
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
        const afterMember = isDelimiter(prev, ".") || (prev?.kind === "operator" && prev.lexeme === "->");
        if (
          !afterMember &&
          depth === 0 &&
          cur.kind === "keyword" &&
          (STATEMENT_START_KEYWORDS.has(cur.lexeme) ||
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

  // Gather non-block symbol items (`source`, `let`) and statement items (`alert`, `suppress`)
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

  // Single linear sweep pairing leaf items to their innermost enclosing container block
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
  // Allow 1-char synthetic EOF width (`lineLength + 1`), reject markers clearly beyond line length
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

function isWholeWordSpan(source: string, startOffset: number, endOffset: number): boolean {
  const before = startOffset > 0 ? source[startOffset - 1] : "";
  const after = endOffset < source.length ? source[endOffset] : "";
  return !/[A-Za-z0-9_.]/.test(before) && !/[A-Za-z0-9_.]/.test(after);
}

function extractTargetPathFromSpan(
  doc: DocumentIndex,
  span: ResolvedSpan,
  code: string,
  range: TextRange,
): { token: string; range: TextRange; startOffset: number; endOffset: number } | null {
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

  // Handle C/WASM statement-wide diagnostic ranges like `source Vitlas` or `bind s = Vitals.systolc_bp`
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
      if (isKeyword(t, "where") || isKeyword(t, "within") || isKeyword(t, "end")) {
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
      // Valid if no code token sits strictly between synthetic close and marker start
      const nextIdx = findLastTokenIdxStartingBefore(doc.tokens, beforeOrAtOffset);
      const prevTokenBeforeMarker = nextIdx >= 0 ? doc.tokens[nextIdx] : undefined;
      if (!prevTokenBeforeMarker || prevTokenBeforeMarker.endOffset <= b.closeOffset) {
        return b;
      }
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
        const eofPos = offsetToPosition(doc.source, doc.source.length);
        const insertText =
          doc.source.length === 0 || doc.source.endsWith("\n") || doc.source.endsWith("\r")
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

        const blockIndent = lineIndentAt(
          doc.source,
          doc.lineStarts,
          openBlock.headerRange.startLineNumber,
        );
        const targetLine = marker.range.startLineNumber;
        pushAction({
          title: `Insert 'end ${expected}'`,
          kind: "quickfix",
          isPreferred: true,
          diagnostics: [marker],
          edit: {
            range: {
              startLineNumber: targetLine,
              startColumn: 1,
              endLineNumber: targetLine,
              endColumn: 1,
            },
            text: `${blockIndent}end ${expected}\n`,
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

      pushAction({
        title: `Replace 'end ${wrong}' with 'end ${expected}'`,
        kind: "quickfix",
        isPreferred: true,
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

      const pool: string[] = [
        ...schema.tableNames,
        ...schema.bindings.keys(),
      ];
      if (code === "BINDING_NOT_FOUND" || /binding/i.test(msg)) {
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
      offsetToPosition(doc.source, targetStart),
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
      const insertLine = enclosingWhen
        ? enclosingWhen.headerRange.startLineNumber
        : targetRange.startLineNumber;
      const indent = lineIndentAt(doc.source, doc.lineStarts, insertLine);

      pushAction({
        title: `Declare 'let ${ident} := 0'`,
        kind: "quickfix",
        isPreferred: typoMatches.length === 0,
        diagnostics: [marker],
        edit: {
          range: {
            startLineNumber: insertLine,
            startColumn: 1,
            endLineNumber: insertLine,
            endColumn: 1,
          },
          text: `${indent}let ${ident} := 0\n`,
        },
      });
    }
  }

  return actions;
}
