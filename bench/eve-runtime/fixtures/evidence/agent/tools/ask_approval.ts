import { defineTool } from 'eve/tools';
import { caseInput } from '../../../shared/input';
export default defineTool({
  description: 'Obtain the configured simulated human approval when the order amount exceeds the regional approval limit. A denial must be respected.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  execute(_input, ctx) {
    const answer = caseInput(ctx.messages).approval;
    if (answer !== 'yes' && answer !== 'no') throw new Error('Missing explicit simulated approval answer.');
    return { kind: 'approval', answer, simulated: true };
  },
});
