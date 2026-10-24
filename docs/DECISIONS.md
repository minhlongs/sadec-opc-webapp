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
