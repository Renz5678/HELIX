import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api";
import type { CompletionKind } from "./intellisense/completions";
import { HelixIntelliSense } from "./intellisense/engine";
import type { MarkerInput, OutlineSymbol, OutlineSymbolKind } from "./intellisense/providers";
import {
  HELIX_KEYWORDS,
  type HelixLanguageHost,
  type TextRange,
} from "./intellisense/types";

export { HELIX_KEYWORDS as keywords };

function mapCompletionKind(
  monaco: typeof Monaco,
  kind: CompletionKind,
): Monaco.languages.CompletionItemKind {
  const kinds = monaco.languages.CompletionItemKind;
  switch (kind) {
    case "keyword":
      return kinds.Keyword;
    case "variable":
      return kinds.Variable;
    case "field":
      return kinds.Field;
    case "property":
      return kinds.Property;
    case "class":
      return kinds.Class;
    case "value":
      return kinds.Value;
    case "enumMember":
      return kinds.EnumMember;
    case "unit":
      return kinds.Unit;
    case "snippet":
      return kinds.Snippet;
    case "module":
      return kinds.Module;
    case "constant":
      return kinds.Constant;
    case "operator":
      return kinds.Operator;
  }
}

function mapSymbolKind(
  monaco: typeof Monaco,
  kind: OutlineSymbolKind,
): Monaco.languages.SymbolKind {
  const kinds = monaco.languages.SymbolKind;
  switch (kind) {
    case "rule":
      return kinds.Class;
    case "source":
      return kinds.Module;
    case "bind":
      return kinds.Property;
    case "let":
      return kinds.Variable;
    case "when":
      return kinds.Boolean;
    case "alert":
    case "suppress":
      return kinds.Event;
  }
}

function toMonacoDocumentSymbol(
  monaco: typeof Monaco,
  sym: OutlineSymbol,
): Monaco.languages.DocumentSymbol {
  return {
    name: sym.name,
    detail: sym.detail,
    kind: mapSymbolKind(monaco, sym.kind),
    tags: [],
    range: sym.range,
    selectionRange: sym.selectionRange,
    children: sym.children.map((child) =>
      toMonacoDocumentSymbol(monaco, child),
    ),
  };
}

function comparePos(
  aLine: number,
  aCol: number,
  bLine: number,
  bCol: number,
): number {
  if (aLine !== bLine) return aLine - bLine;
  return aCol - bCol;
}

function rangesOverlap(a: TextRange, b: TextRange): boolean {
  return (
    comparePos(a.endLineNumber, a.endColumn, b.startLineNumber, b.startColumn) >=
      0 &&
    comparePos(b.endLineNumber, b.endColumn, a.startLineNumber, a.startColumn) >=
      0
  );
}

function markerToInput(m: Monaco.editor.IMarker): MarkerInput {
  const code =
    typeof m.code === "string"
      ? m.code
      : m.code && typeof m.code === "object" && "value" in m.code
        ? m.code.value
        : undefined;
  return {
    code,
    message: m.message,
    range: {
      startLineNumber: m.startLineNumber,
      startColumn: m.startColumn,
      endLineNumber: m.endLineNumber,
      endColumn: m.endColumn,
    },
    severity: m.severity,
  };
}

/**
 * Registers the HELIX language, Monarch tokenizer, dark theme, language
 * configuration, acceptance-tracking command, and all 8 Monaco IDE providers.
 */
