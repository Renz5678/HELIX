/*
 * Instant local highlighter — mirrors the rules of the C lexer's DFA
 * (keywords, # comments, strings with escapes, int/float literals,
 * maximal-munch 2-char operators, error chars) so the editor repaints
 * on every keystroke with zero latency. The server remains the source
 * of truth for the token/diagnostic panels.
 */

export const KEYWORDS = new Set([
  'rule', 'intent', 'bind', 'site', 'source', 'terminology', 'schedule', 'when', 'for',
  'let', 'latest', 'where', 'and', 'or', 'not', 'within', 'then', 'alert', 'suppress',
  'otherwise', 'end',
]);

export const escapeHtml = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * Returns highlighted HTML for the given source.
 * @param {string} code
 * @param {{find?: string, curFind?: number}} [opts] optional find-and-replace marks
 */
export function highlight(code, opts = {}) {
  let out = '';
  let i = 0;
  const n = code.length;
  const isA = (c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
  const isN = (c) => c >= '0' && c <= '9';
  const isAN = (c) => isA(c) || isN(c);
  const span = (cls, txt) => `<span class="${cls}">${escapeHtml(txt)}</span>`;

  while (i < n) {
    const c = code[i];

    if (c === '\n') { out += '\n'; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { out += c; i++; continue; }

    /* # comment to end of line */
    if (c === '#') {
      let j = i;
      while (j < n && code[j] !== '\n') j++;
      out += span('k-comment', code.slice(i, j));
      i = j;
      continue;
    }

    /* string literal (unterminated -> error) */
    if (c === '"') {
      let j = i + 1, closed = false;
      while (j < n && code[j] !== '\n') {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === '"') { j++; closed = true; break; }
        j++;
      }
      out += span(closed ? 'k-string' : 'k-error', code.slice(i, j));
      i = j;
      continue;
    }

    /* numbers: int / float / malformed (123abc, 12.34.56) */
    if (isN(c)) {
      let j = i;
      while (j < n && isN(code[j])) j++;
      let isFloat = false;
      if (code[j] === '.' && isN(code[j + 1])) {
        isFloat = true;
        j++;
        while (j < n && isN(code[j])) j++;
      }
      let bad = false;
      if (j < n && isA(code[j])) { /* suffix: 123abc */
        while (j < n && isAN(code[j])) j++;
        bad = true;
      }
      if (isFloat && code[j] === '.') { /* double dot: 12.34.56 */
        while (j < n && (isN(code[j]) || code[j] === '.')) j++;
        bad = true;
      }
      out += span(bad ? 'k-error' : 'k-number', code.slice(i, j));
      i = j;
      continue;
    }

    /* identifiers / keywords */
    if (isA(c)) {
      let j = i;
      while (j < n && isAN(code[j])) j++;
      const w = code.slice(i, j);
      out += span(KEYWORDS.has(w) ? 'k-keyword' : 'k-identifier', w);
      i = j;
      continue;
    }

    /* two-char operators (maximal munch) */
    const two = code.substr(i, 2);
    if (two === ':=' || two === '==' || two === '!=' ||
        two === '<=' || two === '>=' || two === '->') {
      out += span('k-operator', two);
      i += 2;
      continue;
    }
    if (c === '=' || c === '<' || c === '>' || c === '+' || c === '-' || c === '*' || c === '/') {
      out += span('k-operator', c);
      i++;
      continue;
    }
    if (c === '!') { out += span('k-error', c); i++; continue; } /* lone ! is error */

    /* delimiters */
    if (c === ':' || c === '.' || c === ',' || c === '(' ||
        c === ')' || c === '[' || c === ']') {
      out += span('k-delimiter', c);
      i++;
      continue;
    }

    out += span('k-error', c); /* illegal character */
    i++;
  }
  return out;
}

/* --- position helpers shared across the app --- */

export function lineOfOffset(code, off) {
  let line = 1;
  for (let i = 0; i < off && i < code.length; i++) if (code[i] === '\n') line++;
  return line;
}

export function offsetOf(code, line, col) {
  const lines = code.split('\n');
  let off = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) off += lines[i].length + 1;
  return off + (col - 1);
}
