import type { TerminologySystem } from "./types";

export type { TerminologySystem };

export interface TerminologySystemInfo {
  label: string;
  cls: string;
  uri: string;
}

export interface TerminologyEntry {
  system: TerminologySystem;
  code: string;
  description: string;
  aliases?: readonly string[];
  deprecated?: boolean;
}

export const TERMINOLOGY_SYSTEMS: Readonly<
  Record<TerminologySystem, TerminologySystemInfo>
> = {
  LOINC: { label: "LOINC", cls: "loinc", uri: "http://loinc.org" },
  SNOMED: { label: "SNOMED-CT", cls: "snomed", uri: "http://snomed.info/sct" },
  RxNorm: {
    label: "RxNorm",
    cls: "rxnorm",
    uri: "http://www.nlm.nih.gov/research/umls/rxnorm",
  },
};

/**
 * Curated subset of 49 standard clinical codes ported verbatim from gui/web/src/lib/terminology.js.
 */
export const TERMINOLOGY_CODES: readonly TerminologyEntry[] = [
  /* --- LOINC: laboratory --- */
  { system: "LOINC", code: "2339-0", description: "Glucose [Mass/volume] in Blood" },
  {
    system: "LOINC",
    code: "2345-7",
    description: "Glucose [Mass/volume] in Serum or Plasma",
  },
  {
    system: "LOINC",
    code: "1558-6",
    description: "Glucose [Mass/volume] in Serum or Plasma by Oxygen electrode",
  },
  {
    system: "LOINC",
    code: "2160-0",
    description: "Creatinine [Mass/volume] in Serum or Plasma",
  },
  {
    system: "LOINC",
    code: "38483-4",
    description: "Creatinine [Mass/volume] in Blood",
  },
  {
    system: "LOINC",
    code: "6690-2",
    description: "Leukocytes [#/volume] in Blood by Automated count",
  },
  {
    system: "LOINC",
    code: "7518-8",
    description: "Hematocrit [Volume Fraction] of Blood by Automated count",
  },
  {
    system: "LOINC",
    code: "718-7",
    description: "Hemoglobin [Mass/volume] in Blood",
  },
  {
    system: "LOINC",
    code: "2951-2",
    description: "Sodium [Moles/volume] in Serum or Plasma",
  },
  {
    system: "LOINC",
    code: "2823-3",
    description: "Potassium [Moles/volume] in Serum or Plasma",
    aliases: ["serum potassium"],
  },
  {
    system: "LOINC",
    code: "1988-5",
    description: "C reactive protein [Mass/volume] in Serum or Plasma",
  },
  {
    system: "LOINC",
    code: "6301-6",
    description: "INR in Platelet poor plasma by Coagulation assay",
  },
  {
    system: "LOINC",
    code: "777-3",
    description: "Platelets [#/volume] in Blood by Automated count",
  },
  {
    system: "LOINC",
    code: "4548-4",
    description: "Hemoglobin A1c/Hemoglobin.total in Blood",
  },
  {
    system: "LOINC",
    code: "789-8",
    description: "Erythrocytes [#/volume] in Blood by Automated count",
  },

  /* --- LOINC: vital signs --- */
  { system: "LOINC", code: "8867-4", description: "Heart rate" },
  { system: "LOINC", code: "8480-6", description: "Systolic blood pressure" },
  { system: "LOINC", code: "8462-4", description: "Diastolic blood pressure" },
  { system: "LOINC", code: "8310-5", description: "Body temperature" },
  { system: "LOINC", code: "9279-1", description: "Respiratory rate" },
  {
    system: "LOINC",
    code: "2708-6",
    description: "Oxygen saturation in Arterial blood",
  },
  {
    system: "LOINC",
    code: "39156-5",
    description: "Body mass index (BMI) [Ratio]",
  },
  { system: "LOINC", code: "8302-2", description: "Body height" },
  { system: "LOINC", code: "29463-7", description: "Body weight" },

  /* --- SNOMED-CT --- */
  { system: "SNOMED", code: "91302008", description: "Septic shock" },
  { system: "SNOMED", code: "426761007", description: "Sepsis (disorder)" },
  {
    system: "SNOMED",
    code: "3723001",
    description: "Arterial hypertension (disorder)",
  },
  {
    system: "SNOMED",
    code: "44054006",
    description: "Diabetes mellitus type 2 (disorder)",
  },
  {
    system: "SNOMED",
    code: "46635009",
    description: "Type 1 diabetes mellitus (disorder)",
  },
  { system: "SNOMED", code: "195967001", description: "Asthma (disorder)" },
  {
    system: "SNOMED",
    code: "13646004",
    description: "Chronic obstructive pulmonary disease (disorder)",
  },
  { system: "SNOMED", code: "233604007", description: "Pneumonia (disorder)" },
  {
    system: "SNOMED",
    code: "84114007",
    description: "Heart failure (disorder)",
  },
  {
    system: "SNOMED",
    code: "194828000",
    description: "Angina pectoris (disorder)",
  },
  {
    system: "SNOMED",
    code: "254837009",
    description: "Malignant neoplastic disease (disorder)",
  },
  {
    system: "SNOMED",
    code: "38341003",
    description: "Hypertensive disorder, systemic (disorder)",
  },
  {
    system: "SNOMED",
    code: "62315008",
    description: "Diarrhea (disorder)",
    deprecated: true,
  },
  {
    system: "SNOMED",
    code: "162864005",
    description: "Body temperature (observable entity)",
  },
  {
    system: "SNOMED",
    code: "36407005",
    description: "Heart rate (observable entity)",
  },

  /* --- RxNorm --- */
  {
    system: "RxNorm",
    code: "860975",
    description: "Metformin 500 MG Oral Tablet",
  },
  {
    system: "RxNorm",
    code: "197361",
    description: "Insulin glargine 100 UNT/ML Injectable Solution",
  },
  {
    system: "RxNorm",
    code: "4112004",
    description: "Insulin Regular, Human 100 UNT/ML Injectable Solution",
  },
  {
    system: "RxNorm",
    code: "314076",
    description: "Lisinopril 10 MG Oral Tablet",
  },
  {
    system: "RxNorm",
    code: "314216",
    description: "Lisinopril 20 MG Oral Tablet",
  },
  {
    system: "RxNorm",
    code: "11124",
    description: "Simvastatin 20 MG Oral Tablet",
  },
  {
    system: "RxNorm",
    code: "197116",
    description: "Warfarin 5 MG Oral Tablet",
  },
  {
    system: "RxNorm",
    code: "309965",
    description: "Amoxicillin 500 MG Oral Capsule",
  },
  {
    system: "RxNorm",
    code: "70512",
    description: "Morphine 4 MG/ML Injectable Solution",
  },
  {
    system: "RxNorm",
    code: "1049502",
    description: "Oseltamivir 75 MG Oral Capsule",
  },
];

