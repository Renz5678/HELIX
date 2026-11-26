import { describe, it, expect } from "vitest";
import sepsisData from "../../../examples/data/sepsis.json";
import temporalData from "../../../examples/data/temporal.json";
import type { Dataset } from "../../src/services/types";
import {
  TERMINOLOGY_CODES,
  TERMINOLOGY_SYSTEMS,
  findTerm,
  searchTerms,
} from "../../src/editor/intellisense/terminology";
import {
  getDatasetSchemaIndex,
  columnTypeToValueType,
} from "../../src/editor/intellisense/schema";

describe("terminology catalog and dataset schema index", () => {
  it("ports all 49 curated clinical codes and supports exact, alias, and description search", () => {
    expect(TERMINOLOGY_CODES).toHaveLength(49);
    expect(TERMINOLOGY_CODES.filter((c) => c.system === "LOINC")).toHaveLength(24);
    expect(TERMINOLOGY_CODES.filter((c) => c.system === "SNOMED")).toHaveLength(15);
    expect(TERMINOLOGY_CODES.filter((c) => c.system === "RxNorm")).toHaveLength(10);

    expect(TERMINOLOGY_SYSTEMS.LOINC.uri).toBe("http://loinc.org");
    expect(TERMINOLOGY_SYSTEMS.SNOMED.label).toBe("SNOMED-CT");
    expect(TERMINOLOGY_SYSTEMS.RxNorm.label).toBe("RxNorm");

    expect(findTerm("LOINC", "2339-0")?.description).toContain("Glucose");
    expect(findTerm("loinc", "serum potassium")?.code).toBe("2823-3");
    expect(findTerm("SNOMED", "62315008")?.deprecated).toBe(true);
    expect(findTerm("LOINC", "does-not-exist")).toBeNull();
    expect(findTerm("", "2339-0")).toBeNull();

    expect(searchTerms("septic", "SNOMED")[0]?.code).toBe("91302008");
    expect(searchTerms("2339", "LOINC")[0]?.code).toBe("2339-0");
    expect(searchTerms("", "RxNorm")).toHaveLength(10);
    expect(searchTerms("   ")).toHaveLength(49);
    expect(searchTerms("serum potassium", "LOINC")[0]?.code).toBe("2823-3");
  });

  it("caches per Dataset reference and mirrors src/bindings.c resolution", () => {
    const ds = structuredClone(temporalData) as Dataset;
    const idx1 = getDatasetSchemaIndex(ds);
    const idx2 = getDatasetSchemaIndex(ds);
    expect(idx1).toBe(idx2);
    expect(idx1.resolvePath("Vitals.heart_rate")).toMatchObject({
      tableName: "heart_rate_readings",
      columnName: "value",
      columnType: "Float",
    });
    expect(idx1.bindingPrefixes.get("Vitals")?.map((e) => e.suffix)).toEqual([
      "heart_rate",
    ]);
    expect(idx1.resolvePath("heart_rate_readings.status")?.columnType).toBe("String");
    expect(idx1.resolvePath("heart_rate_readings")?.columnName).toBe("value");
    expect(idx1.resolvePath("heart_rate_readings.missing_col")).toBeNull();
    expect(idx1.resolvePath("missing.path")).toBeNull();

    const customDs: Dataset = {
      schemaVersion: 1,
      evaluationTime: "2026-10-31T12:00:00Z",
      Bindings: {
        "Labs.glucose": "glucose_tbl",
        "Labs.a1c": { table: "glucose_tbl" },
        "glucose_tbl": { table: "missing_tbl" },
      },
      tables: [
        {
          name: "glucose_tbl",
          patientIdColumn: "patient_id",
          timestampColumn: "timestamp",
          defaultValueColumn: "val",
          columns: [
            { name: "patient_id", type: "String" },
            { name: "timestamp", type: "DateTime" },
            { name: "val", type: "Integer" },
            { name: "verified", type: "Boolean" },
          ],
          rows: [],
        },
      ],
    };
    const customIdx = getDatasetSchemaIndex(customDs);
    expect(customIdx.resolvePath("Labs.glucose")).toMatchObject({
      tableName: "glucose_tbl",
      columnName: "val",
      columnType: "Integer",
    });
    expect(customIdx.resolvePath("Labs.a1c")?.columnName).toBe("val");
    // Mirrors bindings.c: if path exists in Bindings and fails, do not fall back to table lookup
    expect(customIdx.resolvePath("glucose_tbl")).toBeNull();
    expect(customIdx.resolvePath("toString")).toBeNull();

    expect(columnTypeToValueType("Integer")).toBe("Number");
    expect(columnTypeToValueType("Float")).toBe("Number");
    expect(columnTypeToValueType("String")).toBe("String");
    expect(columnTypeToValueType("Boolean")).toBe("Boolean");
    expect(columnTypeToValueType("DateTime")).toBe("DateTime");
  });

  it("samples distinct non-null column values ordered by frequency and handles empty/large/null tables safely", () => {
    const idx = getDatasetSchemaIndex(structuredClone(temporalData) as Dataset);
    const sample = idx.getColumnSamples("heart_rate_readings", "status");
    expect(sample.values).toEqual(["final", "preliminary"]);
    expect(sample.nonNullCount).toBe(3);
    expect(sample.min).toBeUndefined();
    expect(sample.max).toBeUndefined();

    const sepsisIdx = getDatasetSchemaIndex(structuredClone(sepsisData) as Dataset);
    const sbp = sepsisIdx.getColumnSamples("Vitals", "systolic_bp");
    expect(sbp.min).toBe(85);
    expect(sbp.max).toBe(120);

    const big: Dataset = {
      schemaVersion: 1,
      evaluationTime: "2026-10-31T12:00:00Z",
      Bindings: {},
      tables: [
        {
          name: "huge",
          patientIdColumn: "patient_id",
          timestampColumn: "timestamp",
          defaultValueColumn: "value",
          columns: [
            { name: "patient_id", type: "String" },
            { name: "timestamp", type: "DateTime" },
            { name: "value", type: "Float" },
            { name: "tag", type: "String" },
          ],
          rows: Array.from({ length: 10000 }, (_, i) => ({
            patient_id: `P${i}`,
            timestamp: "2026-10-31T11:00:00Z",
            value: null,
            tag: `v${i % 50}`,
          })),
        },
        {
          name: "empty_tbl",
          patientIdColumn: "patient_id",
          timestampColumn: "timestamp",
          defaultValueColumn: "value",
          columns: [
            { name: "patient_id", type: "String" },
            { name: "timestamp", type: "DateTime" },
            { name: "value", type: "Float" },
          ],
          rows: [],
        },
      ],
    };
    const bigIdx = getDatasetSchemaIndex(big);
    expect(bigIdx.getColumnSamples("huge", "value").values).toEqual([]);
    expect(bigIdx.getColumnSamples("huge", "value").missingCount).toBe(200);
    expect(bigIdx.getColumnSamples("huge", "tag").values.length).toBeLessThanOrEqual(20);
    expect(bigIdx.getColumnSamples("empty_tbl", "value").values).toEqual([]);
    expect(bigIdx.getColumnSamples("missing_tbl", "value").values).toEqual([]);
    expect(bigIdx.getColumnSamples("empty_tbl", "missing_col").values).toEqual([]);
  });
});
