# Phase 5 — Full Gate Verification (G0–G10), Release Docs & Clean Local Commits

## Goal
Run the complete local verification battery (typecheck, build, unit/integration, fresh + upgrade D1 migrations, D1 backup/restore drills, dual-viewport Playwright E2E), evaluate release gates G0–G10 with concrete command/file evidence, update release documentation under `docs/`, and record clean local commits without pushing or deploying.

## Exact Steps
1. **Database & Backup/Restore Verification:**
   - Run `pnpm db:migrate:local -- --env demo` and `pnpm db:migrate:local -- --env test`
   - Run `pnpm db:seed:demo -- --env demo` and `pnpm db:seed:demo -- --env test`
   - Run `pnpm db:backup -- --env demo`
   - Run `pnpm db:restore:test -- --env test`
   - Run `pnpm db:restore:drill`
2. **Application & E2E Verification:**
   - Run `pnpm verify` (`pnpm typecheck && pnpm build && pnpm test`)
   - Run `pnpm test:e2e` (confirming `retries: 0` in `playwright.config.ts` across `mobile-390` and `desktop-1440`)
3. **Documentation Updates (`docs/`):**
   - Update `docs/CHECKPOINT.md` with exact commit SHAs, test counts, migration `0009`, G0–G10 pass evidence, and explicit local-only status (`DEMO_LIVE_VERIFIED = no`, `PILOT_LIVE_VERIFIED = no`, `Push/Merge = NOT AUTHORIZED`).
   - Create `docs/RELEASE-NOTES-V1-LOCAL.md` (shipped V1 hardening + pilot completion features, schema changes `0007`–`0009`, security & ledger invariants).
   - Create `docs/POST-V1-BACKLOG.md` (explicitly deferred items: product archive UI/API, multi-facet filtering, duplicate-phone advisory, customer history aggregation view, live Cloudflare Access verification on demo/pilot, Zalo/SMS integrations).
4. **Clean Local Commits & Final Audit:**
   - Commit V1 pilot completion code + tests + migration `0009` as **Commit 2** (`feat(ops): add product/customer editing, Vietnamese search, receipt voiding, and nursery ledger wall`).
   - Commit updated docs + plan artifacts as **Commit 3** (`docs(release): record Sa Dec Flow V1 G0-G10 local verification and post-V1 backlog`).
   - Run `git status` and `git log -4 --stat` to confirm a 100% clean working tree, zero tracked secrets/DB dumps, and zero `git push` / remote mutations.

## Acceptance Criteria
- Gates G0 through G10 all PASS with concrete executable evidence; `git status` is clean; zero remote push/merge/deploy occurred.
