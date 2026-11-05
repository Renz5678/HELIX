import type * as Monaco from "monaco-editor";
export const keywords = [
  "rule",
  "intent",
  "bind",
  "site",
  "source",
  "terminology",
  "schedule",
  "when",
  "for",
  "let",
  "latest",
  "where",
  "and",
  "or",
  "not",
  "within",
  "then",
  "alert",
  "suppress",
  "otherwise",
  "end",
];
const docs: Record<string, string> = {
  rule: "Declare a named rule terminated by end rule",
  bind: "Map a series to a table column, optionally filtered by where and within, terminated by end bind",
  source: "Select a local table or describe source-system metadata",
  when: "Run then for TRUE, otherwise for FALSE, terminated by end when; UNKNOWN executes neither",
  latest:
    "Select the latest eligible patient reading using the evaluation timestamp",
  within: "Restrict readings to an inclusive time window",
  suppress:
    "Record a simulated suppression request; no state persists between runs",
};
export function register(monaco: typeof Monaco, getTables: () => string[]) {
  if (!monaco.languages.getLanguages().some((l) => l.id === "helix"))
    monaco.languages.register({ id: "helix", extensions: [".helix"] });
  monaco.languages.setMonarchTokensProvider("helix", {
    keywords,
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
        [/:=|==|!=|<=|>=|->|[=<>]/, "operator"],
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
  return monaco.languages.registerCompletionItemProvider("helix", {
    triggerCharacters: [".", " "],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const prefix = model
        .getLineContent(position.lineNumber)
        .slice(0, position.column - 1);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const words = /\.\w*$/.test(prefix)
        ? ["latest"]
        : /\bthen\s*$/.test(prefix)
          ? ["alert", "suppress"]
          : /\b(source|bind)\s+\w*$/.test(prefix)
            ? getTables()
            : /\bwhen\b/.test(prefix)
              ? ["and", "or", "not", "within", ...keywords]
              : keywords;
      return {
        suggestions: [
          ...words.map((label) => ({
            label,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: label,
            documentation: docs[label] || `HELIX ${label} keyword`,
            range,
          })),
          ...(!/\./.test(prefix)
            ? [
                {
                  label: "rule template",
                  kind: monaco.languages.CompletionItemKind.Snippet,
                  insertText:
                    'rule ${1:RuleName}:\n    source ${2:glucose_data}\n    when ${2:glucose_data}.latest > ${3:250} then\n        alert: "${4:High reading}", "WARNING"\n    end when\nend rule',
                  insertTextRules:
                    monaco.languages.CompletionItemInsertTextRule
                      .InsertAsSnippet,
                  range,
                },
                {
                  label: "when / otherwise",
                  kind: monaco.languages.CompletionItemKind.Snippet,
                  insertText:
                    'when ${1:reading}.latest > ${2:250} then\n    alert: "${3:High reading}"\notherwise\n    suppress: within ${4:1} hours\nend when',
                  insertTextRules:
                    monaco.languages.CompletionItemInsertTextRule
                      .InsertAsSnippet,
                  range,
                },
                {
                  label: "filtered binding",
                  kind: monaco.languages.CompletionItemKind.Snippet,
                  insertText:
                    'bind ${1:readings} = ${2:Vitals.heart_rate} where status == "final" within ${3:30} minutes end bind',
                  insertTextRules:
                    monaco.languages.CompletionItemInsertTextRule
                      .InsertAsSnippet,
                  range,
                },
              ]
            : []),
        ],
      };
    },
  });
}
