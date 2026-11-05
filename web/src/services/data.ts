import { defaultWorkspace } from "../presets";
import type { Cell, ColumnType, Dataset, Table, Workspace } from "./types";
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += c;
      continue;
    }
    if (c === '"') {
      if (cell || closed) throw Error("Unexpected quote");
      quoted = true;
      continue;
    }
    if (c === "," || c === "\n" || c === "\r") {
      row.push(cell);
      cell = "";
      closed = false;
      if (c !== ",") {
        rows.push(row);
        row = [];
        if (c === "\r" && text[i + 1] === "\n") i++;
      }
      continue;
    }
    if (closed) throw Error("Unexpected character after quoted cell");
    cell += c;
  }
  if (quoted) throw Error("Unterminated quoted cell");
  if (cell || row.length || closed) {
    row.push(cell);
    rows.push(row);
  }
  if (
    !rows.length ||
    new Set(rows[0]).size !== rows[0].length ||
    rows[0].some((x) => !x.trim())
  )
    throw Error("CSV requires unique nonempty headers");
  if (rows.some((r) => r.length !== rows[0].length))
    throw Error("CSV rows have inconsistent widths");
  return rows;
}
const quote = (v: Cell) => {
  const s = v === null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
export function exportCSV(t: Table) {
  return [
    t.columns.map((c) => quote(c.name)).join(","),
    ...t.rows.map((row) =>
      t.columns.map((c) => quote(row[c.name] ?? null)).join(","),
    ),
  ].join("\r\n");
}
export function convertCell(raw: string, type: ColumnType): Cell {
  if (type === "String") return raw;
  if (raw === "") return null;
  if (type === "Boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw Error("Use true or false");
  }
  if (type === "DateTime") {
    const match =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(
        raw,
      );
    if (!match) throw Error("Use an ISO timestamp with timezone");
    const y = +match[1],
      m = +match[2],
      d = +match[3],
      h = +match[4],
      mi = +match[5],
      s = +match[6];
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const zone = match[8];
    if (
      y < 1 ||
      m < 1 ||
      m > 12 ||
      d < 1 ||
      d > days ||
      h > 23 ||
      mi > 59 ||
      s > 59 ||
      !Number.isFinite(Date.parse(raw)) ||
      (zone !== "Z" &&
        (+zone.slice(1, 3) > 14 ||
          +zone.slice(4) > 59 ||
          (+zone.slice(1, 3) === 14 && +zone.slice(4) !== 0)))
    )
      throw Error("Invalid calendar date or timezone");
    return raw;
  }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw))
    throw Error(`Expected ${type}`);
  const n = Number(raw);
  if (!Number.isFinite(n) || (type === "Integer" && !Number.isSafeInteger(n)))
    throw Error(`Expected a finite ${type}`);
  return n;
}
export function validateDataset(d: Dataset): string[] {
  const errors: string[] = [];
  if (
    !d ||
    d.schemaVersion !== 1 ||
    typeof d.evaluationTime !== "string" ||
    !d.Bindings ||
    typeof d.Bindings !== "object" ||
    Array.isArray(d.Bindings) ||
    !Array.isArray(d.tables) ||
    d.tables.length > 32
  )
    return ["Invalid dataset structure"];
  for (const t of d.tables) {
    if (
      !t ||
      typeof t.name !== "string" ||
      !Array.isArray(t.columns) ||
      !Array.isArray(t.rows) ||
      !t.columns.length ||
      t.columns.length > 64 ||
      t.columns.some(
        (c) =>
          !c ||
          typeof c.name !== "string" ||
          !["String", "Integer", "Float", "Boolean", "DateTime"].includes(
            c.type,
          ),
      ) ||
      t.rows.some((r) => !r || typeof r !== "object" || Array.isArray(r)) ||
      [t.patientIdColumn, t.timestampColumn, t.defaultValueColumn].some(
        (x) => typeof x !== "string",
      )
    )
      return ["Invalid table structure"];
  }
  if (
    Object.values(d.Bindings).some(
      (b) =>
        typeof b !== "string" &&
        (!b ||
          typeof b !== "object" ||
          typeof b.table !== "string" ||
          (b.column !== undefined && typeof b.column !== "string")),
    )
  )
    return ["Invalid binding structure"];
  try {
    convertCell(d.evaluationTime, "DateTime");
  } catch (e) {
    errors.push(`Evaluation time: ${String(e)}`);
  }
  const names = new Set<string>();
  for (const t of d.tables) {
    if (!t.name || names.has(t.name))
      errors.push("Table names must be unique and nonempty");
    names.add(t.name);
    const cols = new Map(t.columns.map((c) => [c.name, c.type]));
    if (cols.size !== t.columns.length || t.columns.some((c) => !c.name))
      errors.push(`${t.name}: column names must be unique and nonempty`);
    if (
      cols.get(t.patientIdColumn) !== "String" ||
      cols.get(t.timestampColumn) !== "DateTime" ||
      !cols.has(t.defaultValueColumn)
    )
      errors.push(`${t.name}: invalid schema references`);
    t.rows.forEach((row, i) => {
      if (typeof row[t.patientIdColumn] !== "string" || !row[t.patientIdColumn])
        errors.push(`${t.name} row ${i + 1}: patient ID required`);
      for (const c of t.columns) {
        const v = row[c.name];
        if (v == null) continue;
        try {
          const parsed = convertCell(String(v), c.type);
          if (typeof parsed !== typeof v) throw Error("Incorrect stored type");
        } catch (e) {
          errors.push(`${t.name} row ${i + 1} ${c.name}: ${String(e)}`);
        }
      }
    });
  }
  for (const [name, b] of Object.entries(d.Bindings)) {
    const table = typeof b === "string" ? b : b.table;
    const t = d.tables.find((t) => t.name === table);
    if (
      !t ||
      (typeof b !== "string" &&
        b.column &&
        !t.columns.some((c) => c.name === b.column))
    )
      errors.push(`Binding ${name} has an invalid target`);
  }
  return errors;
}
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const key = "helix-studio.workspace.v1";
export function loadWorkspace(storage: StorageLike = localStorage): {
  workspace: Workspace;
  warning?: string;
} {
  try {
    const text = storage.getItem(key);
    if (!text) return { workspace: structuredClone(defaultWorkspace) };
    const w = JSON.parse(text);
    if (
      w.version !== 1 ||
      typeof w.source !== "string" ||
      typeof w.filename !== "string" ||
      typeof w.autoAnalyze !== "boolean" ||
      !Number.isFinite(w.fontSize) ||
      w.fontSize < 10 ||
      w.fontSize > 24 ||
      !Array.isArray(w.dataset?.tables) ||
      typeof w.dataset?.Bindings !== "object" ||
      validateDataset(w.dataset).length
    )
      throw Error("Stored workspace is invalid or has an unsupported version");
    return { workspace: w };
  } catch (e) {
    return {
      workspace: structuredClone(defaultWorkspace),
      warning: `Workspace recovery: ${String(e)}`,
    };
  }
}
export function saveWorkspace(
  w: Workspace,
  storage: StorageLike = localStorage,
) {
  try {
    storage.setItem(key, JSON.stringify(w));
    return "";
  } catch (e) {
    return `Could not save workspace: ${String(e)}`;
  }
}
export function download(name: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
