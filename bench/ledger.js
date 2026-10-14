// Cumulative real spend shared by label.js and run.js (delete bench/results/spend.json to reset). Holds a number only.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const f = new URL('./results/spend.json', import.meta.url);
export const loadLedger = (file = f) => {
  const value = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (value.spent !== undefined && (!Number.isFinite(value.spent) || value.spent < 0)) throw new Error('invalid cumulative spend ledger');
  if (value.unknownCost !== undefined && typeof value.unknownCost !== 'boolean') throw new Error('invalid unknown-cost ledger flag');
  return { spent: value.spent ?? 0, models: value.models || {}, unknownCost: value.unknownCost ?? false };
};
export function saveLedger(l, file = f) {
  const url = typeof file === 'string' ? pathToFileURL(file) : file;
  mkdirSync(new URL('.', url), { recursive: true });
  const temporary = new URL(`spend-${randomUUID()}.tmp`, url);
  writeFileSync(temporary, JSON.stringify({ spent: l.spent, models: l.models || {}, unknownCost: Boolean(l.unknownCost) }));
  renameSync(temporary, file);
}
