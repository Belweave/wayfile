import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAndPublish } from '../apps/waycode/src/coding-release.js';

test('publication bridge requires fresh successful checks against an unchanged plan', async () => {
  const events = [];
  const result = await verifyAndPublish({ workspace: '/fixture', repo: 'owner/site',
    plan: async () => { events.push('plan'); return { workspace: '/fixture', snapshot: 'same' }; },
    verify: async () => { events.push('verify'); return { status: 'passed', scripts: [{ passed: true }] }; },
    publish: async (args) => { events.push('publish'); assert.equal(args.verification.snapshot, 'same'); assert.equal(args.verification.independent, true); return 'ok'; },
  });
  assert.equal(result, 'ok'); assert.deepEqual(events, ['plan', 'verify', 'plan', 'publish']);
});
test('failed verification and changed files block publication', async () => {
  const base = { workspace: '/fixture', repo: 'owner/site', publish: async () => assert.fail('must not publish') };
  await assert.rejects(verifyAndPublish({ ...base, plan: async () => ({ workspace: '/fixture', snapshot: 'a' }), verify: async () => ({ status: 'failed' }) }), /blocked/);
  let calls = 0;
  await assert.rejects(verifyAndPublish({ ...base, plan: async () => ({ workspace: '/fixture', snapshot: String(calls++) }), verify: async () => ({ status: 'passed' }) }), /changed/);
});