export function registerHelixLanguage(
  monaco: typeof Monaco,
  host: HelixLanguageHost,
  engine: HelixIntelliSense = new HelixIntelliSense(),
): Monaco.IDisposable {
  if (!monaco.languages.getLanguages().some((l) => l.id === "helix")) {
    monaco.languages.register({ id: "helix", extensions: [".helix"] });
  }

  monaco.languages.setMonarchTokensProvider("helix", {
    keywords: [...HELIX_KEYWORDS],
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/"(?:[^"\\]|\\.)*"/, "string"],
        [/".*$/, "invalid"],
        [/\b\d+\.\d+\b/, "number"],
        [/\b\d+\b/, "number"],
        [
          /[a-zA-Z_][\w]*/,
          { cases: { "@keywords": "keyword", "@default": "identifier" } },
        ],
        [/:=|==|!=|<=|>=|->|[=<>+\-*/]/, "operator"],
        [/[.:,()[\]]/, "delimiter"],
      ],
    },
  });

  monaco.languages.setLanguageConfiguration("helix", {
    comments: { lineComment: "#" },
    brackets: [
      ["(", ")"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: '"', close: '"' },
    ],
    wordPattern: /[a-zA-Z_][\w]*/,
    folding: {
      markers: {
        start: /^\s*(?:rule|bind|when)\b/,
        end: /^\s*end\s+(?:rule|bind|when)\b/,
      },
    },
    indentationRules: {
      increaseIndentPattern:
        /^\s*(?:rule|when|then|otherwise|bind)\b(?![^#]*\bend\s+bind\b)/,
      decreaseIndentPattern: /^\s*(?:end\b|otherwise\b|then\b)/,
    },
  });

  monaco.editor.defineTheme("helix-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "00D9E8" },
      { token: "identifier", foreground: "F2F8F9" },
      { token: "string", foreground: "34D399" },
      { token: "number", foreground: "FBBF24" },
      { token: "comment", foreground: "8CA5AE" },
      { token: "invalid", foreground: "F87171" },
    ],
    colors: {
      "editor.background": "#0D171D",
      "editor.foreground": "#F2F8F9",
      "editorLineNumber.foreground": "#526F79",
      "editorLineNumber.activeForeground": "#35E8D0",
      "editor.selectionBackground": "#164C54",
      "editorCursor.foreground": "#00D9E8",
      "editor.lineHighlightBackground": "#10232A",
      "editorIndentGuide.background1": "#1A333D",
    },
  });

  const disposables: Monaco.IDisposable[] = [];

  if (typeof monaco.editor.registerCommand === "function") {
    disposables.push(
      monaco.editor.registerCommand(
        "helix.recordAcceptance",
        (_accessor: unknown, contextKind?: unknown, label?: unknown) => {
          if (typeof contextKind === "string" && typeof label === "string") {
            engine.recordAcceptance(contextKind, label);
          }
        },
      ),
    );
  }

  disposables.push(
    monaco.languages.registerCompletionItemProvider("helix", {
      triggerCharacters: [".", '"', "(", "["],
      provideCompletionItems(model, position) {
        const items = engine.provideCompletions(
          model.uri.toString(),
          model.getVersionId(),
          model.getValue(),
          host.getDataset(),
          position,
          host.getFilename(),
        );
        return {
          suggestions: items.map((item) => ({
            label: item.label,
            kind: mapCompletionKind(monaco, item.kind),
            insertText: item.insertText,
            ...(item.isSnippet
              ? {
                  insertTextRules:
                    monaco.languages.CompletionItemInsertTextRule
                      .InsertAsSnippet,
                }
              : {}),
            detail: item.detail,
            documentation: item.documentation
              ? { value: item.documentation }
              : undefined,
            sortText: item.sortText,
            ...(item.filterText !== undefined
              ? { filterText: item.filterText }
              : {}),
            range: item.range,
            ...(item.preselect !== undefined
              ? { preselect: item.preselect }
              : {}),
            command: {
              id: "helix.recordAcceptance",
              title: "Record",
              arguments: [item.contextKind, item.label],
            },
          })),
        };
      },
    }),
  );

  disposables.push(
    monaco.languages.registerInlineCompletionsProvider("helix", {
      provideInlineCompletions(model, position) {
        const enabled = host.getSettings().inlinePredictions;
        if (!enabled) {
          return { items: [] };
        }
        const pred = engine.provideInlinePrediction(
          model.uri.toString(),
          model.getVersionId(),
          model.getValue(),
          host.getDataset(),
          position,
          enabled,
        );
        return {
          items: pred
            ? [{ insertText: pred.insertText, range: pred.range }]
            : [],
        };
      },
      freeInlineCompletions() {},
    }),
  );

  disposables.push(
    monaco.languages.registerHoverProvider("helix", {
      provideHover(model, position) {
        const res = engine.provideHover(
          model.uri.toString(),
          model.getVersionId(),
          model.getValue(),
          host.getDataset(),
          position,
        );
        if (!res) return null;
        return {
          range: res.range,
          contents: [{ value: res.markdown }],
        };
      },
    }),
  );

  disposables.push(
    monaco.languages.registerSignatureHelpProvider("helix", {
      signatureHelpTriggerCharacters: [":", ",", "(", "["],
      signatureHelpRetriggerCharacters: [","],
      provideSignatureHelp(model, position) {
        const res = engine.provideSignatureHelp(
          model.uri.toString(),
          model.getVersionId(),
          model.getValue(),
          host.getDataset(),
          position,
        );
        if (!res) return null;
        return {
          value: {
            signatures: res.signatures.map((sig) => ({
              label: sig.label,
              documentation: sig.documentation
                ? { value: sig.documentation }
                : undefined,
              parameters: sig.parameters.map((p) => ({
                label: p.label,
                documentation: p.documentation
                  ? { value: p.documentation }
                  : undefined,
              })),
            })),
            activeSignature: res.activeSignature,
            activeParameter: res.activeParameter,
          },
          dispose() {},
        };
      },
    }),
  );

  disposables.push(
    monaco.languages.registerDefinitionProvider("helix", {
      provideDefinition(model, position) {
        const range = engine.provideDefinition(
          model.uri.toString(),
          model.getVersionId(),
          model.getValue(),
          host.getDataset(),
          position,
        );
        if (!range) return null;
        return { uri: model.uri, range };
      },
    }),
  );

  disposables.push(
    monaco.languages.registerReferenceProvider("helix", {
      provideReferences(model, position, context) {
        const ranges = engine.provideReferences(
          model.uri.toString(),
          model.getVersionId(),
          model.getValue(),
          host.getDataset(),
          position,
          context.includeDeclaration,
        );
        return ranges.map((range) => ({ uri: model.uri, range }));
      },
    }),
  );

  disposables.push(
    monaco.languages.registerDocumentSymbolProvider("helix", {
      provideDocumentSymbols(model) {
        const symbols = engine.provideDocumentSymbols(
          model.uri.toString(),
          model.getVersionId(),
          model.getValue(),
          host.getDataset(),
        );
        return symbols.map((sym) => toMonacoDocumentSymbol(monaco, sym));
      },
    }),
  );

  disposables.push(
    monaco.languages.registerCodeActionProvider(
      "helix",
      {
        provideCodeActions(model, range) {
          const markers = monaco.editor
            .getModelMarkers({ owner: "helix", resource: model.uri })
            .map(markerToInput)
            .filter((m) => rangesOverlap(m.range, range));

          const quickFixes = engine.provideQuickFixes(
            model.uri.toString(),
            model.getVersionId(),
            model.getValue(),
            host.getDataset(),
            markers,
          );

          const versionId = model.getVersionId();
          const actions: Monaco.languages.CodeAction[] = quickFixes.map(
            (fix) => ({
              title: fix.title,
              kind: "quickfix",
              isPreferred: fix.isPreferred,
              edit: {
                edits: [
                  {
                    resource: model.uri,
                    textEdit: {
                      range: fix.edit.range,
                      text: fix.edit.text,
                    },
                    versionId,
                  },
                ],
              },
            }),
          );

          return {
            actions,
            dispose() {},
          };
        },
      },
      { providedCodeActionKinds: ["quickfix"] },
    ),
  );

  return {
    dispose() {
      for (const d of disposables) {
        d.dispose();
      }
      engine.clearCache();
    },
  };
}
