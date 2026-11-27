import { describe, it, expect, vi } from "vitest";
import glucoseData from "../../../examples/data/glucose.json";
import type { Dataset } from "../../src/services/types";
import {
  registerHelixLanguage,
  keywords,
} from "../../src/editor/language";
import { HelixIntelliSense } from "../../src/editor/intellisense/engine";

function makeFakeModel(source: string, versionId = 1, uriStr = "inmemory://model/1") {
  const lines = source.split(/\r\n|\r|\n/);
  return {
    uri: { toString: () => uriStr },
    getValue: () => source,
    getVersionId: () => versionId,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? "",
    getWordUntilPosition: (pos: { lineNumber: number; column: number }) => {
      const line = lines[pos.lineNumber - 1] ?? "";
      const before = line.slice(0, pos.column - 1);
      const match = /[A-Za-z_][A-Za-z0-9_]*$/.exec(before);
      const word = match ? match[0] : "";
      return {
        word,
        startColumn: pos.column - word.length,
        endColumn: pos.column,
      };
    },
  };
}

function makeFakeMonaco(markers: Array<Record<string, unknown>> = []) {
  const disposables: ReturnType<typeof vi.fn>[] = [];
  const makeDisp = () => {
    const dispose = vi.fn();
    disposables.push(dispose);
    return { dispose };
  };
  let completionTriggerChars: string[] | undefined;
  let registeredProviders: Record<string, unknown> = {};
  const registeredCommands = new Map<string, (...args: unknown[]) => void>();

  const monacoMock = {
    languages: {
      getLanguages: vi.fn(() => []),
      register: vi.fn(),
      setMonarchTokensProvider: vi.fn(),
      setLanguageConfiguration: vi.fn(),
      registerCompletionItemProvider: vi.fn((_lang, provider) => {
        completionTriggerChars = provider.triggerCharacters;
        registeredProviders.completion = provider;
        return makeDisp();
      }),
      registerInlineCompletionsProvider: vi.fn((_lang, provider) => {
        registeredProviders.inline = provider;
        return makeDisp();
      }),
      registerHoverProvider: vi.fn((_lang, provider) => {
        registeredProviders.hover = provider;
        return makeDisp();
      }),
      registerSignatureHelpProvider: vi.fn((_lang, provider) => {
        registeredProviders.signature = provider;
        return makeDisp();
      }),
      registerDefinitionProvider: vi.fn((_lang, provider) => {
        registeredProviders.definition = provider;
        return makeDisp();
      }),
      registerReferenceProvider: vi.fn((_lang, provider) => {
        registeredProviders.reference = provider;
        return makeDisp();
      }),
      registerDocumentSymbolProvider: vi.fn((_lang, provider) => {
        registeredProviders.documentSymbol = provider;
        return makeDisp();
      }),
      registerCodeActionProvider: vi.fn((_lang, provider, metadata) => {
        registeredProviders.codeAction = provider;
        registeredProviders.codeActionMetadata = metadata;
        return makeDisp();
      }),
      CompletionItemKind: {
        Keyword: 17,
        Variable: 4,
        Field: 3,
        Property: 9,
        Class: 5,
        Value: 13,
        EnumMember: 16,
        Unit: 12,
        Snippet: 27,
        Module: 8,
        Constant: 14,
        Operator: 11,
      },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      SymbolKind: {
        Class: 4,
        Module: 1,
        Property: 6,
        Variable: 12,
        Boolean: 16,
        Event: 23,
      },
    },
    editor: {
      defineTheme: vi.fn(),
      registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => void) => {
        registeredCommands.set(id, handler);
        return makeDisp();
      }),
      getModelMarkers: vi.fn(() => markers),
    },
  };
  return {
    monacoMock,
    disposables,
    registeredProviders,
    registeredCommands,
    getTriggerChars: () => completionTriggerChars,
  };
}

