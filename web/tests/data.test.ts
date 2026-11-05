import { describe, it, expect } from "vitest";
import {
  parseCSV,
  exportCSV,
  convertCell,
  validateDataset,
  loadWorkspace,
  saveWorkspace,
} from "../src/services/data";
import { defaultWorkspace } from "../src/presets";
describe("CSV transport", () => {
  it("preserves quoted delimiters, escaped quotes and embedded newlines", () => {
    expect(
      parseCSV('patient_id,note\r\nP1,"hello, ""world""\nline"\r\n'),
    ).toEqual([
      ["patient_id", "note"],
      ["P1", 'hello, "world"\nline'],
    ]);
  });
  it("rejects malformed and duplicate headers", () => {
    expect(() => parseCSV("id,id\n1,2")).toThrow();
    expect(() => parseCSV('a,b\n"oops')).toThrow();
    expect(() => parseCSV("a,b\n1")).toThrow();
  });
  it("round trips table strings while documenting null empty fields", () => {
    const t = structuredClone(defaultWorkspace.dataset.tables[0]);
    const csv = exportCSV(t);
    expect(parseCSV(csv)[1][0]).toBe("P001");
  });
});
describe("typed drafts", () => {
  it("never coerces missing, zero or false", () => {
    expect(convertCell("", "Float")).toBe(null);
    expect(convertCell("0", "Float")).toBe(0);
    expect(convertCell("false", "Boolean")).toBe(false);
    expect(convertCell("", "String")).toBe("");
    expect(() => convertCell("12x", "Float")).toThrow();
    expect(() => convertCell("1.5", "Integer")).toThrow();
    expect(() => convertCell("2026-02-30T10:00:00Z", "DateTime")).toThrow();
  });
  it("validates schema references and binding targets", () => {
    const d = structuredClone(defaultWorkspace.dataset);
    d.tables[0].name = "renamed";
    d.Bindings = { x: { table: "absent" } };
    expect(validateDataset(d).length).toBeGreaterThan(0);
  });
});
describe("storage recovery", () => {
  it("handles corrupt and unavailable storage without losing default work", () => {
    const store = {
      getItem: () => "{bad",
      setItem: () => {
        throw Error("quota");
      },
    };
    expect(loadWorkspace(store).workspace.source).toContain("rule");
    expect(loadWorkspace(store).warning).toBeTruthy();
    expect(saveWorkspace(defaultWorkspace, store)).toContain("quota");
  });
});
it("rejects malformed imported table structures before rendering", () => {
  expect(
    validateDataset({
      schemaVersion: 1,
      evaluationTime: "2026-10-31T12:00:00Z",
      Bindings: {},
      tables: [{}],
    } as never).length,
  ).toBeGreaterThan(0);
});
