// Parse one Markdown node file: frontmatter, title, body, routes list, example blocks.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { compile } from './logic.js';

function scalar(v) {
  v = v.trim();
  if (v.startsWith('[') && v.endsWith(']')) return v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v === 'true' || v === 'false') return v === 'true';
  const q = v.match(/^"(.*)"$/);
  return q ? q[1] : v;
}

const ROUTE = /^-\s+(?:`([^`]+)`|judge:\s*"([^"]+)"|(otherwise))\s*(?:→|->)\s*\[\[([\w-]+)\]\]\s*$/;

export function parseNode(text, file = 'node.md') {
  const id = basename(file, '.md');
  const lines = text.split('\n');
  const node = { id, file, meta: {}, title: '', body: '', routes: [], examples: [], errors: [], text };
  let i = 0;
  if (lines[0]?.trim() === '---') {
    for (i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
      const l = lines[i].replace(/\s+#.*$/, '');
      const m = l.match(/^([\w-]+):\s*(.*)$/);
      if (m) node.meta[m[1]] = scalar(m[2]);
      else if (l.trim()) node.errors.push({ line: i + 1, msg: `bad frontmatter line "${l.trim()}"`, fix: 'use `key: value`' });
    }
    i++;
  }
  node.kind = node.meta.kind || 'route';
  node.needs = node.meta.needs || [];
  node.sets = node.meta.sets || [];
  let section = 'body';
  const body = [];
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('```example')) {
      const ex = { line: i + 1 };
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) {
        const m = lines[i].match(/^(input|expect|judge):\s*(.*)$/);
        if (!m) continue;
        try { ex[m[1]] = m[1] === 'input' ? JSON.parse(m[2]) : m[2].trim(); }
        catch { node.errors.push({ line: i + 1, msg: 'example input is not valid JSON', fix: 'write input as JSON' }); }
      }
      node.examples.push(ex);
      continue;
    }
    if (/^##\s+Routes\s*$/i.test(l)) { section = 'routes'; continue; }
    if (/^#\s+/.test(l) && !node.title) { node.title = l.replace(/^#\s+/, '').trim(); continue; }
    if (section === 'routes' && l.trim().startsWith('-')) {
      const m = l.trim().match(ROUTE);
      if (!m) { node.errors.push({ line: i + 1, msg: `unparseable route "${l.trim()}"`, fix: 'use - `pred` → [[node]], - judge: "q" → [[node]] or - otherwise → [[node]]' }); continue; }
      const r = { line: i + 1, to: m[4] };
      if (m[1]) {
        try { Object.assign(r, { type: 'when', src: m[1], rule: compile(m[1]) }); }
        catch (e) { node.errors.push({ line: i + 1, msg: e.message, fix: 'see predicate syntax in README' }); continue; }
      } else if (m[2]) Object.assign(r, { type: 'judge', src: m[2] });
      else Object.assign(r, { type: 'otherwise', src: 'otherwise' });
      node.routes.push(r);
      continue;
    }
    if (section === 'body') body.push(l);
  }
  node.body = body.join('\n').trim();
  return node;
}

export function loadGraph(dir) {
  const nodes = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== 'AGENT.md').sort()) {
    const file = join(dir, f);
    const n = parseNode(readFileSync(file, 'utf8'), file);
    nodes[n.id] = n;
  }
  for (const n of Object.values(nodes)) {
    const sf = n.meta.skill && join(dir, 'skills', `${n.meta.skill}.md`);
    if (sf && existsSync(sf)) n.skillText = readFileSync(sf, 'utf8');
  }
  const entry = Object.values(nodes).find((n) => n.meta.entry === true)?.id;
  const af = join(dir, 'AGENT.md'); // always-on instructions, like Eve's instructions.md
  return { dir, nodes, entry, instructions: existsSync(af) ? readFileSync(af, 'utf8').trim() : '' };
}
