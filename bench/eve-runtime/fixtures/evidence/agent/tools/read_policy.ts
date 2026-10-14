import { defineTool } from 'eve/tools';
import { readEvidenceRecord } from '../../../../../evidence-tasks.js';
export default defineTool({
  description: 'Read a regional refund policy and its versioned source ID. Use the region returned by read_customer.',
  inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false },
  execute({ id }) { return { kind: 'record-read', ...readEvidenceRecord('policies', id) }; },
});
