import { defineTool } from 'eve/tools';
import { readEvidenceRecord } from '../../../../../evidence-tasks.js';
export default defineTool({
  description: 'Read a customer record and its versioned source ID. Use customerId from the request.',
  inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false },
  execute({ id }) { return { kind: 'record-read', ...readEvidenceRecord('customers', id) }; },
});
