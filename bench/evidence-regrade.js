// Offline regrading of identical captured observations. Never invokes a model
// or reads/writes the spend ledger; historical reports remain immutable.
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { digest } from './measurement.js';
import { summarize, gate, sourceSnapshot } from './run.js';
import { scoreEvidenceTask } from './evidence-models.js';
import { evidenceTasks, evidenceContract, resolveEvidence } from './evidence-tasks.js';
import { evidenceContractVersion, evidenceGraderVersion, evidencePolicy, evidenceOutputSchema } from './evidence-policy.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const gradingFields = new Set(['success', 'routeCorrect', 'checks', 'factualOutputContractSuccess', 'factualEvidenceContractSuccess', 'proseDiagnostics', 'proseFaithfulnessMeasured', 'proseAdjudicationRequired']);
const captured = (rows, arms) => rows.map((row) => ({ id: row.id, observations: Object.fromEntries(arms.filter((arm) => row[arm]).map((arm) => [arm, Object.fromEntries(Object.entries(row[arm]).filter(([key]) => !gradingFields.has(key)))])) }));

export function regradeCapturedReport(original, tasks, { requests = [], source = { hash: null, files: [] }, audit = null } = {}) {
  const config = original?.meta?.config, arms = config?.arms;
  if (original?.meta?.kind !== 'generated-evidence' || config.outputContractVersion !== evidenceContractVersion || !Array.isArray(arms) || !Array.isArray(original.rows)) throw new Error('expected an original generated-evidence report with the current output contract');
  if (!Array.isArray(tasks) || new Set(tasks.map((task) => task.id)).size !== tasks.length || digest(tasks) !== config.taskHash) throw new Error('archived task corpus hash does not match');
  if (tasks.some((task) => digest(task) !== digest(evidenceTasks.find((current) => current.id === task.id)))) throw new Error('archived model-facing tasks differ from the current fixture corpus');
  if (digest(tasks.map((task) => ({ id: task.id, contract: evidenceContract(task, resolveEvidence(task)) }))) !== config.labelsHash || digest(evidenceOutputSchema) !== config.schemaHash) throw new Error('factual labels or output schema changed; this tool only changes the grader');
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  if (new Set(original.rows.map((row) => row.id)).size !== original.rows.length || original.rows.some((row) => !taskById.has(row.id))) throw new Error('invalid captured case IDs');
  if (original.meta.modelQualityMeasured && requests.filter((request) => request.providerCall !== false).length !== original.meta.paidModelCalls) throw new Error('request journal does not match captured paid-call count');
  if (audit && (!Array.isArray(audit.rows) || new Set(audit.rows.map((row) => `${row.id}:${row.arm}`)).size !== audit.rows.length || audit.rows.some((row) => !original.rows.some((capturedRow) => capturedRow.id === row.id && capturedRow[row.arm])))) throw new Error('invalid manual audit case/arm references');

  const rows = original.rows.map((row) => ({ ...row, ...Object.fromEntries(arms.filter((arm) => row[arm]).map((arm) => [arm, { ...row[arm], ...scoreEvidenceTask(taskById.get(row.id), row[arm]) }])) }));
  const captureHash = digest(captured(original.rows, arms));
  if (digest(captured(rows, arms)) !== captureHash) throw new Error('regrading changed captured outputs, evidence or measurements');
  const summary = Object.fromEntries(arms.map((arm) => [arm, original.summary[arm] === null ? null : summarize(rows, arm)]));
  const diagnostic = gate(summary, [], {
    rows, arms, dry: !original.meta.modelQualityMeasured,
    subset: tasks.length !== evidenceTasks.length || original.rows.length !== tasks.length,
    interrupted: Boolean(original.meta.interrupted), sourceChanged: original.meta.sourceChanged,
    provenanceComplete: Boolean(config.requestedModel) && requests.filter((request) => request.providerCall !== false).every((request) => Boolean(request.model)),
  });
  const changes = rows.flatMap((row, i) => arms.filter((arm) => row[arm]).map((arm) => ({
    id: row.id, arm, before: original.rows[i][arm].success, after: row[arm].success,
    beforeFailedChecks: original.rows[i][arm].checks.filter((check) => !check.passed).map((check) => check.name),
    afterFailedChecks: row[arm].checks.filter((check) => !check.passed).map((check) => check.name),
  }))).filter((change) => change.before !== change.after || digest(change.beforeFailedChecks) !== digest(change.afterFailedChecks));
  const regradeConfig = {
    kind: 'posthoc-development-grader-correction', freshComparison: false,
    outputContractVersion: evidenceContractVersion, originalGraderVersion: config.graderVersion,
    graderVersion: evidenceGraderVersion, originalExecutionConfigHash: original.meta.configHash,
    capturedTaskHash: config.taskHash, capturedLabelsHash: config.labelsHash, capturedSchemaHash: config.schemaHash,
    capturedPolicyHash: config.policyHash, currentPolicyHash: digest(evidencePolicy),
    policyChangedSinceCapture: config.policyHash !== digest(evidencePolicy),
    newPolicyPenaltiesAppliedRetrospectively: false, regraderSourceHash: source.hash, capturedObservationsHash: captureHash,
    primaryMetric: 'factual/evidence contract: schema, structured facts, source IDs, observed reads/approval, bounded summary',
    proseFaithfulnessMeasured: false,
    summaryChecksScope: 'Summary bounds determine contract success; prose heuristics are diagnostics requiring semantic adjudication, never automatic wins/losses',
    archivedSummaryChecksScope: config.summaryChecksScope,
    correction: 'Prose heuristics are retained as diagnostics, rather than authoritative contract wins/losses; no English-pattern expansion.',
  };
  return {
    meta: {
      at: new Date().toISOString(), kind: 'archived-evidence-regrade', freshComparison: false,
      posthocDevelopmentCorrection: true, modelQualityMeasured: false, proseFaithfulnessMeasured: false, paidModelCalls: 0, spendDeltaUsd: 0,
      archivedModelQualityMeasured: original.meta.modelQualityMeasured,
      archivedPaidModelCalls: original.meta.paidModelCalls, archivedSpendDeltaUsd: original.meta.spendDeltaUsd,
      config: regradeConfig, configHash: digest(regradeConfig),
    },
    archive: { meta: original.meta, summary: original.summary, gate: original.gate },
    summary,
    gate: {
      ...diagnostic, modelNodes: original.gate?.modelNodes ?? diagnostic.modelNodes,
      diagnosticDecision: diagnostic.decision, decision: 'POST HOC REGRADE (not a fresh comparison)',
      diagnosticRealEveDecision: diagnostic.realEveDecision, realEveDecision: 'ARCHIVED OBSERVATIONS ONLY',
      scope: 'post hoc development factual/evidence-contract regrade of identical captured outputs/evidence and original measured API costs; prose faithfulness unmeasured',
      primaryMetric: regradeConfig.primaryMetric, proseFaithfulnessMeasured: false,
    },
    changes, rows,
    manualAudit: audit ?? { note: 'No independent prose audit supplied. Regex checks do not certify exhaustive summary faithfulness.', rows: [] },
  };
}

