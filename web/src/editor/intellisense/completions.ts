import type { CursorContext, CursorContextKind } from "./context";
import { visibleSymbolsAt } from "./document-index";
import {
  computeLocalityBonus,
  computeNameAffinity,
  extractStems,
  MruTracker,
  scoreCandidate,
  toSortText,
  type ScoreInput,
} from "./ranking";
import { columnTypeToValueType, type DatasetSchemaIndex } from "./schema";
import { searchTerms, TERMINOLOGY_SYSTEMS } from "./terminology";
import {
  EXECUTOR_TIME_UNITS,
  HELIX_KEYWORD_SET,
  MEMBER_KEYWORDS,
  PARSER_ONLY_TIME_UNITS,
  type DocumentIndex,
  type SymbolEntry,
  type TextRange,
  type ValueType,
} from "./types";

export type CompletionKind =
  | "keyword"
  | "variable"
  | "field"
  | "property"
  | "class"
  | "value"
  | "enumMember"
  | "unit"
  | "snippet"
  | "module"
  | "constant"
  | "operator";

export interface CompletionCandidate {
  label: string;
  kind: CompletionKind;
  insertText: string;
  isSnippet: boolean;
  detail: string;
  documentation: string;
  sortText: string;
  filterText?: string;
  range: TextRange;
  preselect?: boolean;
  syntaxOnly?: boolean;
  score: number;
  contextKind: CursorContextKind;
}

export const SYNTAX_ONLY_DETAIL = "Syntax-only (not evaluated in Studio)";

const PRIMARY_TIME_UNITS = new Set([
  "minutes",
  "hours",
  "days",
  "seconds",
  "weeks",
]);

const SHORT_MINUTE_PRESETS = new Set([15, 30, 45, 60]);

const COMPARISON_OP_TOKENS = new Set([
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "=",
]);

const GENERIC_ALIAS_SUFFIXES =
  /(?:_readings|_reading|_data|_records|_record|_events|_event|_table)$/i;

