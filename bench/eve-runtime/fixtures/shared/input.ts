export function caseInput(messages: readonly any[]) {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = typeof message.content === 'string' ? message.content
      : Array.isArray(message.content) ? message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n') : '';
    try {
      const envelope = JSON.parse(text);
      if (envelope && envelope.fixture === 'wayfile-routing-v1' && envelope.input && typeof envelope.input === 'object') return envelope.input;
    } catch { /* Framework context announcements are not case envelopes. */ }
  }
  throw new Error('No authored benchmark input was found in this session.');
}

export function approvalAnswer(input: any) {
  // This fixture provides a simulated human, never a real external approval.
  const answer = input.stub?.ask ?? 'yes';
  if (answer !== 'yes' && answer !== 'no') throw new Error('Invalid simulated approval response.');
  return answer;
}
