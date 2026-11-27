function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

export function byteOffsetToPosition(source: string, offset: number) {
  let bytes = 0,
    lineNumber = 1,
    column = 1;
  for (let i = 0; i < source.length; ) {
    if (bytes >= offset) break;
    const cp = source.codePointAt(i)!;
    const n = utf8ByteLength(cp);
    if (bytes + n > offset) break;
    bytes += n;
    const units = cp > 0xffff ? 2 : 1;
    if (cp === 10) {
      lineNumber++;
      column = 1;
    } else {
      column += units;
    }
    i += units;
  }
  return { lineNumber, column };
}
