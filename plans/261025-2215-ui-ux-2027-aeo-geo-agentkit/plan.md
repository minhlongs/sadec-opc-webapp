---
title: "2027 Biophilic Bento UI/UX + Dual-Surface Agent-Native (WebMCP) & AEO/GEO Architecture"
description: "Restructure Sa Đéc Flow into a Dual-Surface Human + AI Agent platform with single-source AEO/GEO projection, Browser WebMCP, expectedRevision optimistic concurrency, and 2027 Biophilic Bento UI"
status: completed
priority: P1
effort: 6h
issue: 5
branch: feat/ui-2027-aeo-geo-agentkit
tags: [ui-ux-2027, aeo, geo, webmcp, json-ld, bento-grid, agentkit, cloudflare-workers]
blockedBy: []
blocks: []
created: 2026-10-25
---

# 2027 Biophilic Bento UI/UX + Dual-Surface Agent-Native (WebMCP) & AEO/GEO Architecture

## Overview

Tái cấu trúc nền tảng **Sa Đéc Flow** (Sàn B2B Đặt Trước, Gom Hàng Cross-Docking & Bảo Chứng Cọc VietQR Escrow Hoa Kiểng Sa Đéc → TP.HCM) theo kiến trúc **Dual-Surface (Human UI + AI Agent WebMCP & AEO/GEO Discovery)** lấy cảm hứng từ `studio.agentkit.best/docs/` và xu hướng giao diện **Biophilic Bento 2027**:

1. **Single-Source-of-Truth AEO/GEO Projection (`src/domain/aeo-projection.ts`)**: Chiếu dữ liệu từ cùng một nguồn (`SupplyLotRow` + `calculateBookingQuote`) ra `PublicLotProjection` (đã lọc sạch 100% PII), `Schema.org` JSON-LD (`WholesaleStore`, `OfferCatalog`, `Product`, `Offer`, `FAQPage`), `/llms.txt`, `/llms-full.txt`, `/docs.md`, `/robots.txt`, `/sitemap.xml`, `/api/schema`, và HTML5 ngữ nghĩa cho `/api/discover` & `/discover`.
2. **Optimistic Concurrency Control (`expectedRevision`) & Public Edge Discovery**: Mỗi lô hoa kiểng có mã phiên bản tất định `revision = computeLotRevision(lot)`. API đặt giữ `POST /api/b2b/bookings/create` kiểm tra `expected_revision` (nếu truyền vào) và từ chối ngay khi dữ liệu tồn kho đã thay đổi.
3. **Browser WebMCP (`navigator.modelContext` + `window.__SADEC_AGENT_BRIDGE__`) & Human-in-the-loop Proposal HUD**: Cung cấp 4 công cụ thực thi thật (`listSupplyLots`, `quoteBooking`, `proposeBooking`, `verifyQrToken`). Công cụ `proposeBooking` kiểm tra `expectedRevision` và chỉ dựng bản nháp đề xuất trên **Agent Co-Pilot Proposal HUD** để con người bấm nút xác nhận tạo mã VietQR (Zero Auto-Spend).
4. **Giao diện Biophilic Bento 2027 (`390px` ngoài nắng & `1440px` bàn điều khiển)**: Hệ thống lưới Bento Grid sinh thái, hộp lệnh nhanh `Cmd+K` / `Ctrl+K`, công tắc chuyển đổi `Human View ↔ Agent JSON-LD View` ngay trên từng thẻ lô hoa, và sơ đồ vector nội tuyến `Inline SVG Provenance & Escrow Flow` (hỗ trợ chế độ `Clean / Sketch`).

---

## Phases Roadmap

