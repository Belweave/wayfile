import { ToolError } from 'wayfile/tools';

// Reuse scoped, protected, atomic file helpers rather than opening paths here.
export function createEditTool(tools) {
  const read = tools.find((tool) => tool.name === 'read-file');
  const write = tools.find((tool) => tool.name === 'write-file');
  if (!read || !write) return null;
  return {
    name: 'edit-file',
    description: 'Replace exactly one literal occurrence in a file. Read the file first and supply its SHA-256. Fails on stale content, missing match, or ambiguous match.',
    input_schema: { type: 'object', additionalProperties: false, required: ['path', 'old_text', 'new_text', 'expected_sha256'], properties: {
      path: { type: 'string', minLength: 1 }, old_text: { type: 'string', minLength: 1 },
      new_text: { type: 'string' }, expected_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    } },
    async execute(args, context) {
      const file = await read.execute({ path: args.path }, context);
      if (file.sha256 !== args.expected_sha256) throw new ToolError('File changed since read; reread before editing.', { code: 'STALE_READ' });
      const text = file.text;
      if (typeof text !== 'string') throw new ToolError('Read tool returned no file content.');
      const index = text.indexOf(args.old_text);
      if (index < 0 || text.indexOf(args.old_text, index + 1) >= 0) throw new ToolError('old_text must match exactly once; include more surrounding context.', { code: 'EDIT_MATCH' });
      return write.execute({ path: args.path, content: text.slice(0, index) + args.new_text + text.slice(index + args.old_text.length), expected_sha256: args.expected_sha256 }, context);
    },
  };
}
