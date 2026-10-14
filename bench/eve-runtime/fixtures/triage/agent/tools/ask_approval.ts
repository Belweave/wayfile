import { defineTool } from 'eve/tools';
import { approvalAnswer, caseInput } from '../../../shared/input';

export default defineTool({
  description: 'Request the explicitly simulated human answer for this ticket. Required before lookup for a refund over $500. Never assume approval; a no answer blocks lookup and refund.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  execute(_input, ctx) {
    return { kind: 'approval', answer: approvalAnswer(caseInput(ctx.messages)), simulated: true };
  },
});