interface CandidateSpec {
  label: string;
  kind: CompletionKind;
  insertText?: string;
  isSnippet?: boolean;
  detail: string;
  documentation?: string;
  filterText?: string;
  preselect?: boolean;
  syntaxOnly?: boolean;
  scoreInput: ScoreInput;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled CursorContextKind: ${String(value)}`);
}

function symbolDeclOffset(doc: DocumentIndex, sym: SymbolEntry): number {
  const lineStart = doc.lineStarts[sym.nameRange.startLineNumber - 1] ?? 0;
  return lineStart + (sym.nameRange.startColumn - 1);
}

function symbolLocality(
  doc: DocumentIndex,
  sym: SymbolEntry,
  ctx: CursorContext,
): number {
  return computeLocalityBonus(
    symbolDeclOffset(doc, sym),
    sym.scopeStartOffset,
    ctx.offset,
  );
}

function seriesValueType(sym: SymbolEntry): ValueType {
  return sym.resolvedTarget
    ? columnTypeToValueType(sym.resolvedTarget.columnType)
    : "Unknown";
}

function formatLiteralForType(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return String(value);
}

function filenameToRuleName(filename: string): string {
  const base = (filename ?? "")
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.[^.]+$/, "");
  if (!base) return "ClinicalAlertRule";
  const words = base.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (words.length === 0) return "ClinicalAlertRule";
  const pascal = words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  return /^[A-Za-z_]/.test(pascal) ? pascal : `Rule${pascal}`;
}

function isUsableAlias(
  name: string,
  usedNames: ReadonlySet<string>,
  schema: DatasetSchemaIndex,
): boolean {
  if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
  if (HELIX_KEYWORD_SET.has(name)) return false;
  if (usedNames.has(name)) return false;
  if (schema.tablesByName.has(name)) return false;
  return true;
}

function deriveBindAliases(
  doc: DocumentIndex,
  schema: DatasetSchemaIndex,
  offset: number,
): string[] {
  const used = new Set(visibleSymbolsAt(doc, offset).map((s) => s.name));
  const aliases: string[] = [];
  const seen = new Set<string>();

  const pushAlias = (raw: string) => {
    const clean = raw.replace(/[^A-Za-z0-9_]/g, "_");
    if (!seen.has(clean) && isUsableAlias(clean, used, schema)) {
      seen.add(clean);
      aliases.push(clean);
    }
  };

  for (const [key, target] of schema.bindings.entries()) {
    const lastDot = key.lastIndexOf(".");
    const suffix = lastDot !== -1 ? key.slice(lastDot + 1) : key;
    pushAlias(suffix);
    if (target.columnName && !GENERIC_ALIAS_SUFFIXES.test(`_${target.columnName}`)) {
      pushAlias(target.columnName);
    }
  }

  for (const tableName of schema.tableNames) {
    const table = schema.tablesByName.get(tableName);
    const stripped = tableName.replace(GENERIC_ALIAS_SUFFIXES, "");
    if (stripped && stripped !== tableName) {
      pushAlias(stripped);
    }
    if (
      table?.defaultValueColumn &&
      table.defaultValueColumn !== "value" &&
      table.defaultValueColumn !== "val"
    ) {
      pushAlias(table.defaultValueColumn);
    }
    pushAlias(`${tableName.toLowerCase()}_series`);
  }

  if (aliases.length === 0) {
    pushAlias("reading_series");
  }

  return aliases;
}

function computeBindAliasPathBonus(path: string, bindAlias?: string): number {
  if (!bindAlias) return 0;
  let bonus = computeNameAffinity(path, bindAlias);
  const aliasStems = extractStems(bindAlias);
  const pathStems = extractStems(path);
  if (aliasStems.length === 0 || pathStems.length === 0) return bonus;

  for (const a of aliasStems) {
    if (a.length < 2) continue;
    for (let start = 0; start < pathStems.length; start++) {
      let initials = "";
      for (let end = start; end < pathStems.length; end++) {
        initials += pathStems[end][0];
        if (initials === a) {
          return Math.max(bonus, 120);
        }
      }
      if (start + 1 < pathStems.length) {
        const headPlusStem = pathStems[start][0] + pathStems[start + 1];
        if (headPlusStem === a) {
          return Math.max(bonus, 120);
        }
      }
    }
  }
  return bonus;
}

function pickPrimaryDatasetTarget(schema: DatasetSchemaIndex): {
  seriesPath: string;
  alias: string;
  tableName?: string;
  columnName?: string;
  columnType?: string;
  sampleMax?: number;
} {
  const firstTableName = schema.tableNames[0];
  const firstTable = firstTableName
    ? schema.tablesByName.get(firstTableName)
    : undefined;
  if (firstTable) {
    const colName =
      firstTable.defaultValueColumn || firstTable.columns?.[0]?.name;
    const col = colName
      ? firstTable.columns?.find((c) => c.name === colName)
      : undefined;
    const seriesPath = colName ? `${firstTable.name}.${colName}` : firstTable.name;
    const rawAlias = (colName && colName !== "value"
      ? colName
      : firstTable.name.replace(GENERIC_ALIAS_SUFFIXES, "")) || "series";
    const alias = schema.tablesByName.has(rawAlias)
      ? `${rawAlias.toLowerCase()}_series`
      : rawAlias;
    const samples = colName
      ? schema.getColumnSamples(firstTable.name, colName)
      : undefined;
    return {
      seriesPath,
      alias,
      tableName: firstTable.name,
      columnName: colName,
      columnType: col?.type,
      sampleMax: samples?.max,
    };
  }

  const firstBinding = schema.bindings.entries().next().value;
  if (firstBinding) {
    const [path, target] = firstBinding;
    const suffix = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : path;
    return {
      seriesPath: path,
      alias: suffix,
      tableName: target.tableName,
      columnName: target.columnName,
      columnType: target.columnType,
    };
  }

  return {
    seriesPath: "clinical_data",
    alias: "series",
  };
}

function isInsideQuotesBeforeCursor(
  doc: DocumentIndex,
  ctx: CursorContext,
): boolean {
  const quoteIdx = ctx.offset - ctx.prefix.length - 1;
  return quoteIdx >= 0 && doc.source[quoteIdx] === '"';
}

function isComparisonOperatorInCurrentClause(
  doc: DocumentIndex,
  ctx: CursorContext,
): boolean {
  let innerWhenStart = 0;
  for (let i = ctx.openBlocks.length - 1; i >= 0; i--) {
    if (ctx.openBlocks[i].kind === "when") {
      innerWhenStart = ctx.openBlocks[i].openOffset;
      break;
    }
  }
  const limitOffset = ctx.offset - ctx.prefix.length;
  const relevant: typeof doc.tokens = [];
  for (const tok of doc.tokens) {
    if (tok.kind === "eof") break;
    if (tok.startOffset < innerWhenStart) continue;
    if (tok.endOffset > limitOffset) break;
    relevant.push(tok);
  }

  let depth = 0;
  for (let i = relevant.length - 1; i >= 0; i--) {
    const t = relevant[i];
    if (t.kind === "delimiter" && (t.lexeme === ")" || t.lexeme === "]")) {
      depth++;
    } else if (t.kind === "delimiter" && (t.lexeme === "(" || t.lexeme === "[")) {
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
      if (t.kind === "operator" && COMPARISON_OP_TOKENS.has(t.lexeme)) {
        return true;
      }
    }
  }
  return false;
}

function findUniqueNumericLetForSeries(
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

function prefixMatchBoost(
  prefix: string,
  candidateText: string,
): number {
  const p = prefix.trim().toLowerCase();
  if (!p) return 0;
  const c = candidateText.toLowerCase();
  if (c.startsWith(p)) return 200;
  if (c.includes(p)) return 100;
  return 0;
}

function finalizeCandidates(
  specs: readonly CandidateSpec[],
  ctx: CursorContext,
  mru: MruTracker,
): CompletionCandidate[] {
  const byLabel = new Map<string, CompletionCandidate>();

  for (const spec of specs) {
    const syntaxOnly = Boolean(spec.syntaxOnly);
    const mruBoost = mru.boost(ctx.kind, spec.label);
    const score = scoreCandidate({
      ...spec.scoreInput,
      mruBoost,
      syntaxOnly,
    });
    const detail = syntaxOnly
      ? spec.detail.includes(SYNTAX_ONLY_DETAIL)
        ? spec.detail
        : `${SYNTAX_ONLY_DETAIL} — ${spec.detail}`
      : spec.detail;

    const candidate: CompletionCandidate = {
      label: spec.label,
      kind: spec.kind,
      insertText: spec.insertText ?? spec.label,
      isSnippet: Boolean(spec.isSnippet),
      detail,
      documentation: spec.documentation ?? detail,
      sortText: toSortText(score, spec.label),
      range: ctx.replaceRange,
      score,
      contextKind: ctx.kind,
    };
    if (spec.filterText !== undefined) candidate.filterText = spec.filterText;
    if (spec.preselect !== undefined) candidate.preselect = spec.preselect;
    if (syntaxOnly) candidate.syntaxOnly = true;

    const existing = byLabel.get(candidate.label);
    if (!existing || candidate.score > existing.score) {
      byLabel.set(candidate.label, candidate);
    }
  }

  const out = Array.from(byLabel.values());
  out.sort((a, b) =>
    a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : 0,
  );
  return out;
}

function buildTopLevel(
  schema: DatasetSchemaIndex,
  filename: string,
): CandidateSpec[] {
  const target = pickPrimaryDatasetTarget(schema);
  const ruleName = filenameToRuleName(filename);
  const colValType = target.columnType
    ? columnTypeToValueType(
        target.columnType as Parameters<typeof columnTypeToValueType>[0],
      )
    : "Number";

  let conditionLine: string;
  let letLine: string;
  if (colValType === "String") {
    letLine = `    let \${4:expected_status} := "\${5:final}"`;
    conditionLine = `    when \${3:${target.alias}}.latest == \${4:expected_status}:`;
  } else if (colValType === "Boolean") {
    letLine = `    let \${4:expected_flag} := \${5:true}`;
    conditionLine = `    when \${3:${target.alias}}.latest == \${4:expected_flag}:`;
  } else {
    const defaultThreshold =
      target.sampleMax !== undefined ? String(Math.round(target.sampleMax)) : "100";
    letLine = `    let \${4:threshold} := \${5:${defaultThreshold}}`;
    conditionLine = `    when \${3:${target.alias}}.latest > \${4:threshold}:`;
  }

  const snippetBody = [
    `rule \${1:${ruleName}}:`,
    `    intent: "\${2:Clinical alert rule}"`,
    `    bind \${3:${target.alias}} = ${target.seriesPath}`,
    `    end bind`,
    letLine,
    conditionLine,
    `    then:`,
    `        alert: "\${6:Alert triggered}", "\${7|WARNING,CRITICAL,INFO|}", \${3:${target.alias}}.latest`,
    `    end when`,
    `end rule`,
  ].join("\n");

  return [
    {
      label: "rule",
      kind: "keyword",
      detail: "Declare a clinical decision rule",
      documentation: "Starts a `rule <Name>: ... end rule` block.",
      scoreInput: { base: 880 },
    },
    {
      label: "rule template",
      kind: "snippet",
      insertText: snippetBody,
      isSnippet: true,
      detail: `Dynamic rule template (${target.seriesPath})`,
      documentation: `Scaffolds an evaluator-ready HELIX rule bound to \`${target.seriesPath}\`.`,
      scoreInput: { base: 820 },
    },
  ];
}

function findStringFilterColumn(
  table: { columns?: readonly { name: string; type: string }[]; patientIdColumn: string } | undefined,
): string | undefined {
  return table?.columns?.find(
    (c) => c.type === "String" && c.name !== table.patientIdColumn,
  )?.name;
}

