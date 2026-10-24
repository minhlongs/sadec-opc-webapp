---
phase: 5
status: pending
owner: lane-c
depends_on: 4
founder_task: required
---

# Phase 5 — Private preview

Everything an agent can do is automatable except one step: creating the Access
application. The token has no `access` scope, so that single dashboard action
belongs to the founder.

## Context

§6 requires the pilot to be reachable only through declared permission, to
verification unauthenticated requests are refused, alternative URLs are
protected, and dev identity is inert on a deployment. Because no domain is being
purchased, the `workers.dev` hostname is the only production URL, which makes
Worker-level Access — not a hostname-based policy — the control that closes §15
case 17.

## Requirements

1. Pilot Worker and pilot D1 are separate from demo and test. Dev identity is
   disabled at runtime and excluded from the deployment build.
2. Access is applied at Worker level with scope "All traffic", which covers
   routes, custom domains, the `workers.dev` hostname and preview URLs. Preview
   URLs are disabled in the Wrangler config as an additional measure, but Access —
   not that flag — is what makes the alternative URLs safe, since disabling
   `workers_dev` does not disable Preview or Version URLs.
3. The Worker validates `Cf-Access-Jwt-Assertion` itself against the team domain
   JWKS, checking `iss`, `aud` and `exp` and matching the token `kid`. Missing
   `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` fails closed on every `/api/*` route.
4. Mutations verify request origin, since Access is cookie-based.
5. The founder identity is bootstrapped idempotently: only an authenticated
   identity matching the configured founder identity receives `founder_admin`.
   The first person to log in is not automatically an admin. Re-running the
   bootstrap must not create a second membership.
6. Pilot starts empty apart from controlled identity bootstrap. No demo customer,
   order, interview or receipt is copied across. Only an explicitly selected and
   approved configuration set may be carried over, through the normal proposal
   flow — never a direct database copy.
7. There is no "turn demo into real" button, and no seed or reset runs as part of
   a normal start-up.

## Files

Owned: `src/worker/**`, `src/auth/**`, `scripts/db-migrate-pilot.*`,
`scripts/deploy-preview.*`, `scripts/admin-bootstrap-founder.*`, `wrangler.jsonc`.

## Steps

1. Create the pilot D1 database and record its binding.
2. Migrate remote against the pilot binding with the target name printed and a
   hard refusal if the target is missing or is the wrong environment type. There
   is no silent fallback to another binding.
3. Deploy the pilot Worker with preview URLs disabled.
4. **Founder task:** enable Zero Trust, choose a team domain, and protect the
   Worker behind Access with scope "All traffic" and an allowlist policy. Read
   the AUD tag and team domain back from the dashboard and put them in the
   Worker's secret configuration. Allowlist starts with the founder's email; the
   nursery owner's email is added when a self-trial actually begins.
5. Confirm the pilot starts empty — zero customers, orders, interviews and
   receipts, apart from the bootstrapped identity.
6. Run §15 case 17 against the live URL with `curl` and record the output:
   unauthenticated requests to the `workers.dev` hostname and to any preview URL
   are refused; a forged identity header is refused; the dev identity endpoint is
   inert. The recorded output must show the redirect or status code, not a
   statement that Access was configured.
7. Run the main journey on the real URL with a real login.

## Validation

- §15 case 17 has recorded command output, not prose.
- The founder's own login works and yields `founder_admin`.
- An authenticated identity with no membership gets 403 rather than app data.
- Founder-only data (research notes, willingness to pay) never returns on a
  workspace request.
- The pilot database row counts for customers, orders, interviews and receipts
  are all zero at start-up.

## Report status honestly

§19 requires two independent statuses. The app status comes from phase 4. This
phase reports `PRIVATE_PREVIEW_VERIFIED` when case 17 has recorded evidence, or
`DEPLOY_BLOCKED` if a permission, destination or configuration is missing —
naming exactly what is missing. A successful local build is not a deployment
success, and the spec forbids calling a passing build "production-ready".

## Founder actions this phase needs

1. Enable Zero Trust and choose a team domain.
2. Create the Worker-level Access application with scope "All traffic".
3. Read the AUD tag and team domain from the dashboard.
4. Confirm or supply the founder email for allowlist and bootstrap.
5. Log in on a phone and confirm the correct role appears.
