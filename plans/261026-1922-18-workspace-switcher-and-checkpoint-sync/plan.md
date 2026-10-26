---
title: "Plan: Workspace Switcher & Checkpoint Synchronization"
status: completed
created_at: 2026-10-26T19:22:00+07:00
issue: 18
branch: feat/workspace-switcher-and-checkpoint-sync
---

# Plan: Workspace Switcher & Checkpoint Synchronization (#18)

## 1. Objective & Scope Lock

Implement the remaining repository roadmap item listed in `docs/CHECKPOINT.md` (`Next` #2: Workspace Switcher for multi-workspace operators) while strictly preserving the security invariants in `test/worker-auth.test.ts`, and synchronize `docs/CHECKPOINT.md`, `docs/RELEASE.md`, and `docs/PRODUCT.md` with the current 220-test / 8-subsystem codebase reality.

### Non-Negotiable Constraints
- **Chokepoint & Impersonation Guard:** `/api/session` must never expose `"workspaces"` or `"memberships"` keys, must never return another workspace's ID unless selected from the caller's own verified live memberships, and must fall back to `memberships[0]` whenever a requested `workspace_id` is not in the caller's live `listBySubject(accessSubject)` list.
- **Data Ownership:** `localStorage` holds only the UI preference key (`sadec_preferred_workspace_id`).
- **Zero Inline Styles:** Maintain `0` inline `style={{ ... }}` attributes across all `.tsx` files.
- **Responsive Dual Widths:** Render cleanly at `390px` mobile and `1440px` desktop without console/page errors.

## 2. Acceptance Criteria

- [x] `src/worker/index.ts` updates `handleSessionRoute` to select a requested `workspace_id` query param only when it matches one of the caller's live memberships (`memberships.find(...) ?? memberships[0]`), and passes `canSwitchWorkspace: memberships.length > 1` to `handleSession`.
- [x] `src/ops/catalog.ts`, `src/ops/routes.ts`, and `src/ui/api.ts` include `canSwitchWorkspace?: boolean` on `SessionView` / `Session` and support `fetchSession(preferredWorkspaceId?: string)`.
- [x] `src/ui/app.tsx` provides a topbar workspace toggle button (`Đổi vườn`) and Command Palette action when `session.canSwitchWorkspace` is true, persisting the preference in `localStorage` (`sadec_preferred_workspace_id`).
- [x] `test/worker-auth.test.ts` includes a test verifying that `/api/session?workspace_id=ws-b` switches to `ws-b` when the caller holds live memberships in both `ws-a` and `ws-b`, while still ignoring any workspace the caller does not belong to.
- [x] `docs/CHECKPOINT.md`, `docs/RELEASE.md`, and `docs/PRODUCT.md` reflect the exact test counts and deployed version.
- [x] `pnpm verify` and `pnpm test:e2e` pass 100% with 0 errors.
