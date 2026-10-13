// 50 synthetic tickets with ground-truth end node. Deterministic (no randomness).
const T = [
  // [body template, amount, expected end]
  ['Please refund order {n}, it arrived broken', 40, 'refund'],
  ['I want a chargeback for order #{n}', 120, 'refund'],
  ['Refund please, I changed my mind', 25, 'general-reply'], // no order id → lookup not_found
  ['Refund order {n} — the TV never worked', 900, 'refund'], // >500 → ask (stub yes) → refund
  ['I forgot my password and cannot log in', 0, 'account-help'],
  ['My 2FA codes stopped working, locked out', 0, 'account-help'],
  ['App crashes: 1) open Settings 2) tap Export 3) it closes', 0, 'bug-intake'],
  ['Steps to reproduce: upload a 2MB png, click save, spinner forever', 0, 'bug-intake'],
  ['What are your support hours?', 0, 'general-reply'],
  ['Do you ship to Canada?', 0, 'general-reply'],
];
export const tickets = Array.from({ length: 50 }, (_, i) => {
  const [body, amount, expect] = T[i % T.length];
  return { id: `t${String(i + 1).padStart(2, '0')}`, input: { ticket: { body: body.replace('{n}', String(100 + i)), amount } }, expect };
});
