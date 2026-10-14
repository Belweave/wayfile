// Optional label-agreement diagnostic. Same-model agreement is not gold validation.
// Labelling has its own run artifacts and spend delta; bench.sh does not repeat it.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { provider } from '../packages/wayfile/src/model.js';
import { loadLedger, saveLedger } from './ledger.js';
import { dataset } from './datasets.js';
import { OUTCOMES } from './agents.js';
import { parseRoute } from './contracts.js';
import { digest, requestRecorder } from './measurement.js';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--dataset')) { console.error('usage: node bench/label.js [--dataset legacy|challenge]'); process.exit(2); }
const data = dataset(args[1] ?? 'legacy');
const ledger = loadLedger(), spentStart = ledger.spent;
const base = provider({ ledger, ...(process.env.LABEL_MODEL ? { model: process.env.LABEL_MODEL } : {}) });
if (!base) { console.error('No model API key; model label diagnostic skipped.'); process.exit(2); }
const policy = (g) => readFileSync(new URL(`./policy/${g === 'triage' ? 'tickets' : 'ci'}.md`, import.meta.url), 'utf8');
const policies = { triage: policy('triage'), ci: policy('ci') };
const knownFlaky = readFileSync(new URL('../examples/ci/scripts/flaky.txt', import.meta.url), 'utf8').trim().split(/\r?\n/);
const dir = new URL(`./results/labels-${new Date().toISOString().replace(/[:.]/g, '-')}-${data.name}-${randomUUID().slice(0, 8)}/`, import.meta.url);
mkdirSync(dir, { recursive: true });
const rows = [], requests = [];
let interrupted = null;
for (const c of data.cases) {
  const recorder = requestRecorder(base, { ledger, context: { phase: 'labelling', caseId: c.id }, onEvent: (e) => { requests.push(e); appendFileSync(new URL('requests.jsonl', dir), `${JSON.stringify(e)}\n`); } });
  let route = null, error = null;
  try {
    const r = await recorder.call({
      system: `${policies[c.graph]}\nYou label benchmark cases. Apply the policy literally; do not run tools. An order number recognized by the example lookup fixture exists.${c.graph === 'ci' ? ` The immutable labelling fixture's known-flaky files are ${JSON.stringify(knownFlaky)}.` : ''} For approval, the configured input.stub.ask answer applies, default yes. Reply with only JSON {"route": "<${OUTCOMES[c.graph].join('|')}>"}.`,
      messages: [{ role: 'user', content: JSON.stringify(c.input) }], maxTokens: 400,
    });
    route = parseRoute(r.text, OUTCOMES[c.graph], r.stop);
  } catch (e) { error = String(e.message).slice(0, 300); }
  saveLedger(ledger);
  rows.push({ id: c.id, modelLabel: route, hand: c.expect, legacy: c.legacy ?? null, error, ...recorder.measurement() });
  appendFileSync(new URL('labels.jsonl', dir), `${JSON.stringify(rows.at(-1))}\n`);
  if (/cost guard|budget/i.test(error || '')) { interrupted = error; break; }
}
const agree = (k) => { const xs = rows.filter((r) => r[k]); return { correct: xs.filter((r) => r.modelLabel === r[k]).length, n: xs.length }; };
const out = {
  phase: 'labelling-diagnostic', dataset: data.name, corpusHash: data.corpusHash, labelsHash: data.labelsHash,
  policyHash: digest(policies), labellingEvidenceHash: digest({ knownFlaky }), requestedModel: base.model ?? null,
  spendDeltaUsd: ledger.spent - spentStart, spentUsdCumulative: ledger.spent,
  responseModels: Object.fromEntries([...new Set(requests.map((r) => r.model).filter(Boolean))].sort().map((m) => [m, requests.filter((r) => r.model === m).length])),
  handAgreement: agree('hand'), legacyAgreement: agree('legacy'),
  disagreements: rows.filter((r) => r.modelLabel !== r.hand), plannedN: data.cases.length, interrupted,
  warning: 'Same-model agreement does not establish independent gold. Disagreements require policy-based adjudication; no label is changed automatically.',
  rows,
};
writeFileSync(new URL('report.json', dir), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, rows: undefined }, null, 2));
if (interrupted) process.exitCode = 2;
