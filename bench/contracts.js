// Independent success checks. A correct terminal name alone is insufficient.
import { parseJSON, validateValue } from '../packages/wayfile/src/contracts.js';
import { evidenceContractVersion, evidenceOutputSchema } from './evidence-policy.js';
export function parseRoute(text, outcomes, stop) {
  if (stop === 'length' || stop === 'max_tokens') throw new Error('route response was truncated');
  let value;
  try { value = parseJSON(text); } catch { throw new Error('route response is not one unambiguous JSON object'); }
  if (!value || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.route !== 'string' || !outcomes.includes(value.route)) {
    throw new Error('route response must contain exactly one allowed route');
  }
  return value.route;
}

export function wayfileEvidence(graph, result) {
  return result.steps.flatMap((s) => {
    const node = graph.nodes[s.node];
    if (node.kind === 'script') return [{ kind: s.node === 'lookup-order' ? 'order-lookup' : s.node === 'check-flaky' ? 'flaky-lookup' : 'script', node: s.node, set: s.set, cached: Boolean(s.cached) }];
    if (node.kind === 'ask') return [{ kind: 'approval', node: s.node, answer: Object.values(s.set || {})[0], simulated: true }];
    return [];
  });
}

export function scoreCase(c, result) {
  const checks = [{ name: 'completed', passed: result.status === 'completed' }, { name: 'route', passed: result.end === c.expect }];
  const evidence = result.evidence || [];
  for (const rule of c.contract?.evidence || []) {
    checks.push({ name: `evidence:${rule.kind}`, passed: evidence.some((e) => e.kind === rule.kind && (!rule.answer || e.answer === rule.answer) && Object.entries(rule.set || {}).every(([k, v]) => e.set?.[k] === v)) });
  }
  for (const kind of c.contract?.forbidEvidence || []) checks.push({ name: `forbidden-evidence:${kind}`, passed: !evidence.some((e) => e.kind === kind) });
  if (c.contract?.approvalBeforeLookup) {
    const approve = evidence.findIndex((e) => e.kind === 'approval' && e.answer === 'yes');
    const lookup = evidence.findIndex((e) => e.kind === 'order-lookup');
    checks.push({ name: 'approval-before-lookup', passed: approve >= 0 && lookup > approve });
  }
  return { routeCorrect: result.end === c.expect, success: checks.every((x) => x.passed), checks };
}

