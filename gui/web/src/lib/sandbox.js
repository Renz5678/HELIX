/*
 * FHIR Sandbox — dry-run rule execution against an HL7 FHIR R4 payload.
 *
 * Strategy: reuse the AST built from the real C lexer's token stream,
 * locate the rule's condition expression, resolve identifiers against
 *   - `let` bindings (constants)
 *   - `bind` bindings (mapped to Observation values in the payload)
 * then evaluate and log every step, including branch outcome and the
 * suppression window that would follow.
 */

import { buildAst } from './ast.js';
import { parseLets, parseBinds, primaryTerminology, parseSuppressMinutes } from './timeline.js';

/* Common HELIX source paths -> LOINC codes (fallback: payload search). */
const PATH_TO_LOINC = {
  glucose: '2339-0',
  heart_rate: '8867-4',
  systolic_bp: '8480-6',
  diastolic_bp: '8462-4',
  body_temperature: '8310-5',
  white_blood_count: '6690-2',
  creatinine: '2160-0',
  respiratory_rate: '9279-1',
};

/** Flatten a FHIR Bundle (or loose array) into Observation records. */
export function extractObservations(payload) {
  const out = [];
  const seen = new Set();
  const pushObs = (o) => {
    if (!o || o.resourceType !== 'Observation' || seen.has(o)) return;
    seen.add(o);
    const coding = o.code?.coding?.[0] || {};
    const value =
      o.valueQuantity?.value ??
      o.valueInteger ??
      o.valueString ??
      o.component?.[0]?.valueQuantity?.value;
    out.push({
      code: coding.code || o.code?.text || '',
      system: coding.system || '',
      display: coding.display || o.code?.text || '',
      value,
      unit: o.valueQuantity?.unit || '',
      issued: o.effectiveDateTime || o.issued || '',
      resource: o,
    });
  };
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    pushObs(node);
    for (const v of Object.values(node)) walk(v);
  };
  walk(payload);
  return out.filter((o) => typeof o.value === 'number');
}