function buildRuleBody(
  doc: DocumentIndex,
  schema: DatasetSchemaIndex,
  ctx: CursorContext,
): CandidateSpec[] {
  const visible = visibleSymbolsAt(doc, ctx.offset);
  const series = visible.filter(
    (s) => (s.kind === "bind" || s.kind === "source") && !s.syntaxOnly,
  );
  const numLets = visible.filter(
    (s) => s.kind === "let" && s.valueType === "Number",
  );
  const target = pickPrimaryDatasetTarget(schema);

  const primarySeries = series[series.length - 1];
  const whenSeriesExpr = primarySeries
    ? `${primarySeries.name}.latest`
    : target.tableName
      ? `${target.tableName}.latest`
      : `${target.alias}.latest`;
  const matchedLet = primarySeries
    ? findUniqueNumericLetForSeries(visible, primarySeries)
    : numLets[0] ?? null;
  const thresholdExpr = matchedLet
    ? matchedLet.name
    : target.sampleMax !== undefined
      ? String(Math.round(target.sampleMax))
      : "100";

  const whenSnippet = [
    `when \${1:${whenSeriesExpr}} > \${2:${thresholdExpr}}:`,
    `then:`,
    `    alert: "\${3:Clinical condition met}", "\${4|WARNING,CRITICAL,INFO|}"`,
    `otherwise:`,
    `    \${5:suppress: within 4 hours}`,
    `end when`,
  ].join("\n");

  const filterTarget = (() => {
    for (const [path, resolved] of schema.bindings.entries()) {
      const strCol = findStringFilterColumn(resolved.table);
      if (strCol) {
        const sample = schema.getColumnSamples(resolved.tableName, strCol)
          .values[0];
        return {
          path,
          colName: strCol,
          valLiteral:
            sample !== undefined ? formatLiteralForType(sample) : '"final"',
        };
      }
    }
    const table = target.tableName
      ? schema.tablesByName.get(target.tableName)
      : undefined;
    const strCol = findStringFilterColumn(table);
    const colName = strCol ?? target.columnName ?? "status";
    const sample =
      target.tableName && colName
        ? schema.getColumnSamples(target.tableName, colName).values[0]
        : undefined;
    const valLiteral =
      sample !== undefined
        ? formatLiteralForType(sample)
        : strCol
          ? '"final"'
          : "0";
    return {
      path: target.seriesPath,
      colName,
      valLiteral,
    };
  })();

  const unusedAlias =
    deriveBindAliases(doc, schema, ctx.offset)[0] ?? target.alias;
  const bindSnippet = [
    `bind \${1:${unusedAlias}} = \${2:${filterTarget.path}} where \${3:${filterTarget.colName}} == \${4:${filterTarget.valLiteral}} within \${5:30 minutes}`,
    `end bind`,
  ].join("\n");

  return [
    {
      label: "bind",
      kind: "keyword",
      detail: "Bind a filtered clinical series (`bind alias = path`)",
      scoreInput: { base: 880 },
    },
    {
      label: "let",
      kind: "keyword",
      detail: "Declare a rule-scoped variable (`let name := expr`)",
      scoreInput: { base: 870 },
    },
    {
      label: "when",
      kind: "keyword",
      detail: "Conditional clinical rule branch (`when <cond>: then: ...`)",
      scoreInput: { base: 865 },
    },
    {
      label: "source",
      kind: "keyword",
      detail: "Bind a dataset table or binding directly",
      scoreInput: { base: 855 },
    },
    {
      label: "intent",
      kind: "keyword",
      detail: "Clinical intent description (`intent: \"...\"`)",
      scoreInput: { base: 840 },
    },
    {
      label: "terminology",
      kind: "keyword",
      detail: "Annotate clinical code (`LOINC`, `SNOMED`, `RxNorm`)",
      scoreInput: { base: 830 },
    },
    {
      label: "alert",
      kind: "keyword",
      detail: "Emit clinical alert action",
      scoreInput: { base: 820 },
    },
    {
      label: "when / otherwise",
      kind: "snippet",
      insertText: whenSnippet,
      isSnippet: true,
      detail: `Conditional block for ${whenSeriesExpr}`,
      documentation: "Evaluator-ready `when ... then ... otherwise ... end when` block.",
      scoreInput: { base: 815 },
    },
    {
      label: "suppress",
      kind: "keyword",
      detail: "Suppress duplicate alerts (`suppress: within <duration>`)",
      scoreInput: { base: 810 },
    },
    {
      label: "filtered binding",
      kind: "snippet",
      insertText: bindSnippet,
      isSnippet: true,
      detail: `Filtered bind for ${filterTarget.path}`,
      documentation: "Creates a `bind ... where ... within ... end bind` block.",
      scoreInput: { base: 805 },
    },
    {
      label: "schedule",
      kind: "keyword",
      detail: "Rule evaluation schedule (`schedule: \"every 5m\"`)",
      scoreInput: { base: 790 },
    },
    {
      label: "site",
      kind: "keyword",
      detail: "Clinical care site metadata (`site: ICU`)",
      scoreInput: { base: 770 },
    },
    {
      label: "end rule",
      kind: "keyword",
      detail: "Terminate enclosing rule block",
      scoreInput: { base: 760 },
    },
    {
      label: "for",
      kind: "keyword",
      syntaxOnly: true,
      detail: `${SYNTAX_ONLY_DETAIL} — Event iteration binding`,
      scoreInput: { base: 780 },
    },
    {
      label: "latest",
      kind: "keyword",
      syntaxOnly: true,
      detail: `${SYNTAX_ONLY_DETAIL} — Standalone latest query`,
      scoreInput: { base: 750 },
    },
  ];
}

function buildBindName(
  doc: DocumentIndex,
  schema: DatasetSchemaIndex,
  ctx: CursorContext,
): CandidateSpec[] {
  const aliases = deriveBindAliases(doc, schema, ctx.offset);
  const specs: CandidateSpec[] = aliases.map((alias, idx) => ({
    label: alias,
    kind: "variable",
    detail: "Suggested binding alias",
    scoreInput: { base: 900 - idx * 5 },
  }));

  specs.push({
    label: "site",
    kind: "keyword",
    syntaxOnly: true,
    detail: `${SYNTAX_ONLY_DETAIL} — Site metadata block (\`bind site: ...\`)`,
    scoreInput: { base: 750 },
  });
  return specs;
}