- [x] **Phase 01 — Single-Source AEO/GEO Projection Engine & Static Discovery Assets**: Xây dựng `src/domain/aeo-projection.ts`, `test/aeo-geo-discovery.test.ts` (unit tests cho projection, JSON-LD, lọc PII), và các tài sản khám phá tĩnh đồng bộ trong `public/` (`llms.txt`, `llms-full.txt`, `docs.md`, `robots.txt`, `sitemap.xml`, `discover/index.html`) + JSON-LD trong `index.html`.
- [x] **Phase 02 — Worker Public Discovery Endpoints & Optimistic Concurrency (`expectedRevision`)**: Mở rộng `src/ops/b2b-catalog.ts`, `src/ops/b2b-routes.ts`, tạo `src/ops/public-discovery-routes.ts`, và đăng ký `{ kind: 'public', path: '/api/public/catalog' }`, `{ kind: 'public', path: '/api/schema' }`, `{ kind: 'public', path: '/api/discover' }` trong `src/worker/index.ts`.
- [x] **Phase 03 — Browser WebMCP (`navigator.modelContext` + `window.__SADEC_AGENT_BRIDGE__`) & API Query Fix**: Xây dựng `src/ui/agent-bridge.ts` và sửa lỗi nối query string + lọc `mode` trong `src/ui/api.ts`.
- [x] **Phase 04 — 2027 Biophilic Bento UI, Command Palette (`Cmd+K`), Dual-View Lot Cards & Inline SVG Flow**: Xây dựng `src/ui/components/provenance-svg.tsx`, `src/ui/components/command-palette.tsx`, nâng cấp `src/ui/styles.css`, `src/ui/components/b2b-marketplace.tsx`, và `src/ui/App.tsx`.
- [x] **Phase 05 — End-to-End Verification (`pnpm verify` & `pnpm test:e2e`)**: Mở rộng `test/aeo-geo-discovery.test.ts` cho Worker routes & `expected_revision`, mở rộng `e2e/b2b-flow.spec.ts` kiểm tra WebMCP, Command Palette, JSON-LD toggle và Agent Proposal HUD ở `390px` & `1440px`.

---

## File Ownership Matrix (Strict Disjoint Boundaries)

| Phase / Owner | Exclusive Files Owned |
|---|---|
| **Phase 01 (Domain & Public Static Assets)** | `src/domain/aeo-projection.ts`, `public/llms.txt`, `public/llms-full.txt`, `public/docs.md`, `public/robots.txt`, `public/sitemap.xml`, `public/discover/index.html`, `index.html` |
| **Phase 02 (Backend Ops & Worker Routes)** | `src/ops/b2b-catalog.ts`, `src/ops/b2b-routes.ts`, `src/ops/public-discovery-routes.ts`, `src/worker/index.ts` |
| **Phase 03 (Browser WebMCP & Client API)** | `src/ui/agent-bridge.ts`, `src/ui/api.ts` |
| **Phase 04 (2027 Bento UI & SVG Components)** | `src/ui/components/provenance-svg.tsx`, `src/ui/components/command-palette.tsx`, `src/ui/components/b2b-marketplace.tsx`, `src/ui/App.tsx`, `src/ui/styles.css` |
| **Phase 05 (Integration & E2E Test Suite)** | `test/aeo-geo-discovery.test.ts`, `e2e/b2b-flow.spec.ts` |

---

## Acceptance Criteria

1. `src/domain/aeo-projection.ts` chiếu dữ liệu từ cùng một nguồn (`SupplyLotRow` + `calculateBookingQuote`) ra `PublicLotProjection` (0% PII), `Schema.org` JSON-LD (`WholesaleStore`, `OfferCatalog`, `Product`, `Offer`, `FAQPage`), `/llms.txt`, `/llms-full.txt`, `/docs.md`, `/api/schema`, và HTML ngữ nghĩa cho `/api/discover`.
2. `GET /api/public/catalog`, `GET /api/schema`, `GET /api/discover` (và các đường dẫn `/llms.txt`, `/llms-full.txt`, `/docs.md`, `/robots.txt`, `/sitemap.xml`, `/discover`) trả về `200 OK` không cần xác thực, không chứa PII (`owner_name`, `phone`, `buyer_contact_phone`, `tax_code`), trong khi `wrangler.jsonc` giữ nguyên `run_worker_first: ["/api/*"]`.
3. `POST /api/b2b/bookings/create` hỗ trợ `expected_revision` (Optimistic Concurrency Control): khớp revision thì tạo đơn `201`, lệch revision thì từ chối `409 Conflict` và không trừ tồn kho.
4. `window.__SADEC_AGENT_BRIDGE__` và `navigator.modelContext` cung cấp 4 công cụ `listSupplyLots`, `quoteBooking`, `proposeBooking`, `verifyQrToken`, trong đó `proposeBooking` chỉ tạo đề xuất trên Agent Co-Pilot HUD chờ con người bấm xác nhận.
5. Giao diện Bento Grid 2027 đáp ứng chuẩn `390px` và `1440px`, có hộp lệnh `Cmd+K`, công tắc `Human View ↔ Agent JSON-LD View` trên từng thẻ lô hoa, sơ đồ `Inline SVG Provenance & Escrow Flow`, và bảo toàn 100% nhãn nút hiện hữu của `e2e/b2b-flow.spec.ts`.
6. `pnpm verify` và `pnpm test:e2e` vượt qua 100% với 0 lỗi.
