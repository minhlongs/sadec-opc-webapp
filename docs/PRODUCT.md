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

**B2B.** A nursery publishes a supply lot; a shop books units against a
revision of that lot; the nursery confirms the deposit; the Hub consolidates a
trip; the buyer inspects; settlement is recorded as an obligation and only a
founder's confirmation moves the ledger.

The scope line, and it has moved exactly once: **no ERP, no wallet, no tax
accounting, no native mobile app, no payment or bank integration.** The
marketplace *is* in scope — this file used to say "no marketplace" while
describing one, which was the documentation lagging the code rather than the
code overstepping. What is *not* in scope is an escrow service: the ledger in
this app is a simulation of confirmation records, not a custodian of funds.

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

**The first founder is provisioned, not self-served.** A fresh database admits
nobody, by design: there is no "first login becomes admin" path and no public
bootstrap endpoint. An operator with database access runs
`pnpm bootstrap:founder` — preview, then `--apply` — which creates the workspace,
the identity, the membership and one audit row in a single transaction. After
that, every role comes from a membership row and every request goes through the
same chokepoint.

## Status

Implemented in `src/**`, covered by `test/**` and `e2e/**`, and verified locally
(2026-10-30: `pnpm verify` → 405 tests across 37 files; `pnpm test:e2e` → 48
browser tests, 8 spec files at 390px and 1440px, run eight times — seven in the
working repository and one from a clean clone of the handover bundle):

- **Nursery operations** — catalog, quote chains and immutable revisions,
  accept → order, deposits and receipts, deliveries, follow-up tasks, today
  summary, printable A4 quote with the DEMO label.
- **Founder area** — discovery (interviews, append-only observations, import
  preview/apply, CSV export), change proposals with evidence and rationale,
  immutable configuration versions with rollback lineage, OPC economics,
  contracts, obligations, receipts and single-use pilot credits.
- **B2B marketplace** — supply lots, bookings with revision-checked stock,
  deposit confirmation, Hub Sa Đéc consolidation, inspection, settlement
  obligations recorded separately from confirmed cash, pilot 3–6 month
  dashboard.
- **Marketing & field GTM** — ROI and deposit calculator, Zalo/SMS/pitch
  templates, printable A4 poster.
- **Dual-surface AEO/GEO** — `/llms.txt`, `/llms-full.txt`, `/docs.md`,
  `/robots.txt`, `/sitemap.xml` and `/discover`, generated per request from the
  same rows the catalog API reads; `/api/schema`; the WebMCP agent bridge,
  which reports only lots the server returned — with nothing loaded it answers
  an empty list rather than a sample, and a proposal for a lot it has not been
  told about is refused with a reason.
- **Multi-workspace switcher** — driven by the caller's own live memberships
  from `/api/session`.

What the product does **not** do, and the screens say so:

- It does not hold money. The escrow ledger is a **simulation**: a row records
  that a person confirmed a receipt or a payment, with the reference they were
  given. No bank integration exists, a VietQR payload is not proof of a bank
  credit, and no ledger balance is evidence that funds moved.
- It does not show a payment QR unless the deployment configures a receiving
  account. With none configured the booking screen says not to transfer
  anything, and an operator records the deposit against a reference.
- It does not price carrier damage (`CARRIER` is a domain value with no cost
  rule, excluded from the HTTP surface), and it does not apply part of a pilot
  credit — both are un made product decisions, recorded in
  `docs/DECISIONS.md` rather than invented.
- Every business parameter ships as an **assumption**. Nothing in the product
  claims the model is market-validated, and the economics screen repeats the
  formulas and the parameter source every time it renders.
