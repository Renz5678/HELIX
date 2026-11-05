/*
 * Terminology service — LOINC / SNOMED-CT / RxNorm dictionaries.
 * Powers: hover tooltips, inline autocomplete, the terminology browser
 * panel, and unknown-code warnings in the diagnostics list.
 */

export const SYSTEMS = {
  LOINC: { label: 'LOINC', cls: 'loinc', uri: 'http://loinc.org' },
  SNOMED: { label: 'SNOMED-CT', cls: 'snomed', uri: 'http://snomed.info/sct' },
  RxNorm: { label: 'RxNorm', cls: 'rxnorm', uri: 'http://www.nlm.nih.gov/research/umls/rxnorm' },
};

/**
 * Curated subset of standard codes relevant to HELIX demo rules.
 * Each entry: system, code, description, optional deprecated flag.
 */
export const CODES = [
  /* --- LOINC: laboratory --- */
  { system: 'LOINC', code: '2339-0', description: 'Glucose [Mass/volume] in Blood' },
  { system: 'LOINC', code: '2345-7', description: 'Glucose [Mass/volume] in Serum or Plasma' },
  { system: 'LOINC', code: '1558-6', description: 'Glucose [Mass/volume] in Serum or Plasma by Oxygen electrode' },
  { system: 'LOINC', code: '2160-0', description: 'Creatinine [Mass/volume] in Serum or Plasma' },
  { system: 'LOINC', code: '38483-4', description: 'Creatinine [Mass/volume] in Blood' },
  { system: 'LOINC', code: '6690-2', description: 'Leukocytes [#/volume] in Blood by Automated count' },
  { system: 'LOINC', code: '7518-8', description: 'Hematocrit [Volume Fraction] of Blood by Automated count' },
  { system: 'LOINC', code: '718-7', description: 'Hemoglobin [Mass/volume] in Blood' },
  { system: 'LOINC', code: '2951-2', description: 'Sodium [Moles/volume] in Serum or Plasma' },
  { system: 'LOINC', code: '2823-3', description: 'Potassium [Moles/volume] in Serum or Plasma' },
  { system: 'LOINC', code: '1988-5', description: 'C reactive protein [Mass/volume] in Serum or Plasma' },
  { system: 'LOINC', code: '6301-6', description: 'INR in Platelet poor plasma by Coagulation assay' },
  { system: 'LOINC', code: '777-3', description: 'Platelets [#/volume] in Blood by Automated count' },
  { system: 'LOINC', code: '4548-4', description: 'Hemoglobin A1c/Hemoglobin.total in Blood' },
  { system: 'LOINC', code: '789-8', description: 'Erythrocytes [#/volume] in Blood by Automated count' },

  /* --- LOINC: vital signs --- */
  { system: 'LOINC', code: '8867-4', description: 'Heart rate' },
  { system: 'LOINC', code: '8480-6', description: 'Systolic blood pressure' },
  { system: 'LOINC', code: '8462-4', description: 'Diastolic blood pressure' },
  { system: 'LOINC', code: '8310-5', description: 'Body temperature' },
  { system: 'LOINC', code: '9279-1', description: 'Respiratory rate' },
  { system: 'LOINC', code: '2708-6', description: 'Oxygen saturation in Arterial blood' },
  { system: 'LOINC', code: '39156-5', description: 'Body mass index (BMI) [Ratio]' },
  { system: 'LOINC', code: '8302-2', description: 'Body height' },
  { system: 'LOINC', code: '29463-7', description: 'Body weight' },

  /* --- SNOMED-CT --- */
  { system: 'SNOMED', code: '91302008', description: 'Septic shock' },
  { system: 'SNOMED', code: '426761007', description: 'Sepsis (disorder)' },
  { system: 'SNOMED', code: '3723001', description: 'Arterial hypertension (disorder)' },
  { system: 'SNOMED', code: '44054006', description: 'Diabetes mellitus type 2 (disorder)' },
  { system: 'SNOMED', code: '46635009', description: 'Type 1 diabetes mellitus (disorder)' },
  { system: 'SNOMED', code: '195967001', description: 'Asthma (disorder)' },
  { system: 'SNOMED', code: '13646004', description: 'Chronic obstructive pulmonary disease (disorder)' },
  { system: 'SNOMED', code: '233604007', description: 'Pneumonia (disorder)' },
  { system: 'SNOMED', code: '84114007', description: 'Heart failure (disorder)' },
  { system: 'SNOMED', code: '194828000', description: 'Angina pectoris (disorder)' },
  { system: 'SNOMED', code: '254837009', description: 'Malignant neoplastic disease (disorder)' },
  { system: 'SNOMED', code: '38341003', description: 'Hypertensive disorder, systemic (disorder)' },
  { system: 'SNOMED', code: '62315008', description: 'Diarrhea (disorder)', deprecated: true },
  { system: 'SNOMED', code: '162864005', description: 'Body temperature (observable entity)' },
  { system: 'SNOMED', code: '36407005', description: 'Heart rate (observable entity)' },

  /* --- RxNorm --- */
  { system: 'RxNorm', code: '860975', description: 'Metformin 500 MG Oral Tablet' },
  { system: 'RxNorm', code: '197361', description: 'Insulin glargine 100 UNT/ML Injectable Solution' },
  { system: 'RxNorm', code: '4112004', description: 'Insulin Regular, Human 100 UNT/ML Injectable Solution' },
  { system: 'RxNorm', code: '314076', description: 'Lisinopril 10 MG Oral Tablet' },
  { system: 'RxNorm', code: '314216', description: 'Lisinopril 20 MG Oral Tablet' },
  { system: 'RxNorm', code: '11124', description: 'Simvastatin 20 MG Oral Tablet' },
  { system: 'RxNorm', code: '197116', description: 'Warfarin 5 MG Oral Tablet' },
  { system: 'RxNorm', code: '309965', description: 'Amoxicillin 500 MG Oral Capsule' },
  { system: 'RxNorm', code: '70512', description: 'Morphine 4 MG/ML Injectable Solution' },
  { system: 'RxNorm', code: '1049502', description: 'Oseltamivir 75 MG Oral Capsule' },
];

