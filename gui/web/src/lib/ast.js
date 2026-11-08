/*
 * AST builder — a client-side recursive-descent parser mirroring the
 * grammar of src/parser.c. It consumes the token stream produced by the
 * real C lexer (via /api/analyze) and produces structural nodes for the
 * visualizer:
 *
 *   ProgramNode -> RuleNode -> {IntentNode, ScheduleNode, SiteNode,
 *     TerminologyNode, SourceBindingNode, LetBindingNode,
 *     ConditionActionBlock -> {Condition, ThenBranch, OtherwiseBranch}}
 */

export function buildAst(tokens) {
  const toks = tokens
    .filter((t) => t.kind !== 'whitespace' && t.kind !== 'eof')
    .map((t) => ({ type: t.type, lex: t.lexeme, line: t.line, col: t.column }));

  let pos = 0;
  const peek = (o = 0) =>
    toks[Math.min(pos + o, toks.length - 1)] || { type: 'TOKEN_EOF', lex: '<eof>', line: 0, col: 0 };
  const at = (type, o = 0) => peek(o).type === type;
  const next = () => toks[pos++];
  const match = (type) => (at(type) ? (pos++, true) : false);
  const atEnd = () => pos >= toks.length || peek().type === 'TOKEN_EOF';

  const node = (kind, extra = {}) => ({ kind, children: [], ...extra });
  const add = (parent, child) => { if (child) parent.children.push(child); return child; };
  const atLoc = (t) => ({ line: t.line, column: t.col });

  /* ---------- expressions ---------- */
  function primary() {
    const t = peek();
    if (match('TOKEN_IDENTIFIER')) return node('Identifier', { detail: t.lex, ...atLoc(t) });
    if (match('TOKEN_INT_LIT')) return node('IntLiteral', { detail: t.lex, ...atLoc(t) });
    if (match('TOKEN_FLOAT_LIT')) return node('FloatLiteral', { detail: t.lex, ...atLoc(t) });
    if (match('TOKEN_STRING_LIT')) return node('StringLiteral', { detail: t.lex, ...atLoc(t) });
    if (match('TOKEN_KW_LATEST')) return node('LatestRef', { detail: 'latest', ...atLoc(t) });
    if (match('TOKEN_LPAREN')) {
      const grp = node('GroupExpr', atLoc(t));
      add(grp, expression());
      match('TOKEN_RPAREN');
      return grp;
    }
    pos++;
    return node('ErrorExpr', { detail: `expected expression, got "${t.lex}"`, error: true, ...atLoc(t) });
  }

  function postfix() {
    let e = primary();
    for (;;) {
      const t = peek();
      if (match('TOKEN_DOT') || match('TOKEN_ARROW')) {
        const mem = node('MemberExpr', { detail: t.lex, ...atLoc(t) });
        add(mem, e);
        const name = next();
        add(mem, node('Identifier', { detail: name.lex, ...atLoc(name) }));
        e = mem;
      } else if (match('TOKEN_LBRACKET')) {
        const idx = node('IndexExpr', atLoc(t));
        add(idx, e);
        add(idx, expression());
        match('TOKEN_RBRACKET');
        e = idx;
      } else if (match('TOKEN_LPAREN')) {
        const call = node('CallExpr', atLoc(t));
        add(call, e);
        while (!atEnd() && !at('TOKEN_RPAREN')) {
          add(call, expression());
          if (!match('TOKEN_COMMA')) break;
        }
        match('TOKEN_RPAREN');
        e = call;
      } else break;
    }
    return e;
  }

  const COMP = new Set(['TOKEN_EQ', 'TOKEN_NEQ', 'TOKEN_GT', 'TOKEN_GTE', 'TOKEN_LT', 'TOKEN_LTE', 'TOKEN_EQUAL']);

  function comparison() {
    let e = postfix();
    if (COMP.has(peek().type)) {
      const op = next();
      const bin = node('BinaryExpr', { detail: op.lex, ...atLoc(op) });
      add(bin, e);
      add(bin, postfix());
      e = bin;
    }
    if (at('TOKEN_KW_WITHIN')) {
      const w = node('TemporalWindow', { detail: 'within', ...atLoc(peek()) });
      add(w, e);
      next();
      add(w, duration());
      e = w;
    }
    return e;
  }

  function unary() {
    if (match('TOKEN_KW_NOT')) {
      const t = toks[pos - 1];
      const nn = node('UnaryExpr', { detail: 'not', ...atLoc(t) });
      add(nn, unary());
      return nn;
    }
    return comparison();
  }

  function binLevel(kwType, detail, sub) {
    let e = sub();
    while (match(kwType)) {
      const t = toks[pos - 1];
      const b = node('BinaryExpr', { detail, ...atLoc(t) });
      add(b, e);
      add(b, sub());
      e = b;
    }
    return e;
  }

  const andExpr = () => binLevel('TOKEN_KW_AND', 'and', unary);
  const orExpr = () => binLevel('TOKEN_KW_OR', 'or', andExpr);
  const expression = () => orExpr();

  function duration() {
    const t = peek();
    if (match('TOKEN_INT_LIT') || match('TOKEN_FLOAT_LIT')) {
      const d = node('Duration', { detail: t.lex, ...atLoc(t) });
      if (at('TOKEN_IDENTIFIER')) add(d, node('Unit', { detail: next().lex }));
      return d;
    }
    if (match('TOKEN_STRING_LIT')) return node('Duration', { detail: `"${t.lex}"`, ...atLoc(t) });
    if (match('TOKEN_IDENTIFIER')) return node('Duration', { detail: t.lex, ...atLoc(t) });
    return null;
  }

  /* ---------- rule body ---------- */
  const BRANCH_START = new Set(['TOKEN_KW_LET', 'TOKEN_KW_ALERT', 'TOKEN_KW_SUPPRESS', 'TOKEN_KW_WHEN']);
  const STOPPERS = ['TOKEN_KW_END', 'TOKEN_KW_OTHERWISE', 'TOKEN_KW_THEN'];

  function statement() {
    if (at('TOKEN_KW_LET')) return letDecl();
    if (at('TOKEN_KW_ALERT')) return alertStmt();
    if (at('TOKEN_KW_SUPPRESS')) return suppressStmt();
    if (at('TOKEN_KW_WHEN')) return whenStmt();
    return null;
  }

  function letDecl() {
    const kw = next();
    const nn = node('LetBindingNode', { detail: '', ...atLoc(kw) });
    if (at('TOKEN_IDENTIFIER')) nn.detail = next().lex;
    match('TOKEN_ASSIGN'); match('TOKEN_EQUAL');
    if (!atEnd() && !BRANCH_START.has(peek().type) && !STOPPERS.includes(peek().type)) {
      add(nn, expression());
    }
    return nn;
  }

  function alertStmt() {
    const kw = next();
    const nn = node('AlertAction', { detail: '', ...atLoc(kw) });
    match('TOKEN_COLON');
    if (!atEnd() && (at('TOKEN_STRING_LIT') || at('TOKEN_IDENTIFIER') ||
        at('TOKEN_INT_LIT') || at('TOKEN_FLOAT_LIT') || at('TOKEN_DOT') || at('TOKEN_LPAREN'))) {
      add(nn, expression());
      while (at('TOKEN_COMMA')) { next(); add(nn, expression()); }
    }
    return nn;
  }

  function suppressStmt() {
    const kw = next();
    const nn = node('SuppressAction', { detail: '', ...atLoc(kw) });
    match('TOKEN_COLON');
    const repeat = at('TOKEN_IDENTIFIER') && peek().lex === 'repeat_of' && at('TOKEN_COLON', 1);
    if (repeat) {
      next(); next();
      if (at('TOKEN_IDENTIFIER')) nn.detail = `repeat_of : ${next().lex}`;
    }
    if (match('TOKEN_KW_WITHIN')) {
      const d = add(nn, duration());
      if (d) {
        const unit = d.children[0] ? ' ' + d.children[0].detail : '';
        nn.detail += `${repeat ? ' ' : ''}within ${d.detail}${unit}`;
      }
    } else if (!repeat && (at('TOKEN_STRING_LIT') || at('TOKEN_IDENTIFIER'))) {
      nn.detail = next().lex;
    }
    return nn;
  }

  function whenStmt() {
    const kw = next();
    const nn = node('ConditionActionBlock', { detail: 'when ... then', ...atLoc(kw) });
    if (match('TOKEN_KW_FOR')) {
      nn.detail = 'when for';
      if (at('TOKEN_IDENTIFIER')) next();
    }
    const cond = node('Condition', { detail: 'condition', ...atLoc(peek()) });
    add(cond, expression());
    add(nn, cond);
    match('TOKEN_COLON'); match('TOKEN_ASSIGN'); match('TOKEN_EQUAL');

    if (match('TOKEN_KW_THEN')) {
      const thenB = node('ThenBranch', { detail: 'then', ...atLoc(toks[pos - 1]) });
      match('TOKEN_COLON');
      while (!atEnd() && BRANCH_START.has(peek().type)) {
        const s = statement();
        if (!s) break;
        add(thenB, s);
      }
      add(nn, thenB);
    }
    if (match('TOKEN_KW_OTHERWISE')) {
      const elseB = node('OtherwiseBranch', { detail: 'otherwise', ...atLoc(toks[pos - 1]) });
      match('TOKEN_COLON');
      while (!atEnd() && BRANCH_START.has(peek().type)) {
        const s = statement();
        if (!s) break;
        add(elseB, s);
      }
      add(nn, elseB);
    }
    if (at('TOKEN_KW_END') && at('TOKEN_KW_WHEN', 1)) { next(); next(); }
    return nn;
  }

  function ruleElement(rule) {
    const t = peek();
    switch (t.type) {
      case 'TOKEN_KW_INTENT': {
        next(); match('TOKEN_COLON');
        const nn = node('IntentNode', atLoc(t));
        if (at('TOKEN_STRING_LIT')) nn.detail = `"${next().lex}"`;
        add(rule, nn);
        return;
      }
      case 'TOKEN_KW_SCHEDULE': {
        next(); match('TOKEN_COLON');
        const nn = node('ScheduleNode', atLoc(t));
        if (at('TOKEN_STRING_LIT')) nn.detail = `"${next().lex}"`;
        else if (at('TOKEN_IDENTIFIER')) nn.detail = next().lex;
        else if (at('TOKEN_INT_LIT') || at('TOKEN_FLOAT_LIT')) {
          nn.detail = next().lex;
          if (at('TOKEN_IDENTIFIER')) nn.detail += ' ' + next().lex;
        }
        add(rule, nn);
        return;
      }
      case 'TOKEN_KW_SITE': {
        next(); match('TOKEN_COLON');
        const nn = node('SiteNode', atLoc(t));
        if (at('TOKEN_IDENTIFIER') || at('TOKEN_STRING_LIT')) nn.detail = next().lex;
        add(rule, nn);
        return;
      }
      case 'TOKEN_KW_TERMINOLOGY': {
        next(); match('TOKEN_COLON');
        const nn = node('TerminologyNode', atLoc(t));
        const fmtStr = (s) => (s.startsWith('"') ? s : `"${s}"`);
        const readSelector = () => {
          const open = at('TOKEN_LPAREN') ? 'TOKEN_LPAREN' : at('TOKEN_LBRACKET') ? 'TOKEN_LBRACKET' : null;
          if (!open) return '';
          const close = open === 'TOKEN_LPAREN' ? 'TOKEN_RPAREN' : 'TOKEN_RBRACKET';
          next();
          const args = [];
          while (!atEnd() && !at(close)) {
            if (at('TOKEN_STRING_LIT')) args.push(fmtStr(next().lex));
            else if (at('TOKEN_IDENTIFIER') || at('TOKEN_INT_LIT') || at('TOKEN_FLOAT_LIT')) args.push(next().lex);
            else break;
            if (!match('TOKEN_COMMA')) break;
          }
          match(close);
          return open === 'TOKEN_LPAREN' ? `(${args.join(', ')})` : `[${args.join(', ')}]`;
        };
        if (at('TOKEN_IDENTIFIER') && at('TOKEN_ARROW', 1)) {
          const mappings = [];
          while (!atEnd() && at('TOKEN_IDENTIFIER') && at('TOKEN_ARROW', 1)) {
            const loc = atLoc(peek());
            const concept = next().lex;
            next(); /* consume '->' */
            const sys = at('TOKEN_IDENTIFIER') ? next().lex : '';
            const sel = readSelector();
            const entry = `${concept} -> ${sys}${sel}`;
            mappings.push(entry);
            add(nn, node('TerminologyMapping', { detail: entry, ...loc }));
          }
          nn.detail = mappings.join(', ');
        } else if (at('TOKEN_IDENTIFIER')) {
          nn.detail = next().lex + readSelector();
          if (at('TOKEN_STRING_LIT')) next();
        } else if (at('TOKEN_STRING_LIT')) {
          nn.detail = fmtStr(next().lex);
        }
        add(rule, nn);
        return;
      }
      case 'TOKEN_KW_SOURCE': {
        next(); match('TOKEN_COLON');
        const nn = node('SourceBindingNode', { detail: 'source', ...atLoc(t) });
        if (at('TOKEN_IDENTIFIER')) {
          nn.detail = next().lex;
          if (match('TOKEN_ARROW') && at('TOKEN_IDENTIFIER')) nn.detail += ' -> ' + next().lex;
        }
        add(rule, nn);
        return;
      }
      case 'TOKEN_KW_BIND': {
        const kw = next();
        const nn = node('SourceBindingNode', { detail: 'bind', ...atLoc(kw) });
        if (at('TOKEN_IDENTIFIER')) nn.detail = 'bind ' + next().lex;
        match('TOKEN_ASSIGN'); match('TOKEN_EQUAL'); match('TOKEN_COLON'); match('TOKEN_ARROW');
        add(nn, postfix());
        if (at('TOKEN_KW_WHERE')) {
          next();
          const where = node('WhereClause', { detail: 'where' });
          add(where, expression());
          add(nn, where);
        }
        if (at('TOKEN_KW_WITHIN')) { next(); add(nn, duration()); }
        if (at('TOKEN_KW_END') && at('TOKEN_KW_BIND', 1)) { next(); next(); }
        add(rule, nn);
        return;
      }
      case 'TOKEN_KW_LET': add(rule, letDecl()); return;
      case 'TOKEN_KW_WHEN': add(rule, whenStmt()); return;
      case 'TOKEN_KW_ALERT': add(rule, alertStmt()); return;
      case 'TOKEN_KW_SUPPRESS': add(rule, suppressStmt()); return;
      default:
        pos++; /* skip unexpected token */
    }
  }

  const program = node('ProgramNode', { detail: 'HELIX compilation unit' });
  let failed = null;

  while (!atEnd()) {
    if (match('TOKEN_KW_RULE')) {
      const kw = toks[pos - 1];
      const rule = node('RuleNode', atLoc(kw));
      rule.detail = at('TOKEN_IDENTIFIER') ? next().lex : '<anonymous>';
      match('TOKEN_COLON');
      while (!atEnd() && !at('TOKEN_KW_END')) {
        const before = pos;
        ruleElement(rule);
        if (pos === before) { failed = `unexpected token "${peek().lex}"`; break; }
      }
      if (!match('TOKEN_KW_END') && !failed) failed = `missing 'end' for rule ${rule.detail}`;
      else match('TOKEN_KW_RULE');
      add(program, rule);
      if (failed) break;
    } else {
      failed = `expected rule declaration, got "${peek().lex}"`;
      break;
    }
  }

  return { program, failed };
}

/* Count nodes by kind — used for the AST panel badge. */
export function countNodes(n) {
  let c = 1;
  for (const ch of n.children || []) c += countNodes(ch);
  return c;
}
