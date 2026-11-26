import type {
  Cell,
  ColumnType,
  Dataset,
  Diagnostic,
  Table,
} from "../../services/types";

export type { Cell, ColumnType, Dataset, Diagnostic, Table };

/**
 * Exact 21 HELIX reserved keywords matching src/keywords.c.
 */
export const HELIX_KEYWORDS: readonly string[] = [
  "rule",
  "intent",
  "bind",
  "site",
  "source",
  "terminology",
  "schedule",
  "when",
  "for",
  "let",
  "latest",
  "where",
  "and",
  "or",
  "not",
  "within",
  "then",
  "alert",
  "suppress",
  "otherwise",
  "end",
];

export const HELIX_KEYWORD_SET: ReadonlySet<string> = new Set(HELIX_KEYWORDS);

export const EXECUTOR_TIME_UNITS: readonly string[] = [
  "minutes",
  "hours",
  "days",
  "seconds",
  "weeks",
  "m",
  "h",
  "d",
  "s",
  "w",
  "minute",
  "hour",
  "day",
  "second",
  "week",
  "min",
  "mins",
  "hr",
  "hrs",
  "sec",
  "secs",
  "wk",
  "wks",
];

export const PARSER_ONLY_TIME_UNITS: readonly string[] = [
  "months",
  "month",
  "years",
  "year",
];

export const MEMBER_KEYWORDS: ReadonlySet<string> = new Set([
  "latest",
  "source",
  "site",
  "schedule",
  "terminology",
]);

/**
 * 1-based UTF-16 position compatible with Monaco IPosition.
 */
export interface TextPosition {
  lineNumber: number;
  column: number;
}

/**
 * 1-based UTF-16 range compatible with Monaco IRange.
 */
export interface TextRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export type LexTokenKind =
  | "keyword"
  | "identifier"
  | "int"
  | "float"
  | "string"
  | "unterminated_string"
  | "operator"
  | "delimiter"
  | "error"
  | "eof";

export interface LexToken {
  kind: LexTokenKind;
  lexeme: string;
  startOffset: number;
  endOffset: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface LexComment {
  startOffset: number;
  endOffset: number;
  line: number;
  column: number;
  text: string;
}

export interface LexResult {
  tokens: LexToken[];
  comments: LexComment[];
  lineStarts: number[];
}

export type ValueType =
  | "Number"
  | "String"
  | "Boolean"
  | "DateTime"
  | "Series"
  | "Unknown";

export interface ResolvedBinding {
  path: string;
  tableName: string;
  columnName: string;
  columnType: ColumnType;
  table: Table;
}

export type BlockKind = "rule" | "bind" | "bind-site" | "when";

export interface BlockNode {
  index: number;
  kind: BlockKind;
  name?: string;
  openOffset: number;
  closeOffset: number | null;
  headerRange: TextRange;
  fullRange: TextRange;
  thenOffset: number | null;
  otherwiseOffset: number | null;
  parentIndex: number | null;
  syntheticClosed?: boolean;
  conditionPreview?: string;
}

export type SymbolKindTag = "rule" | "source" | "bind" | "let" | "for";

export interface SymbolEntry {
  index: number;
  kind: SymbolKindTag;
  name: string;
  nameRange: TextRange;
  declarationRange: TextRange;
  scopeStartOffset: number;
  scopeEndOffset: number;
  valueType: ValueType;
  resolvedTarget?: ResolvedBinding;
  sourcePath?: string;
  whereText?: string;
  withinText?: string;
  initializerPreview?: string;
  syntaxOnly?: boolean;
}

export type TerminologySystem = "LOINC" | "SNOMED" | "RxNorm";

export interface TerminologyOccurrence {
  system: TerminologySystem;
  code: string;
  range: TextRange;
  codeRange: TextRange;
  startOffset: number;
  endOffset: number;
}

export interface IdentifierRef {
  name: string;
  range: TextRange;
  startOffset: number;
  endOffset: number;
  symbolIndex: number | null;
  isDeclaration: boolean;
  memberOf?: string;
}

export interface DocumentIndex {
  source: string;
  tokens: LexToken[];
  comments: LexComment[];
  lineStarts: number[];
  blocks: BlockNode[];
  symbols: SymbolEntry[];
  terminologyCalls: TerminologyOccurrence[];
  references: IdentifierRef[];
  largeFileDegraded: boolean;
}

export interface HelixLanguageSettings {
  inlinePredictions: boolean;
  autoSuggest: boolean;
}

export interface HelixLanguageHost {
  getDataset: () => Dataset;
  getSettings: () => HelixLanguageSettings;
  getFilename: () => string;
  getDiagnostics?: () => Diagnostic[];
}
