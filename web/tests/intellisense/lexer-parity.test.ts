import { describe, it, expect } from "vitest";
import high from "../../../examples/high_glucose_alert.helix?raw";
import basic from "../../../examples/basic_rule.helix?raw";
import sepsis from "../../../examples/alert_rule.helix?raw";
import temporal from "../../../examples/temporal_rule.helix?raw";
import invalid from "../../../examples/invalid_syntax_demo.helix?raw";
import { HELIX_KEYWORDS } from "../../src/editor/intellisense/types";
import {
  tokenizeHelix,
  isOffsetInComment,
  positionToOffset,
  offsetToPosition,
} from "../../src/editor/intellisense/lexer";

describe("HELIX error-tolerant lexer parity", () => {
  it("exports the exact 21 C11 reserved keywords", () => {
    expect(HELIX_KEYWORDS).toHaveLength(21);
    expect([...HELIX_KEYWORDS].sort()).toEqual([
      "alert",
      "and",
      "bind",
      "end",
      "for",
      "intent",
      "latest",
      "let",
      "not",
      "or",
      "otherwise",
      "rule",
      "schedule",
      "site",
      "source",
      "suppress",
      "terminology",
      "then",
      "when",
      "where",
      "within",
    ]);
  });

  it("tokenizes all four valid presets without error tokens", () => {
    for (const src of [high, basic, sepsis, temporal]) {
      const res = tokenizeHelix(src);
      expect(res.tokens.some((t) => t.kind === "error")).toBe(false);
      expect(res.tokens.some((t) => t.kind === "unterminated_string")).toBe(false);
      expect(res.tokens[res.tokens.length - 1]?.kind).toBe("eof");
    }
  });

  it("recovers cleanly from unterminated strings, CRLF, and unicode without corrupting next line", () => {
    const src = 'rule R:\r\n    # temp °C 😀\r\n    alert: "unterminated\r\n    end rule\r\n';
    const res = tokenizeHelix(src);
    const unterm = res.tokens.find((t) => t.kind === "unterminated_string");
    expect(unterm?.lexeme).toBe('"unterminated');
    expect(unterm?.line).toBe(3);
    const endKw = res.tokens.find((t) => t.kind === "keyword" && t.lexeme === "end");
    expect(endKw?.line).toBe(4);
    expect(
      isOffsetInComment(
        res.comments,
        positionToOffset(src, { lineNumber: 2, column: 10 })
      )
    ).toBe(true);
    expect(
      isOffsetInComment(
        res.comments,
        positionToOffset(src, { lineNumber: 2, column: 17 })
      )
    ).toBe(true);
    expect(
      isOffsetInComment(
        res.comments,
        positionToOffset(src, { lineNumber: 4, column: 5 })
      )
    ).toBe(false);
    const emojiEnd = positionToOffset(src, { lineNumber: 2, column: 16 });
    expect(offsetToPosition(src, emojiEnd)).toEqual({ lineNumber: 2, column: 16 });
    const afterEmoji = positionToOffset(src, { lineNumber: 2, column: 17 });
    expect(offsetToPosition(src, afterEmoji)).toEqual({ lineNumber: 2, column: 17 });
  });

  it("recognizes multi-char operators and flags lone '!' as error token", () => {
    const res = tokenizeHelix("a := 1 + 2 - 3 * 4 / 5 == 6 != 7 <= 8 >= 9 -> x ! y");
    expect(
      res.tokens.filter((t) => t.kind === "operator").map((t) => t.lexeme)
    ).toEqual([":=", "+", "-", "*", "/", "==", "!=", "<=", ">=", "->"]);
    expect(res.tokens.find((t) => t.kind === "error")?.lexeme).toBe("!");
    expect(
      tokenizeHelix(invalid).tokens.some(
        (t) => t.kind === "error" || t.kind === "unterminated_string"
      )
    ).toBe(true);
  });

  it("matches C11 lexer rules for numbers, member access after numbers, delimiters, and string escapes", () => {
    const res = tokenizeHelix(
      '123 45.67 123.latest 123abc 12.34.56 "ok\\"\\\\\\n\\t\\r" "bad\\q" "trail\\\nend'
    );
    const summary = res.tokens.map((t) => [t.kind, t.lexeme]);
    expect(summary).toEqual([
      ["int", "123"],
      ["float", "45.67"],
      ["int", "123"],
      ["delimiter", "."],
      ["keyword", "latest"],
      ["error", "123abc"],
      ["error", "12.34.56"],
      ["string", '"ok\\"\\\\\\n\\t\\r"'],
      ["error", '"bad\\q"'],
      ["unterminated_string", '"trail\\'],
      ["keyword", "end"],
      ["eof", ""],
    ]);
    expect(res.tokens[res.tokens.length - 2]?.line).toBe(2);
  });

  it("handles empty input, standalone CR line endings, and clamps positionToOffset/offsetToPosition", () => {
    const empty = tokenizeHelix("");
    expect(empty.tokens).toHaveLength(1);
    expect(empty.tokens[0]).toMatchObject({
      kind: "eof",
      lexeme: "",
      startOffset: 0,
      endOffset: 0,
      line: 1,
      column: 1,
    });
    expect(empty.lineStarts).toEqual([0]);
    expect(isOffsetInComment(empty.comments, 0)).toBe(false);

    const macCr = "rule A:\r    # comment\r    end rule";
    const crRes = tokenizeHelix(macCr);
    expect(crRes.lineStarts).toEqual([0, 8, 22]);
    expect(crRes.comments).toHaveLength(1);
    expect(crRes.comments[0]?.text).toBe("# comment");
    expect(crRes.tokens.find((t) => t.lexeme === "end")?.line).toBe(3);

    expect(positionToOffset(macCr, { lineNumber: 1, column: 999 })).toBe(7);
    expect(positionToOffset(macCr, { lineNumber: 99, column: 1 })).toBe(macCr.length);
    expect(offsetToPosition(macCr, -5)).toEqual({ lineNumber: 1, column: 1 });
    expect(offsetToPosition(macCr, 9999)).toEqual({ lineNumber: 3, column: 13 });
  });
});
