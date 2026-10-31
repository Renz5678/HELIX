# HELIX Studio API

Version 1; adopted after approval of the refined plan.

## API contract

Retain the three proposed C signatures: `helix_analyze`, `helix_evaluate`, and
`helix_free_result`. Inputs are borrowed UTF-8 strings; results are owned heap
strings. NULL input produces a structured error if allocation permits. NULL result
means allocation/engine failure and is never passed to JSON.parse. No static result
buffer; repeated calls are independent.

Responses carry `schemaVersion: 1`. Evaluation requests may include version 1;
an omitted version is accepted for original input fixtures. Other versions fail.
This adopted revision supersedes the unreleased one-outcome SSOT response.

Analysis response preserves tokens/counts/diagnostics. Define `tokenCount` as
non-EOF entries (including error tokens); include EOF in `tokens` with its sentinel
category. Derive the count explicitly rather than assuming `TokenList.count`.
`success` means lexical and syntax validation succeeded; this does not promise
that a program is evaluation-ready. A later evaluation can return semantic errors.

Evaluation input adds `evaluationTime` to the existing `tables`/`Bindings` object.
Result contract:

```json
{
  "schemaVersion": 1,
  "success": true,
  "analysisSuccess": true,
  "evaluationTime": "2026-10-31T12:00:00Z",
  "results": [{
    "ruleId": "rule:0",
    "ruleName": "HighGlucoseAlert",
    "patientId": "P002",
    "conditions": [{
      "conditionId": "rule:0/when:0",
      "conditionText": "glucose_data.latest > 250",
      "outcome": "TRUE",
      "resolvedValues": [{
        "expression": "glucose_data.latest",
        "table": "glucose_data",
        "column": "value",
        "rowIndex": 1,
        "timestamp": "2026-10-31T09:00:00Z",
        "type": "Float",
        "value": 275
      }]
    }],
    "actions": [{
      "kind": "alert",
      "conditionId": "rule:0/when:0",
      "message": "High glucose detected",
      "severity": "WARNING",
      "payload": []
    }],
    "diagnostics": []
  }],
  "diagnostics": []
}
```

Add spans to conditions/actions in the complete schema. IDs are stable for the
same source snapshot; edits may change them. Do not invent a single patient-level
outcome when several conditions differ. Standalone actions have a null condition ID.
MISSING values serialize with explicit type `Missing`, `value: null`, and a reason.
Suppression events carry duration/reason fields instead of alert-only fields.

`analysisSuccess` concerns lexical/syntax validity. `success` means data validation,
semantic validation, and execution completed without error diagnostics. UNKNOWN
alone is a successful evaluation. Pre-execution errors return no patient results;
runtime errors retain explicit partial traces with `success:false`. Warnings/info
do not flip success. There are no actual patient notifications or side effects.
