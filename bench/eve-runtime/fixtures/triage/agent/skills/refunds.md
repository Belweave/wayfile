---
description: Handle actual refund, chargeback, reimbursement or money-back requests, excluding negated requests and questions about policy.
---
The amount must be a finite nonnegative number. Missing, negative or nonnumeric amount → general-reply to ask for clarification. If amount > 500 call ask_approval first. A simulated no → general-reply, with no order lookup. A simulated yes permits the lookup. Then look up the order with lookup_order. No order number or status not_found → general-reply; otherwise → refund.
