import type { Dataset, Workspace } from "./services/types";
import high from "../../examples/high_glucose_alert.helix?raw";
import basic from "../../examples/basic_rule.helix?raw";
import sepsis from "../../examples/alert_rule.helix?raw";
import temporal from "../../examples/temporal_rule.helix?raw";
import invalid from "../../examples/invalid_syntax_demo.helix?raw";
import glucoseData from "../../examples/data/glucose.json";
import sepsisData from "../../examples/data/sepsis.json";
import temporalData from "../../examples/data/temporal.json";
const dataset = glucoseData as Dataset;
export const presets = [
  {
    name: "High glucose alert",
    filename: "high_glucose_alert.helix",
    description: "Three patients · direct source",
    source: high,
    dataset: structuredClone(dataset),
  },
  {
    name: "Inpatient glucose",
    filename: "basic_rule.helix",
    description: "Bindings · thresholds · suppression",
    source: basic,
    dataset: {
      ...structuredClone(dataset),
      Bindings: { "Labs.glucose": { table: "glucose_data", column: "value" } },
    },
  },
  {
    name: "Sepsis early warning",
    filename: "alert_rule.helix",
    description: "Multiple vital signs · logical conditions",
    source: sepsis,
    dataset: sepsisData as Dataset,
  },
  {
    name: "Recent heart rate",
    filename: "temporal_rule.helix",
    description: "Filtered latest reading · time windows",
    source: temporal,
    dataset: temporalData as Dataset,
  },
  {
    name: "Diagnostic demonstration",
    filename: "invalid_syntax_demo.helix",
    description: "Intentional lexical and syntax errors",
    source: invalid,
    dataset: structuredClone(dataset),
  },
];
export const defaultWorkspace: Workspace = {
  version: 1,
  source: high,
  filename: "high_glucose_alert.helix",
  dataset: structuredClone(dataset),
  autoAnalyze: true,
  fontSize: 14,
};
