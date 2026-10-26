# Product

What ships, who may do what, and the rules the code enforces. This describes the
target of Part A, not what is built — see `docs/CHECKPOINT.md` for the
difference. Where a rule is not implemented yet, this file says so.

## One app, two areas

**Nursery operations.** The work the owner already does by phone and notebook:
product catalog → a customer asks about stock → a quote with immutable revisions
→ an order → deposit confirmation → a delivery schedule → follow-up. The unit of
work is "what needs a quote, a callback, a confirmation, or a delivery today",
computed from the database rather than listed by hand.

**Founder.** Discovery of prospective OPC clients, interviews and observations
classified by evidence, change proposals, parameter versions with rollback, OPC
economics and capacity, service contracts and collection duties, pilot credit.
This is where "maybe we should change the monthly fee" becomes a numbered,
reversible proposal instead of an edit nobody can trace.

No marketplace, no ERP, no wallet, no tax accounting, no native mobile app. §1
draws that line and this app stays inside it.

## Roles

Three, and the rules are enforced in one place — `src/security/authorize.ts` —
rather than scattered through handlers.

| Role | Nursery area | Founder area |
| --- | --- | --- |
| `founder_admin` | Access any workspace it is granted, always audited | Full: parameters, contracts, capacity, economics |
| `workspace_owner` | Full in granted workspaces; **confirms deposits** | None |
| `workspace_operator` | Sells and fulfils in granted workspaces | None |

The walls that matter:

- **Only `founder_admin` reads or publishes founder parameters.** An operator
  working in a granted workspace still sees nothing from the founder area. That
  boundary is unverified, so it carries its own test rather than relying on a
  hidden control.
- **Only an owner confirms a deposit or reverses a receipt.** An operator may
  create an order and schedule a delivery, but a delivery under insufficient
  deposit is refused unless an owner overrides it — and the override writes an
  audit row.
- **Nobody self-grants.** Role changes are `founder_admin` only, and revoking a
  membership denies future requests without deleting the row, so the history
  survives.

## Business rules the code enforces

**Money is an integer number of dong.** Rates are basis points. A total is
computed on the server and never taken from the client, even a client value that
looks correct. Truncation toward zero happens once, at the boundary between
domain arithmetic and presentation, so a quote is never optimistic about what a
customer is asked to pay.

**Quote revisions are immutable.** A published quote revision is a snapshot.
Correcting one means a new revision with its own number, never an edit in place —
so a customer who received revision 2 can be shown exactly revision 2 later.

**Parameters are versioned.** A published parameter set is immutable; the next
change is a new version that can be compared against its predecessor and rolled
back. Publishing is `founder_admin` only.

**Concurrency is guarded in the database.** An optimistic-concurrency check is a
SQL condition, not an application pre-check, so a lost race produces a real error
and the whole batch rolls back. `UPDATE … WHERE version = ?` matching zero rows is
not an error in D1 — the code must read `changes` and turn it into a refusal, or
two people editing the same order can silently overwrite each other.

**Immutable records stay immutable.** Published quote revisions, config versions
and audit events are never edited. A correction is a new row plus an audit entry
naming what changed and why.

**Demo data is never mistaken for real.** Everything created by the demo seed
carries a visible environment label, in the app and on anything printed from it.
Every initial business parameter is an assumption; no claim in the product says
the model is market-validated.

## Status

The Nursery Operations area (catalog, quote revisions, orders, receipts/deposits,
deliveries, follow-up tasks, today summary, printable A4 quote with DEMO label)
and Founder Discovery area (interviews, immutable revisions, observations, pain
tags, change proposals, config versions with rollback, OPC economics, contracts,
pilot credits, import-preview/apply, CSV export) are fully implemented and
verified locally in `src/ops/**`, `src/founder/**`, `src/ui/**`, and `test/**`.
All 217 unit/integration tests and 22 Playwright E2E tests are green.
