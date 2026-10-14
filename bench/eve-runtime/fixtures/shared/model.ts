import { appendFileSync } from 'node:fs';
import { defineAgent } from 'eve';
import { mockModel } from 'eve/evals';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { approvalAnswer } from './input';
import { assertEvidenceReplySchema } from '../../schema-check.mjs';

// These smoke responses exercise the actual harness/tools/structured reply.
// They are deliberately NOT an inference model or an accuracy baseline.
function smokeResponse(request: any, graph: string) {
  const input = JSON.parse(request.userMessages.find((text: string) => {
    try { return JSON.parse(text).fixture === 'wayfile-routing-v1'; } catch { return false; }
  }) || '{}').input || {};
  const results = request.toolResults || [];
  const used = (name: string) => results.find((result: any) => result.name === name);
  const tool = (name: string, value: any = {}) => ({ toolCalls: [{ name, input: value }] });
  const finish = (route: string) => tool('eve__reply', { route });
  if (graph === 'evidence') {
    // Check what Eve actually presents to the mock provider, not just the
    // scripted reply's values. An underconstrained contract must fail locally.
    assertEvidenceReplySchema(request.tools.find((entry: any) => entry.name === 'eve__reply')?.inputSchema);
    if (!used('read_customer')) return tool('read_customer', { id: input.customerId });
    const customerRead = used('read_customer').output;
    const customer = customerRead.value;
    if (!customer) return tool('eve__reply', { decision: 'needs-review', reason_code: 'missing_evidence', amount: null, currency: null, summary: 'Required customer evidence is missing.', sources: [customerRead.source] });
    if (!used('read_order')) return tool('read_order', { id: customer.orderId });
    const orderRead = used('read_order').output;
    const order = orderRead.value;
    if (!order) return tool('eve__reply', { decision: 'needs-review', reason_code: 'missing_evidence', amount: null, currency: null, summary: 'Required order evidence is missing.', sources: [customerRead.source, orderRead.source] });
    if (!used('read_policy')) return tool('read_policy', { id: customer.region });
    const policyRead = used('read_policy').output;
    const policy = policyRead.value;
    const sources = [customerRead.source, orderRead.source, policyRead.source];
    if (policy && order.amount > policy.approvalOver && !used('ask_approval')) return tool('ask_approval');
    const decision = !policy || order.customerId !== input.customerId ? 'needs-review'
      : order.ageDays > policy.returnDays ? 'decline'
      : order.status !== 'delivered' ? 'needs-review'
      : order.amount > policy.approvalOver && input.approval !== 'yes' ? 'needs-review' : 'refund';
    const reason_code = !policy ? 'missing_evidence' : order.customerId !== input.customerId ? 'order_customer_mismatch'
      : order.ageDays > policy.returnDays ? 'outside_return_window' : order.status !== 'delivered' ? 'order_not_delivered'
      : order.amount > policy.approvalOver && input.approval !== 'yes' ? 'approval_not_granted' : 'eligible_return';
    return tool('eve__reply', { decision, reason_code, amount: order.amount, currency: order.currency, sources,
      summary: decision === 'refund' ? 'The order is eligible for a refund; no payment has been issued.'
        : decision === 'decline' ? 'The order is outside the regional return window.' : 'Human approval has not been granted.' });
  }
  if (graph === 'triage') {
    const body = input.ticket?.body || '';
    const amount = input.ticket?.amount;
    const refund = /refund|money back|reimburse|chargeback/i.test(body) && !/do not refund|refund policy|debug log says/i.test(body);
    if (refund) {
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return finish('general-reply');
      if (!used('eve__skill')) return tool('eve__skill', { name: 'refunds' });
      if (amount > 500) {
        if (!used('ask_approval')) return tool('ask_approval');
        if (approvalAnswer(input) === 'no') return finish('general-reply');
      }
      if (!used('lookup_order')) return tool('lookup_order');
      return finish(/order #?\d+/i.test(body) ? 'refund' : 'general-reply');
    }
    return finish(/password|sign-in|verification codes/i.test(body) ? 'account-help' : 'general-reply');
  }
  const log = input.ci?.log || '';
  if (/AKIA[0-9A-Z]{16}|private key|token leaked/i.test(log)) {
    if (!used('ask_approval')) return tool('ask_approval');
    return finish(approvalAnswer(input) === 'yes' ? 'rotate-secret' : 'human-triage');
  }
  if (/FAIL /i.test(log)) {
    if (!used('eve__skill')) return tool('eve__skill', { name: 'tests' });
    if (!used('check_flaky')) return tool('check_flaky');
    return finish(/FAIL (src\/clock.test.ts|tests\/checkout.spec.ts|tests\/upload-retry.spec.ts)\b/.test(log) ? 'quarantine-test' : 'human-triage');
  }
  if (/ECONNRESET|ETIMEDOUT|503|socket dropped/i.test(log)) return finish([1, 2].includes(input.ci?.attempt) ? 'retry-job' : 'human-triage');
  return finish('human-triage');
}

export function fixtureAgent(graph: string) {
  const paid = process.env.EVE_BENCH_MODE === 'openrouter';
  if (paid && (process.env.EVE_BENCH_ALLOW_PAID !== '1' || !process.env.EVE_BENCH_PROVIDER_URL)) throw new Error('Paid fixture requires the metered adapter and an explicit paid run.');
  const model = paid ? createOpenAICompatible({
    name: 'wayfile-openrouter-meter',
    baseURL: process.env.EVE_BENCH_PROVIDER_URL!,
    apiKey: 'local-meter-only',
    includeUsage: true,
    supportsStructuredOutputs: true,
  })(process.env.EVE_BENCH_MODEL || 'anthropic/claude-haiku-5.5') : mockModel({
    modelId: `wayfile-${graph}-protocol-smoke`,
    provider: 'eve-mock',
    respond: (request) => {
      const response = smokeResponse(request, graph);
      if (process.env.EVE_BENCH_MOCK_JOURNAL) appendFileSync(process.env.EVE_BENCH_MOCK_JOURNAL, `${JSON.stringify({ at: new Date().toISOString(), graph, model: `wayfile-${graph}-protocol-smoke`, provider: 'eve-mock', status: 'mock', response, toolSchemas: request.tools.map((entry: any) => ({ name: entry.name, parameters: entry.inputSchema })) })}\n`);
      return response;
    },
  });
  return defineAgent({
    model,
    modelContextWindowTokens: 200_000,
    defaultTools: false,
    tool: false,
    reasoning: 'provider-default',
    limits: { sessionTimeoutMs: 5 * 60 * 1000, maxInputTokensPerSession: 200_000, maxOutputTokensPerSession: 20_000 },
  });
}