function buildBindRhs(
  schema: DatasetSchemaIndex,
  ctx: CursorContext,
): CandidateSpec[] {
  const specs: CandidateSpec[] = [];

  for (const [key, target] of schema.bindings.entries()) {
    const aliasBonus = computeBindAliasPathBonus(key, ctx.bindAlias);
    specs.push({
      label: key,
      kind: "property",
      detail: `Binding -> ${target.tableName}.${target.columnName} (${target.columnType})`,
      scoreInput: { base: 940 + aliasBonus },
    });
  }

  for (const tableName of schema.tableNames) {
    const table = schema.tablesByName.get(tableName);
    if (!table) continue;
    for (const col of table.columns ?? []) {
      const pair = `${tableName}.${col.name}`;
      const isIdOrTs =
        col.name === table.patientIdColumn ||
        col.name === table.timestampColumn;
      const isDefault = col.name === table.defaultValueColumn;
      const base = isDefault ? 895 : isIdOrTs ? 760 : 870;
      const aliasBonus = computeBindAliasPathBonus(pair, ctx.bindAlias);
      specs.push({
        label: pair,
        kind: "field",
        detail: `${tableName} column (${col.type})`,
        scoreInput: { base: base + aliasBonus },
      });
    }

    const tableAliasBonus = computeBindAliasPathBonus(tableName, ctx.bindAlias);
    specs.push({
      label: tableName,
      kind: "module",
      detail: `Dataset table (default: ${table.defaultValueColumn})`,
      scoreInput: { base: 840 + tableAliasBonus },
    });
  }

  return specs;
}

function buildWhereColumn(
  schema: DatasetSchemaIndex,
  ctx: CursorContext,
): CandidateSpec[] {
  const specs: CandidateSpec[] = [];
  const table = ctx.resolvedTableName
    ? schema.tablesByName.get(ctx.resolvedTableName)
    : undefined;

  if (table) {
    for (const col of table.columns ?? []) {
      const samples = schema.getColumnSamples(table.name, col.name);
      let sampleHint = "";
      if (samples.min !== undefined && samples.max !== undefined) {
        sampleHint = ` — range ${samples.min}..${samples.max}`;
      } else if (samples.values.length > 0) {
        const preview = samples.values
          .slice(0, 3)
          .map(formatLiteralForType)
          .join(", ");
        sampleHint = ` — e.g. ${preview}`;
      }
      const isIdOrTs =
        col.name === table.patientIdColumn ||
        col.name === table.timestampColumn;
      specs.push({
        label: col.name,
        kind: "field",
        detail: `${col.type}${sampleHint}`,
        documentation: `Column \`${col.name}\` (${col.type}) on table \`${table.name}\`${sampleHint}.`,
        scoreInput: { base: isIdOrTs ? 930 : 960 },
      });
    }
  }

  specs.push({
    label: "not",
    kind: "keyword",
    detail: "Negate filter predicate",
    scoreInput: { base: 820 },
  });
  return specs;
}

function buildWhereValue(
  doc: DocumentIndex,
  schema: DatasetSchemaIndex,
  ctx: CursorContext,
): CandidateSpec[] {
  const specs: CandidateSpec[] = [];
  const tableName = ctx.resolvedTableName;
  const colName = ctx.resolvedColumnName;
  const table = tableName ? schema.tablesByName.get(tableName) : undefined;
  const col = colName
    ? table?.columns?.find((c) => c.name === colName)
    : undefined;
  const colValueType: ValueType = col
    ? columnTypeToValueType(col.type)
    : ctx.expectedType ?? "Unknown";

  if (tableName && colName) {
    const samples = schema.getColumnSamples(tableName, colName);
    const total = Math.max(1, samples.nonNullCount);
    for (const val of samples.values) {
      if (ctx.kind === "where-string-value" && typeof val !== "string") {
        continue;
      }
      const count = samples.counts.get(val) ?? 0;
      const frequencyBonus = Math.round((count / total) * 20);
      const rawText = String(val);
      const literal =
        ctx.kind === "where-string-value" ? rawText : formatLiteralForType(val);
      const pBoost =
        ctx.kind === "where-string-value"
          ? prefixMatchBoost(ctx.prefix, rawText)
          : 0;
      specs.push({
        label: literal,
        kind: "value",
        insertText: literal,
        detail: `${col?.type ?? typeof val} sample (${count} row${count === 1 ? "" : "s"})`,
        documentation: `Observed value in \`${tableName}.${colName}\` (${count}/${total} sampled rows).`,
        scoreInput: {
          base: 930 + pBoost,
          candidateType: colValueType,
          expectedType: ctx.expectedType,
          frequencyBonus,
        },
      });
    }
  }

  if (ctx.kind === "where-value") {
    if (colValueType === "Boolean") {
      for (const b of ["true", "false"]) {
        specs.push({
          label: b,
          kind: "value",
          detail: "Boolean literal",
          scoreInput: {
            base: 860,
            candidateType: "Boolean",
            expectedType: ctx.expectedType,
          },
        });
      }
    }

    for (const sym of visibleSymbolsAt(doc, ctx.offset)) {
      if (sym.kind !== "let" && sym.kind !== "for") continue;
      specs.push({
        label: sym.name,
        kind: "variable",
        syntaxOnly: sym.syntaxOnly,
        detail: sym.syntaxOnly
          ? SYNTAX_ONLY_DETAIL
          : `let (${sym.valueType})${sym.initializerPreview ? ` = ${sym.initializerPreview}` : ""}`,
        scoreInput: {
          base: 840,
          candidateType: sym.valueType,
          expectedType: ctx.expectedType,
          candidateName: sym.name,
          lhsHintName: colName,
          localityBonus: symbolLocality(doc, sym, ctx),
        },
      });
    }
  }

  return specs;
}

