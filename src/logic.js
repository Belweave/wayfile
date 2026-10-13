// Route predicates: a tiny expression syntax compiled to JSONLogic, plus an evaluator.
// Syntax:  path OP literal   (OP: > >= < <= == !=)   |   path ~ /regex/flags   |   path exists
// Clauses may be joined with && (all must hold).

export function get(state, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), state);
}

function literal(s) {
  s = s.trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === 'true' || s === 'false') return s === 'true';
  if (s === 'null') return null;
  const m = s.match(/^"(.*)"$/) || s.match(/^'(.*)'$/);
  if (m) return m[1];
  throw new Error(`bad literal: ${s}`);
}

function clause(src) {
  let m = src.match(/^\s*([\w.]+)\s*~\s*\/(.*)\/([a-z]*)\s*$/);
  if (m) {
    new RegExp(m[2], m[3]); // validate now
    return { match: [{ var: m[1] }, m[2], m[3]] };
  }
  m = src.match(/^\s*([\w.]+)\s+exists\s*$/);
  if (m) return { '!!': [{ var: m[1] }] };
  m = src.match(/^\s*([\w.]+)\s*(>=|<=|==|!=|>|<)\s*(.+?)\s*$/);
  if (m) return { [m[2]]: [{ var: m[1] }, literal(m[3])] };
  throw new Error(`cannot parse predicate: ${src}`);
}

export function compile(src) {
  const parts = src.split('&&').map(clause);
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
