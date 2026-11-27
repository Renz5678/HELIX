import { useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Play,
  Search,
  Terminal,
} from "lucide-react";
import type { DiagnosticEntry } from "../services/diagnostics";
import type { Analysis, Diagnostic, Evaluation } from "../services/types";
import grammar from "../../../docs/grammar.md?raw";

export const INSPECTION_TABS = [
  "Problems",
  "Tokens",
  "Evaluation Results",
  "Output",
  "Grammar",
] as const;

export type InspectionTab = (typeof INSPECTION_TABS)[number];

export default function InspectionPanel({
  tab,
  setTab,
  diagnosticEntries,
  diagnosticsCount,
  errorCount,
  analysis,
  analysisSource,
  evaluation,
  evalSource,
  stale,
  logs,
  navigate,
}: {
  tab: InspectionTab;
  setTab: (tab: InspectionTab) => void;
  diagnosticEntries: DiagnosticEntry[];
  diagnosticsCount: number;
  errorCount: number;
  analysis: Analysis | null;
  analysisSource: string;
  evaluation: Evaluation | null;
  evalSource: string;
  stale: boolean;
  logs: string[];
  navigate: (d: Diagnostic, snapshotSource?: string) => void;
}) {
  const [tokenSearch, setTokenSearch] = useState("");

  return (
    <section
      className="bottom-panel"
      aria-label="Analysis and evaluation panels"
    >
      <div className="panel-tabs" role="tablist">
        {INSPECTION_TABS.map((t) => (
          <button
            key={t}
            role="tab"
            id={`tab-${t.replaceAll(" ", "-")}`}
            aria-controls="inspection-panel"
            tabIndex={tab === t ? 0 : -1}
            onKeyDown={(event) => {
              const at = INSPECTION_TABS.indexOf(t);
              let next = at;
              if (event.key === "ArrowRight")
                next = (at + 1) % INSPECTION_TABS.length;
              else if (event.key === "ArrowLeft")
                next = (at + INSPECTION_TABS.length - 1) % INSPECTION_TABS.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = INSPECTION_TABS.length - 1;
              else return;
              event.preventDefault();
              setTab(INSPECTION_TABS[next]);
              document
                .getElementById(
                  `tab-${INSPECTION_TABS[next].replaceAll(" ", "-")}`,
                )
                ?.focus();
            }}
            aria-selected={tab === t}
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t}
            {t === "Problems" && (
              <span className={`count ${errorCount ? "has-errors" : ""}`}>
                {diagnosticsCount}
              </span>
            )}
            {t === "Evaluation Results" && evaluation && (
              <span className="count">{evaluation.results.length}</span>
            )}
          </button>
        ))}
      </div>
      <div
        className="panel-content"
        id="inspection-panel"
        role="tabpanel"
        aria-labelledby={`tab-${tab.replaceAll(" ", "-")}`}
      >
        {tab === "Problems" &&
          (diagnosticEntries.length ? (
            <div className="problem-list">
              {diagnosticEntries.map(({ d, source }, i) => (
                <button
                  key={i}
                  className="problem-row"
                  onClick={() => navigate(d, source)}
                >
                  <AlertCircle size={14} />
                  <span className="small-tag">{d.category}</span>
                  <span>{d.message}</span>
                  <code>
                    {d.line ? `Ln ${d.line}, Col ${d.column}` : d.code}
                  </code>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <CheckCircle2 size={23} />
              <strong>
                {analysis?.success
                  ? "No problems found"
                  : "Ready for analysis"}
              </strong>
              <p>
                {analysis?.success
                  ? "Your HELIX syntax is valid. Evaluation checks bindings and data."
                  : "Analyze your program to see C-engine diagnostics."}
              </p>
            </div>
          ))}
        {tab === "Tokens" && (
          <>
            <div className="token-toolbar">
              <Search size={14} />
              <input
                aria-label="Search tokens"
                placeholder="Filter lexeme, type or category…"
                value={tokenSearch}
                onChange={(e) => setTokenSearch(e.target.value)}
              />
              <span>{analysis?.tokenCount ?? 0} tokens</span>
            </div>
            <div className="token-scroll">
              <table className="token-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Lexeme</th>
                    <th>Token type</th>
                    <th>Line</th>
                    <th>Column</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis?.tokens
                    .filter((t) =>
                      `${t.lexeme} ${t.type} ${t.category}`
                        .toLowerCase()
                        .includes(tokenSearch.toLowerCase()),
                    )
                    .map((t) => (
                      <tr
                        key={t.index}
                        onClick={() =>
                          navigate(
                            {
                              severity: "info",
                              category: "token",
                              code: t.type,
                              message: t.lexeme,
                              startOffset: t.startOffset,
                            },
                            analysisSource,
                          )
                        }
                      >
                        <td>{t.index}</td>
                        <td>
                          <code>{t.lexeme || "EOF"}</code>
                        </td>
                        <td className="muted">{t.type}</td>
                        <td>{t.line}</td>
                        <td>{t.column}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {tab === "Evaluation Results" && (
          <>
            <div className="simulation-disclaimer">
              Simulated Rule Output — Not for Clinical Use
            </div>
            {stale && (
              <div className="warning-strip">
                Results are from an earlier source or data snapshot. Evaluate
                again.
              </div>
            )}
            {evaluation ? (
              <>
                <div className="evaluation-summary">
                  <strong>{evaluation.results.length} patient results</strong>
                  <span>{evaluation.evaluationTime}</span>
                  <span>
                    {evaluation.success
                      ? "Evaluation complete"
                      : "Evaluation has errors"}
                  </span>
                </div>
                {evaluation.diagnostics.map((d, i) => (
                  <button
                    key={i}
                    className="problem-row"
                    onClick={() => navigate(d, evalSource)}
                  >
                    <AlertCircle size={14} />
                    {d.message}
                  </button>
                ))}
                {evaluation.results.map((r) => (
                  <details
                    className="patient-result"
                    key={`${r.ruleId}/${r.patientId}`}
                    open
                  >
                    <summary>
                      <span className="patient-id">{r.patientId}</span>
                      <span>{r.ruleName}</span>
                      <span className="result-badges">
                        {r.conditions.map((c) => (
                          <b
                            key={c.conditionId}
                            className={`outcome ${c.outcome.toLowerCase()}`}
                          >
                            {c.outcome}
                          </b>
                        ))}
                      </span>
                    </summary>
                    {r.conditions.map((c) => (
                      <div className="condition-trace" key={c.conditionId}>
                        <button
                          className="condition-text"
                          onClick={() =>
                            navigate(
                              {
                                severity: "info",
                                category: "condition",
                                code: c.conditionId,
                                message: c.conditionText,
                                startOffset: c.startOffset,
                              },
                              evalSource,
                            )
                          }
                        >
                          {c.conditionText}
                        </button>
                        {c.resolvedValues.map((v, i) => (
                          <div className="resolved-value" key={i}>
                            <code>{v.expression}</code>
                            <b>
                              {v.value === null ? "MISSING" : String(v.value)}
                            </b>
                            <span>
                              {v.table}.{v.column} ·{" "}
                              {v.rowIndex === null
                                ? "no eligible row"
                                : `row ${v.rowIndex + 1}`}
                            </span>
                            {v.reason && <small>{v.reason}</small>}
                          </div>
                        ))}
                      </div>
                    ))}
                    {r.actions.map((a, i) => (
                      <div
                        key={i}
                        className={`action-event ${a.kind} ${a.severity?.toLowerCase() ?? ""}`}
                      >
                        {a.kind === "alert" ? (
                          <>
                            <AlertCircle size={14} />
                            <strong>{a.severity}</strong>
                            <span>{a.message}</span>
                            {!!a.payload?.length && (
                              <code>{JSON.stringify(a.payload)}</code>
                            )}
                          </>
                        ) : (
                          <>
                            <span>Simulated suppression</span>
                            <code>
                              {a.durationMs
                                ? `${a.durationMs / 60000} minutes`
                                : a.reason}
                            </code>
                          </>
                        )}
                      </div>
                    ))}
                    {!r.actions.length && (
                      <p className="no-action">No action triggered</p>
                    )}
                  </details>
                ))}
              </>
            ) : (
              <div className="empty-state">
                <Play size={22} />
                <strong>Evaluate against your data</strong>
                <p>Run rules for each patient at the selected timestamp.</p>
              </div>
            )}
          </>
        )}
        {tab === "Output" && (
          <div className="output-log">
            <div>
              <Terminal size={14} /> Engine output
            </div>
            {logs.length ? (
              logs.map((line, i) => <p key={i}>{line}</p>)
            ) : (
              <p>No execution output yet.</p>
            )}
          </div>
        )}
        {tab === "Grammar" && (
          <div className="grammar-reference">
            <div className="grammar-links">
              {["Reserved Words", "Expressions", "Declarations", "Actions"].map(
                (s) => (
                  <button
                    key={s}
                    onClick={() => {
                      const area = document.querySelector(".grammar-text");
                      if (area) {
                        const match =
                          s === "Reserved Words"
                            ? "Reserved Words"
                            : s === "Expressions"
                              ? "expression"
                              : s === "Declarations"
                                ? "Declarations"
                                : "Actions";
                        const at = grammar.indexOf(match);
                        area.scrollTop = Math.max(
                          0,
                          grammar.slice(0, at).split("\n").length * 18 - 40,
                        );
                      }
                    }}
                  >
                    {s}
                  </button>
                ),
              )}
            </div>
            <pre className="grammar-text">{grammar}</pre>
          </div>
        )}
      </div>
    </section>
  );
}
