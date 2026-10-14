import { planRepositoryPublication, publishRepository } from './coding-publish.js';
import { verifyWorkspace } from './coding.js';

// Explicit user publication command: establish evidence on the exact planned tree.
export async function verifyAndPublish({ workspace, repo, visibility = 'private', checkURL, signal, onEvent, assertPreview,
  plan = planRepositoryPublication, verify = verifyWorkspace, publish = publishRepository } = {}) {
  const before = await plan({ workspace, repo, visibility, allowDirty: true, signal });
  if (checkURL && (!assertPreview || await assertPreview(checkURL) !== true)) throw new Error('Publication requires a running managed preview for the requested URL.');
  const result = await verify(before.workspace, { signal, checkURL, timeoutMs: 300000, onEvent });
  if (result.status !== 'passed') throw new Error(`Publication blocked: ${result.reason || 'independent verification did not pass'}`);
  const after = await plan({ workspace, repo, visibility, allowDirty: true, signal });
  if (before.snapshot !== after.snapshot) throw new Error('Files changed during verification. Run checks again before publishing.');
  signal?.throwIfAborted();
  if (checkURL && await assertPreview(checkURL) !== true) throw new Error('Managed preview stopped during publication verification.');
  return publish({ workspace: after.workspace, repo, visibility, allowDirty: true, signal, verification: {
    workspace: after.workspace, snapshot: after.snapshot, passed: true, independent: true,
    verifiedBy: 'waycode-host-verifier', verifiedAt: new Date().toISOString(), evidence: JSON.stringify(result),
  } });
}
