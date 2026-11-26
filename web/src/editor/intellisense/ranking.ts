import type { ValueType } from "./types";

const MAX_MRU_ENTRIES = 100;
const MAX_MRU_BOOST = 60;

const STOP_WORDS = new Set([
  "data",
  "readings",
  "reading",
  "val",
  "value",
  "var",
]);

const THRESHOLD_STEMS = new Set([
  "threshold",
  "limit",
  "max",
  "min",
  "crit",
  "critical",
  "high",
  "low",
]);

export interface ScoreInput {
  base: number;
  candidateType?: ValueType;
  expectedType?: ValueType;
  candidateName?: string;
  lhsHintName?: string;
  localityBonus?: number;
  frequencyBonus?: number;
  mruBoost?: number;
  syntaxOnly?: boolean;
}

export interface RankedCandidate {
  label: string;
  score: number;
  sortText: string;
  syntaxOnly?: boolean;
}

/**
 * Per-session in-memory MRU acceptance tracker capped at 100 entries.
 * Never persists to localStorage.
 */
export class MruTracker {
  private readonly order: string[] = [];

  record(contextKind: string, label: string): void {
    if (!contextKind || !label) return;
    const key = `${contextKind}\0${label}`;
    const existing = this.order.indexOf(key);
    if (existing !== -1) {
      this.order.splice(existing, 1);
    }
    this.order.push(key);
    if (this.order.length > MAX_MRU_ENTRIES) {
      this.order.shift();
    }
  }

  boost(contextKind: string, label: string): number {
    if (!contextKind || !label || this.order.length === 0) return 0;
    const key = `${contextKind}\0${label}`;
    const idx = this.order.indexOf(key);
    if (idx === -1) return 0;
    return Math.round(((idx + 1) / this.order.length) * MAX_MRU_BOOST);
  }

  clear(): void {
    this.order.length = 0;
  }

  get size(): number {
    return this.order.length;
  }
}

/**
 * Splits snake_case, camelCase, and dotted identifiers into unique lowercase
 * semantic stems while filtering generic stop-words.
 */
export function extractStems(ident: string): string[] {
  if (!ident) return [];
  const spaced = ident
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const rawParts = spaced.split(/[^a-zA-Z0-9]+/);
  const stems: string[] = [];
  const seen = new Set<string>();
  for (const part of rawParts) {
    if (!part) continue;
    const lower = part.toLowerCase();
    if (STOP_WORDS.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    stems.push(lower);
  }
  return stems;
}

/**
 * Scores identifier name affinity: +120 for shared stems with the LHS hint
 * and +60 for numeric threshold stems when expectedType is "Number".
 */
export function computeNameAffinity(
  candidateName: string,
  lhsHintName?: string,
  expectedType?: ValueType,
): number {
  const candStems = extractStems(candidateName);
  if (candStems.length === 0) return 0;

  let bonus = 0;
  if (lhsHintName) {
    const lhsStems = new Set(extractStems(lhsHintName));
    if (candStems.some((stem) => lhsStems.has(stem))) {
      bonus += 120;
    }
  }

  if (
    expectedType === "Number" &&
    candStems.some((stem) => THRESHOLD_STEMS.has(stem))
  ) {
    bonus += 60;
  }

  return bonus;
}

/**
 * Computes a +0..+40 lexical proximity bonus for declarations closer to cursor.
 */
export function computeLocalityBonus(
  declOffset: number,
  scopeStartOffset: number,
  cursorOffset: number,
): number {
  if (cursorOffset <= scopeStartOffset) return 0;
  const span = Math.max(1, cursorOffset - scopeStartOffset);
  const clampedDecl = Math.max(
    scopeStartOffset,
    Math.min(cursorOffset, declOffset),
  );
  return Math.round(((clampedDecl - scopeStartOffset) / span) * 40);
}

/**
 * Combines base slot priority, type compatibility (+180/-160), name affinity,
 * lexical locality (+0..+40), sample frequency (+0..+20), MRU (+0..+60), and
 * syntax-only penalty (-250).
 */
export function scoreCandidate(input: ScoreInput): number {
  let score = input.base;

  if (
    input.expectedType &&
    input.expectedType !== "Unknown" &&
    input.candidateType &&
    input.candidateType !== "Unknown"
  ) {
    score += input.candidateType === input.expectedType ? 180 : -160;
  }

  if (input.candidateName) {
    score += computeNameAffinity(
      input.candidateName,
      input.lhsHintName,
      input.expectedType,
    );
  }

  if (input.localityBonus !== undefined) {
    score += Math.max(0, Math.min(40, input.localityBonus));
  }

  if (input.frequencyBonus !== undefined) {
    score += Math.max(0, Math.min(20, input.frequencyBonus));
  }

  if (input.mruBoost !== undefined) {
    score += Math.max(0, Math.min(60, input.mruBoost));
  }

  if (input.syntaxOnly) {
    score -= 250;
  }

  return Math.round(score);
}

/**
 * Converts a numeric score into a lexicographically ascending Monaco sortText.
 */
export function toSortText(score: number, label: string): string {
  const rounded = Math.round(score);
  const lower = label.toLowerCase();
  if (rounded >= 0) {
    const inverted = Math.max(0, 9999 - rounded);
    return `${String(inverted).padStart(4, "0")}_${lower}`;
  }
  return `z${String(Math.min(999999, Math.abs(rounded))).padStart(6, "0")}_${lower}`;
}
