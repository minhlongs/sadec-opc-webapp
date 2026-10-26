---
title: "Plan: Full-Stack CMO & Marketing GTM Execution + AEO/CRO Surface Upgrade"
status: completed
created_at: 2026-10-26T18:26:00+07:00
branch: feat/cmo-marketing-gtm-full-stack
---

# Plan: CMO & Marketing Team Full-Stack GTM Execution (`docs/marketing/` + AEO/CRO Surfaces)

## 1. Objective & Scope Lock

Execute the confirmed `/ak-advise --ultra` Winning Strategy (Candidate 3: Full-Stack O2O B2B Growth Engine — 78/80) by mobilizing the `cmo` and `copywriter` subagents in parallel to author 4 field-ready marketing playbooks in `docs/marketing/` and upgrading the live AEO/GEO & B2B Marketplace conversion surfaces (`src/domain/aeo-projection.ts`, `index.html`, `src/ui/components/b2b-marketplace.tsx`, `test/aeo-projection.test.ts`).

### Non-Negotiable Constraints
- **Zero Platform Outlay:** `platformOutlayVnd === 0` (`totalCollectedFromBuyerVnd === nurseryPayoutVnd + buyerRefundVnd + platformFeeRetainedVnd`).
- **Integer VND & Basis Points:** All monetary calculations in integer VND; deposit rate `3000..5000 bps` (30–50%), platform fee `200..500 bps` (2–5%).
- **Zero PII on Public Routes:** Never expose `owner_name`, `phone`, `tax_code`, `buyer_contact_phone`, or `qr_lot_token` on `/discover`, `/llms.txt`, `/llms-full.txt`, or `/api/public/catalog`.
- **Zero Inline Styles:** Maintain `0` inline `style={{ ... }}` attributes across all `.tsx` files (`src/ui/styles.css` only).
- **Document LOC Bound:** Every markdown file under `docs/marketing/` must be strictly `< 800 LOC`.

## 2. Disjoint Parallel File Ownership

| Track | Owner | Files Owned |
|---|---|---|
| **Track A: Brand Bible & Field SDR Playbook** | `cmo` / `copywriter` Agent 1 | `docs/marketing/brand-positioning-and-messaging.md`, `docs/marketing/field-sdr-and-zalo-playbook.md` |
| **Track B: Short Video & SEO/AEO Strategy** | `copywriter` / `marketing-seo` Agent 2 | `docs/marketing/short-video-and-social-campaigns.md`, `docs/marketing/seo-aeo-geo-content-strategy.md` |
| **Track C: Codebase AEO/CRO & Unit Tests** | Controller (`main`) | `src/domain/aeo-projection.ts`, `index.html`, `src/ui/components/b2b-marketplace.tsx`, `test/aeo-projection.test.ts` |

## 3. Acceptance Criteria (Done Means)

- [x] `docs/marketing/brand-positioning-and-messaging.md` created (< 800 LOC) with "Bộ đôi Chắc tiền & Giá gốc" positioning, vocabulary translation matrix, and persona messaging.
- [x] `docs/marketing/field-sdr-and-zalo-playbook.md` created (< 800 LOC) with Sa Đéc hamlet scripts (Tân Quy Đông, Sa Nhiên, Cai Dao), HCMC market scripts (Hồ Thị Kỷ, Đầm Sen, Thủ Đức), 10 objection handlers, and Zalo VietQR templates.
- [x] `docs/marketing/short-video-and-social-campaigns.md` created (< 800 LOC) with 15 TikTok/Reels/Zalo Video scripts and 10 Facebook B2B group seeding templates.
- [x] `docs/marketing/seo-aeo-geo-content-strategy.md` created (< 800 LOC) with 30 B2B keyword matrix and AI Search (ChatGPT/Perplexity/Claude/Google) citation architecture.
- [x] `src/domain/aeo-projection.ts`, `index.html`, and `src/ui/components/b2b-marketplace.tsx` upgraded with "Bộ đôi Chắc tiền & Giá gốc" value proposition, Traditional Middlemen vs. Sa Đéc Flow comparison table, and 100% refund-on-spec-failure FAQ entries.
- [x] `pnpm verify` (218+ unit tests, 0 TS errors, production build) and `pnpm test:e2e` (22/22 Playwright tests at 390px and 1440px) pass 100%.
- [x] GitHub Issue & PR created, reviewed, merged to `main`, and deployed live to `https://sadec-flow.agencyos-openclaw.workers.dev`.
