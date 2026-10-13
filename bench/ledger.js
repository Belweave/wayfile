// Cumulative real spend shared by label.js and run.js (delete bench/results/spend.json to reset). Holds a number only.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
const f = new URL('./results/spend.json', import.meta.url);
export const loadLedger = () => ({ spent: existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).spent : 0, models: existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).models || {} : {} });
export function saveLedger(l) { mkdirSync(new URL('./results', import.meta.url), { recursive: true }); writeFileSync(f, JSON.stringify({ spent: l.spent, models: l.models || {} })); }
