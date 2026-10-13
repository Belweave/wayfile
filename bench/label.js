// Model labels every case from the written policy alone, then reports agreement with the hand labels.
// Needs ANTHROPIC_API_KEY. Does not change any label.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { provider } from '../src/model.js';
import { loadLedger, saveLedger } from './ledger.js';
import { cases } from './cases.js';
import { OUTCOMES } from './agents.js';

const ledger = loadLedger();
const call = provider({ ledger, ...(process.env.LABEL_MODEL ? { model: process.env.LABEL_MODEL } : {}) });
if (!call) { console.error('No model API key; model labelling skipped.'); process.exit(2); }
const policy = (g) => readFileSync(new URL(`./policy/${g === 'triage' ? 'tickets' : 'ci'}.md`, import.meta.url), 'utf8');
const rows = [];
for (const c of cases) {
  const r = await call({
    system: `${policy(c.graph)}\nYou label benchmark cases. Apply the policy literally; do not run tools. For order lookups, an order number that appears in the ticket exists. Reply with only JSON {"route": "<${OUTCOMES[c.graph].join('|')}>"}.`,
    messages: [{ role: 'user', content: JSON.stringify(c.input) }], maxTokens: 400,
  });
  saveLedger(ledger);
  rows.push({ id: c.id, model: r.text.match(/"route"\s*:\s*"([\w-]+)"/)?.[1] ?? null, hand: c.expect, legacy: c.legacy ?? null, usage: r.usage });
}
const agree = (k) => { const xs = rows.filter((r) => r[k]); return `${xs.filter((r) => r.model === r[k]).length}/${xs.length}`; };
const out = { spentUsdCumulative: ledger.spent, responseModels: ledger.models, handAgreement: agree('hand'), legacyAgreement: agree('legacy'), handVsLegacy: `${rows.filter((r) => r.legacy && r.legacy === r.hand).length}/${rows.filter((r) => r.legacy).length}`, disagreements: rows.filter((r) => r.model !== r.hand) };
mkdirSync(new URL('./results', import.meta.url), { recursive: true });
writeFileSync(new URL('./results/labels.json', import.meta.url), JSON.stringify({ ...out, rows }, null, 2));
console.log(JSON.stringify(out, null, 2));
