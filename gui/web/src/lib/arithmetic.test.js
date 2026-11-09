import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAst } from './ast.js';
import { executeRule, defaultPayload } from './sandbox.js';

function toTokens(pairs) {
  return pairs.map(([type, lexeme], i) => ({ type, lexeme, line: 1, column: i + 1 }));
}

test('AST parses arithmetic precedence (* and / before + and -) and explicit end rule', () => {
  const tokens = toTokens([
    ['TOKEN_KW_RULE', 'rule'], ['TOKEN_IDENTIFIER', 'R'], ['TOKEN_COLON', ':'],
    ['TOKEN_KW_LET', 'let'], ['TOKEN_IDENTIFIER', 'x'], ['TOKEN_ASSIGN', ':='],
    ['TOKEN_INT_LIT', '1'], ['TOKEN_PLUS', '+'], ['TOKEN_INT_LIT', '2'],
    ['TOKEN_MINUS', '-'], ['TOKEN_INT_LIT', '3'], ['TOKEN_STAR', '*'],
    ['TOKEN_INT_LIT', '4'], ['TOKEN_SLASH', '/'], ['TOKEN_INT_LIT', '5'],
    ['TOKEN_KW_END', 'end'], ['TOKEN_KW_RULE', 'rule'],
  ]);
  const { program, failed } = buildAst(tokens);
  assert.equal(failed, null);
  const letNode = program.children[0].children[0];
  assert.equal(letNode.kind, 'LetBindingNode');
  assert.equal(letNode.detail, 'x');

  // Top-level expression is BinaryExpr '-' with left = (1 + 2) and right = ((3 * 4) / 5)
  const sub = letNode.children[0];
  assert.equal(sub.kind, 'BinaryExpr');
  assert.equal(sub.detail, '-');
  assert.equal(sub.children[0].kind, 'BinaryExpr');
  assert.equal(sub.children[0].detail, '+');
  assert.equal(sub.children[1].kind, 'BinaryExpr');
  assert.equal(sub.children[1].detail, '/');
  assert.equal(sub.children[1].children[0].kind, 'BinaryExpr');
  assert.equal(sub.children[1].children[0].detail, '*');
});

test('AST parses unary negation (-1, A * -B) and grouped expressions', () => {
  const tokens = toTokens([
    ['TOKEN_KW_RULE', 'rule'], ['TOKEN_IDENTIFIER', 'R'], ['TOKEN_COLON', ':'],
    ['TOKEN_KW_LET', 'let'], ['TOKEN_IDENTIFIER', 'neg'], ['TOKEN_ASSIGN', ':='],
    ['TOKEN_MINUS', '-'], ['TOKEN_INT_LIT', '1'],
    ['TOKEN_KW_LET', 'let'], ['TOKEN_IDENTIFIER', 'prod'], ['TOKEN_ASSIGN', ':='],
    ['TOKEN_IDENTIFIER', 'A'], ['TOKEN_STAR', '*'], ['TOKEN_MINUS', '-'], ['TOKEN_IDENTIFIER', 'B'],
    ['TOKEN_KW_END', 'end'], ['TOKEN_KW_RULE', 'rule'],
  ]);
  const { program, failed } = buildAst(tokens);
  assert.equal(failed, null);
  const [negLet, prodLet] = program.children[0].children;
  assert.equal(negLet.children[0].kind, 'UnaryExpr');
  assert.equal(negLet.children[0].detail, '-');
  assert.equal(negLet.children[0].children[0].detail, '1');

  assert.equal(prodLet.children[0].kind, 'BinaryExpr');
  assert.equal(prodLet.children[0].detail, '*');
  assert.equal(prodLet.children[0].children[1].kind, 'UnaryExpr');
  assert.equal(prodLet.children[0].children[1].detail, '-');
});

test('Sandbox evaluates arithmetic let calculations, precedence, and negative values', () => {
  const source = [
    'rule R:',
    '  bind glucose_data = Labs.glucose',
    '  end bind',
    '  let x := 1 + 2 - 3 * 4 / 5',
    '  let offset := -1',
    '  let threshold := 180 + 20 * 3 - 40 / 2',
    '  when glucose_data.latest + offset > threshold:',
    '  then:',
    '    alert: "High Glucose"',
    '  end when',
    'end rule',
  ].join('\n');
  const tokens = toTokens([
    ['TOKEN_KW_RULE', 'rule'], ['TOKEN_IDENTIFIER', 'R'], ['TOKEN_COLON', ':'],
    ['TOKEN_KW_BIND', 'bind'], ['TOKEN_IDENTIFIER', 'glucose_data'], ['TOKEN_EQUAL', '='],
    ['TOKEN_IDENTIFIER', 'Labs'], ['TOKEN_DOT', '.'], ['TOKEN_IDENTIFIER', 'glucose'],
    ['TOKEN_KW_END', 'end'], ['TOKEN_KW_BIND', 'bind'],
    ['TOKEN_KW_LET', 'let'], ['TOKEN_IDENTIFIER', 'x'], ['TOKEN_ASSIGN', ':='],
    ['TOKEN_INT_LIT', '1'], ['TOKEN_PLUS', '+'], ['TOKEN_INT_LIT', '2'],
    ['TOKEN_MINUS', '-'], ['TOKEN_INT_LIT', '3'], ['TOKEN_STAR', '*'],
    ['TOKEN_INT_LIT', '4'], ['TOKEN_SLASH', '/'], ['TOKEN_INT_LIT', '5'],
    ['TOKEN_KW_LET', 'let'], ['TOKEN_IDENTIFIER', 'offset'], ['TOKEN_ASSIGN', ':='],
    ['TOKEN_MINUS', '-'], ['TOKEN_INT_LIT', '1'],
    ['TOKEN_KW_LET', 'let'], ['TOKEN_IDENTIFIER', 'threshold'], ['TOKEN_ASSIGN', ':='],
    ['TOKEN_INT_LIT', '180'], ['TOKEN_PLUS', '+'], ['TOKEN_INT_LIT', '20'],
    ['TOKEN_STAR', '*'], ['TOKEN_INT_LIT', '3'], ['TOKEN_MINUS', '-'],
    ['TOKEN_INT_LIT', '40'], ['TOKEN_SLASH', '/'], ['TOKEN_INT_LIT', '2'],
    ['TOKEN_KW_WHEN', 'when'], ['TOKEN_IDENTIFIER', 'glucose_data'], ['TOKEN_DOT', '.'],
    ['TOKEN_KW_LATEST', 'latest'], ['TOKEN_PLUS', '+'], ['TOKEN_IDENTIFIER', 'offset'],
    ['TOKEN_GT', '>'], ['TOKEN_IDENTIFIER', 'threshold'], ['TOKEN_COLON', ':'],
    ['TOKEN_KW_THEN', 'then'], ['TOKEN_COLON', ':'],
    ['TOKEN_KW_ALERT', 'alert'], ['TOKEN_COLON', ':'], ['TOKEN_STRING_LIT', 'High Glucose'],
    ['TOKEN_KW_END', 'end'], ['TOKEN_KW_WHEN', 'when'],
    ['TOKEN_KW_END', 'end'], ['TOKEN_KW_RULE', 'rule'],
  ]);
  const res = executeRule(source, tokens, JSON.stringify(defaultPayload()));
  assert.equal(res.ok, true);
  assert.equal(res.fired, true);
  const text = res.log.map((l) => l.text).join('\n');
  assert.match(text, /let x := .*0\.6/);
  assert.match(text, /let offset := .*-1/);
  assert.match(text, /let threshold := .*220/);
});
