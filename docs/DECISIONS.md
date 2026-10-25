# Decisions

Only choices that change behavior, cost, or how a later reader should read the
code. Each entry says what was decided, why, and what it would cost to reverse.

## Rounding of money

§7.2 requires VND money to be an integer. §13's first-year average cost is
`monthly_fee + setup_fee / 12`, which is 3,833,333.33 with the starting
parameters — not an integer.

**Decision: truncate toward zero to the dong, in one function, at the boundary
between domain arithmetic and presentation.** No rounding up, and no per-site
choice.

Every one of §13's three verification rows is integer arithmetic, and I
recomputed them before recording this: N=5 gives 15,000,000 / 4,250,000 /
10,750,000 / 92h / 13,800,000 / −3,050,000; N=10 gives 30,000,000 / 6,000,000 /
24,000,000 / 112h / 16,800,000 / 7,200,000; N=10 with S=2 gives 50,000,000 /
7,000,000 / 43,000,000 / 160h / 24,000,000 / 19,000,000. The target-benefit row
lands on exactly 11,500,000 because multiplying by the benefit ratio clears the
fraction. So this rule governs one displayed row, not the acceptance evidence.

It truncates rather than rounds because a truncated quote is never optimistic
about what a customer is asked to pay, and because a reviewer can recompute the
§13 rows by hand with no extra step.

Rounding never happens inside an intermediate calculation. `2 × 5,000,000 / 12`
is not computed as `2 × 416,666`. Only a final output is truncated.

Cost to reverse: one line in one module plus this entry. That is the whole reason
for concentrating it.

## The Worker validates the Access JWT itself

Cloudflare's docs state that Workers serving Static Assets run behind an
internal router Worker, and that the router does not pass `ctx.access` to the
user Worker. So `ctx.access.getIdentity()` is unavailable here and code that
waits for it would refuse the founder on a deployment while passing locally.

**Decision: the Worker reads the `Cf-Access-Jwt-Assertion` header, verifies it
against `https://<team-domain>.cloudflareaccess.com/cdn-cgi/access/certs`, and
checks `iss`, `aud` and `exp`.** Keys rotate every six weeks and old keys stay
valid seven more days, so the token's `kid` is matched against the published set
rather than any single cached certificate. Missing `ACCESS_TEAM_DOMAIN` or
`ACCESS_AUD` fails closed on every `/api/*` route.

Cost to reverse: the verifier stays correct even if a future runtime propagates
`ctx.access`, so there is nothing to unwind — only a redundant path to remove.

### The observed result, measured rather than assumed

Phase 1 added `/api/whoami` as a development instrument — registered only when
the environment is local or test, absent everywhere else — and ran it against the
real dev server through the Static Assets router. It answered
`access_present: false`.

So on this stack, today: `@cloudflare/vite-plugin` 1.62.5, `wrangler` 4.152.0,
`compatibility_date` 2026-10-08, the router Worker does not forward `ctx.access`
to the user Worker. The published documentation is right here, and code that
waited on that object would have failed on a deployment while passing locally.

The probe is kept anyway, for two reasons. It is the only way to notice the day a
runtime starts propagating `ctx.access` — and a reader of this repository would
otherwise have to take the claim on trust. And it costs one boolean behind a
development-only route.

## `APP_ENV=local` runs on the demo database

The dev identity adapter is permitted only under `APP_ENV=local` or `test`. The
`demo` value is not in that set, and that is deliberate: `demo` is also the value
a *deployed* demo environment uses, so allowing the adapter there would let an
accidental real-demo deployment silently invent an identity instead of refusing.

Local development therefore sets `APP_ENV=local`, which maps to the `sadec_demo`
binding — the same database the demo seed populates. So the local server reads
demo data while the adapter stays a local-only affordance.

A developer whose `DEV_IDENTITY_SUBJECT` names no demo identity gets no identity
at all, and every guarded route refuses. A typo in configuration should stop the
session rather than quietly resolve to a lower role, because a developer who
believes they are testing as the founder while testing as an operator has a
permission test that passes against the wrong role.

## Worker-level Access rather than a hostname policy

No domain is purchased, so the `workers.dev` hostname is the only production
URL. Worker-level Access with scope "All traffic" covers routes, custom domains,
the `workers.dev` hostname, and preview URLs, which is exactly the set §6 asks
to protect.

A hostname policy cannot cover the `workers.dev` hostname without a domain, so
this is not a preference between two working options.

**Worth knowing: `workers_dev: false` does not disable Preview URLs or Version
URLs.** Disabling it is not the protection. Access is the protection, and
preview URLs are disabled as a second measure, not as the control that closes
§15 case 17.

## The session route names a workspace only from the membership table

The browser cannot know which workspace to scope its first request to, because
naming one is what the session route answers. So `/api/session` is the one guarded
route the client cannot scope, and it resolves the workspace through a new
`MembershipStore.listBySubject` rather than through the request.

The alternative — reading `workspace_id` from a query parameter — was rejected
because §6 forbids trusting anything the browser sends. A client that could name
a workspace could point itself at any workspace in the database; the membership
lookup decides instead, exactly as it does on every other route.

