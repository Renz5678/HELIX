import { useEffect, useState } from "react";
import { Plus, Trash2, Upload, Download, Table2, Link2 } from "lucide-react";
import type { Cell, ColumnType, Dataset, Table } from "../services/types";
import {
  convertCell,
  parseCSV,
  exportCSV,
  download,
  validateDataset,
} from "../services/data";
const types: ColumnType[] = [
  "String",
  "Integer",
  "Float",
  "Boolean",
  "DateTime",
];
function CellEditor({
  value,
  type,
  label,
  onCommit,
  onError,
}: {
  value: Cell;
  type: ColumnType;
  label: string;
  onCommit: (v: Cell) => void;
  onError: (id: string, error: string) => void;
}) {
  const [raw, setRaw] = useState(value === null ? "" : String(value));
  const [error, setError] = useState("");
  useEffect(() => {
    setRaw(value === null ? "" : String(value));
  }, [value]);
  useEffect(() => () => onError(label, ""), [label]);
  return (
    <div className={`cell ${error ? "invalid-cell" : ""}`}>
      <input
        aria-label={label}
        aria-invalid={!!error}
        title={error || label}
        value={raw}
        placeholder={value === null ? "MISSING" : ""}
        onChange={(e) => {
          const text = e.target.value;
          setRaw(text);
          try {
            const v = convertCell(text, type);
            setError("");
            onError(label, "");
            onCommit(v);
          } catch (err) {
            const message = String(err);
            setError(message);
            onError(label, message);
          }
        }}
      />
      {value !== null && (
        <button
          className="missing-control"
          title="Set cell to MISSING"
          aria-label={`Set ${label} missing`}
          onClick={() => {
            setRaw("");
            setError("");
            onError(label, "");
            onCommit(null);
          }}
        >
          ∅
        </button>
      )}
    </div>
  );
}
export default function DataPlayground({
  dataset,
  setDataset,
  setDraftError,
  focusCell,
}: {
  focusCell?:{tableName:string;rowIndex:number;columnName:string};
  dataset: Dataset;
  setDataset: (d: Dataset) => void;
  setDraftError: (id: string, error: string) => void;
}) {
  const [index, setIndex] = useState(0),
    [csv, setCSV] = useState<string[][] | null>(null),
    [csvTypes, setCSVTypes] = useState<ColumnType[]>([]),
    [error, setError] = useState(""),
    [binding, setBinding] = useState("");
  const table = dataset.tables[Math.min(index, dataset.tables.length - 1)];
  useEffect(()=>{
    if(!focusCell)return;
    const at=dataset.tables.findIndex(t=>t.name===focusCell.tableName);if(at<0)return;
    setIndex(at);const timer=setTimeout(()=>{
      const label=`${focusCell.tableName} row ${focusCell.rowIndex+1} ${focusCell.columnName}`;
      const input=[...document.querySelectorAll<HTMLInputElement>('.cell input')].find(el=>el.getAttribute('aria-label')===label);
      input?.scrollIntoView({block:'center',inline:'center'});input?.focus();
    },0);return ()=>clearTimeout(timer);
  },[focusCell]);
  const replace = (t: Table) =>
    setDataset({
      ...dataset,
      tables: dataset.tables.map((old) => (old === table ? t : old)),
    });
  const addTable = () => {
    let i = dataset.tables.length + 1;
    while (dataset.tables.some((t) => t.name === `table_${i}`)) i++;
    const t: Table = {
      name: `table_${i}`,
      patientIdColumn: "patient_id",
      timestampColumn: "timestamp",
      defaultValueColumn: "value",
      columns: [
        { name: "patient_id", type: "String" },
        { name: "value", type: "Float" },
        { name: "timestamp", type: "DateTime" },
      ],
      rows: [],
    };
    setDataset({ ...dataset, tables: [...dataset.tables, t] });
    setIndex(dataset.tables.length);
  };
  async function importFile(file: File) {
    try {
      const text = await file.text();
      if (file.name.endsWith(".json")) {
        const d = JSON.parse(text);
        if (
          d.schemaVersion !== 1 ||
          !Array.isArray(d.tables) ||
          !d.Bindings ||
          typeof d.evaluationTime !== "string"
        )
          throw Error("Expected a HELIX dataset JSON object");
        const issues = validateDataset(d);
        if (issues.length) throw Error(issues[0]);
        setDataset(d);
        setIndex(0);
      } else {
        const rows = parseCSV(text);
        setCSV(rows);
        setCSVTypes(
          rows[0].map(
            (name) =>
              table?.columns.find((c) => c.name === name)?.type ??
              (name === "timestamp" ? "DateTime" : "String"),
          ),
        );
      }
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <aside className="playground" aria-label="Data Playground">
      <div className="section-heading">
        <div>
          <Table2 size={16} />
          <strong>Data Playground</strong>
        </div>
        <span className="small-tag">Local data</span>
      </div>
      <div className="data-toolbar">
        <select
          aria-label="Active data table"
          value={table?.name ?? ""}
          onChange={(e) =>
            setIndex(dataset.tables.findIndex((t) => t.name === e.target.value))
          }
        >
          {dataset.tables.map((t) => (
            <option key={t.name}>{t.name}</option>
          ))}
        </select>
        <button aria-label="Add table" title="Add table" onClick={addTable}>
          <Plus size={15} />
        </button>
      </div>
      <div className="table-actions">
        <label className="button compact">
          <Upload size={13} />
          Import CSV / JSON
          <input
            hidden
            type="file"
            accept=".csv,.json"
            onChange={(e) => {
              if (e.target.files?.[0]) void importFile(e.target.files[0]);
              e.target.value = "";
            }}
          />
        </label>
        <button
          className="compact"
          disabled={!table}
          onClick={() =>
            download(`${table.name}.csv`, exportCSV(table), "text/csv")
          }
        >
          <Download size={13} />
          CSV
        </button>
        <button
          className="compact"
          onClick={() =>
            download(
              "helix-dataset.json",
              JSON.stringify(dataset, null, 2),
              "application/json",
            )
          }
        >
          JSON
        </button>
      </div>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {table ? (
        <>
          <div className="table-metadata">
            <label>
              Table name
              <input
                aria-label="Table name"
                value={table.name}
                onChange={(e) => replace({ ...table, name: e.target.value })}
              />
            </label>
            <button
              className="danger icon-button"
              title="Delete table"
              aria-label="Delete table"
              onClick={() => {
                setDataset({
                  ...dataset,
                  tables: dataset.tables.filter((t) => t !== table),
                });
                setIndex(0);
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
          <div className="data-grid-scroll">
            <table className="data-grid">
              <thead>
                <tr>
                  <th className="row-number">#</th>
                  {table.columns.map((col, i) => (
                    <th key={i}>
                      <div className="column-heading">
                        <input
                          aria-label={`Column ${i + 1} name`}
                          value={col.name}
                          onChange={(e) => {
                            const name = e.target.value;
                            replace({
                              ...table,
                              columns: table.columns.map((c, j) =>
                                j === i ? { ...c, name } : c,
                              ),
                              rows: table.rows.map((row) => {
                                const next = { ...row };
                                delete next[col.name];
                                return {
                                  ...next,
                                  [name]: row[col.name] ?? null,
                                };
                              }),
                            });
                          }}
                        />
                        <button
                          title={`Delete column ${col.name}`}
                          aria-label={`Delete column ${col.name}`}
                          onClick={() =>
                            replace({
                              ...table,
                              columns: table.columns.filter((_, j) => i !== j),
                              rows: table.rows.map((row) => {
                                const next = { ...row };
                                delete next[col.name];
                                return next;
                              }),
                            })
                          }
                        >
                          ×
                        </button>
                      </div>
                      <select
                        aria-label={`${col.name} type`}
                        value={col.type}
                        onChange={(e) =>
                          replace({
                            ...table,
                            columns: table.columns.map((c, j) =>
                              j === i
                                ? { ...c, type: e.target.value as ColumnType }
                                : c,
                            ),
                          })
                        }
                      >
                        {types.map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, r) => (
                  <tr key={r}>
                    <td className="row-number">{r + 1}</td>
                    {table.columns.map((col, k) => (
                      <td key={k}>
                        <CellEditor
                          value={row[col.name] ?? null}
                          type={col.type}
                          label={`${table.name} row ${r + 1} ${col.name}`}
                          onError={setDraftError}
                          onCommit={(value) =>
                            replace({
                              ...table,
                              rows: table.rows.map((old, i) =>
                                i === r ? { ...old, [col.name]: value } : old,
                              ),
                            })
                          }
                        />
                      </td>
                    ))}
                    <td>
                      <button
                        className="icon-button"
                        aria-label={`Delete row ${r + 1}`}
                        onClick={() =>
                          replace({
                            ...table,
                            rows: table.rows.filter((_, i) => i !== r),
                          })
                        }
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row-actions">
            <button
              className="compact"
              onClick={() =>
                replace({
                  ...table,
                  rows: [
                    ...table.rows,
                    Object.fromEntries(
                      table.columns.map((c) => [c.name, null]),
                    ),
                  ],
                })
              }
            >
              <Plus size={13} />
              Add row
            </button>
            <button
              className="compact"
              onClick={() => {
                let i = table.columns.length + 1;
                while (table.columns.some((c) => c.name === `column_${i}`)) i++;
                replace({
                  ...table,
                  columns: [
                    ...table.columns,
                    { name: `column_${i}`, type: "String" },
                  ],
                });
              }}
            >
              <Plus size={13} />
              Add column
            </button>
            <span>{table.rows.length} records</span>
          </div>
          <details className="schema-details">
            <summary>Schema references</summary>
            {(
              [
                "patientIdColumn",
                "timestampColumn",
                "defaultValueColumn",
              ] as const
            ).map((key) => (
              <label key={key}>
                {key}
                <select
                  aria-label={key}
                  value={table[key]}
                  onChange={(e) => replace({ ...table, [key]: e.target.value })}
                >
                  <option value="">Select column</option>
                  {table.columns.map((c, i) => (
                    <option key={i}>{c.name}</option>
                  ))}
                </select>
              </label>
            ))}
          </details>
        </>
      ) : (
        <div className="empty-state">
          <Table2 />
          <p>No tables yet.</p>
          <button onClick={addTable}>Create a table</button>
        </div>
      )}
      <div className="bindings">
        <h3>
          <Link2 size={14} />
          Source bindings
        </h3>
        <p>
          Map qualified paths to local tables. Direct table names resolve
          automatically.
        </p>
        {Object.entries(dataset.Bindings).map(([name, target]) => (
          <div className="binding-row" key={name}>
            <code title={name}>{name}</code>
            <select
              aria-label={`Binding ${name} table`}
              value={typeof target === "string" ? target : target.table}
              onChange={(e) =>
                setDataset({
                  ...dataset,
                  Bindings: {
                    ...dataset.Bindings,
                    [name]: { table: e.target.value },
                  },
                })
              }
            >
              <option value="">Select table</option>
              {dataset.tables.map((t, i) => (
                <option key={i}>{t.name}</option>
              ))}
            </select>
            <select
              aria-label={`Binding ${name} column`}
              value={typeof target === "string" ? "" : (target.column ?? "")}
              onChange={(e) =>
                setDataset({
                  ...dataset,
                  Bindings: {
                    ...dataset.Bindings,
                    [name]: {
                      table: typeof target === "string" ? target : target.table,
                      column: e.target.value || undefined,
                    },
                  },
                })
              }
            >
              <option value="">Default value</option>
              {dataset.tables
                .find(
                  (t) =>
                    t.name ===
                    (typeof target === "string" ? target : target.table),
                )
                ?.columns.map((c, i) => (
                  <option key={i}>{c.name}</option>
                ))}
            </select>
            <button
              aria-label={`Delete binding ${name}`}
              onClick={() => {
                const next = { ...dataset.Bindings };
                delete next[name];
                setDataset({ ...dataset, Bindings: next });
              }}
            >
              ×
            </button>
          </div>
        ))}
        <div className="add-binding">
          <input
            aria-label="New binding path"
            placeholder="e.g. Labs.glucose"
            value={binding}
            onChange={(e) => setBinding(e.target.value)}
          />
          <button
            disabled={
              !binding.trim() ||
              !!dataset.Bindings[binding.trim()] ||
              !dataset.tables.length
            }
            onClick={() => {
              setDataset({
                ...dataset,
                Bindings: {
                  ...dataset.Bindings,
                  [binding.trim()]: { table: dataset.tables[0].name },
                },
              });
              setBinding("");
            }}
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
      <div className="evaluation-clock">
        <label>
          Evaluation timestamp
          <input
            aria-label="Evaluation timestamp"
            value={dataset.evaluationTime}
            onChange={(e) =>
              setDataset({ ...dataset, evaluationTime: e.target.value })
            }
          />
        </label>
        <button
          className="compact"
          onClick={() =>
            setDataset({ ...dataset, evaluationTime: new Date().toISOString() })
          }
        >
          Use current time
        </button>
        <p>One fixed timestamp is used for every patient in this run.</p>
      </div>
      {csv && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="CSV import preview"
          >
            <h2>Preview CSV import</h2>
            <p>
              {csv.length - 1} rows. Empty numeric/date cells become MISSING;
              String cells preserve empty text.
            </p>
            <div className="csv-columns">
              {csv[0].map((name, i) => (
                <label key={i}>
                  {name}
                  <select
                    aria-label={`Import ${name} type`}
                    value={csvTypes[i]}
                    onChange={(e) =>
                      setCSVTypes(
                        csvTypes.map((t, j) =>
                          i === j ? (e.target.value as ColumnType) : t,
                        ),
                      )
                    }
                  >
                    {types.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <pre>
              {csv
                .slice(0, 4)
                .map((r) => r.join(" | "))
                .join("\n")}
            </pre>
            <div className="modal-actions">
              <button onClick={() => setCSV(null)}>Cancel</button>
              <button
                className="primary"
                onClick={() => {
                  try {
                    const columns = csv[0].map((name, i) => ({
                      name,
                      type: csvTypes[i],
                    }));
                    const rows = csv
                      .slice(1)
                      .map((r) =>
                        Object.fromEntries(
                          columns.map((c, i) => [
                            c.name,
                            convertCell(r[i], c.type),
                          ]),
                        ),
                      );
                    let id = 1;
                    while (
                      dataset.tables.some((t) => t.name === `imported_${id}`)
                    )
                      id++;
                    const t: Table = {
                      name: `imported_${id}`,
                      columns,
                      rows,
                      patientIdColumn:
                        columns.find((c) => c.name === "patient_id")?.name ??
                        columns[0].name,
                      timestampColumn:
                        columns.find((c) => c.type === "DateTime")?.name ??
                        "timestamp",
                      defaultValueColumn:
                        columns.find((c) => c.name === "value")?.name ??
                        columns.find(
                          (c) => c.type === "Float" || c.type === "Integer",
                        )?.name ??
                        columns[1]?.name ??
                        columns[0].name,
                    };
                    setDataset({ ...dataset, tables: [...dataset.tables, t] });
                    setIndex(dataset.tables.length);
                    setCSV(null);
                    setError("");
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                Import as new table
              </button>
            </div>
          </section>
        </div>
      )}
    </aside>
  );
}