export function regradeArchive(reportPath, { auditPath = null, outputDir = null } = {}) {
  const input = resolve(reportPath), archiveDir = dirname(input);
  if (input !== join(archiveDir, 'report.json')) throw new Error('input must be an archived report.json');
  const names = ['report.json', 'dataset.json', 'manifest.json', 'requests.jsonl', 'cases.jsonl'];
  const contents = Object.fromEntries(names.map((name) => [name, readFileSync(join(archiveDir, name), 'utf8')]));
  const hashes = Object.fromEntries(names.map((name) => [name, digest(contents[name])]));
  const original = JSON.parse(contents['report.json']), tasks = JSON.parse(contents['dataset.json']);
  const requests = contents['requests.jsonl'].split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const cases = contents['cases.jsonl'].split('\n').filter(Boolean).map((line) => JSON.parse(line));
  if (digest(cases) !== digest(original.rows)) throw new Error('case journal differs from the archived report');
  const source = sourceSnapshot(root), audit = auditPath ? JSON.parse(readFileSync(resolve(auditPath), 'utf8')) : null;
  const result = regradeCapturedReport(original, tasks, { requests, source, audit });
  result.archive.reportPath = input;
  result.archive.artifactHashes = hashes;
  result.archive.hashAlgorithm = 'sha256';
  if (auditPath) result.meta.auditInput = { path: resolve(auditPath), hash: digest(readFileSync(resolve(auditPath), 'utf8')) };
  const dir = outputDir ? resolve(outputDir) : join(root, 'bench/results', `${new Date().toISOString().replace(/[:.]/g, '-')}-evidence-regrade-c${evidenceContractVersion}-g${evidenceGraderVersion}-${randomUUID().slice(0, 8)}`);
  if (existsSync(dir)) throw new Error('output directory already exists; archive regrading never overwrites artifacts');
  mkdirSync(dirname(dir), { recursive: true }); mkdirSync(dir);
  copyFileSync(join(archiveDir, 'dataset.json'), join(dir, 'dataset.json'));
  copyFileSync(join(archiveDir, 'requests.jsonl'), join(dir, 'requests.jsonl'));
  writeFileSync(join(dir, 'cases.jsonl'), `${result.rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  writeFileSync(join(dir, 'report.json'), JSON.stringify(result, null, 2));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...result.meta, archive: { reportPath: input, artifactHashes: hashes }, sourceFiles: source.files }, null, 2));
  const dollars = (value) => value == null ? 'unknown' : `$${value.toFixed(6)}`;
  const report = [
    `# Captured evidence regrade: contract V${evidenceContractVersion}, grader V${evidenceGraderVersion}`, '',
    '**Post hoc development grader correction. This is not a fresh or independent comparison. Zero new model calls; zero new API spend.**', '',
    `Original artifact: [report.json](${input}). Original grader: V${original.meta.config.graderVersion}. The original report and gate are unchanged. Captured outputs, evidence, usage, calls, costs, latency and provider provenance are retained.`, '',
    'The primary metric is factual/evidence contract success: schema, structured facts/reason codes, source IDs, observed reads/approval and summary bounds. Prose faithfulness is unmeasured; heuristics require semantic adjudication and do not determine wins/losses.', '',
    '| arm | factual decision | regraded factual/evidence contract success | original model calls | original measured API USD | original USD / factual success |',
    '|---|---|---|---|---|---|',
    ...original.meta.config.arms.map((arm) => result.summary[arm] ? `| ${arm} | ${result.summary[arm].correct}/${result.summary[arm].n} | ${result.summary[arm].successes}/${result.summary[arm].n} | ${result.summary[arm].calls} | ${dollars(result.summary[arm].usd)} | ${dollars(result.summary[arm].usdPerSuccess)} |` : `| ${arm} | unmeasured | | | | |`), '',
    `Changed scores: ${result.changes.map((change) => `${change.id}/${change.arm}: ${change.before} → ${change.after}`).join(', ') || 'none'}. This is a post hoc metric/grader correction, not evidence of a runtime improvement. Original grader scores are retained under archive.`, '',
    `Prose diagnostic flags requiring semantic review: ${result.rows.flatMap((row) => original.meta.config.arms.filter((arm) => row[arm]?.proseDiagnostics.some((check) => !check.passed)).map((arm) => `${row.id}/${arm}`)).join(', ') || 'none'}. Flags may be false positives; unflagged prose is not certified faithful.`, '',
    'Order age does not establish time since delivery. No new policy penalties are applied to captured outputs. See the manual audit for factual prose concerns; its notes do not change the automated score.', '',
    result.manualAudit.note,
    ...result.manualAudit.rows.filter((row) => row.notes?.length).map((row) => `- ${row.id}/${row.arm}: ${row.notes.join(' ')}`), '',
    'The original sample has four public development tasks. Reusing its outputs does not supply another trial, independent holdout, or exhaustive faithfulness assessment.', '',
  ].join('\n');
  writeFileSync(join(dir, 'report.md'), report);
  for (const name of names) if (digest(readFileSync(join(archiveDir, name), 'utf8')) !== hashes[name]) throw new Error('original archive changed during regrade');
  return { result, dir, report };
}

export function main(args = process.argv.slice(2)) {
  const reportPath = args[0];
  if (!reportPath || reportPath.startsWith('--')) throw new Error('usage: node bench/evidence-regrade.js REPORT_JSON [--audit AUDIT_JSON] [--out-dir NEW_DIR]');
  const opts = {};
  for (let i = 1; i < args.length; i += 2) {
    if (!['--audit', '--out-dir'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('invalid archive regrade option');
    opts[args[i] === '--audit' ? 'auditPath' : 'outputDir'] = args[i + 1];
  }
  const { result, dir, report } = regradeArchive(reportPath, opts);
  console.log(`${report}\nArtifacts: ${relative(root, dir)}`);
  return result;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
