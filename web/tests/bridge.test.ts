import { it, expect } from "vitest";
import { byteOffsetToPosition } from "../src/services/positions";
it("converts original UTF-8 byte offsets into editor UTF-16 positions", () => {
  expect(byteOffsetToPosition("a😀é\nbad", 7)).toEqual({
    lineNumber: 1,
    column: 5,
  });
  expect(byteOffsetToPosition("a😀é\nbad", 8)).toEqual({
    lineNumber: 2,
    column: 1,
  });
});
