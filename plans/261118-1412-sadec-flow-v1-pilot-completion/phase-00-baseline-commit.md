# Phase 0 — Baseline Integrity & Isolated Hardening Commit

## Goal
Verify and lock the 20 pre-existing V1 hardening files in `/Users/macbook/projects/sadec-opc-wt-v1-ship` into their own clean local commit on `feat/sadec-v1-local-verified` before any new V1 completion code is written.

## Exact Steps
1. Inspect `git status --short` and `git diff --stat` to confirm only the 20 expected hardening files (+ the untracked `plans/261118-1412-sadec-flow-v1-pilot-completion/` directory, which stays unstaged in Commit 1) are present, with zero `.env`, `.dev.vars`, `.sqlite`, `.wrangler/`, `dist/`, or `test-results/` files.
2. Run `pnpm verify` (`typecheck` + `build` + Vitest unit/integration suite) to confirm the baseline hardening worktree is 100% green before committing.
3. Explicitly stage ONLY the 20 hardening files:
   - `CLAUDE.md`, `docs/CHECKPOINT.md`, `docs/PILOT-GATES.md`
   - `migrations/0008_orders_workspace_order_code.sql`
   - `src/domain/money.ts`, `src/ops/quote-revisions.ts`, `src/ops/routes.ts`, `src/ops/transactions.ts`, `src/ui/api.ts`, `src/ui/components/screens.tsx`, `src/worker/index.ts`
   - `test/migration-0007.test.ts`, `test/migration-0008.test.ts`, `test/money.test.ts`, `test/nursery-transactions.test.ts`, `test/smoke-live.test.ts`, `test/sqlite-d1-harness.ts`
   - `e2e/founder-flow.spec.ts`, `e2e/nursery-flow.spec.ts`, `e2e/smoke.spec.ts`
4. Commit locally with conventional message (`fix(ops): harden money math, receipt reversal, printable quote XSS, and workspace order codes`). Do NOT push.

## Acceptance Criteria
- `git log -1` shows the isolated 20-file hardening commit on `feat/sadec-v1-local-verified`.
- `pnpm verify` exited `0` immediately prior to commit.
- Zero remote operations performed.
