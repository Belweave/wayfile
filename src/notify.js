// ask-node backends. Default is a local stub; the Notify backend is opt-in (WAYFILE_NOTIFY=live)
// and maps the user-notify MCP `interactions_create` flow onto Notify's REST API
// (POST {base}/interactions, then GET {base}/interactions/{id}/wait), per notify.belweave.ai/openapi.json.
import { createHash } from 'node:crypto';

export const stubAsk = async ({ state }) => ({ answer: state?.stub?.ask ?? 'yes', via: 'stub' });

const ANSWER = { approved: 'yes', yes: 'yes', denied: 'no', no: 'no', expired: 'timeout', canceled: 'timeout' };

// The REST interactions schema has no project or accent field (those exist only on /notifications and apps),
// so `project` and `accent` are kept as config and recorded in the result, not sent. See docs/NOTIFY.md.
export function notifyRequest(node, state, { project = 'Chief Engineer', accent = '#FF3D7F', expiresInSeconds = 900 } = {}) {
  const needs = Object.fromEntries(node.needs.map((k) => [k, k.split('.').reduce((o, p) => o?.[p], state)]));
  const idempotencyKey = `wayfile-${node.id}-${createHash('sha256').update(JSON.stringify([node.text, needs])).digest('hex').slice(0, 24)}`;
  const body = {
    title: node.title.slice(0, 80),
    prompt: `${node.body}\n\n${JSON.stringify(needs)}`.slice(0, 2000),
    kind: node.meta.ask_kind || 'approval',
    expiresInSeconds,
  };
  return { idempotencyKey, body, project, accent };
}

export function notifyAsk({ token = process.env.NOTIFY_TOKEN, base = process.env.NOTIFY_BASE || 'https://notify.belweave.ai/api/agent', fetchFn = fetch, ...cfg } = {}) {
  if (!token) throw new Error('NOTIFY_TOKEN not set (needs interactions:create, notifications:send, interactions:read)');
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  return async ({ node, state }) => {
    const req = notifyRequest(node, state, cfg);
    const res = await fetchFn(`${base}/interactions`, { method: 'POST', headers: { ...h, 'idempotency-key': req.idempotencyKey }, body: JSON.stringify(req.body) });
    if (!res.ok) throw new Error(`notify ${res.status}: ${await res.text()}`);
    const created = await res.json();
    const id = created.interaction?.id ?? created.id;
    const deadline = Date.now() + req.body.expiresInSeconds * 1000;
    while (Date.now() < deadline) {
      const w = await fetchFn(`${base}/interactions/${id}/wait?timeout=25`, { headers: h });
      if (!w.ok) throw new Error(`notify wait ${w.status}: ${await w.text()}`);
      const { interaction: it, timedOut } = await w.json();
      if (!timedOut && it.status !== 'pending') return { answer: it.status === 'replied' ? it.response : ANSWER[it.status], via: 'notify', id };
    }
    return { answer: 'timeout', via: 'notify', id };
  };
}
