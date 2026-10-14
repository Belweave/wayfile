import { defineTool } from 'eve/tools';
import { caseInput } from '../../../shared/input';

export default defineTool({
  description: 'Look up the order named in the current ticket using the same parity fixture as the routing experiment. Call only after any required approval.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  execute(_input, ctx) {
    const state = caseInput(ctx.messages);
    const match = String(state.ticket?.body ?? '').match(/order #?(\d+)/i);
    const status = !match ? 'not_found' : BigInt(match[1]) % 2n === 0n ? 'delivered' : 'shipped';
    return { kind: 'order-lookup', set: { 'order.status': status }, fixture: 'parity-order-v1' };
  },
});