describe("Monaco HELIX language registration", () => {
  it("registers all 8 providers with punctuation-only triggers (no space) and disposes cleanly", () => {
    const { monacoMock, disposables, getTriggerChars } = makeFakeMonaco();
    const disp = registerHelixLanguage(monacoMock as never, {
      getDataset: () => structuredClone(glucoseData) as Dataset,
      getSettings: () => ({ inlinePredictions: true, autoSuggest: true }),
      getFilename: () => "high_glucose_alert.helix",
    });

    expect(keywords).toHaveLength(21);
    expect(getTriggerChars()).toEqual([".", '"', "(", "["]);
    expect(monacoMock.languages.registerCompletionItemProvider).toHaveBeenCalledTimes(1);
    expect(monacoMock.languages.registerInlineCompletionsProvider).toHaveBeenCalledTimes(1);
    expect(monacoMock.languages.registerHoverProvider).toHaveBeenCalledTimes(1);
    expect(monacoMock.languages.registerSignatureHelpProvider).toHaveBeenCalledTimes(1);
    expect(monacoMock.languages.registerDefinitionProvider).toHaveBeenCalledTimes(1);
    expect(monacoMock.languages.registerReferenceProvider).toHaveBeenCalledTimes(1);
    expect(monacoMock.languages.registerDocumentSymbolProvider).toHaveBeenCalledTimes(1);
    expect(monacoMock.languages.registerCodeActionProvider).toHaveBeenCalledTimes(1);
    expect(monacoMock.editor.registerCommand).toHaveBeenCalledTimes(1);

    disp.dispose();
    expect(disposables).toHaveLength(9);
    for (const d of disposables) expect(d).toHaveBeenCalledTimes(1);
  });

  it("wires command, completions, inline gating, hover, signature, definition, references, symbols, and quick fixes", () => {
    const markers = [
      {
        owner: "helix",
        code: "SOURCE_NOT_FOUND",
        message: "Source table is not mapped: 'glucse_data'",
        startLineNumber: 2,
        startColumn: 12,
        endLineNumber: 2,
        endColumn: 23,
      },
      {
        owner: "helix",
        code: "SOURCE_NOT_FOUND",
        message: "Source table is not mapped: 'unreltd_tbl'",
        startLineNumber: 9,
        startColumn: 1,
        endLineNumber: 9,
        endColumn: 5,
      },
    ];
    const { monacoMock, registeredProviders, registeredCommands } =
      makeFakeMonaco(markers);
    const engine = new HelixIntelliSense();
    const recordSpy = vi.spyOn(engine, "recordAcceptance");
    const clearSpy = vi.spyOn(engine, "clearCache");

    let inlineEnabled = true;
    const disp = registerHelixLanguage(
      monacoMock as never,
      {
        getDataset: () => structuredClone(glucoseData) as Dataset,
        getSettings: () => ({
          inlinePredictions: inlineEnabled,
          autoSuggest: true,
        }),
        getFilename: () => "high_glucose_alert.helix",
      },
      engine,
    );

    const recordHandler = registeredCommands.get("helix.recordAcceptance");
    expect(recordHandler).toBeDefined();
    recordHandler?.({} /* _accessor */, "member", "latest");
    expect(recordSpy).toHaveBeenCalledWith("member", "latest");

    const source = [
      "rule HighGlucose:",
      "    source glucse_data",
      "    bind readings = glucose_data.value where ",
      "    when readings.latest > 250 then",
      '        alert: "High", ',
      "    end when",
      "end rule",
    ].join("\n");
    const model = makeFakeModel(source, 7);

    // Completions include acceptance tracking command
    const completionProvider = registeredProviders.completion as {
      provideCompletionItems: (
        m: unknown,
        pos: { lineNumber: number; column: number },
      ) => {
        suggestions: Array<{
          label: string;
          command?: { id: string; arguments?: unknown[] };
        }>;
      };
    };
    const compResult = completionProvider.provideCompletionItems(model, {
      lineNumber: 4,
      column: 19,
    });
    expect(compResult.suggestions.length).toBeGreaterThan(0);
    expect(compResult.suggestions[0].command?.id).toBe("helix.recordAcceptance");
    expect(compResult.suggestions[0].command?.arguments).toHaveLength(2);

    // Inline completions respect host.getSettings().inlinePredictions
    const inlineProvider = registeredProviders.inline as {
      provideInlineCompletions: (
        m: unknown,
        pos: { lineNumber: number; column: number },
      ) => { items: Array<{ insertText: string }> };
      freeInlineCompletions: (c: unknown) => void;
    };
    expect(typeof inlineProvider.freeInlineCompletions).toBe("function");
    inlineEnabled = false;
    const disabledInline = inlineProvider.provideInlineCompletions(model, {
      lineNumber: 3,
      column: 45,
    });
    expect(disabledInline.items).toEqual([]);

    // Hover
    const hoverProvider = registeredProviders.hover as {
      provideHover: (
        m: unknown,
        pos: { lineNumber: number; column: number },
      ) => { contents: Array<{ value: string }> } | null;
    };
    const hover = hoverProvider.provideHover(model, {
      lineNumber: 4,
      column: 11,
    });
    expect(hover?.contents[0]?.value).toContain("readings");

    // Signature help
    const sigProvider = registeredProviders.signature as {
      provideSignatureHelp: (
        m: unknown,
        pos: { lineNumber: number; column: number },
      ) => { value: { signatures: unknown[] }; dispose: () => void } | null;
    };
    const sig = sigProvider.provideSignatureHelp(model, {
      lineNumber: 5,
      column: 24,
    });
    expect(sig?.value.signatures.length).toBeGreaterThan(0);
    sig?.dispose();

    // Definition & References
    const defProvider = registeredProviders.definition as {
      provideDefinition: (
        m: unknown,
        pos: { lineNumber: number; column: number },
      ) => { uri: unknown; range: { startLineNumber: number } } | null;
    };
    const def = defProvider.provideDefinition(model, {
      lineNumber: 4,
      column: 11,
    });
    expect(def?.range.startLineNumber).toBe(3);

    const refProvider = registeredProviders.reference as {
      provideReferences: (
        m: unknown,
        pos: { lineNumber: number; column: number },
        ctx: { includeDeclaration: boolean },
      ) => Array<{ uri: unknown; range: unknown }>;
    };
    const refs = refProvider.provideReferences(
      model,
      { lineNumber: 4, column: 11 },
      { includeDeclaration: true },
    );
    expect(refs.length).toBeGreaterThanOrEqual(2);

    // Document symbols
    const symProvider = registeredProviders.documentSymbol as {
      provideDocumentSymbols: (
        m: unknown,
      ) => Array<{ name: string; children?: unknown[] }>;
    };
    const syms = symProvider.provideDocumentSymbols(model);
    expect(syms[0]?.name).toBe("HighGlucose");

    // Code actions filter markers to overlapping range & convert to WorkspaceEdit
    const codeActionProvider = registeredProviders.codeAction as {
      provideCodeActions: (
        m: unknown,
        range: {
          startLineNumber: number;
          startColumn: number;
          endLineNumber: number;
          endColumn: number;
        },
      ) => {
        actions: Array<{
          title: string;
          kind?: string;
          edit?: {
            edits: Array<{
              resource: unknown;
              textEdit: { range: unknown; text: string };
              versionId: number;
            }>;
          };
        }>;
        dispose: () => void;
      };
    };
    const actions = codeActionProvider.provideCodeActions(model, {
      startLineNumber: 2,
      startColumn: 12,
      endLineNumber: 2,
      endColumn: 20,
    });
    expect(actions.actions.length).toBeGreaterThan(0);
    expect(actions.actions[0].kind).toBe("quickfix");
    expect(actions.actions[0].edit?.edits[0].versionId).toBe(7);
    expect(actions.actions[0].edit?.edits[0].textEdit.text).toBe("glucose_data");
    actions.dispose();

    disp.dispose();
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});