const index = new Map(CODES.map((c) => [`${c.system.toUpperCase()}|${c.code}`, c]));

/** Exact lookup, e.g. findTerm('LOINC', '2339-0'). */
export function findTerm(system, code) {
  if (!system || !code) return null;
  return index.get(`${system.toUpperCase()}|${code}`) || null;
}

/** Substring search over code + description. */
export function searchTerms(query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return CODES;
  return CODES.filter(
    (c) =>
      c.code.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q) ||
      c.system.toLowerCase().includes(q)
  );
}

/*
 * Scan source for terminology invocations: LOINC("2339-0"), SNOMED("..."), RxNorm("...")
 * Returns [{system, code, line, column, index}] with 1-based line/col.
 */
export function extractTerminologyCalls(code) {
  const calls = [];
  const re = /\b(LOINC|SNOMED|RxNorm)\s*\(\s*"([^"]*)"(\s*\))?|\b(LOINC|SNOMED|RxNorm)\s*\(\s*([A-Za-z0-9.\-]*)\s*(\))?/g;
  /* Two passes keep the regex readable: quoted forms first, then bare. */
  const quoted = /\b(LOINC|SNOMED|RxNorm)\s*\(\s*"([^"]*)"\s*\)/g;
  const bare = /\b(LOINC|SNOMED|RxNorm)\s*\(\s*([A-Za-z0-9.\-]+)\s*\)/g;
  const collect = (r) => {
    let m;
    while ((m = r.exec(code)) !== null) {
      const before = code.slice(0, m.index);
      const line = before.split('\n').length;
      const column = m.index - (before.lastIndexOf('\n') + 1) + 1;
      calls.push({ system: m[1], code: m[2], line, column, index: m.index });
    }
  };
  collect(quoted);
  collect(bare);
  re.lastIndex = 0;
  return calls.sort((a, b) => a.index - b.index);
}

/**
 * Warnings for unknown or deprecated codes — merged into the
 * diagnostics panel alongside the compiler's own output.
 * @returns {Array<{severity:string, line:number, column:number, message:string, source:string}>}
 */
export function terminologyDiagnostics(code) {
  const out = [];
  for (const call of extractTerminologyCalls(code)) {
    if (!call.code) continue;
    const term = findTerm(call.system, call.code);
    if (!term) {
      out.push({
        severity: 'warning',
        line: call.line,
        column: call.column,
        message: `Unknown ${SYSTEMS[call.system]?.label || call.system} code "${call.code}" — not found in the terminology service`,
        source: 'terminology',
      });
    } else if (term.deprecated) {
      out.push({
        severity: 'warning',
        line: call.line,
        column: call.column,
        message: `${SYSTEMS[call.system].label} code "${call.code}" is deprecated — ${term.description}`,
        source: 'terminology',
      });
    }
  }
  return out;
}

/** Resolve the token under a text offset to a terminology entry (for hover). */
export function termAtOffset(code, offset) {
  for (const call of extractTerminologyCalls(code)) {
    const start = call.index;
    const end = start + `${call.system}("${call.code}")`.length + 2;
    if (offset >= start - 1 && offset <= end) {
      return { ...call, term: findTerm(call.system, call.code) };
    }
  }
  return null;
}
