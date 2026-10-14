// Route predicates: a tiny expression syntax compiled to JSONLogic, plus an evaluator.
// Syntax:  path OP literal   (OP: > >= < <= == !=)   |   path ~ /regex/flags   |   path exists
// Clauses may be joined with && (all must hold).

export function validStatePath(path) {
  return typeof path === 'string' && /^\w+(?:\.\w+)*$/.test(path)
    && !path.split('.').some((k) => ['__proto__', 'prototype', 'constructor'].includes(k));
}

export function get(state, path) {
  if (!validStatePath(path)) return undefined;
  return path.split('.').reduce((o, k) => (o == null || !Object.hasOwn(o, k) ? undefined : o[k]), state);
}

function variable(path) {
  if (!validStatePath(path)) throw new Error(`invalid state path: ${path}`);
  return { var: path };
}

function literal(s) {
  s = s.trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === 'true' || s === 'false') return s === 'true';
  if (s === 'null') return null;
  if (s.startsWith('"')) { try { const value = JSON.parse(s); if (typeof value === 'string') return value; } catch { /* report below */ } }
  const m = s.match(/^'(.*)'$/);
  if (m) return m[1].replace(/\\(['\\])/g, '$1');
  throw new Error(`bad literal: ${s}`);
}

function clause(src) {
  let m = src.match(/^\s*([\w.]+)\s*~\s*\/(.*)\/([a-z]*)\s*$/);
  if (m) {
    new RegExp(m[2], m[3]); // validate now
    return { match: [variable(m[1]), m[2], m[3]] };
  }
  m = src.match(/^\s*([\w.]+)\s+exists\s*$/);
  if (m) return { '!!': [variable(m[1])] };
  m = src.match(/^\s*([\w.]+)\s*(>=|<=|==|!=|>|<)\s*(.+?)\s*$/);
  if (m) {
    const value = literal(m[3]);
    if (!['==', '!='].includes(m[2]) && typeof value !== 'number') throw new Error(`numeric comparison needs a number literal: ${src}`);
    return { [m[2]]: [variable(m[1]), value] };
  }
  throw new Error(`cannot parse predicate: ${src}`);
}

export function compile(src) {
  // A conjunction inside a quoted literal or regex is data, not an operator.
  const sources = [];
  let start = 0, quote = null, regex = false, characterClass = false, escaped = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\' && (quote || regex)) { escaped = true; continue; }
    if (quote) { if (c === quote) quote = null; continue; }
    if (regex) {
      if (c === '[') characterClass = true;
      if (c === ']') characterClass = false;
      if (c === '/' && !characterClass) regex = false;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '/' && /^\s*[\w.]+\s*~\s*$/.test(src.slice(start, i))) { regex = true; continue; }
    if (c === '&' && src[i + 1] === '&') { sources.push(src.slice(start, i)); start = i + 2; i++; }
  }
  if (quote || regex) throw new Error(`unterminated ${quote ? 'quoted literal' : 'regex'}: ${src}`);
  sources.push(src.slice(start));
  const parts = sources.map(clause);
  return parts.length === 1 ? parts[0] : { and: parts };
}

export function evaluate(rule, state) {
  const [op] = Object.keys(rule);
  const args = rule[op];
  const v = (a) => (a && typeof a === 'object' && 'var' in a ? get(state, a.var) : a);
  switch (op) {
    case 'and': return args.every((r) => evaluate(r, state));
    case 'match': { const x = v(args[0]); return typeof x === 'string' && new RegExp(args[1], args[2]).test(x); }
    case '!!': return v(args[0]) != null;
    case '==': return v(args[0]) === args[1];
    case '!=': return v(args[0]) !== args[1];
    case '>': case '>=': case '<': case '<=': {
      const x = v(args[0]);
      if (typeof x !== 'number') return false;
      return op === '>' ? x > args[1] : op === '>=' ? x >= args[1] : op === '<' ? x < args[1] : x <= args[1];
    }
    default: throw new Error(`unknown op ${op}`);
  }
}

// Variables referenced by a rule, and the constants compared against them (used by the fork sampler).
export function vars(rule, out = []) {
  const [op] = Object.keys(rule);
  if (op === 'and') { rule.and.forEach((r) => vars(r, out)); return out; }
  const [a, ...rest] = rule[op];
  out.push({ path: a.var, op, args: rest });
  return out;
}
