export type ColumnType =
  | "String"
  | "Integer"
  | "Float"
  | "Boolean"
  | "DateTime";
export type Cell = string | number | boolean | null;
export interface Column {
  name: string;
  type: ColumnType;
}
export interface Table {
  name: string;
  patientIdColumn: string;
  timestampColumn: string;
  defaultValueColumn: string;
  columns: Column[];
  rows: Record<string, Cell>[];
}
export interface Dataset {
  schemaVersion: 1;
  evaluationTime: string;
  Bindings: Record<string, string | { table: string; column?: string }>;
  tables: Table[];
}
export interface Diagnostic {
  severity: "error" | "warning" | "info";
  category: string;
  code: string;
  message: string;
  startOffset?: number;
  endOffset?: number;
  tableName?: string;
  rowIndex?: number;
  columnName?: string;
  line?: number;
  column?: number;
}
export interface Token {
  index: number;
  type: string;
  category: string;
  lexeme: string;
  line: number;
  column: number;
  startOffset: number;
  endOffset: number;
}
export interface Analysis {
  schemaVersion: 1;
  success: boolean;
  tokenCount: number;
  lexicalErrorCount: number;
  syntaxErrorCount: number;
  warningCount: number;
  tokens: Token[];
  diagnostics: Diagnostic[];
  summary: string;
}
export interface Resolved {
  expression: string;
  table: string;
  column: string;
  rowIndex: number | null;
  timestamp: string | null;
  type: string;
  value: Cell;
  reason?: string;
}
export interface Condition {
  conditionId: string;
  conditionText: string;
  outcome: "TRUE" | "FALSE" | "UNKNOWN";
  startOffset: number;
  endOffset: number;
  resolvedValues: Resolved[];
}
export interface Action {
  kind: "alert" | "suppress";
  conditionId: string | null;
  message?: string;
  severity?: string;
  payload?: Cell[];
  durationMs?: number | null;
  reason?: string | null;
  simulated?: boolean;
}
export interface PatientResult {
  ruleId: string;
  ruleName: string;
  patientId: string;
  conditions: Condition[];
  actions: Action[];
  diagnostics: Diagnostic[];
}
export interface Evaluation {
  schemaVersion: 1;
  success: boolean;
  analysisSuccess: boolean;
  evaluationTime: string | null;
  results: PatientResult[];
  diagnostics: Diagnostic[];
}
export interface Workspace {
  version: 1;
  source: string;
  filename: string;
  dataset: Dataset;
  autoAnalyze: boolean;
  fontSize: number;
}
