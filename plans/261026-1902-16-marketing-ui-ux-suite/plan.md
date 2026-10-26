---
title: "Plan: Full-Stack Marketing UI/UX Suite — B2B Growth Landing, Interactive Escrow Calculator & CMO GTM Hub"
status: completed
created_at: 2026-10-26T19:02:00+07:00
completed_at: 2026-10-26T19:10:00+07:00
issue: 16
branch: feat/marketing-ui-ux-interactive-suite
---

# Plan: Full-Stack Marketing UI/UX Suite (#16)

## 1. Objective & Scope Lock

Bring the full CMO & Marketing GTM playbook alive directly inside the Sa Đéc Flow React application across 3 interactive UI/UX surfaces:
1. **`src/ui/components/marketing-landing.tsx` (`marketing_landing`)**: B2B Growth Hero ("Bộ đôi Chắc tiền & Giá gốc"), Interactive ROI & VietQR Escrow Calculator powered by `calculateBookingQuote` (`src/domain/escrow-ledger.ts`), and Traditional Middlemen vs. Sa Đéc Flow comparison matrix.
2. **CRO Trust & Guarantee Strip inside `src/ui/components/b2b-marketplace.tsx`**: 3-pillar conversion trust bar (*Cọc tươi 30–50%*, *0đ kê giá trung gian*, *Hoàn cọc 100% nếu sai nụ*) with quick jump to the ROI Calculator.
3. **`src/ui/components/marketing-gtm-hub.tsx` (`cmo_gtm_hub`)**: Interactive CMO & Field SDR Command Center featuring Pilot 3–6 month funnel metrics and filterable cards with **1-Click Copy (`navigator.clipboard.writeText`)** for 4 Zalo VietQR templates, 10 field objection handlers, 15 TikTok/Reels video scripts, and 30 SEO/AEO keywords.

### Non-Negotiable Constraints
- **Zero Platform Outlay:** `platformOutlayVnd === 0`.
- **Integer VND & Basis Points:** All monetary calculations in integer VND via `calculateBookingQuote` and `multiplyByBasisPoints`; deposit rate `3000..5000 bps`, platform fee `200..500 bps`.
- **Zero Inline Styles:** Maintain `0` inline `style={{ ... }}` attributes across all `.tsx` files (`src/ui/styles.css` only).
- **Responsive Dual Widths:** Render cleanly at `390px` mobile and `1440px` desktop without console/page errors.

## 2. Disjoint Parallel File Ownership

| Track | Owner | Files Owned |
|---|---|---|
| **Track A: Marketing Landing & Interactive ROI Calculator** | Subagent 1 (`frontend-developer`) | `src/ui/components/marketing-landing.tsx` |
| **Track B: CMO & Field SDR Command Center (1-Click Copy)** | Subagent 2 (`frontend-developer`) | `src/ui/components/marketing-gtm-hub.tsx` |
| **Track C: Styles, Shell Wiring, CRO Trust Strip & Verification** | Controller (`main`) | `src/ui/styles.css`, `src/ui/components/b2b-marketplace.tsx`, `src/ui/app.tsx`, `test/marketing-ui.test.ts`, `e2e/b2b-flow.spec.ts` |

## 3. Acceptance Criteria

- [x] `src/ui/styles.css` includes semantic classes for `.marketing-hero`, `.roi-calc`, `.trust-strip`, `.gtm-hub`, `.copy-card`, and responsive badges with 0 inline styles.
- [x] `src/ui/components/marketing-landing.tsx` computes exact integer VND savings comparing middleman markup (20%–35%) vs. Sa Đéc Flow fee (2%–5%) and VietQR deposit (30%–50%).
- [x] `src/ui/components/marketing-gtm-hub.tsx` renders interactive tabs for Zalo templates, 10 Objection handlers, 15 Short Video scripts, and 30 AEO Keywords with 1-Click Copy feedback.
- [x] `src/ui/components/b2b-marketplace.tsx` displays the 3-pillar CRO Trust Strip and quick link to the ROI Calculator.
- [x] `src/ui/app.tsx` registers `marketing_landing` and `cmo_gtm_hub` in `AppTab`, `subnav`, and `CommandPalette`.
- [x] `pnpm verify` and `pnpm test:e2e` pass 100%.
