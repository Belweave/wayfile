#!/usr/bin/env node
// Tool contract: state JSON on stdin → {"set": {...}, "next"?: "<node>"} on stdout. Replace the fake DB with your API.
let input = '';
for await (const chunk of process.stdin) input += chunk;
const state = JSON.parse(input);
const id = state.message?.text?.match(/order #?(\d+)/i)?.[1];
const status = !id ? 'not_found' : Number(id) % 2 ? 'shipped' : 'delivered';
console.log(JSON.stringify({ set: { 'order.status': status } }));
