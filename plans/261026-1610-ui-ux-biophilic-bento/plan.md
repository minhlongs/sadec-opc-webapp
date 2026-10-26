---
title: "2027 Biophilic Bento UI/UX Unification Across All 6 Subsystems"
status: completed
branch: feat/ui-ux-biophilic-bento-unification
created_at: 2026-10-26T16:10:00+07:00
---

# Plan: 2027 Biophilic Bento UI/UX Unification

## 1. Outcome
Unify all 6 subsystems of Sa Đéc Flow (`OpsScreen`, `FounderScreen`, `B2bMarketplace`, `HubDispatch`, `InspectionSettlement`, `PilotDashboard`) under the §5 Technical Practical Biophilic Bento 2027 design system, introducing a two-tier navigation system (Clustered Top Navigation + Sticky Anchor Pipeline Stepper) and eliminating inline `style={{ ... }}` objects in `screens.tsx` and `founder-screen.tsx`.

## 2. Constraints & Invariants
- Preserve 100% of existing button labels, `id` attributes (`#customer`, `#reference`, `#product-0`, `#quantity-0`, `#saved-heading`, `#drafts-heading`), and DOM structure so all 22 Playwright E2E tests (`390px` and `1440px`) and 217 unit tests remain green.
- Do not hide sections behind conditional sub-tabs; use anchor-based Sticky Pipeline Steppers (`href="#..."`) so all sections remain mounted in the DOM.
- Zero external CSS/UI libraries (no Tailwind, Radix, Shadcn, or MUI); 100% pure CSS tokens in `src/ui/styles.css`.
- Preserve §7.2 integer VND formatting and right-aligned `tabular-nums` columns.

## 3. Phases

| Phase | Owner / Surface | Status | Description |
| --- | --- | --- | --- |
| Phase 1 | `src/ui/styles.css` & `src/ui/app.tsx` | completed | Add Bento Grid utility classes, Sticky Pipeline Stepper (`stepper-bar`), Semantic Status Badges (`badge--*`), Cluster Navigation (`subnav`), and responsive table wrappers (`table-wrap`). |
| Phase 2 | `src/ui/components/screens.tsx` & `src/ui/components/founder-screen.tsx` | completed | Add 5-step Ops Pipeline Stepper & 4-step Founder Pipeline Stepper; replace all inline `style={{ ... }}` with semantic Bento & badge classes. |
| Phase 3 | `src/ui/components/hub-dispatch.tsx`, `inspection-settlement.tsx`, `pilot-dashboard.tsx`, `b2b-marketplace.tsx` | completed | Align remaining 4 screens with semantic Bento classes and clean up inline styles. |
| Phase 4 | Verification, PR, Merge & Edge Deploy | completed | Run `pnpm verify` + `pnpm test:e2e`, open PR, merge to `main`, and deploy to Cloudflare Edge (`sadec-flow` and `sadec-flow-pilot`). |

## 4. Acceptance Criteria
- [x] `grep -c "style={{" src/ui/components/screens.tsx src/ui/components/founder-screen.tsx` returns `0` for both files.
- [x] Sticky Pipeline Stepper renders in `OpsScreen` (6 steps) and `FounderScreen` (4 steps) with anchor navigation.
- [x] Top navigation groups the 6 subsystems into 3 semantic clusters with horizontal scroll support on `390px` viewports.
- [x] `pnpm verify` passes (0 TypeScript errors, >= 217 unit tests green, clean Vite + Worker build).
- [x] `pnpm test:e2e` passes all 22 Playwright tests across `390px` and `1440px`.
