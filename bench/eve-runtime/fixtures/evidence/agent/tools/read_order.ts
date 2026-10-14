import { defineTool } from 'eve/tools';
import { readEvidenceRecord } from '../../../../../evidence-tasks.js';
export default defineTool({
  description: 'Read an order record and its versioned source ID, including a missing-record result. Use the orderId returned by read_customer.',
  inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false },
  execute({ id }) { return { kind: 'record-read', ...readEvidenceRecord('orders', id) }; },
});
