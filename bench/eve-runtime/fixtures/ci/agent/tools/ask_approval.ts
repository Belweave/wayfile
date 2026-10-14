import { defineTool } from 'eve/tools';
import { approvalAnswer, caseInput } from '../../../shared/input';

export default defineTool({
  description: 'Request the explicitly simulated human answer for credential rotation in the current CI case. Never assume approval; a no answer routes to human triage.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  execute(_input, ctx) {
    return { kind: 'approval', answer: approvalAnswer(caseInput(ctx.messages)), simulated: true };
  },
});
