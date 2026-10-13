// Model labels every case from the written policy alone, then reports agreement with the hand labels.
// Needs ANTHROPIC_API_KEY. Does not change any label.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { anthropic } from '../src/model.js';
import { cases } from './cases.js';
import { OUTCOMES } from './agents.js';

if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY is absent; model labelling skipped.'); process.exit(2); }
const call = anthropic({ model: process.env.LABEL_MODEL || process.env.WAYFILE_MODEL || 'claude-haiku-4-5' });
const policy = (g) => readFileSync(new URL(`./policy/${g === 'triage' ? 'tickets' : 'ci'}.md`, import.meta.url), 'utf8');
const rows = [];
for (const c of cases) {
  const r = await call({
    system: `${policy(c.graph)}\nYou label benchmark cases. Apply the policy literally; do not run tools. For order lookups, an order number that appears in the ticket exists. Reply with only JSON {"route": "<${OUTCOMES[c.graph].join('|')}>"}.`,
    messages: [{ role: 'user', content: JSON.stringify(c.input) }], maxTokens: 30,
  });
  rows.push({ id: c.id, model: r.text.match(/"route"\s*:\s*"([\w-]+)"/)?.[1] ?? null, hand: c.expect, legacy: c.legacy ?? null, usage: r.usage });
}
const agree = (k) => { const xs = rows.filter((r) => r[k]); return `${xs.filter((r) => r.model === r[k]).length}/${xs.length}`; };
const out = { handAgreement: agree('hand'), legacyAgreement: agree('legacy'), handVsLegacy: `${rows.filter((r) => r.legacy && r.legacy === r.hand).length}/${rows.filter((r) => r.legacy).length}`, disagreements: rows.filter((r) => r.model !== r.hand) };
mkdirSync(new URL('./results', import.meta.url), { recursive: true });
writeFileSync(new URL('./results/labels.json', import.meta.url), JSON.stringify({ ...out, rows }, null, 2));
console.log(JSON.stringify(out, null, 2));
