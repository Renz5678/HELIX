import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAst } from './ast.js';
import { extractTerminologyCalls, findTerm, terminologyDiagnostics } from './terminology.js';

function tokensFromPairs(pairs) {
  return pairs.map(([type, lexeme], i) => ({ type, lexeme, line: 1, column: i + 1 }));
}

test('AST parses Page 3 single concept -> LOINC[...] mapping and source : FHIR_R4', () => {
  const { program, failed } = buildAst(tokensFromPairs([
    ['TOKEN_KW_RULE', 'rule'], ['TOKEN_IDENTIFIER', 'Hyperkalemia_Alert'],
    ['TOKEN_KW_SOURCE', 'source'], ['TOKEN_COLON', ':'], ['TOKEN_IDENTIFIER', 'FHIR_R4'],
    ['TOKEN_KW_TERMINOLOGY', 'terminology'],
    ['TOKEN_IDENTIFIER', 'potassium'], ['TOKEN_ARROW', '->'],
    ['TOKEN_IDENTIFIER', 'LOINC'], ['TOKEN_LBRACKET', '['],
    ['TOKEN_STRING_LIT', '"serum potassium"'], ['TOKEN_RBRACKET', ']'],
    ['TOKEN_KW_END', 'end'], ['TOKEN_KW_RULE', 'rule'],
  ]));
  assert.equal(failed, null);
  const rule = program.children[0];
  assert.equal(rule.detail, 'Hyperkalemia_Alert');
  const srcNode = rule.children.find((n) => n.kind === 'SourceBindingNode');
  assert.equal(srcNode.detail, 'FHIR_R4');
  const termNode = rule.children.find((n) => n.kind === 'TerminologyNode');
  assert.equal(termNode.detail, 'potassium -> LOINC["serum potassium"]');
  assert.equal(termNode.children.length, 1);
  assert.equal(termNode.children[0].kind, 'TerminologyMapping');
});

test('AST parses multi-entry terminology mapping block without swallowing following statements', () => {
  const { program, failed } = buildAst(tokensFromPairs([
    ['TOKEN_KW_RULE', 'rule'], ['TOKEN_IDENTIFIER', 'MultiMapping'],
    ['TOKEN_KW_TERMINOLOGY', 'terminology'],
    ['TOKEN_IDENTIFIER', 'potassium'], ['TOKEN_ARROW', '->'],
    ['TOKEN_IDENTIFIER', 'LOINC'], ['TOKEN_LBRACKET', '['], ['TOKEN_STRING_LIT', '"serum potassium"'], ['TOKEN_RBRACKET', ']'],
    ['TOKEN_IDENTIFIER', 'sodium'], ['TOKEN_ARROW', '->'],
    ['TOKEN_IDENTIFIER', 'LOINC'], ['TOKEN_LBRACKET', '['], ['TOKEN_STRING_LIT', '"2951-2"'], ['TOKEN_RBRACKET', ']'],
    ['TOKEN_KW_LET', 'let'], ['TOKEN_IDENTIFIER', 'x'], ['TOKEN_ASSIGN', ':='], ['TOKEN_INT_LIT', '1'],
    ['TOKEN_KW_END', 'end'], ['TOKEN_KW_RULE', 'rule'],
  ]));
  assert.equal(failed, null);
  const rule = program.children[0];
  const termNode = rule.children.find((n) => n.kind === 'TerminologyNode');
  assert.equal(termNode.detail, 'potassium -> LOINC["serum potassium"], sodium -> LOINC["2951-2"]');
  assert.equal(termNode.children.length, 2);
  const letNode = rule.children.find((n) => n.kind === 'LetBindingNode');
  assert.equal(letNode.detail, 'x');
});

test('AST preserves legacy direct terminology: LOINC("2339-0") syntax', () => {
  const { program, failed } = buildAst(tokensFromPairs([
    ['TOKEN_KW_RULE', 'rule'], ['TOKEN_IDENTIFIER', 'LegacyRule'], ['TOKEN_COLON', ':'],
    ['TOKEN_KW_TERMINOLOGY', 'terminology'], ['TOKEN_COLON', ':'],
    ['TOKEN_IDENTIFIER', 'LOINC'], ['TOKEN_LPAREN', '('], ['TOKEN_STRING_LIT', '"2339-0"'], ['TOKEN_RPAREN', ')'],
    ['TOKEN_KW_END', 'end'], ['TOKEN_KW_RULE', 'rule'],
  ]));
  assert.equal(failed, null);
  const termNode = program.children[0].children[0];
  assert.equal(termNode.kind, 'TerminologyNode');
  assert.equal(termNode.detail, 'LOINC("2339-0")');
});

test('Terminology service extracts both bracketed LOINC[...] and parenthesized LOINC(...) without warnings on serum potassium', () => {
  const sample = `
    rule Hyperkalemia_Alert
      source : FHIR_R4
      terminology
        potassium -> LOINC["serum potassium"]
        glucose -> LOINC("2339-0")
    end rule
  `;
  const calls = extractTerminologyCalls(sample);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => ({ system: c.system, code: c.code })), [
    { system: 'LOINC', code: 'serum potassium' },
    { system: 'LOINC', code: '2339-0' },
  ]);
  assert.equal(findTerm('LOINC', 'serum potassium')?.code, '2823-3');
  assert.deepEqual(terminologyDiagnostics(sample), []);
});
