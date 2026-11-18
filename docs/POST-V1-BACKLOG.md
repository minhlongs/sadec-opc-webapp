# Sa Đéc Flow — Post-V1 Backlog & Operational Hold Items

Items below are intentionally excluded from the V1 local completion scope (`feat/sadec-v1-local-verified`) so V1 remains small, auditable, and strictly faithful to verified contracts.

---

## 1. Operational & Cloud Deployment Gates (Blocked on Owner Credentials / Approval)

1. **Remote Cloudflare R2 Backup Bucket & Object Lock Preflight (`ops-preflight-pilot`)**
   - Provision private R2 bucket with 30-day retention and object lock covering `pilot/`, configure GitHub Environment secrets, and pass `pnpm preflight:cloudflare` against live Cloudflare APIs (`docs/PILOT-CONFIG-CHECKLIST.md`).
2. **Remote D1 Migrations `0005..0009` on Demo & Pilot**
   - Remote environments recorded in `docs/RELEASE.md` remain at `0004` (`DEMO_LIVE_VERIFIED = no`, `PILOT_LIVE_VERIFIED = no`). Applying `0005` through `0009` to `sadec_pilot` requires merging to `main`, passing CI `verify`, and running `db-migrate-pilot` with a verified R2 backup receipt.
3. **Live Cloudflare Access End-to-End Browser Sign-In**
   - Verify real `Cf-Access-Jwt-Assertion` login flows on Demo and Pilot (`pnpm smoke:live`) once Access audience tags, team domain, and founder `bootstrap:founder` identity are provisioned.

---

## 2. Nursery Catalog & Customer Relationship Enhancements

1. **Product Archive / Unarchive (`products.is_active` Toggle)**
   - Schema column `products.is_active` is already enforced when pricing new quotes (`catalog.ts`), but V1 intentionally omits a UI/API archive toggle until operator workflow rules for open draft quotes referencing archived products are finalized.
2. **Duplicate Customer Phone Advisory**
   - Optional non-blocking warning (or normalized phone lookup badge) when creating or editing a customer whose phone number already matches another customer in the same workspace; intentionally not enforced as a hard `UNIQUE` constraint because a single buyer or contractor may represent multiple sub-accounts.
3. **Customer Commercial History Drawer**
   - Dedicated read-only aggregation view per customer showing historical `quote_chains`, `orders`, `receipts`, `deliveries`, and `follow_up_tasks` in one timeline.
4. **Multi-Facet Catalog Filtering & Pagination**
   - Structured filters by `species`, price band, and `include_archived`, plus cursor pagination once workspace catalogs grow beyond a few hundred SKUs.

---

## 3. Workflow & Commercial Extensions

1. **Quote Expiration & Cancellation Actions (`expired`, `cancelled`)**
   - Explicit operator action to cancel an issued quote chain and automatic/scheduled refusal when `acceptRevision` is called past `valid_until`.
2. **Workspace-Scoped Membership Management UI (`membership.grant` / `membership.revoke`)**
   - Action constants exist in `src/security/authorize.ts`, while provisioning currently happens via SQL seed/bootstrap; add founder/owner HTTP routes and UI with full audit trail.
3. **Workspace Operations Scope Selector in Founder UI**
   - Backend `change_proposals` supports both `business_model` and `workspace_operations`, whereas `founder-screen.tsx` currently submits `business_model`; expose `workspace_operations` selector in UI when per-nursery policy tuning begins.
4. **Partial Pilot-Credit Split / Carry-Forward Policy**
   - Currently `applyPilotCredit` requires `obligation_remaining >= credit_amount_vnd` (single-use scalar FK). If an OPC pilot fee ever exceeds an initial obligation, partial split ledger entries require an explicit accounting rule first.
5. **B2B Carrier-Fault Loss Allocation & Live Bank Webhook Reconciliation**
   - Define contractual split rules for `CARRIER` transit damage in `b2b_settlements`, and evaluate bank webhook / VietQR reconciliation once real B2B escrow accounts are approved.