/** Default mock patient: glucose + vitals bundle matching the demo rules. */
export function defaultPayload() {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      { resource: { resourceType: 'Patient', id: 'demo-1', gender: 'female', birthDate: '1958-03-12' } },
      {
        resource: {
          resourceType: 'Observation',
          status: 'final',
          code: { coding: [{ system: 'http://loinc.org', code: '2339-0', display: 'Glucose [Mass/volume] in Blood' }] },
          valueQuantity: { value: 268, unit: 'mg/dL' },
          effectiveDateTime: '2026-01-01T08:10:00Z',
        },
      },
      {
        resource: {
          resourceType: 'Observation',
          status: 'final',
          code: { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Systolic blood pressure' }] },
          valueQuantity: { value: 88, unit: 'mm[Hg]' },
          effectiveDateTime: '2026-01-01T08:12:00Z',
        },
      },
      {
        resource: {
          resourceType: 'Observation',
          status: 'final',
          code: { coding: [{ system: 'http://loinc.org', code: '8310-5', display: 'Body temperature' }] },
          valueQuantity: { value: 38.9, unit: 'Cel' },
          effectiveDateTime: '2026-01-01T08:12:30Z',
        },
      },
      {
        resource: {
          resourceType: 'Observation',
          status: 'final',
          code: { coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart rate' }] },
          valueQuantity: { value: 124, unit: '/min' },
          effectiveDateTime: '2026-01-01T08:13:00Z',
        },
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Expression evaluation over the AST                                   */
/* ------------------------------------------------------------------ */

class EvalContext {
  constructor({ lets, bindValues, observations, log }) {
    this.lets = lets;
    this.bindValues = bindValues;
    this.observations = observations;
    this.log = log;
  }
}

function evalNode(node, ctx) {
  if (!node) return undefined;
  switch (node.kind) {
    case 'IntLiteral':
    case 'FloatLiteral':
      return Number(node.detail);
    case 'StringLiteral':
      return node.detail;
    case 'Identifier': {
      const name = node.detail;
      if (Object.prototype.hasOwnProperty.call(ctx.lets, name)) return ctx.lets[name];
      if (Object.prototype.hasOwnProperty.call(ctx.bindValues, name)) return ctx.bindValues[name];
      return undefined;
    }
    case 'GroupExpr':
      return evalNode(node.children[0], ctx);
    case 'UnaryExpr': {
      const v = evalNode(node.children[0], ctx);
      if (node.detail === '-') return typeof v === 'number' ? -v : undefined;
      return !v;
    }
    case 'MemberExpr': {
      /* <bind>.latest — first child is the base identifier */
      const base = node.children[0];
      if (base && base.kind === 'Identifier') {
        const v = ctx.bindValues[base.detail];
        if (v !== undefined) return v;
      }
      return undefined;
    }
    case 'BinaryExpr': {
      const op = node.detail;
      if (op === 'and') return !!evalNode(node.children[0], ctx) && !!evalNode(node.children[1], ctx);
      if (op === 'or') return !!evalNode(node.children[0], ctx) || !!evalNode(node.children[1], ctx);
      const l = evalNode(node.children[0], ctx);
      const r = evalNode(node.children[1], ctx);
      if (l === undefined || r === undefined) return undefined;
      switch (op) {
        case '+': return typeof l === 'number' && typeof r === 'number' ? l + r : undefined;
        case '-': return typeof l === 'number' && typeof r === 'number' ? l - r : undefined;
        case '*': return typeof l === 'number' && typeof r === 'number' ? l * r : undefined;
        case '/': return typeof l === 'number' && typeof r === 'number' && r !== 0 ? l / r : undefined;
        case '>': return l > r;
        case '>=': return l >= r;
        case '<': return l < r;
        case '<=': return l <= r;
        case '==':
        case '=': return l === r;
        case '!=': return l !== r;
        default: return undefined;
      }
    }
    case 'TemporalWindow':
      /* The sandbox ignores wall-clock windows — noted in the log instead. */
      ctx.log.push({ level: 'info', text: `temporal window "${node.detail}" honored in timeline simulator` });
      return evalNode(node.children[0], ctx);
    default:
      return undefined;
  }
}

/** Human-readable render of an expression for the log. */
function exprText(node) {
  if (!node) return '?';
  if (['IntLiteral', 'FloatLiteral', 'StringLiteral', 'Identifier'].includes(node.kind)) return node.detail;
  if (node.kind === 'MemberExpr') {
    const base = exprText(node.children[0]);
    const mem = node.children[1] ? node.children[1].detail : '?';
    return `${base}.${mem}`;
  }
  if (node.kind === 'GroupExpr') return `(${exprText(node.children[0])})`;
  if (node.kind === 'BinaryExpr') {
    if (node.detail === 'and' || node.detail === 'or') {
      return `${exprText(node.children[0])} ${node.detail} ${exprText(node.children[1])}`;
    }
    return `${exprText(node.children[0])} ${node.detail} ${exprText(node.children[1])}`;
  }
  if (node.kind === 'TemporalWindow') return exprText(node.children[0]);
  if (node.kind === 'UnaryExpr') return node.detail === '-' ? `-${exprText(node.children[0])}` : `not ${exprText(node.children[0])}`;
  return node.kind;
}

/**
 * Execute the active rule against a FHIR payload.
 * @returns {{ok: boolean, fired: boolean, log: Array<{level:string,text:string}>}}
 */
export function executeRule(source, tokens, payloadText) {
  const log = [];
  const push = (level, text) => log.push({ level, text });

  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch (err) {
    push('err', `payload is not valid JSON — ${err.message}`);
    return { ok: false, fired: false, log };
  }

  const observations = extractObservations(payload);
  push('info', `payload parsed: ${observations.length} numeric Observation(s)`);

  /* --- rule metadata --- */
  const lets = parseLets(source);
  const binds = parseBinds(source);
  const terminology = primaryTerminology(source);
  const suppressMin = parseSuppressMinutes(source);

  for (const [k, v] of Object.entries(binds)) push('dim', `bind ${k} = ${v}`);

  /* --- resolve binds to payload values --- */
  const bindValues = {};
  for (const [name, path] of Object.entries(binds)) {
    const leaf = path.split('.').pop();
    const wantLoinc = PATH_TO_LOINC[leaf] || (terminology && terminology.code) || null;

    let obs = wantLoinc ? observations.find((o) => o.code === wantLoinc) : null;
    if (!obs && leaf) {
      obs = observations.find((o) =>
        (o.display || '').toLowerCase().includes(leaf.replace(/_/g, ' ')));
    }
    if (obs) {
      bindValues[name] = obs.value;
      push('ok', `bind ${name} -> ${obs.code} "${obs.display}" = ${obs.value} ${obs.unit}`);
    } else {
      push('warn', `bind ${name} (${path}) — no matching Observation in payload`);
    }
  }

  /* --- build AST from the real lexer output --- */
  const { program, failed } = buildAst(tokens);
  if (failed) push('warn', `parser recovered early: ${failed}`);

  const rule = program.children.find((n) => n.kind === 'RuleNode');
  if (!rule) {
    push('err', 'no RuleNode found — fix syntax errors before executing');
    return { ok: false, fired: false, log };
  }
  push('info', `executing rule ${rule.detail}`);

  const block = rule.children.find((n) => n.kind === 'ConditionActionBlock');
  if (!block) {
    push('err', 'rule has no when/then block — nothing to evaluate');
    return { ok: false, fired: false, log };
  }

  const condition = block.children.find((n) => n.kind === 'Condition');
  const condNode = condition ? condition.children[0] : null;
  if (!condNode) {
    push('err', 'condition expression missing');
    return { ok: false, fired: false, log };
  }

  const ctx = new EvalContext({ lets, bindValues, observations, log });
  for (const child of rule.children) {
    if (child.kind === 'LetBindingNode' && child.detail && child.children[0]) {
      const rawVal = evalNode(child.children[0], ctx);
      if (rawVal !== undefined) {
        const val = typeof rawVal === 'number' ? Number(rawVal.toPrecision(12)) : rawVal;
        ctx.lets[child.detail] = val;
        push('dim', `let ${child.detail} := ${exprText(child.children[0])} => ${val}`);
      }
    }
  }
  const expr = exprText(condNode);
  const result = evalNode(condNode, ctx);

  if (result === undefined) {
    push('err', `condition "${expr}" could not be fully resolved — check bindings`);
    return { ok: true, fired: false, log };
  }
  push(result ? 'ok' : 'info', `${expr}  =>  ${result}`);

  const thenBranch = block.children.find((n) => n.kind === 'ThenBranch');
  const elseBranch = block.children.find((n) => n.kind === 'OtherwiseBranch');

  if (result && thenBranch) {
    for (const action of thenBranch.children) {
      if (action.kind === 'AlertAction') {
        const msg = action.children.map((c) => c.detail).filter(Boolean).join(', ');
        push('err', `ALERT FIRED: ${msg || '(no message)'}`);
      } else if (action.kind === 'SuppressAction') {
        push('info', `action: suppress ${action.detail}`.trim());
      } else if (action.kind === 'LetBindingNode') {
        push('dim', `action: let ${action.detail}`);
      }
    }
    if (suppressMin > 0) {
      push('warn', `suppression window armed: next identical alert blocked for ${suppressMin} min`);
    }
    return { ok: true, fired: true, log };
  }

  if (!result && elseBranch) {
    push('info', 'otherwise branch:');
    for (const action of elseBranch.children) {
      if (action.kind === 'AlertAction') {
        const msg = action.children.map((c) => c.detail).filter(Boolean).join(', ');
        push('err', `ALERT FIRED (otherwise): ${msg}`);
      } else if (action.kind === 'LetBindingNode') {
        push('dim', `action: let ${action.detail}`);
      } else if (action.kind === 'SuppressAction') {
        push('info', `action: suppress ${action.detail}`.trim());
      }
    }
    return { ok: true, fired: false, log };
  }

  push('info', result ? 'no then-branch actions' : 'condition false, no otherwise branch');
  return { ok: true, fired: false, log };
}
