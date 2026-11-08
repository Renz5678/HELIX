import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAst } from './ast.js';
import { exportYaml } from './export.js';
import { parseSuppressMinutes, ruleParams, simulateTimeline } from './timeline.js';

// Token shape supplied by /api/analyze; repeat_of remains an identifier.
function suppressionAst(within, branchColons) {
  const pairs = [
    ['TOKEN_KW_RULE', 'rule'], ['TOKEN_IDENTIFIER', 'HighGlucoseAlert'], ['TOKEN_COLON', ':'],
    ['TOKEN_KW_WHEN', 'when'], ['TOKEN_IDENTIFIER', 'high'], ['TOKEN_KW_THEN', 'then'],
    ...(branchColons ? [['TOKEN_COLON', ':']] : []),
    ['TOKEN_KW_SUPPRESS', 'suppress'], ['TOKEN_IDENTIFIER', 'repeat_of'], ['TOKEN_COLON', ':'],
    ['TOKEN_IDENTIFIER', 'HighGlucoseAlert'],
    ...(within ? [['TOKEN_KW_WITHIN', 'within'], ['TOKEN_INT_LIT', '4'], ['TOKEN_IDENTIFIER', 'hours']] : []),
    ['TOKEN_KW_OTHERWISE', 'otherwise'],
    ...(branchColons ? [['TOKEN_COLON', ':']] : []),
    ['TOKEN_KW_ALERT', 'alert'], ['TOKEN_STRING_LIT', 'low'],
    ['TOKEN_KW_END', 'end'],
  ];
  return buildAst(pairs.map(([type, lexeme], i) => ({ type, lexeme, line: 1, column: i + 1 })));
}

for (const within of [false, true]) {
  for (const branchColons of [false, true]) {
    test(`repeat_of AST preserves target, window and following branch (within=${within}, colons=${branchColons})`, () => {
      const { program, failed } = suppressionAst(within, branchColons);
      assert.equal(failed, null);
      const block = program.children[0].children[0];
      const action = block.children.find((n) => n.kind === 'ThenBranch').children[0];
      assert.equal(action.kind, 'SuppressAction');
      assert.equal(action.detail, `repeat_of : HighGlucoseAlert${within ? ' within 4 hours' : ''}`);
      assert.equal(action.children.length, within ? 1 : 0);
      if (within) assert.equal(action.children[0].detail, '4');
      assert.equal(block.children.find((n) => n.kind === 'OtherwiseBranch').children[0].kind, 'AlertAction');
    });
  }
}

test('timeline recognizes repeat_of windows and existing suppression syntax', () => {
  for (const statement of [
    'suppress repeat_of : HighGlucoseAlert within 4 hours',
    'suppress: repeat_of:HighGlucoseAlert within 4 hours',
    'suppress: within 4 hours',
  ]) {
    assert.equal(parseSuppressMinutes(statement), 240, statement);
    const params = ruleParams(`rule HighGlucoseAlert: ${statement} end`);
    const result = simulateTimeline([0, 239, 240].map((t) => ({ t, code: '2339-0', value: 200 })), params);
    assert.deepEqual(result.results.map((r) => r.status), ['fired', 'suppressed', 'fired']);
  }
  assert.equal(parseSuppressMinutes('suppress repeat_of : HighGlucoseAlert'), 0);
});

test('YAML summary retains repeat_of and legacy suppression windows', async (t) => {
  let output;
  t.mock.method(URL, 'createObjectURL', (blob) => { output = blob; return 'blob:test'; });
  t.mock.method(URL, 'revokeObjectURL', () => {});
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ click() {} }) };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  for (const statement of [
    'suppress repeat_of : HighGlucoseAlert within 4 hours',
    'suppress: within 4 hours',
  ]) {
    exportYaml({ stats: { valid: true } }, { ruleName: 'HighGlucoseAlert', terminology: [] }, statement);
    assert.match(await output.text(), /suppress_within: 4 hours/);
  }
});
