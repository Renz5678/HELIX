export function byteOffsetToPosition(source: string, offset: number) {
  let bytes = 0,
    lineNumber = 1,
    column = 1;
  for (const char of source) {
    if (bytes >= offset) break;
    const n = new TextEncoder().encode(char).length;
    if (bytes + n > offset) break;
    bytes += n;
    if (char === "\n") {
      lineNumber++;
      column = 1;
    } else column += char.length;
  }
  return { lineNumber, column };
}