`listBySubject` carries no permission decision. The role is still resolved by
`authorize`, in the workspace the membership chose, so the session route gains no
permission it did not already hold. It only learns which workspace to ask about.

Where a caller holds more than one membership, the earliest-granted is chosen: the
query orders by `granted_at, workspace_id`, so the answer is a property of the
database rather than of the order rows arrived in. The demo owner is granted both
demo workspaces at an identical timestamp, so the tiebreak falls to the workspace
id — `ws-demo-a` every time. A workspace switcher is later work; it is why the
list is ordered rather than simply taken.

## A mutation proves its origin by `Sec-Fetch-Site`, not `Origin`

§6 asks for origin checking on writes, and the first version required an `Origin`
header. That rule refused every save the app actually makes. `Origin` is a
forbidden request-header name: the browser sets it itself and strips it from a
`fetch` init, so a same-origin POST carries no such header. A Chromium probe
against the dev server confirmed it — two same-origin POSTs, one explicitly
setting `origin: location.origin`, both arrived with no `Origin` header at all.

**Decision: a write is accepted when the browser reports `Sec-Fetch-Site` as
`same-origin` or `same-site`.** That header is also a forbidden request-header
name, but the browser sends it on every request it makes, so a page cannot forge
one and cannot suppress it. A cross-site form post is still refused; the same
check now bites in the case it was written for rather than in the case that was
never a threat. `cross-site` and an absent header are refused for mutations, and
reads are unconstrained because a GET is ordinary navigation.

The cost of the old rule was invisible locally for the reason the whole class is
invisible: the unit tests construct `Request` objects and set the header
directly, which a real browser refuses to do. `test/worker-auth.test.ts` now
asserts both refusals and the acceptance, and the acceptance is the one that
would have caught this.

## The pilot environment is stated at deploy time, not in `wrangler.jsonc`

`wrangler deploy --env pilot` does not read `wrangler.jsonc`. The Cloudflare Vite
plugin redirects it to the config it generates under `dist/`, and it drops the
whole `env` object: it records `definedEnvironments: ["pilot"]` and then emits no
bindings, no vars and no Worker name for it. So the source file said
`APP_ENV: pilot` and `sadec_pilot`, and the file the deploy read said neither. A
pilot deployment then had no D1 binding and no `APP_ENV`, so every guarded route
refused — on a Worker that passed every local gate and every unit test, because
the tests inject their own binding.

**Decision: the pilot's binding is declared at the top level of `wrangler.jsonc`,
and its `APP_ENV` and Worker name are passed by `scripts/deploy-preview.ts`.**
The env section is gone rather than kept as documentation, because a config entry
a build silently drops is a lie about what runs. `test/deploy-config.test.ts`
asserts on the generated file, which is the artifact a deployment actually gets,
so this regression fails a test instead of a deploy.

A missing `APP_ENV` no longer falls back to `local` either. `BINDING_BY_ENVIRONMENT`
used to default an unset environment to the demo database's binding name; an
environment that does not say what it is now resolves no database at all, because
defaulting to another environment's data is the failure §3 exists to prevent.

## The verifier is built from the environment, not injected into it

`accessTokenVerifier` had no caller anywhere in `src/` or `scripts/`. The module
slot stayed null on a real deployment because only the tests filled it, so
`resolveIdentity` returned null and every guarded route refused everyone with a
401 that said nothing about why. The deploy command checked for
`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` and reported them present, so an operator
had every reason to believe authentication worked.

**Decision: `resolveIdentity` builds the verifier from the environment when none
was injected, caching it per pair of values.** The injected slot stays, because
substituting one without a key set to publish is how the tests exercise the
chokepoint at all.

The `Verifier` type is async, and that is load-bearing rather than cosmetic. A
verifier verifying against a published key set does I/O, so a synchronous type
would compile a Promise where a result is expected — and every truthiness check
on a Promise passes. A refusal would have looked like a success, which is the
worst failure shape this file can produce. Tests asserting a forged token is
refused would have kept passing.

## `run_worker_first` is routing, not security

`run_worker_first: ["/api/*"]` decides which requests enter the Worker. It
protects nothing. An API route with no guard is reached by it and returns data.

Recorded here so that a later glob such as `/api/public/*` is never read as a
security bypass. No exception pattern is permitted.

## This repository tracks `.claude/`

The repo carries the engineer kit, 1,788 files under `.claude/`, so that a
teammate can clone and start immediately. That is the intent recorded in
`.gitignore` itself.

The project's own instructions say not to bundle `.claude/` into delivered
artifacts, and the repo is private, so the two do not collide today. If it ever
ships to someone outside the team, the two commented lines already in
`.gitignore` are the switch — and that costs the "clone and run" property, which
is why it is a decision rather than a default.

## Money and configuration invariants live in the database, not in application code

A losing race in D1 must produce a real SQL error so the whole batch rolls back.
§11 is explicit that `batch()` is a SQL transaction, not a row lock, and that an
`UPDATE` matching zero rows is not an error — so the guard is a constraint, and
`meta.changes` is read to turn a zero-row update into a refusal.

Application-side checks cannot be the only control, because a later edit to a
route could bypass them silently.

Cost to reverse: high. Schema changes require migrations, and remote migrations
already applied cannot be rewritten.
