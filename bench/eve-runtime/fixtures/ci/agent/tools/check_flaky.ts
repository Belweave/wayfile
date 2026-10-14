import { defineTool } from 'eve/tools';
import { caseInput } from '../../../shared/input';

export default defineTool({
  description: 'Inspect the failing test in the current CI log and the known-flaky list. Uses the same first FAIL line and list as check-flaky.sh in the routing experiment.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  execute(_input, ctx) {
    const state = caseInput(ctx.messages);
    const file = String(state.ci?.log ?? '').match(/FAIL ([^ \r\n]+)/)?.[1] ?? '';
    return { kind: 'flaky-lookup', set: { 'test.file': file, 'test.flaky': ['tests/checkout.spec.ts', 'tests/upload-retry.spec.ts', 'src/clock.test.ts'].includes(file) }, fixture: 'flaky-list-v1' };
  },
});
