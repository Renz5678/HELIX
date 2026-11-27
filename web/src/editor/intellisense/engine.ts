import {
  buildCompletions,
  type CompletionCandidate,
} from "./completions";
import { analyzeCursorContext } from "./context";
import { activeRuleAt, indexDocument } from "./document-index";
import {
  computeInlinePrediction,
  type InlinePrediction,
} from "./inline-predictions";
import { offsetFromLineStarts } from "./token-utils";
import {
  computeDefinition,
  computeDocumentSymbols,
  computeHover,
  computeQuickFixes,
  computeReferences,
  computeSignatureHelp,
  type HoverResult,
  type MarkerInput,
  type OutlineSymbol,
  type QuickFixAction,
  type SignatureResult,
} from "./providers";
import { MruTracker } from "./ranking";
import { getDatasetSchemaIndex, type DatasetSchemaIndex } from "./schema";
import type {
  Dataset,
  DocumentIndex,
  TextPosition,
  TextRange,
} from "./types";

interface CachedDocumentEntry {
  uri: string;
  versionId: number;
  dataset: Dataset;
  doc: DocumentIndex;
  schema: DatasetSchemaIndex;
}

const MAX_CACHED_URIS = 4;

/**
 * Coordinates document indexing, dataset schema caching, per-session MRU memory,
 * completions, inline predictions, and IDE language providers across edits.
 */
export class HelixIntelliSense {
  private readonly cache = new Map<string, CachedDocumentEntry>();
  private readonly mru = new MruTracker();

  /**
   * Returns a cached `{ doc, schema }` pair when `(uri, versionId, dataset)` matches,
   * evicting the least-recently-used URI when exceeding 4 cached URIs.
   */
  getDocument(
    uri: string,
    versionId: number,
    source: string,
    dataset: Dataset,
  ): { doc: DocumentIndex; schema: DatasetSchemaIndex } {
    const hit = this.cache.get(uri);
    if (
      hit &&
      hit.versionId === versionId &&
      hit.dataset === dataset &&
      hit.doc.source === source
    ) {
      // Refresh LRU position on hit
      this.cache.delete(uri);
      this.cache.set(uri, hit);
      return { doc: hit.doc, schema: hit.schema };
    }

    const schema = getDatasetSchemaIndex(dataset);
    const doc = indexDocument(source, schema);
    const entry: CachedDocumentEntry = {
      uri,
      versionId,
      dataset,
      doc,
      schema,
    };

    if (this.cache.has(uri)) {
      this.cache.delete(uri);
    } else if (this.cache.size >= MAX_CACHED_URIS) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(uri, entry);
    return { doc, schema };
  }

  getActiveRuleName(
    uri: string,
    versionId: number,
    source: string,
    dataset: Dataset,
    pos: TextPosition,
  ): string | null {
    const { doc } = this.getDocument(uri, versionId, source, dataset);
    const offset = offsetFromLineStarts(doc.source, doc.lineStarts, pos);
    return activeRuleAt(doc, offset)?.name ?? null;
  }

  recordAcceptance(contextKind: string, label: string): void {
    this.mru.record(contextKind, label);
  }

  provideCompletions(
    uri: string,
    versionId: number,
    source: string,
    dataset: Dataset,
    pos: TextPosition,
    filename = "",
  ): CompletionCandidate[] {
    const { doc, schema } = this.getDocument(uri, versionId, source, dataset);
    const ctx = analyzeCursorContext(doc, schema, pos);
    return buildCompletions(doc, schema, ctx, this.mru, filename);
  }

  provideInlinePrediction(
    uri: string,
    versionId: number,
    source: string,
    dataset: Dataset,
    pos: TextPosition,
    enabled = true,
  ): InlinePrediction | null {
    if (!enabled) return null;
    const { doc, schema } = this.getDocument(uri, versionId, source, dataset);
    const ctx = analyzeCursorContext(doc, schema, pos);
    return computeInlinePrediction(doc, schema, ctx, pos, enabled);
  }

  provideHover(
    uri: string,
    versionId: number,
    source: string,
    dataset: Dataset,
    pos: TextPosition,
  ): HoverResult | null {
    const { doc, schema } = this.getDocument(uri, versionId, source, dataset);
    return computeHover(doc, schema, pos);
  }

  provideSignatureHelp(
    uri: string,
    versionId: number,
    source: string,
    dataset: Dataset,
    pos: TextPosition,
  ): SignatureResult | null {
    const { doc } = this.getDocument(uri, versionId, source, dataset);
    return computeSignatureHelp(doc, pos);
  }

  provideDefinition(
    uri: string,
    versionId: number,
    source: string,
    dataset: Dataset,
    pos: TextPosition,
  ): TextRange | null {
    const { doc } = this.getDocument(uri, versionId, source, dataset);
    return computeDefinition(doc, pos);
  }

  provideReferences(
    uri: string,
    versionId: number,
    source: string,
    dataset: Dataset,
    pos: TextPosition,
    includeDeclaration = true,
  ): TextRange[] {
    const { doc } = this.getDocument(uri, versionId, source, dataset);
    return computeReferences(doc, pos, includeDeclaration);
  }

  provideDocumentSymbols(
    uri: string,
    versionId: number,
    source: string,
    dataset: Dataset,
  ): OutlineSymbol[] {
    const { doc } = this.getDocument(uri, versionId, source, dataset);
    return computeDocumentSymbols(doc);
  }

  provideQuickFixes(
    uri: string,
    versionId: number,
    source: string,
    dataset: Dataset,
    markers: readonly MarkerInput[],
  ): QuickFixAction[] {
    const { doc, schema } = this.getDocument(uri, versionId, source, dataset);
    return computeQuickFixes(doc, schema, markers);
  }

  clearCache(): void {
    this.cache.clear();
  }
}