// Prose heuristics are diagnostic signals for semantic adjudication. Known
// false positives/negatives remain visible; they never determine contract wins.
export function scoreEvidenceSummary(summary, contract) {
  if (typeof summary !== 'string') return [{ name: 'summary-bound', passed: false }];
  const text = summary.toLowerCase().replace(/[’‘]/g, "'");
  const words = text.match(/\p{L}+(?:'\p{L}+)?/gu) || [];
  const topical = /\b(?:order|purchase|refund|return|window|deadline|record|customer|evidence|policy|approval|authorization|delivery|delivered|review|payment)\b/.test(text);
  const checks = [
    { name: 'summary-bound', passed: summary.trim().length > 0 && [...summary].length <= contract.maxSummaryChars },
    { name: 'summary-topical', passed: words.length >= 3 && new Set(words).size >= 3 && topical },
  ];
  const clauses = text.split(/[.!?;]|\b(?:but|however|and)\b/).map((s) => s.trim()).filter(Boolean);
  // Negation is scoped to a predicate, not any occurrence of "not" in a
  // sentence. "Not blocked; already issued" still asserts an unsupported act.
  const statusPredicate = '(?:issued|sent|processed|paid|returned|refunded|credited|granted|approved|authorized|found|located|available|supplied|provided|present|exists|delivered|missing|denied|declined|refused|outside|beyond|eligible|within|inside)';
  const auxiliary = '(?:refund|payment|money|credit|customer|client|buyer|user|order|purchase|shipment|item|human|manual|simulated|approval|authorization|record|evidence|policy|has|have|had|been|was|were|is|are|will|would|could|may|can|be|being|a|the|any|already|yet|ever|actually)';
  // A shared negative covers coordinated "approved or issued"/"neither ...
  // nor ..." predicates. "Not approved but issued" has an affirmative act.
  const negated = new RegExp(`\\b(?:no|not|never|neither|hasn't|haven't|wasn't|weren't|isn't|aren't|didn't|don't|won't|cannot|can't)\\b(?:[\\s,]+${auxiliary})*[\\s,]+(?:${statusPredicate}\\b[\\s,]+(?:or|nor)[\\s,]+(?:${auxiliary}[\\s,]+)*)*${statusPredicate}\\b(?:\\s+(?:a|the|return|refund|policy|order|record|window|deadline))*\\s*$`);
  const futureAction = /\b(?:will|would|may|might|can|could|pending|planned)\b(?:[\s,]+(?:a|the|refund|payment|be|been|being))*[\s,]+(?:issued|sent|processed|paid|returned|refunded|credited)\b\s*$/;
  const sentences = text.split(/[.!?;]/);
  const unsupportedPayment = sentences.some((sentence) => [...sentence.matchAll(/\b(?:refunded|credited|issued|sent|processed|paid|returned)\b/g)].some((match) => {
    const prefix = sentence.slice(0, match.index + match[0].length);
    const monetary = /^(?:refunded|credited)$/.test(match[0]) || /\b(?:refund|payment|money|credit)\b/.test(sentence.slice(Math.max(0, match.index - 80), match.index + match[0].length + 25));
    return monetary && !negated.test(prefix) && !futureAction.test(prefix);
  }));
  checks.push({ name: 'no-unsupported-payment', passed: !unsupportedPayment });
  const affirmative = (pattern) => clauses.some((c) => [...c.matchAll(new RegExp(pattern.source, 'g'))].some((m) => !negated.test(c.slice(0, m.index + m[0].length))));
  let contradiction = false;
  if (contract.reasonCode === 'eligible_return') {
    contradiction = /\bineligible\b|\bnot\s+(?:eligible|qualified)\b/.test(text) || affirmative(/\b(?:outside|beyond|past)\b.{0,35}\b(?:return|window|deadline)\b/);
  } else if (contract.reasonCode === 'outside_return_window') {
    contradiction = affirmative(/\b(?:within|inside)\b.{0,35}\b(?:return|window|deadline)\b/);
  } else if (contract.reasonCode === 'missing_evidence' && contract.missingEvidence?.includes('order')) {
    contradiction = affirmative(/\b(?:order|record)\b.{0,35}\b(?:found|located|available|exists|present)\b/);
  } else if (contract.reasonCode === 'order_not_delivered') {
    contradiction = affirmative(/\b(?:order|purchase|shipment|item)\b.{0,35}\bdelivered\b/);
  } else if (contract.reasonCode === 'approval_not_granted') {
    contradiction = affirmative(/\b(?:approved|authorized)\b|\b(?:approval|authorization|permission|consent)\b.{0,35}\b(?:granted|provided|obtained|confirmed)\b|\b(?:will|can)\s+(?:approve|issue|send|process|pay|refund|credit)\b/) || /\b(?:approval|authorization)\b.{0,35}\bnot\s+(?:denied|refused|declined)\b/.test(text);
  }
  checks.push({ name: 'no-explicit-reason-contradiction', passed: !contradiction });
  return checks;
}

// Generated JSON is graded against the declared V2 output contract. The facts
// are independently derived by the fixture service, not by the output model.
export function scoreEvidenceOutput(text, contract) {
  const checks = [];
  const proseScope = { proseFaithfulnessMeasured: false, proseAdjudicationRequired: true };
  let value;
  try { value = parseJSON(text); } catch { return { success: false, factualOutputContractSuccess: false, checks: [{ name: 'json', passed: false }], proseDiagnostics: [], ...proseScope }; }
  checks.push({ name: 'contract-version', passed: contract.version === evidenceContractVersion });
  checks.push({ name: 'schema', passed: validateValue(value, evidenceOutputSchema).length === 0 });
  for (const k of ['decision', 'amount', 'currency']) checks.push({ name: `fact:${k}`, passed: value?.[k] === contract[k] });
  checks.push({ name: 'fact:reason_code', passed: value?.reason_code === contract.reasonCode });
  checks.push({ name: 'sources', passed: Array.isArray(value?.sources) && value.sources.length === contract.sources.length && new Set(value.sources).size === contract.sources.length && contract.sources.every((s) => value.sources.includes(s)) });
  const summary = scoreEvidenceSummary(value?.summary, contract);
  checks.push(...summary.filter((check) => check.name === 'summary-bound'));
  const proseDiagnostics = summary.filter((check) => check.name !== 'summary-bound');
  const success = checks.every((check) => check.passed);
  return { success, factualOutputContractSuccess: success, checks, proseDiagnostics, ...proseScope };
}
