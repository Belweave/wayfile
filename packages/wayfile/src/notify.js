// ask-node backends. Default is a local stub; the Notify backend is opt-in (WAYFILE_NOTIFY=live)
// and maps the user-notify MCP `interactions_create` flow onto Notify's REST API
// (POST {base}/interactions, then GET {base}/interactions/{id}/wait), per notify.belweave.ai/openapi.json.
import { createHash, randomUUID } from 'node:crypto';
import { get } from './logic.js';

export const stubAsk = async ({ state }) => {
  const answer = state?.stub?.ask;
  if (answer === undefined) throw new Error('ask node needs an approval backend or explicit state.stub.ask test response');
  return { answer, via: 'stub' };
};

const ANSWER = { approved: 'yes', yes: 'yes', denied: 'no', no: 'no', expired: 'timeout', canceled: 'timeout' };

// The REST interactions schema has no project or accent field (those exist only on /notifications and apps),
// so `project` and `accent` are kept as config and recorded in the result, not sent. See docs/NOTIFY.md.
export function notifyRequest(node, state, { project = 'Wayfile', accent = '#FFD600', expiresInSeconds = 900, approvalScope = '' } = {}) {
  const needs = Object.fromEntries(node.needs.map((k) => [k, get(state, k)]));
  const idempotencyKey = `wayfile-${node.id}-${createHash('sha256').update(JSON.stringify([approvalScope, node.text, needs])).digest('hex').slice(0, 24)}`;
  const prompt = `${node.body}\n\n${JSON.stringify(needs)}`;
  if ([...prompt].length > 2000) throw new Error('Notify approval prompt exceeds 2000 characters; provide a concise complete decision packet instead of truncating evidence');
  const body = {
    title: node.title.slice(0, 80),
    prompt,
    kind: node.meta.ask_kind || 'approval',
    expiresInSeconds,
  };
  return { idempotencyKey, body, project, accent };
}

export function notifyAsk({ token = process.env.NOTIFY_TOKEN, base = process.env.NOTIFY_BASE || 'https://notify.belweave.ai/api/agent', fetchFn = fetch, ...cfg } = {}) {
  if (!token) throw new Error('NOTIFY_TOKEN not set (needs interactions:create, notifications:send, interactions:read)');
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  return async ({ node, state }) => {
    // A repeated task needs a new human decision; idempotency applies only to this invocation.
    const req = notifyRequest(node, state, { ...cfg, approvalScope: randomUUID() });
    const res = await fetchFn(`${base}/interactions`, { method: 'POST', headers: { ...h, 'idempotency-key': req.idempotencyKey }, body: JSON.stringify(req.body) });
    if (!res.ok) throw new Error(`notify ${res.status}: ${await res.text()}`);
    const created = await res.json();
    const id = created.interaction?.id ?? created.id;
    if (typeof id !== 'string' || !id) throw new Error('notify create returned no interaction id');
    const deadline = Date.now() + req.body.expiresInSeconds * 1000;
    while (Date.now() < deadline) {
      const w = await fetchFn(`${base}/interactions/${id}/wait?timeout=25`, { headers: h });
      if (!w.ok) throw new Error(`notify wait ${w.status}: ${await w.text()}`);
      const { interaction: it, timedOut } = await w.json();
      if (!it || typeof it.status !== 'string') throw new Error('notify wait returned no interaction status');
      if (!timedOut && it.status !== 'pending') {
        const answer = it.status === 'replied' ? it.response : ANSWER[it.status];
        if (typeof answer !== 'string') throw new Error(`notify returned unsupported interaction status ${it.status}`);
        return { answer, via: 'notify', id };
      }
    }
    return { answer: 'timeout', via: 'notify', id };
  };
}
