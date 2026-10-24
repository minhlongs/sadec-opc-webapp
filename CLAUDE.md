# CLAUDE.md

Context for working in this repo. Keep it short; the spec is not copied here.

Read `docs/CHECKPOINT.md` first — it says what is true today and what is next.

## What this is

Part A of a two-area app for a plant nursery and its founder. Nursery ops:
product → customer inquiry → quote with immutable revisions → order → deposit
confirmation → delivery schedule → follow-up. Founder: interview and
observation → change proposal → config version with rollback, OPC economics,
contracts and collection duties, pilot credit.

The foundation (authorization chokepoint, route registry, money arithmetic,
Access token verification) is built and tested. **No screen and no flow exists
yet.** Don't claim a flow works because its route is registered.

## Commands

```bash
pnpm verify          # typecheck + test + build — run before pushing
pnpm test            # unit tests
pnpm test:e2e        # browser tests at 390px and 1440px
pnpm dev
pnpm db:migrate:local
pnpm db:seed:demo
pnpm deploy:preview  # pilot Worker only; refuses without the Access config
```

`pnpm verify` fails a test run that collected fewer than 20 tests. A short run is
a setup or collection problem, not a pass.

## Boundaries you must not cross

**Money.** VND is an integer. Never a float, never rounded inside an intermediate
calculation — `2 × 5,000,000 / 12` is not `2 × 416,666`. Rates are basis points.
Truncation toward zero happens once, at the domain/presentation boundary, in
`src/domain/money.ts`. The server computes every total; a client-supplied total
is never trusted, even one that looks correct.

**Authorization.** Every route resolves identity, role and `workspace_id` through
`src/security/authorize.ts`, and only there. Never write a second function that
answers "may this identity do this". An undeclared action is refused. No lane
calls any other authorization path.

**Identity.** The Worker verifies `Cf-Access-Jwt-Assertion` itself. Do not read
`ctx.access` — a Static Assets Worker runs behind a router that does not forward
it, so that path fails on a deploy while passing locally. Never invent an
identity: missing config, missing store, or a revoked membership means refusal.

**Data ownership.** `localStorage` holds UI preferences only. Business records
live in D1, and `workspace_id` is required on every tenant table. Three separate
bindings — `sadec-demo`, `sadec-test`, `sadec-test-restore` — keep demo data a
customer might view separate from data tests write.

**Immutable records.** A published quote revision, a config version, and an audit
event are never edited in place. A correction is a new revision plus an audit row
naming what changed and why.

**Environment guard.** A script that touches a database resolves its environment
through `scripts/require-environment.ts`. A command absent from its map is
permitted nothing.

**Secrets.** `.dev.vars` and `ACCESS_AUD` never enter a commit. A leaked audience
tag is what makes a forged token look valid.

## Reading a checkpoint

`docs/CHECKPOINT.md` records gates as *last run*, with the numbers, and
separates "nothing is deployed" from "the feature is missing". Trust the check
marks. If a phase claims a route works, the claim is only real when
`docs/RELEASE.md` shows the command that produced the evidence, or a test proves
it. A build passing is not a launch.

## Conventions

- Conventional commits, no AI references in the message.
- pnpm, not npm or yarn.
- Vietnamese-first user-facing copy. The API's `error` field currently carries
  Vietnamese prose directly; a stable machine-readable key alongside it is a
  change to make when the first routes that clients branch on land, not a
  convention already in place.
- The demo banner is global state, never a copy per page.