function buildMemberAccess(
  doc: DocumentIndex,
  schema: DatasetSchemaIndex,
  ctx: CursorContext,
): CandidateSpec[] {
  const specs: CandidateSpec[] = [];
  const owner = ctx.memberOwner ?? "";
  const chain = ctx.memberChain ?? (owner ? owner.split(".") : []);
  const visible = visibleSymbolsAt(doc, ctx.offset);

  const headName = chain[0] ?? owner;
  const ownerSym = visible.find((s) => s.name === headName);

  if (
    ownerSym &&
    (ownerSym.kind === "bind" || ownerSym.kind === "source") &&
    !ownerSym.syntaxOnly
  ) {
    const target = ownerSym.resolvedTarget;
    const targetType = target
      ? columnTypeToValueType(target.columnType)
      : "Unknown";

    if (chain.length <= 1) {
      specs.push({
        label: "latest",
        kind: "property",
        preselect: true,
        detail: target
          ? `Latest ${target.tableName}.${target.columnName} (${target.columnType})`
          : "Latest observation value",
        scoreInput: { base: 980 },
      });

      if (
        ctx.inWhen &&
        !ctx.hasThen &&
        (targetType === "Number" || targetType === "Unknown") &&
        !isComparisonOperatorInCurrentClause(doc, ctx)
      ) {
        const matchedLet = findUniqueNumericLetForSeries(visible, ownerSym);
        if (matchedLet) {
          const expr = `latest > ${matchedLet.name}`;
          specs.push({
            label: expr,
            kind: "property",
            detail: `Compare latest reading against ${matchedLet.name}${matchedLet.initializerPreview ? ` (${matchedLet.initializerPreview})` : ""}`,
            scoreInput: { base: 970 },
          });
        }
      }

      if (target?.table) {
        for (const col of target.table.columns ?? []) {
          const isDefault = col.name === target.columnName;
          specs.push({
            label: col.name,
            kind: "field",
            detail: `${col.type} column on ${target.tableName}`,
            scoreInput: { base: isDefault ? 895 : 875 },
          });
        }
      }
      return specs;
    }

    specs.push({
      label: "latest",
      kind: "property",
      preselect: true,
      detail: `Latest ${chain[1]} observation value`,
      scoreInput: { base: 980 },
    });
    return specs;
  }

  let handledSchema = false;
  const bindingSuffixes = schema.bindingPrefixes.get(owner);
  if (bindingSuffixes && bindingSuffixes.length > 0) {
    handledSchema = true;
    for (const entry of bindingSuffixes) {
      const aliasBonus = computeBindAliasPathBonus(
        entry.fullPath,
        ctx.bindAlias,
      );
      specs.push({
        label: entry.suffix,
        kind: "property",
        detail: `Binding -> ${entry.target.tableName}.${entry.target.columnName} (${entry.target.columnType})`,
        scoreInput: { base: 950 + aliasBonus },
      });
    }
  }

  const table = schema.tablesByName.get(owner);
  if (table) {
    handledSchema = true;
    for (const col of table.columns ?? []) {
      const isDefault = col.name === table.defaultValueColumn;
      specs.push({
        label: col.name,
        kind: "field",
        detail: `${col.type} column on ${table.name}`,
        scoreInput: { base: isDefault ? 920 : 880 },
      });
    }
    if (!ctx.inBind) {
      specs.push({
        label: "latest",
        kind: "property",
        detail: `Latest ${table.name}.${table.defaultValueColumn} value`,
        scoreInput: { base: 940 },
      });
    }
  }

  if (handledSchema) {
    return specs;
  }

  for (const kw of MEMBER_KEYWORDS) {
    specs.push({
      label: kw,
      kind: "keyword",
      syntaxOnly: true,
      detail: `${SYNTAX_ONLY_DETAIL} — Member attribute`,
      scoreInput: { base: 760 },
    });
  }
  return specs;
}

function buildComparisonRhs(
  doc: DocumentIndex,
  schema: DatasetSchemaIndex,
  ctx: CursorContext,
): CandidateSpec[] {
  const specs: CandidateSpec[] = [];
  const visible = visibleSymbolsAt(doc, ctx.offset);

  for (const sym of visible) {
    if (sym.kind === "let" || sym.kind === "for") {
      specs.push({
        label: sym.name,
        kind: "variable",
        syntaxOnly: sym.syntaxOnly,
        detail: sym.syntaxOnly
          ? SYNTAX_ONLY_DETAIL
          : `let (${sym.valueType})${sym.initializerPreview ? ` = ${sym.initializerPreview}` : ""}`,
        scoreInput: {
          base: 920,
          candidateType: sym.valueType,
          expectedType: ctx.expectedType,
          candidateName: sym.name,
          lhsHintName: ctx.lhsHintName,
          localityBonus: symbolLocality(doc, sym, ctx),
        },
      });
    } else if (
      (sym.kind === "bind" || sym.kind === "source") &&
      !sym.syntaxOnly
    ) {
      const valType = seriesValueType(sym);
      const isSameSeries = sym.name === ctx.lhsHintName;
      specs.push({
        label: `${sym.name}.latest`,
        kind: "property",
        detail: sym.resolvedTarget
          ? `Latest ${sym.resolvedTarget.tableName}.${sym.resolvedTarget.columnName} (${sym.resolvedTarget.columnType})`
          : "Latest series value",
        scoreInput: {
          base: isSameSeries ? 760 : 880,
          candidateType: valType,
          expectedType: ctx.expectedType,
          candidateName: sym.name,
          lhsHintName: ctx.lhsHintName,
          localityBonus: symbolLocality(doc, sym, ctx),
        },
      });
    }
  }

  if (ctx.lhsHintName) {
    const hintSym = visible.find((s) => s.name === ctx.lhsHintName);
    const resolved =
      hintSym?.resolvedTarget ?? schema.resolvePath(ctx.lhsHintName);
    if (resolved) {
      const samples = schema.getColumnSamples(
        resolved.tableName,
        resolved.columnName,
      );
      const valType = columnTypeToValueType(resolved.columnType);
      if (samples.min !== undefined) {
        const minStr = String(samples.min);
        specs.push({
          label: minStr,
          kind: "value",
          detail: `Observed min in ${resolved.tableName}.${resolved.columnName}`,
          scoreInput: {
            base: 800,
            candidateType: valType,
            expectedType: ctx.expectedType,
          },
        });
      }
      if (samples.max !== undefined && samples.max !== samples.min) {
        const maxStr = String(samples.max);
        specs.push({
          label: maxStr,
          kind: "value",
          detail: `Observed max in ${resolved.tableName}.${resolved.columnName}`,
          scoreInput: {
            base: 795,
            candidateType: valType,
            expectedType: ctx.expectedType,
          },
        });
      }
      if (samples.min === undefined && samples.values.length > 0) {
        const total = Math.max(1, samples.nonNullCount);
        for (const val of samples.values.slice(0, 5)) {
          const lit = formatLiteralForType(val);
          const count = samples.counts.get(val) ?? 0;
          specs.push({
            label: lit,
            kind: "value",
            detail: `Observed in ${resolved.tableName}.${resolved.columnName}`,
            scoreInput: {
              base: 800,
              candidateType: valType,
              expectedType: ctx.expectedType,
              frequencyBonus: Math.round((count / total) * 20),
            },
          });
        }
      }
    }
  }

  return specs;
}

function buildWhenConditionStart(
  doc: DocumentIndex,
  ctx: CursorContext,
): CandidateSpec[] {
  const specs: CandidateSpec[] = [];
  const visible = visibleSymbolsAt(doc, ctx.offset);

  for (const sym of visible) {
    if ((sym.kind === "bind" || sym.kind === "source") && !sym.syntaxOnly) {
      specs.push({
        label: `${sym.name}.latest`,
        kind: "property",
        detail: sym.resolvedTarget
          ? `${sym.resolvedTarget.tableName}.${sym.resolvedTarget.columnName} (${sym.resolvedTarget.columnType})`
          : "Bound series latest value",
        scoreInput: {
          base: 940,
          localityBonus: symbolLocality(doc, sym, ctx),
        },
      });
    } else if (sym.kind === "let" || sym.kind === "for") {
      specs.push({
        label: sym.name,
        kind: "variable",
        syntaxOnly: sym.syntaxOnly,
        detail: sym.syntaxOnly
          ? SYNTAX_ONLY_DETAIL
          : `let (${sym.valueType})${sym.initializerPreview ? ` = ${sym.initializerPreview}` : ""}`,
        scoreInput: {
          base: sym.valueType === "Boolean" ? 910 : 880,
          localityBonus: symbolLocality(doc, sym, ctx),
        },
      });
    }
  }

  specs.push({
    label: "not",
    kind: "keyword",
    detail: "Logical negation",
    scoreInput: { base: 850 },
  });
  return specs;
}

