import type {
  Cell,
  Column,
  ColumnType,
  Dataset,
  Table,
} from "../../services/types";
import type { ResolvedBinding, ValueType } from "./types";

export type { ResolvedBinding };

export interface BindingSuffixEntry {
  prefix: string;
  suffix: string;
  fullPath: string;
  target: ResolvedBinding;
}

export interface ColumnSampleSummary {
  values: Cell[];
  counts: Map<Cell, number>;
  nonNullCount: number;
  missingCount: number;
  min?: number;
  max?: number;
}

export interface DatasetSchemaIndex {
  readonly tablesByName: ReadonlyMap<string, Table>;
  readonly tableNames: readonly string[];
  readonly bindings: ReadonlyMap<string, ResolvedBinding>;
  readonly bindingPrefixes: ReadonlyMap<string, readonly BindingSuffixEntry[]>;
  resolvePath(path: string): ResolvedBinding | null;
  getColumnSamples(tableName: string, columnName: string): ColumnSampleSummary;
}

const MAX_SAMPLE_ROWS = 200;
const MAX_DISTINCT_VALUES = 20;

const schemaCache = new WeakMap<Dataset, DatasetSchemaIndex>();

/**
 * Maps a dataset ColumnType to a HELIX IntelliSense ValueType.
 */
export function columnTypeToValueType(type: ColumnType): ValueType {
  switch (type) {
    case "Integer":
    case "Float":
      return "Number";
    case "String":
      return "String";
    case "Boolean":
      return "Boolean";
    case "DateTime":
      return "DateTime";
    default:
      return "Unknown";
  }
}

function findColumn(table: Table, columnName: string | undefined): Column | null {
  if (!columnName || !Array.isArray(table.columns)) return null;
  for (const col of table.columns) {
    if (col.name === columnName) return col;
  }
  return null;
}

function resolveExplicitBinding(
  path: string,
  entry: unknown,
  tablesByName: ReadonlyMap<string, Table>,
): ResolvedBinding | null {
  let tableName: string | undefined;
  let columnName: string | undefined;

  if (typeof entry === "string") {
    tableName = entry;
  } else if (entry && typeof entry === "object") {
    const obj = entry as { table?: unknown; column?: unknown };
    if (typeof obj.table === "string") tableName = obj.table;
    if (typeof obj.column === "string") columnName = obj.column;
  }

  if (!tableName) return null;
  const table = tablesByName.get(tableName);
  if (!table) return null;

  const targetColumnName = columnName || table.defaultValueColumn;
  const column = findColumn(table, targetColumnName);
  if (!column) return null;

  return {
    path,
    tableName: table.name,
    columnName: column.name,
    columnType: column.type,
    table,
  };
}

function sampleTableColumn(
  table: Table,
  column: Column,
): ColumnSampleSummary {
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const limit = Math.min(rows.length, MAX_SAMPLE_ROWS);
  const allCounts = new Map<Cell, number>();
  const isNumeric = column.type === "Integer" || column.type === "Float";

  let nonNullCount = 0;
  let missingCount = 0;
  let min: number | undefined;
  let max: number | undefined;

  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    const raw = row ? row[column.name] : undefined;
    if (raw === null || raw === undefined) {
      missingCount += 1;
      continue;
    }

    nonNullCount += 1;
    allCounts.set(raw, (allCounts.get(raw) ?? 0) + 1);

    if (isNumeric && typeof raw === "number" && Number.isFinite(raw)) {
      if (min === undefined || raw < min) min = raw;
      if (max === undefined || raw > max) max = raw;
    }
  }

  const sorted = Array.from(allCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_DISTINCT_VALUES);

  const values = sorted.map(([value]) => value);
  const counts = new Map<Cell, number>(sorted);

  const summary: ColumnSampleSummary = {
    values,
    counts,
    nonNullCount,
    missingCount,
  };
  if (min !== undefined) summary.min = min;
  if (max !== undefined) summary.max = max;
  return summary;
}

function buildDatasetSchemaIndex(dataset: Dataset): DatasetSchemaIndex {
  const tables = Array.isArray(dataset?.tables) ? dataset.tables : [];
  const tablesByName = new Map<string, Table>();
  const tableNames: string[] = [];

  for (const table of tables) {
    if (table && typeof table.name === "string" && !tablesByName.has(table.name)) {
      tablesByName.set(table.name, table);
      tableNames.push(table.name);
    }
  }

  const rawBindings: Record<string, unknown> =
    dataset?.Bindings && typeof dataset.Bindings === "object"
      ? (dataset.Bindings as Record<string, unknown>)
      : {};

  const bindings = new Map<string, ResolvedBinding>();
  const bindingPrefixes = new Map<string, BindingSuffixEntry[]>();

  for (const [key, value] of Object.entries(rawBindings)) {
    const resolved = resolveExplicitBinding(key, value, tablesByName);
    if (!resolved) continue;
    bindings.set(key, resolved);

    const lastDot = key.lastIndexOf(".");
    if (lastDot > 0 && lastDot < key.length - 1) {
      const prefix = key.slice(0, lastDot);
      const suffix = key.slice(lastDot + 1);
      const list = bindingPrefixes.get(prefix) ?? [];
      list.push({ prefix, suffix, fullPath: key, target: resolved });
      bindingPrefixes.set(prefix, list);
    }
  }

  const sampleCache = new Map<string, ColumnSampleSummary>();

  function resolvePath(path: string): ResolvedBinding | null {
    if (!path) return null;

    if (Object.prototype.hasOwnProperty.call(rawBindings, path)) {
      return bindings.get(path) ?? null;
    }

    const lastDot = path.lastIndexOf(".");
    if (lastDot !== -1) {
      const tableName = path.slice(0, lastDot);
      const colName = path.slice(lastDot + 1);
      const table = tablesByName.get(tableName);
      if (!table) return null;
      const column = findColumn(table, colName);
      if (!column) return null;
      return {
        path,
        tableName: table.name,
        columnName: column.name,
        columnType: column.type,
        table,
      };
    }

    const table = tablesByName.get(path);
    if (!table) return null;
    const column = findColumn(table, table.defaultValueColumn);
    if (!column) return null;
    return {
      path,
      tableName: table.name,
      columnName: column.name,
      columnType: column.type,
      table,
    };
  }

  function getColumnSamples(
    tableName: string,
    columnName: string,
  ): ColumnSampleSummary {
    const cacheKey = `${tableName}\0${columnName}`;
    const cached = sampleCache.get(cacheKey);
    if (cached) return cached;

    const table = tablesByName.get(tableName);
    const column = table ? findColumn(table, columnName) : null;
    const summary =
      table && column
        ? sampleTableColumn(table, column)
        : {
            values: [],
            counts: new Map<Cell, number>(),
            nonNullCount: 0,
            missingCount: 0,
          };

    sampleCache.set(cacheKey, summary);
    return summary;
  }

  return {
    tablesByName,
    tableNames,
    bindings,
    bindingPrefixes,
    resolvePath,
    getColumnSamples,
  };
}

/**
 * Returns a WeakMap-cached schema and bounded value-sample index for a Dataset.
 */
export function getDatasetSchemaIndex(dataset: Dataset): DatasetSchemaIndex {
  const existing = schemaCache.get(dataset);
  if (existing) return existing;

  const created = buildDatasetSchemaIndex(dataset);
  schemaCache.set(dataset, created);
  return created;
}
