// A shared benchmark contract must make nullable primitive types explicit.
// Description/minimum alone permit strings under native JSON Schema rules.
export function assertEvidenceReplySchema(schema) {
  for (const [name, primitive] of [['amount', 'number'], ['currency', 'string']]) {
    const field = schema?.properties?.[name];
    if (!Array.isArray(field?.type) || field.type.length !== 2 || !field.type.includes(primitive) || !field.type.includes('null')) {
      throw new Error(`Evidence reply schema must declare ${name}.type as ["${primitive}","null"].`);
    }
    if (!schema.required?.includes(name)) throw new Error(`Evidence reply schema must require ${name}.`);
  }
  if (schema.properties.amount.minimum !== 0) throw new Error('Evidence amount must retain its nonnegative numeric bound.');
  return schema;
}