const termIndex = new Map<string, TerminologyEntry>();
for (const entry of TERMINOLOGY_CODES) {
  termIndex.set(`${entry.system.toUpperCase()}|${entry.code.toLowerCase()}`, entry);
  if (entry.aliases) {
    for (const alias of entry.aliases) {
      termIndex.set(`${entry.system.toUpperCase()}|${alias.toLowerCase()}`, entry);
    }
  }
}

/**
 * Exact O(1) lookup by system and code or alias (case-insensitive).
 */
export function findTerm(
  system: string,
  code: string,
): TerminologyEntry | null {
  if (!system || !code) return null;
  return termIndex.get(`${system.toUpperCase()}|${code.toLowerCase()}`) ?? null;
}

function scoreMatch(
  entry: TerminologyEntry,
  q: string,
  allowSystemMatch: boolean,
): number | null {
  const codeLower = entry.code.toLowerCase();
  if (codeLower === q) return 0;
  if (codeLower.startsWith(q)) return 1;

  const aliasesLower = entry.aliases?.map((a) => a.toLowerCase()) ?? [];
  if (aliasesLower.some((a) => a === q || a.startsWith(q))) return 2;

  if (codeLower.includes(q)) return 3;

  if (
    entry.description.toLowerCase().includes(q) ||
    aliasesLower.some((a) => a.includes(q))
  ) {
    return 4;
  }

  if (allowSystemMatch && entry.system.toLowerCase().includes(q)) {
    return 5;
  }

  return null;
}

/**
 * Searches terminology entries with optional system filter, ranking exact/prefix
 * code matches ahead of description and alias substring matches.
 */
export function searchTerms(
  query: string,
  system?: TerminologySystem,
): TerminologyEntry[] {
  const pool = system
    ? TERMINOLOGY_CODES.filter((entry) => entry.system === system)
    : TERMINOLOGY_CODES;
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return [...pool];

  const scored: { entry: TerminologyEntry; rank: number }[] = [];
  for (const entry of pool) {
    const rank = scoreMatch(entry, q, !system);
    if (rank !== null) {
      scored.push({ entry, rank });
    }
  }
  scored.sort((a, b) => a.rank - b.rank);
  return scored.map((item) => item.entry);
}