function buildWhenConditionAfterOperand(): CandidateSpec[] {
  const cmpOps: readonly [string, string, number][] = [
    [">", "Greater than comparison", 910],
    ["<", "Less than comparison", 908],
    [">=", "Greater than or equal comparison", 906],
    ["<=", "Less than or equal comparison", 904],
    ["==", "Equality comparison", 902],
    ["!=", "Inequality comparison", 900],
  ];
  const arithOps: readonly [string, string, number][] = [
    ["+", "Addition", 830],
    ["-", "Subtraction", 825],
    ["*", "Multiplication", 820],
    ["/", "Division", 815],
  ];

  const specs: CandidateSpec[] = [];
  for (const [op, detail, base] of cmpOps) {
    specs.push({ label: op, kind: "operator", detail, scoreInput: { base } });
  }
  for (const [op, detail, base] of arithOps) {
    specs.push({ label: op, kind: "operator", detail, scoreInput: { base } });
  }
  specs.push(
    {
      label: "and",
      kind: "keyword",
      detail: "Logical conjunction",
      scoreInput: { base: 880 },
    },
    {
      label: "or",
      kind: "keyword",
      detail: "Logical disjunction",
      scoreInput: { base: 875 },
    },
    {
      label: "within",
      kind: "keyword",
      detail: "Temporal recency constraint (`within 15 minutes`)",
      scoreInput: { base: 860 },
    },
    {
      label: "then:",
      kind: "keyword",
      detail: "Begin `then:` action branch",
      scoreInput: { base: 855 },
    },
  );
  return specs;
}

function buildAlertArg(
  doc: DocumentIndex,
  ctx: CursorContext,
): CandidateSpec[] {
  const argIdx = ctx.alertArgIndex ?? 0;
  const specs: CandidateSpec[] = [];

  if (argIdx === 0) {
    specs.push(
      {
        label: '"Alert message"',
        kind: "snippet",
        insertText: '"${1:Alert triggered}", "${2|WARNING,CRITICAL,INFO|}"',
        isSnippet: true,
        detail: "Alert message and severity",
        scoreInput: { base: 920 },
      },
      {
        label: "level:",
        kind: "keyword",
        insertText: "level: ",
        syntaxOnly: true,
        detail: `${SYNTAX_ONLY_DETAIL} — Alert level prefix`,
        scoreInput: { base: 750 },
      },
    );
    return specs;
  }

  if (argIdx === 1) {
    specs.push(
      {
        label: '"WARNING"',
        kind: "enumMember",
        preselect: true,
        detail: "Standard warning alert severity",
        scoreInput: { base: 950 },
      },
      {
        label: '"CRITICAL"',
        kind: "enumMember",
        detail: "Critical clinical alert severity",
        scoreInput: { base: 930 },
      },
      {
        label: '"INFO"',
        kind: "enumMember",
        detail: "Informational alert severity",
        scoreInput: { base: 910 },
      },
    );
  }

  for (const sym of visibleSymbolsAt(doc, ctx.offset)) {
    if ((sym.kind === "bind" || sym.kind === "source") && !sym.syntaxOnly) {
      specs.push({
        label: `${sym.name}.latest`,
        kind: "property",
        detail: "Include series latest reading in alert payload",
        scoreInput: {
          base: argIdx >= 2 ? 920 : 840,
          localityBonus: symbolLocality(doc, sym, ctx),
        },
      });
    } else if (sym.kind === "let" || sym.kind === "for") {
      specs.push({
        label: sym.name,
        kind: "variable",
        syntaxOnly: sym.syntaxOnly,
        detail: sym.syntaxOnly
          ? SYNTAX_ONLY_DETAIL
          : "Include variable in alert payload",
        scoreInput: {
          base: argIdx >= 2 ? 890 : 820,
          localityBonus: symbolLocality(doc, sym, ctx),
        },
      });
    }
  }
  return specs;
}

function buildTerminologyCode(ctx: CursorContext, doc: DocumentIndex): CandidateSpec[] {
  const matches = searchTerms(ctx.prefix, ctx.terminologySystem);
  const insideQuotes = isInsideQuotesBeforeCursor(doc, ctx);
  const sysInfo = ctx.terminologySystem
    ? TERMINOLOGY_SYSTEMS[ctx.terminologySystem]
    : undefined;

  return matches.map((entry, idx) => {
    const deprecatedNote = entry.deprecated ? " (deprecated)" : "";
    const detail = `${entry.description}${deprecatedNote}`;
    const documentation = [
      `**${entry.system}** \`${entry.code}\``,
      entry.description,
      sysInfo ? sysInfo.uri : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const filterParts = [entry.code, entry.description, ...(entry.aliases ?? [])];
    return {
      label: entry.code,
      kind: "enumMember",
      insertText: insideQuotes ? entry.code : JSON.stringify(entry.code),
      detail,
      documentation,
      filterText: filterParts.join(" "),
      scoreInput: {
        base: (entry.deprecated ? 860 : 950) - Math.min(200, idx * 2),
      },
    };
  });
}

function buildLetName(
  doc: DocumentIndex,
  ctx: CursorContext,
): CandidateSpec[] {
  const visible = visibleSymbolsAt(doc, ctx.offset);
  const used = new Set(visible.map((s) => s.name));
  const specs: CandidateSpec[] = [];

  if (!used.has("threshold")) {
    specs.push({
      label: "threshold",
      kind: "variable",
      detail: "Suggested threshold variable name",
      scoreInput: { base: 900 },
    });
  }

  let idx = 0;
  for (const sym of visible) {
    if ((sym.kind !== "bind" && sym.kind !== "source") || sym.syntaxOnly) {
      continue;
    }
    const stem = extractStems(sym.name)[0] ?? sym.name;
    for (const candidate of [`${stem}_crit`, `max_${stem}`, `min_${stem}`]) {
      if (used.has(candidate)) continue;
      used.add(candidate);
      specs.push({
        label: candidate,
        kind: "variable",
        detail: `Suggested threshold name for ${sym.name}`,
        scoreInput: { base: 880 - idx * 3 },
      });
      idx++;
    }
  }
  return specs;
}

function buildLetRhs(
  doc: DocumentIndex,
  ctx: CursorContext,
): CandidateSpec[] {
  const specs: CandidateSpec[] = [];
  for (const sym of visibleSymbolsAt(doc, ctx.offset)) {
    if ((sym.kind === "bind" || sym.kind === "source") && !sym.syntaxOnly) {
      specs.push({
        label: `${sym.name}.latest`,
        kind: "property",
        detail: sym.resolvedTarget
          ? `Latest ${sym.resolvedTarget.tableName}.${sym.resolvedTarget.columnName}`
          : "Latest series reading",
        scoreInput: {
          base: 920,
          localityBonus: symbolLocality(doc, sym, ctx),
        },
      });
    } else if (sym.kind === "let" || sym.kind === "for") {
      specs.push({
        label: sym.name,
        kind: "variable",
        syntaxOnly: sym.syntaxOnly,
        detail: sym.syntaxOnly
          ? SYNTAX_ONLY_DETAIL
          : `let (${sym.valueType})${sym.initializerPreview ? ` = ${sym.initializerPreview}` : ""}`,
        scoreInput: {
          base: 880,
          candidateType: sym.valueType,
          expectedType: ctx.expectedType,
          localityBonus: symbolLocality(doc, sym, ctx),
        },
      });
    }
  }

  specs.push({
    label: "latest",
    kind: "keyword",
    syntaxOnly: true,
    detail: `${SYNTAX_ONLY_DETAIL} — Standalone latest expression`,
    scoreInput: { base: 750 },
  });
  return specs;
}

function buildWithinUnit(ctx: CursorContext): CandidateSpec[] {
  const specs: CandidateSpec[] = [];
  const preferMinutes =
    ctx.withinNumber !== undefined && SHORT_MINUTE_PRESETS.has(ctx.withinNumber);

  EXECUTOR_TIME_UNITS.forEach((unit, idx) => {
    const isPrimary = PRIMARY_TIME_UNITS.has(unit);
    let base = isPrimary ? 920 - idx * 2 : 860 - idx;
    if (preferMinutes && unit === "minutes") {
      base += 10;
    }
    specs.push({
      label: unit,
      kind: "unit",
      detail: "Duration unit",
      scoreInput: { base },
    });
  });

  PARSER_ONLY_TIME_UNITS.forEach((unit, idx) => {
    specs.push({
      label: unit,
      kind: "unit",
      syntaxOnly: true,
      detail: `${SYNTAX_ONLY_DETAIL} — Calendar duration unit`,
      scoreInput: { base: 760 - idx },
    });
  });

  return specs;
}

/**
 * Generates and ranks context-aware completion candidates for the cursor slot.
 */
export function buildCompletions(
  doc: DocumentIndex,
  schema: DatasetSchemaIndex,
  ctx: CursorContext,
  mru: MruTracker,
  filename: string,
): CompletionCandidate[] {
  let specs: CandidateSpec[];

  switch (ctx.kind) {
    case "comment":
    case "string-literal":
      return [];

    case "top-level":
      specs = buildTopLevel(schema, filename);
      break;

    case "rule-name": {
      const derived = filenameToRuleName(filename);
      specs = [
        {
          label: derived,
          kind: "class",
          detail: "Rule name derived from active file",
          scoreInput: { base: 940 },
        },
      ];
      if (derived !== "ClinicalAlertRule") {
        specs.push({
          label: "ClinicalAlertRule",
          kind: "class",
          detail: "Default rule identifier",
          scoreInput: { base: 840 },
        });
      }
      break;
    }

    case "rule-body":
      specs = buildRuleBody(doc, schema, ctx);
      break;

    case "bind-name":
      specs = buildBindName(doc, schema, ctx);
      break;

    case "bind-rhs":
      specs = buildBindRhs(schema, ctx);
      break;

    case "bind-clause":
      specs = [
        {
          label: "where",
          kind: "keyword",
          detail: "Filter series rows (`where column == value`)",
          scoreInput: { base: 900 },
        },
        {
          label: "within",
          kind: "keyword",
          detail: "Restrict temporal window (`within 30 minutes`)",
          scoreInput: { base: 870 },
        },
        {
          label: "end bind",
          kind: "keyword",
          detail: "Close bind block",
          scoreInput: { base: 840 },
        },
      ];
      break;

    case "bind-site-body":
      specs = [
        {
          label: "site",
          kind: "keyword",
          syntaxOnly: true,
          detail: `${SYNTAX_ONLY_DETAIL} — Site identifier`,
          scoreInput: { base: 860 },
        },
        {
          label: "source",
          kind: "keyword",
          syntaxOnly: true,
          detail: `${SYNTAX_ONLY_DETAIL} — Site data source`,
          scoreInput: { base: 840 },
        },
        {
          label: "terminology",
          kind: "keyword",
          syntaxOnly: true,
          detail: `${SYNTAX_ONLY_DETAIL} — Site terminology`,
          scoreInput: { base: 820 },
        },
        {
          label: "end bind",
          kind: "keyword",
          detail: "Close bind site block",
          scoreInput: { base: 800 },
        },
      ];
      break;

    case "source-target":
      specs = [
        ...schema.tableNames.map((name, idx) => {
          const table = schema.tablesByName.get(name);
          return {
            label: name,
            kind: "module" as const,
            detail: table
              ? `Dataset table (${table.columns?.length ?? 0} cols, default: ${table.defaultValueColumn})`
              : "Dataset table",
            scoreInput: { base: 920 - idx * 2 },
          };
        }),
        ...Array.from(schema.bindings.entries()).map(([key, target], idx) => ({
          label: key,
          kind: "property" as const,
          detail: `Binding -> ${target.tableName}.${target.columnName}`,
          scoreInput: { base: 890 - idx * 2 },
        })),
        {
          label: "EHR",
          kind: "value",
          detail: "External EHR adapter metadata (`EHR -> FHIR_R4`)",
          scoreInput: { base: 780 },
        },
      ];
      break;

    case "source-arrow":
      specs = [
        {
          label: "FHIR_R4",
          kind: "enumMember",
          detail: "HL7 FHIR Release 4 source standard",
          scoreInput: { base: 900 },
        },
        {
          label: "HL7v2",
          kind: "enumMember",
          detail: "HL7 v2 messaging source standard",
          scoreInput: { base: 880 },
        },
        {
          label: "OMOP",
          kind: "enumMember",
          detail: "OMOP Common Data Model source standard",
          scoreInput: { base: 860 },
        },
      ];
      break;

    case "let-name":
      specs = buildLetName(doc, ctx);
      break;

    case "let-rhs":
      specs = buildLetRhs(doc, ctx);
      break;

    case "where-column":
      specs = buildWhereColumn(schema, ctx);
      break;

    case "where-value":
    case "where-string-value":
      specs = buildWhereValue(doc, schema, ctx);
      break;

    case "member-access":
      specs = buildMemberAccess(doc, schema, ctx);
      break;

    case "when-condition-start":
      specs = buildWhenConditionStart(doc, ctx);
      break;

    case "when-condition-after-operand":
      specs = buildWhenConditionAfterOperand();
      break;

    case "comparison-rhs":
      specs = buildComparisonRhs(doc, schema, ctx);
      break;

    case "branch-body":
      specs = [
        {
          label: "alert",
          kind: "keyword",
          detail: "Emit alert action",
          scoreInput: { base: 900 },
        },
        {
          label: "suppress",
          kind: "keyword",
          detail: "Suppress repeated alerts (`within <duration>`)",
          scoreInput: { base: 880 },
        },
        {
          label: "let",
          kind: "keyword",
          detail: "Declare branch-local variable",
          scoreInput: { base: 860 },
        },
        {
          label: "alert snippet",
          kind: "snippet",
          insertText: 'alert: "${1:Alert triggered}", "${2|WARNING,CRITICAL,INFO|}"',
          isSnippet: true,
          detail: "Alert message and severity template",
          scoreInput: { base: 850 },
        },
        {
          label: "when",
          kind: "keyword",
          detail: "Nested conditional block",
          scoreInput: { base: 830 },
        },
        ...(ctx.hasOtherwise
          ? []
          : [
              {
                label: "otherwise",
                kind: "keyword" as const,
                detail: "Fallback branch when condition is not true",
                scoreInput: { base: 810 },
              },
            ]),
        {
          label: "end when",
          kind: "keyword",
          detail: "Close enclosing `when` block",
          scoreInput: { base: 790 },
        },
      ];
      break;

    case "alert-arg":
      specs = buildAlertArg(doc, ctx);
      break;

    case "alert-severity-string":
      specs = [
        {
          label: "WARNING",
          kind: "enumMember",
          preselect: true,
          detail: "Standard warning alert severity",
          scoreInput: {
            base: 960 + prefixMatchBoost(ctx.prefix, "WARNING"),
          },
        },
        {
          label: "CRITICAL",
          kind: "enumMember",
          detail: "Critical clinical alert severity",
          scoreInput: {
            base: 940 + prefixMatchBoost(ctx.prefix, "CRITICAL"),
          },
        },
        {
          label: "INFO",
          kind: "enumMember",
          detail: "Informational alert severity",
          scoreInput: {
            base: 920 + prefixMatchBoost(ctx.prefix, "INFO"),
          },
        },
      ];
      break;

    case "suppress-operand":
      specs = [
        {
          label: "within",
          kind: "keyword",
          detail: "Suppression time window (`within 4 hours`)",
          scoreInput: { base: 920 },
        },
        {
          label: "within 1 hours",
          kind: "value",
          detail: "Suppress repeats for 1 hour",
          scoreInput: { base: 895 },
        },
        {
          label: "within 4 hours",
          kind: "value",
          detail: "Suppress repeats for 4 hours",
          scoreInput: { base: 890 },
        },
        {
          label: "within 6 hours",
          kind: "value",
          detail: "Suppress repeats for 6 hours",
          scoreInput: { base: 885 },
        },
        {
          label: "within 24 hours",
          kind: "value",
          detail: "Suppress repeats for 24 hours",
          scoreInput: { base: 880 },
        },
        {
          label: '"reason"',
          kind: "snippet",
          insertText: '"${1:Suppression reason}"',
          isSnippet: true,
          detail: "Suppression reason string",
          scoreInput: { base: 820 },
        },
        {
          label: "repeat_of:",
          kind: "keyword",
          insertText: "repeat_of: ",
          syntaxOnly: true,
          detail: `${SYNTAX_ONLY_DETAIL} — Suppress repeats of a target rule`,
          scoreInput: { base: 750 },
        },
      ];
      break;

    case "suppress-repeat-target":
      specs = doc.symbols
        .filter((s) => s.kind === "rule")
        .map((sym, idx) => ({
          label: sym.name,
          kind: "class" as const,
          detail: "Declared rule in document",
          scoreInput: { base: 940 - idx * 2 },
        }));
      break;

    case "within-amount":
      specs = [
        "15 minutes",
        "30 minutes",
        "1 hours",
        "4 hours",
        "6 hours",
        "24 hours",
        "7 days",
      ].map((preset, idx) => ({
        label: preset,
        kind: "unit" as const,
        detail: "Duration preset",
        scoreInput: { base: 910 - idx * 5 },
      }));
      break;

    case "within-unit":
      specs = buildWithinUnit(ctx);
      break;

    case "within-post":
      specs = [
        {
          label: "before now",
          kind: "keyword",
          detail: "Anchor window relative to evaluation clock",
          scoreInput: { base: 900 },
        },
        ...(ctx.inBind
          ? [
              {
                label: "end bind",
                kind: "keyword" as const,
                detail: "Close bind block",
                scoreInput: { base: 880 },
              },
            ]
          : []),
        ...(ctx.inWhen && !ctx.hasThen
          ? [
              {
                label: "then:",
                kind: "keyword" as const,
                detail: "Begin `then:` action branch",
                scoreInput: { base: 880 },
              },
              {
                label: "and",
                kind: "keyword" as const,
                detail: "Logical conjunction",
                scoreInput: { base: 840 },
              },
              {
                label: "or",
                kind: "keyword" as const,
                detail: "Logical disjunction",
                scoreInput: { base: 835 },
              },
            ]
          : []),
      ];
      break;

    case "terminology-system":
      specs = [
        {
          label: "LOINC",
          kind: "snippet",
          insertText: 'LOINC("${1:2339-0}")',
          isSnippet: true,
          detail: "LOINC laboratory & clinical observation codes",
          documentation: TERMINOLOGY_SYSTEMS.LOINC.uri,
          scoreInput: { base: 880 },
        },
        {
          label: "SNOMED",
          kind: "snippet",
          insertText: 'SNOMED("${1:91302008}")',
          isSnippet: true,
          detail: "SNOMED-CT clinical disorder & procedure codes",
          documentation: TERMINOLOGY_SYSTEMS.SNOMED.uri,
          scoreInput: { base: 860 },
        },
        {
          label: "RxNorm",
          kind: "snippet",
          insertText: 'RxNorm("${1:860975}")',
          isSnippet: true,
          detail: "RxNorm normalized medication codes",
          documentation: TERMINOLOGY_SYSTEMS.RxNorm.uri,
          scoreInput: { base: 840 },
        },
      ];
      break;

    case "terminology-code":
      specs = buildTerminologyCode(ctx, doc);
      break;

    case "end-block":
      if (ctx.expectedBlockEnd) {
        specs = [
          {
            label: ctx.expectedBlockEnd,
            kind: "keyword",
            preselect: true,
            detail: `Close innermost open \`${ctx.expectedBlockEnd}\` block`,
            scoreInput: { base: 1000 },
          },
        ];
      } else {
        specs = [
          {
            label: "rule",
            kind: "keyword",
            detail: "Close `rule` block",
            scoreInput: { base: 820 },
          },
          {
            label: "when",
            kind: "keyword",
            detail: "Close `when` block",
            scoreInput: { base: 810 },
          },
          {
            label: "bind",
            kind: "keyword",
            detail: "Close `bind` block",
            scoreInput: { base: 800 },
          },
        ];
      }
      break;

    default:
      return assertNever(ctx.kind);
  }

  return finalizeCandidates(specs, ctx, mru);
}
