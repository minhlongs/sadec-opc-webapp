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

## OPC obligations, pilot credits, and OPC receipts belong to the founder area

Phase 3 adds two distinct financial ledgers and two distinct configuration
scopes:

1. **Configuration scopes (`business_model` vs `workspace_operations`):**
   - `business_model` parameters (`pilot_fee_vnd`, `setup_fee_vnd`,
     `monthly_fee_vnd`, cost/hour assumptions) are global OPC pricing and
     economics parameters. Only `founder_admin` may read, propose, or publish
     them (`founder.parameter.read`, `founder.parameter.publish`).
   - `workspace_operations` parameters (e.g., workspace-specific deposit rules
     or operating settings) belong to a tenant workspace. Both `founder_admin`
     and `workspace_owner` may apply them through `workspace.setting.write`.

2. **OPC commercial ledger (`opc_agreements`, `opc_obligations`,
   `pilot_credits`, `opc_receipts`):**
   - Unlike nursery plant order receipts (`receipt.confirm` / `receipt.reverse`
     in Phase 2, which a `workspace_owner` confirms for their own nursery's
     customers), OPC obligations and OPC receipts record what the nursery
     workspace owes and pays to the OPC founder (pilot fee, setup fee, monthly
     subscription). Allowing a `workspace_owner` to confirm or reverse their own
     OPC subscription receipt would let a customer mark their own SaaS bill
     paid.
   - **Decision: all OPC agreement, obligation, pilot credit, and OPC receipt
     routes require `founder_admin` (`founder.parameter.read` for reads,
     `founder.parameter.publish` for mutations).**

Cost to reverse: one line in `PERMITTED_ROLES` if a read-only workspace billing
view is later exposed to `workspace_owner`.


## The session lists the caller's own live memberships; the request still proves nothing

Supersedes the "workspace switcher is later work" note above and plan
`261026-1922-18` ("session never exposes workspaces"). The demo shell used to
toggle between two hard-coded workspace ids, and an operator who held no
membership in the second was offered a switch the server then refused.

**Decision: `/api/session` returns `workspaces`, the caller's own live
memberships (id, display name, role), and nothing about anyone else's.** The UI
builds its switcher from that list and from nowhere else; the command palette
offers only those entries. A `workspace_id` on a request remains a *selection*:
every request is authorized against the membership table as before, and a
revoked membership denies the next request that relies on it. The list grants
nothing — a client that forges an id gets the same 403 it always did, and the
session route still answers an unheld id by falling back to a held one, which
the UI detects by comparing the confirmed id to the one it asked for.

The switch is adopted only after the server confirms it. Until then the current
workspace stays active and the control is disabled; a response that arrives
after a newer request is dropped (a sequence number guards it); a confirmed
switch clears the agent bridge's lot cache, any staged or confirmed proposal,
and every screen's state (screens are keyed by workspace). A stored preference
the server no longer honours is reported in words and overwritten.

Lists are scoped to the selected workspace (its bookings as buyer or nursery);
record-level actions use the wider set of workspaces the caller may act in for
that action, so a founder may confirm a deposit from any workspace they
administer. The test in `worker-auth.test.ts` that forbade the `workspaces` key
was revised, not deleted; `tenant-boundary.test.ts` pins the new contract.

Cost to reverse: remove one field from the session and the `<select>` that
reads it. The authorization path is untouched either way.

## Inspection records obligations; only a founder's confirmation moves the ledger

Inspection used to write `BALANCE_COLLECTED`, `PLATFORM_FEE_RETAINED` and
`NURSERY_PAYOUT_RELEASED` into `escrow_ledger_entries` the moment a buyer
entered accepted and defective counts, and the domain summed the balance the
buyer *should* pay into a field named "collected". No one had received it.

**Decision: inspection writes a `b2b_settlements` row (migration 0005) that
holds what was computed — accepted value, deduction, fee, the deposit already
confirmed, the balance receivable, the refund and payout payable — and moves
the booking to an `INSPECTED_*` state. It writes no ledger row.** A separate
founder-only route, `/api/b2b/bookings/confirm-settlement` (action
`marketplace.escrow.confirm`, the same boundary as confirming a deposit),
requires a bank reference whenever a balance is owed, writes the ledger rows in
one transaction, and moves the booking to `SETTLED`. The domain field is now
`buyerTotalObligationVnd`. The pilot dashboard's "platform outlay" is derived
from ledger inflow versus outflow per booking, not from an assertion.

The ledger remains a *simulated* escrow: it records confirmations typed by a
person, and a VietQR payload or reference string is not evidence of a bank
credit. The inspection screen says so. No wallet, escrow service or bank
integration was added.

`CARRIER` exists as a fault party in the domain type but has no approved cost
rule — who bears a carrier loss is a product decision nobody has made. It is
excluded from the HTTP schema and from the `b2b_settlements` CHECK, and the
screen tells the inspector to note carrier damage for manual handling. This is
recorded as a blocker, not invented.

Every multi-row B2B write is one `db.batch` whose first statement carries the
business condition (status, stock, capacity, MOQ, revision) and whose later
statements are guarded by `WHERE EXISTS` on the row just written; a `changes`
of zero on the first statement is re-read and answered as a 409 with a stable
`code` (`invalid_state`, `insufficient_stock`, `revision_conflict`). Reads of a
booking are party-scoped: visible iff the buyer or nursery workspace is one the
caller may act in, else 404 with no hint of existence.

Cost to reverse: the settlement table stays (history); the inspection route
would again write ledger rows. Not recommended.

## Money-moving POSTs honour an `Idempotency-Key`

A deposit confirmation or booking sent twice because the network dropped the
first answer must not be two records. **Decision: a guarded mutation carrying
`Idempotency-Key` runs at most once per (workspace, route, key, body hash);
a retry receives the stored response with `Idempotency-Replayed: true`.** The
reservation is one `INSERT OR IGNORE` into `idempotency_keys` and `changes`
decides ownership, so two concurrent retries cannot both run. The same key with
a different body is refused (`idempotency_conflict`); a first attempt still
running is reported (`idempotency_in_progress`); a 5xx is not stored so the
next retry does the work. The key is honoured only after identity, origin and
authorization, and the UI mints one key per intent (opening a booking form,
choosing a package, choosing a settlement to confirm), reusing it across
retries and replacing it once the intent succeeds. Without a header the layer
is a pass-through, so existing clients are unchanged.

## API refusals carry a stable `code` beside the Vietnamese `error`

A UI that must tell "the lot changed under you" from "you may not do this"
cannot do so by matching prose. **Decision: every refusal is
`{ error: <Vietnamese sentence>, code?: <closed set> }`**, produced by
`src/ops/api-error.ts`; the set is `validation`, `unauthorized`, `forbidden`,
`not_found`, `invalid_state`, `conflict`, `revision_conflict`,
`insufficient_stock`, `idempotency_conflict`, `idempotency_in_progress`,
`unavailable`. Domain refusals that carry only a status get the code that
status implies. A thrown database constraint is answered as a generic 409
`conflict`; neither SQL text nor a stack reaches the client. The `error` text is
unchanged for existing clients.

## A nursery write is recorded against the caller's live membership, or refused

`receipts.confirmed_by`, `receipt_events.actor_id`, `deliveries.override_by`
and `audit_events.actor_id` name who did the work. The previous
`resolveActorId` accepted any identity id, and when the id was missing or
unknown it fell back to the workspace's first owner and finally to the literal
`'id-demo-owner'` — an audit trail that could name someone who was not there.
**Decision: every Nursery write (accept, transition, cancel, receipt
create/confirm/reverse, delivery create/override/status) requires the caller's
identity id, re-reads it as an unrevoked membership of the requested workspace
inside the write, and otherwise refuses with 403 `forbidden`.** Nothing is
substituted. The chokepoint always supplies the id; the re-read closes the
window between authorization and the write in which a membership is revoked.
`handleAcceptRevision` and `handleUpdateDeliveryStatus` now receive the actor
context like the other handlers.

## The deposit rate is the server's; a customer order carries no client credit

`/api/quote-revisions/accept` accepted `deposit_rate_bps` (0–10000) and
`pilot_credit_vnd` from the body — a client that could name the rate could
name zero, and a credit applied to a customer order has no source (pilot
credits are a founder-area concept applied to OPC obligations, not to
orders). **Decision: the route takes only `revision_id` and an optional note;
the server applies `DEFAULT_DEPOSIT_RATE_BPS = 3000` from
`src/ops/quote-revisions.ts` and writes `pilot_credit_applied_vnd = 0`.** A
body that still carries the old keys is accepted and the keys are ignored, so
no client breaks; the UI never sent them. The 30% is an **assumption** — no
published parameter or product rule defines a per-workspace deposit rate — and
is recorded as such; when a founder parameter exists it is read in that one
constant's place. An order whose required deposit is positive starts in
`pending_deposit` (previously a 100% deposit skipped straight to `processing`).

## Each nursery multi-row write is one transaction gated by a fresh row

Acceptance updated the revision and *then* batched the order and audit rows;
confirmation updated the receipt, then the order, then the events; reversal,
cancellation and delivery scheduling were likewise split, and the under-deposit
and remaining-balance checks were application pre-checks. A failure or a race
after the first statement left a revision `accepted` with no order, a receipt
`confirmed` with the order uncredited, or a delivery scheduled against a
deposit that had just been reversed. **Decision: each of these writes is a
single `db.batch` whose first statement is an `INSERT … SELECT` or conditional
`UPDATE` carrying the business condition against the live row, and whose later
statements are guarded by `WHERE EXISTS` on a row with a *fresh id* minted for
this attempt** — the new order, the new `receipt_events` row, the new audit
row — never a timestamp, because two requests can share a millisecond and the
earlier `… AND updated_at = ?` guards would have credited an order twice. A
`changes` of zero on the gate is re-read and answered as 409 `invalid_state`
(or `conflict` for a duplicate), and a constraint the database raises rolls the
whole batch back. Specific rules now in SQL: a receipt is recorded and
confirmed only while `total − credit − collected ≥ amount` and the order is not
cancelled (a pending receipt that could never be confirmed is not recorded); a
delivery is inserted only while the order is not cancelled, has no delivery,
and either covers its deposit or carries the owner's override; cancellation
takes `refund_owed_vnd = collected_vnd` from the row at that moment; a revision
is superseded only together with its successor draft. Delivery status changes
follow a state machine as data (`DELIVERY_TRANSITIONS`; a failed attempt may be
scheduled again, delivered and cancelled are final) and write an audit row;
this ordering is an assumption drawn from the existing "scheduled → in_transit
→ delivered" comment, not a product rule.

## The under-deposit override is owner-only on every route that can take it

`/api/deliveries/create` is `order.write`, which an operator holds, and its
body accepted `override_under_deposit: true` — an operator could deliver under
deposit without the owner, bypassing `/api/deliveries/override`. **Decision:
a create body asking for the override is checked against the same permission
table as the override route (`roleMayPerform(role,
'delivery.override_under_deposit')` in `src/security/authorize.ts`) and refused
403 `forbidden` for an operator; a granted override requires a reason and
writes its own `delivery.under_deposit_override` audit row beside
`delivery.scheduled`, whichever route it arrived through.**

## A handler fault after authorization is a 409 or a 500, never a 403

The Worker's top-level catch answered every thrown error with the 403
"Hệ thống chưa sẵn sàng", including a UNIQUE constraint a lost race raised
inside an authorized write. **Decision: the dispatch after authorization is
wrapped in `responseForThrown`: a constraint error is 409 `conflict`, anything
else is 500 `unavailable`, both with a Vietnamese sentence and no SQL text.**
The store-level fault (no schema, membership query throws) keeps its 403 so a
not-yet-migrated deployment still fails closed the same way.

## Nursery UI actions carry one idempotency key per intent and refuse a double click

The Nursery buttons (issue, accept, revise, confirm receipt, complete task) sent
bare POSTs and could be clicked twice. **Decision: `OpsScreen` runs each
action through one guard — a synchronous in-flight ref ignores a second click,
the button is disabled and labelled "Đang …" while pending, and an
`Idempotency-Key` minted per intent (action + record id) is reused across
retries until the server answers.** Success is shown only after the response
and the lists are re-read. The "Sửa bản mới" button sent `chain_id` where the
route's schema takes `revision_id` — it had never succeeded from the UI — and
now sends the revision it is rendered beside. `createQuoteChainApi`'s return
type now matches the route, which answers the chain at the top level.

## A founder's import is one transaction, and its preview is the same plan without the write

`/api/founder/interviews/import-apply` looped `createOrUpdateInterview` over
the batch. A refusal on item 7 left items 1–6 written, and the only record was
each item's own audit row. Preview ran a separate, weaker validator, so what it
approved and what apply did could differ. **Decision: both routes call
`planInterviewImport`, which reads the database and returns the plan — create,
revise or unchanged per interview — with every check apply will make (batch
size, the pilot ban on synthetic data, metric keys, duplicate `external_id`
inside the batch, and the one transition never allowed: synthetic → real in
place). Preview returns that plan and writes nothing. Apply re-plans from fresh
reads and executes it as a single `db.batch` whose statement 0 is the import's
audit row, gated on "none of the interviews to create exist yet, and every
interview read is still at the revision read"; every other statement writes only
where that audit row exists. A plan that went stale writes nothing and is
answered 409 `conflict`, naming the interview that moved. Observation equality
now compares every field — it used to ignore `source_ref`, `period`, `value_str`
and `is_null`, so an import that only changed the evidence source was silently
treated as identical and the change was lost.** A single interview write runs
through the same plan and the same transaction, so there is one code path.

Cost to reverse: moderate. The plan/execute split is two functions and one
batch; an importer that writes item by item would reintroduce partial batches.

## A config version is published against the pointer it was based on, inside the batch

Applying a proposal read the active pointer, checked the base version against
it, then inserted the new version and moved the pointer in a batch. Two
founders applying against the same base could both pass the pre-check, and
`UNIQUE (scope, workspace_id, version_number)` did not stop them for the global
scope because `workspace_id` is NULL there and SQLite treats NULLs as distinct.
**Decision: the new version is inserted with `WHERE EXISTS` on the proposal
still being open *and* the pointer still naming the base version; the pointer
move, the proposal status and the audit row follow only where that version row
exists; and migration 0006 adds a partial unique index on
`(scope, version_number) WHERE workspace_id IS NULL` so the database refuses the
duplicate even if a future code path forgets the gate.** A loser is answered
409 `conflict` after re-reading, or 409 `invalid_state` if the proposal was
already applied. Rollback takes the same shape, matches scope *and* workspace
for a tenant version, and records `restored_from_version_id` on the new row
(backfilled by 0006 from the audit events the old code wrote) so the lineage is
in the table rather than only in a JSON detail.

Cost to reverse: the index stays; the gate is one `EXISTS` clause per statement.

## A proposal must cite observations that exist, and base itself on the active version

`evidence_ids` was free text: the demo proposal cites two observation ids and
nothing checked them, `rationale` could be blank, and `base_version_id` was
whatever the client sent — `null` meant "apply against whatever is active",
which defeats the staleness check. **Decision: creating a proposal requires at
least one evidence id, each of which must name a recorded observation, and a
non-empty reason; an omitted base version defaults to the active one at creation
time, so every proposal is checkable for staleness when it is applied.** A
`workspace_operations` proposal or rollback resolves its target workspace
through the chokepoint, and applying a tenant proposal re-checks it against the
caller's live memberships — the request names a proposal, and the workspace on
the record is not evidence of a right to it.

## The OPC ledger settles from the ledger, not from the receipt in hand

Confirming an OPC receipt decided the obligation's status with
`amount_vnd >= obligation.amount_vnd` — the amount of *this* receipt against
the whole obligation — so two partial payments each marked it
`partially_settled` forever, and one 60% payment followed by a 40% payment left
it unsettled or settled depending on order. The write was also three separate
statements, and a receipt could be allocated to an obligation of another
workspace or another agreement. **Decision: "remaining" has one definition,
`amount − confirmed receipts − applied credits`, used both inside the SQL gates
and for explanations. A receipt is written only while its agreement is active
and, when allocated, only while the obligation belongs to that agreement and
workspace and still has at least this much left; the obligation's status is then
recomputed from the ledger, so it settles exactly once covered. A credit
application is one transaction gated on its own audit row, and a credit larger
than the remaining amount is refused — no document defines partial use or a
carry-forward, and none was invented.** Receipts, credits and agreement/
obligation writes now carry audit rows naming the actor and the amount.

## The AEO documents are generated from the database, not committed

`public/llms.txt`, `llms-full.txt`, `docs.md`, `robots.txt`, `sitemap.xml` and
`public/discover/index.html` were generated once from the seed catalog and
committed. Every inventory count and `revision` string in them froze at that
moment, under a heading that promised "toàn bộ dữ liệu danh mục" — an agent
reading them would quote availability that no longer existed, and the files
pointed at `sadec-flow.example.com` rather than at the host serving them.
**Decision: the Worker answers those paths itself, building each document from
the same `loadPublishedLots` rows and the same PII-stripping projection the
catalog API uses, with the request's own origin in its links. `public/` no
longer holds them, and `run_worker_first` lists the paths so the asset router
cannot answer them from a stale copy.** The builders already existed and were
unused apart from `/api/discover`; this connects them to the surface they
describe. Tests assert the live revision changes after an inventory write, that
a DRAFT lot is never described, that no owner name, phone, QR token or workspace
id appears in any document or in the catalog API, and that a lot name cannot
inject markup into the HTML.

## The receiving account is configuration, and there is no default

`src/domain/vietqr.ts` built a scannable VietQR payload from three constants:
bank BIN `970415`, account `113002899999`, holder `SAN GIAO DICH HOA KIENG SA
DEC ESCROW`. The booking screen rendered that as the account to pay a deposit
into, and two Zalo templates printed it for a salesperson to paste into a
message. No such account belongs to this product: a buyer following it would
send real money to an account nobody here controls. **Decision: the account is
deployment configuration — `ESCROW_BANK_BIN`, `ESCROW_ACCOUNT_NUMBER`,
`ESCROW_ACCOUNT_HOLDER` — with no default and a shape check. Unset means no QR
is built at all (the response carries `null`), the booking screen states that no
receiving account is configured and says not to transfer anything, and a
founder records the deposit against a bank reference they verified. The Zalo/GTM
copy no longer contains an account number and points at the QR the booking
issues.** A test asserts the templates contain no account number, and the
route/browser tests assert the unconfigured state is what a local run shows.

## The founder area is exercised through a second dev server with the admin identity

Every other screen is reachable with the default local identity, an operator.
The founder area is `founder_admin`-only by design, and making the default
identity an administrator in local dev would put administrative writes one
click away from a developer testing a quote. **Decision: the Playwright config
starts a second dev server on `:5174` with `DEV_IDENTITY_SUBJECT=demo-admin`,
reading `.dev.vars.e2e-founder`, which `scripts/e2e-founder-env.ts` generates
from `.env.example` (template values plus a development subject — no secret, and
gitignored like every `.dev.vars*`).** The founder specs point at that server
and skip if it is absent, rather than passing without running.

## The agent may propose, but the screen never invents a lot to place a proposal on

Confirming a staged proposal whose lot had left the loaded catalog constructed a
synthetic lot — `available_units: max(quantity, 100)`, MOQ equal to the quantity,
a fixed ship date — and opened the booking form on it. Those numbers were
fiction shown beside a real button. **Decision: if the catalog does not hold the
proposal's lot, or holds it at a different revision than the proposal's
`expectedRevision`, the proposal is dropped with a message and no form opens.**
The server still decides: the booking POST carries `expected_revision`, and a
stale one is refused 409 `revision_conflict`, after which the form re-reads the
lot and keeps what the person typed.

## CI runs the gates and deploys nothing

There was no workflow, so "verified" always meant "verified on somebody's
machine". **Decision: `.github/workflows/verify.yml` enables the pnpm version
declared in `package.json` via corepack, installs with a frozen lockfile, runs
`pnpm verify`, prepares the local databases, installs Chromium, runs the browser
suite at 390px and 1440px, and uploads failing-run artifacts for seven days. It
holds no `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN` or Cloudflare token,
it touches no remote database, and it deploys nothing.** A test asserts all of
that against the file, so a later edit cannot quietly turn the gate into a
deploy. Whether branch protection requires the check is a repository setting and
is recorded as unverified in `docs/CHECKPOINT.md`.

## The browser suite starts from the seed, and resets only the demo database

The E2E specs book real units from real lots, so every run decremented
`available_units`. After a handful of runs "the first lot with enough stock"
stopped existing and a spec failed for a reason unconnected to the code — the
sort of test that trains people to re-run until green. **Decision:
`pnpm test:e2e` runs `scripts/e2e-prepare.ts` first. It writes the two
`.dev.vars*` files from `.env.example` (template values, gitignored), deletes
only the demo database file — identified by holding `ws-demo-a`, not by
deleting `.wrangler/state` — with its `-wal`/`-shm` companions, and re-runs
migrations and the demo seed.** The `test`, `test_restore` and `pilot` databases
are untouched, `SADEC_E2E_KEEP_DB=1` opts out, and CI takes the same path as a
laptop instead of its own preparation steps. Deleting the whole state directory
was rejected: it would take the test database with it.

## The bridge invents nothing on the read path either

The rule above closed the *write* path: a confirmed proposal for a lot that had
left the catalog is dropped rather than synthesized. The read path was still
open. `listSupplyLots` seeded `SAMPLE_LOTS` whenever its cache was empty, and
`findCachedLot` seeded them again on a miss, so an agent that asked "what is
available?" while the catalog was empty — or while `/api/b2b/lots` and
`/api/public/catalog` both failed — was handed four lots whose ids matched real
seeded rows (`lot-tet-01`, `lot-w-01`) with invented availability, MOQ, price
and ship date. `proposeBooking` then answered with a revision string for a lot
that may not exist. Reverting the file makes the new test fail with
`expected [ { id: 'lot-tet-01', … }, … ] to deeply equal []`.

**Decision: the bridge reports only what the server reported.** With nothing
loaded it answers `[]`; `quoteBooking` and `proposeBooking` refuse with the
Vietnamese message that says to reload the catalog. `SAMPLE_LOTS` stays in
`src/domain/aeo-projection.ts` as a *fixture for the pure builder functions* and
is imported by no runtime code. A public projection carries no workspace id, so
the field is `''` rather than a placeholder that looks like one.

## A public document built from a failed read is served, but not cached

> **Superseded in part** by "An unreadable catalogue is unavailable, never empty"
> below. Caching a failure was the first symptom; the deeper error was answering
> `200` at all. `no-store` survives as one header on the `503`; the `degraded`
> flag and the "empty catalog is cacheable" rule do not.

The documents answer 200 with an empty list when the database cannot be read, so
a crawler gets prose rather than a stack trace. They were also sending
`cache-control: public, max-age=60` with that empty list, which turns a
transient failure into a crawled fact: "Sa Đéc Flow has no lots" for the next
minute, at every cache in the path. **Decision: a degraded read is served with
`no-store`; a healthy read keeps `max-age=60`; a deployment with no binding at
all is not degraded and is cacheable like any other empty catalog.** The
`degraded` flag comes from `readPublishedLots`, and what is *shown* does not
change with it — only whether a cache may keep it.

## The browser suite owns its ports and never reuses a server

`reuseExistingServer: true` made the suite reuse whatever already listened on
5173/5174. That is how a previous session reported 48 passing tests against two
hand-started servers from an older revision: the code under test was not the
code in the tree, and `scripts/e2e-prepare.ts` reset the database underneath
them. The same file also left worker count and retries at Playwright's defaults,
so on a machine with more cores two spec files could book the same seeded lot
and one would fail on the other's write — the failure a retry hides.

**Decision: `workers: 1`, `retries: 0`, and `reuseExistingServer: false`.**
`e2e-prepare` checks both ports *before* deleting anything and refuses with a
message that names them and says the database is untouched, so a developer with
`pnpm dev` running gets an instruction instead of a wiped local database.
Deliberate concurrency stays in unit tests (`test/nursery-transactions.test.ts`,
`test/idempotency.test.ts`), where two transactions are interleaved on purpose
and the assertion is about the invariant rather than about a screen.

Measured, not assumed: 40 concurrent receipt writes split across the two dev
servers produced 40 × `201` and no `SQLITE_BUSY`, so the earlier explanation
that "resetting the demo database fixed the lock errors" was wrong — the reset
only guarantees a known starting stock level. What actually breaks the suite is
a stale or duplicated server, which is what the port rule removes.

## A B2B record is reachable through its parties, and a truck is a shared resource

A booking has a buyer workspace and a nursery workspace. Each record-level
handler resolves the caller's accessible set through the chokepoint and reads
the booking through `readVisibleBooking`, so confirming a deposit, verifying a
Hub package or confirming a settlement for a booking whose parties the caller
does not administer answers 404 — the same as an id that does not exist. Tested
with a founder whose only live membership is a workspace that is party to
neither (`test/cross-tenant-b2b.test.ts`).

`hub_dispatch_trips` has no workspace column, because a Hub truck physically
carries several nurseries' flowers to the same market. **Decision: the truck is
an explicitly shared resource and the packages on it are not.** Any member may
read a trip's schedule, plate, capacity and driver contact — a shop has to be
able to call the driver — and the packages joined onto it are filtered to
bookings the caller is a party to. An outsider therefore sees the truck and an
empty `packages` array, which the tests assert. This is a stated boundary, not
an open table: booking contacts, receipts, settlements and audit rows stay
behind the party check.

## An unreadable catalogue is unavailable, never empty

`readPublishedLots` returned `{lots: []}` for both a healthy empty read and a
throw — a missing binding, a query error, anything. Caching it `no-store` was
honest about the cache and dishonest about the status: a caller could not tell
"nobody is selling" from "we cannot see". **Decision: a read that fails or has no
binding answers `503`, `{"error": "Tạm thời không truy cập được dữ liệu danh
mục…", "code": "catalog_unavailable"}`, `cache-control: no-store`,
`retry-after: 60`.** A healthy read with no published lots is still `200` with
`lots: []`, and that is the only way to say empty. `/discover` renders a
temporarily-unavailable page carrying `data-catalog-status="unavailable"` and
never says "no lots". `/llms.txt`, `/robots.txt`, `/sitemap.xml` and
`/api/schema` stay `200` on the same broken database, because they read no
inventory — the failure is reported where the data is, not by taking the whole
surface down.

The error body carries a stable code and no internals: no SQL, no table or
binding name, no stack. `readPublishedLots` returns
`{ok: true, lots}` or `{ok: false, reason: 'no_database' | 'query_failed'}` and
the reason stays on the server.

## The bridge returns a status, not a list that may mean nothing

`listSupplyLots` returned `SupplyLotView[]` and swallowed every failure into
`[]`. That made three different situations identical to the agent: nothing is
for sale, the service is down, and the request was never made. **Decision:
`listSupplyLots()` returns `{status: 'OK' | 'STALE' | 'UNAVAILABLE', lots,
stale, message}`.** `OK` may legitimately be empty. `STALE` is a cached list
shown after a refresh failed: it may be displayed, and it may never be used —
`findCachedLot` refuses it, and a failed refresh clears any staged proposal so a
proposal cannot look confirmed. `UNAVAILABLE` means nobody could look, and the
screen says so instead of showing an empty catalogue.

The same pass removed `nursery_workspace_id` from the public projection.
`B2bLotView` had been satisfied with `nursery_workspace_id: ''`, an invented id
in a public payload. **The public DTO no longer has the field, and the type says
so** (`Omit<SupplyLotView, 'nursery_workspace_id'>`), so a future caller cannot
re-add it by passing an empty string. A booking takes its workspace and rights
from the server session, which is where authorization already came from.

## The first founder is provisioned by a command, not by logging in

An empty database cannot admit anyone: `authorize.ts` resolves a role from a
membership, so with no rows every guarded route answers `403`, including to the
founder. The previous round recorded this as a blocker with three options and did
not choose. **Decision: the first grant is `pnpm bootstrap:founder`, run by a
person with database access, outside the Worker and outside HTTP.**

Alternatives and why not:

- *Grant `founder_admin` to the first identity that authenticates.* §6 forbids it,
  and it makes the first visitor to find the URL the owner of the system.
- *An email allowlist that bypasses the membership check.* It creates a second
  authorization path, decided by a string comparison, that every later route
  would have to remember not to consult.
- *A bootstrap HTTP endpoint.* A public unauthenticated write path; even
  authenticated, it would be a second grant mechanism beside `memberships`.
- *A Worker start-up hook.* Invisible, re-runs on every deploy, and hides a
  security decision inside a side effect.

The command's properties are the design:

- **The subject is an argument, never derived from the email.** Access verifies a
  `sub`; an email is a label that can be shared or changed. `--subject-verified`
  is required for `--apply` so an operator has to state that they read the real
  value.
- **Preview is the default.** Nothing is written without `--apply`.
- **One transaction, proved rather than assumed.** Every statement carries the
  same precondition, and the command does not send them through an API batch: it
  renders them into one SQL file and runs `wrangler d1 execute --file`. That the
  file is one transaction was **measured on the local runtime, not inferred from
  D1 batch semantics**: a file whose last statement violates a CHECK leaves
  `workspaces`, `identities`, `memberships` and `audit_events` empty, and the same
  file without the bad statement writes all four rows
  (`test/bootstrap-transport.test.ts`, real `wrangler` processes against
  `.wrangler/transport-*`). Whether the **remote** endpoint applies a `--file`
  script the same way has **not** been observed, and a successful pilot apply
  cannot show it: a read-back after a happy path proves the final state, not that a
  failure would have left nothing. So remote atomicity has its own procedure on a
  throwaway D1 database — failing script, then the same script without the failure
  — and it is deliberately never run against the pilot database
  (`docs/PILOT-RUNBOOK.md` §6). The audit row is written before the membership and
  gates it, following `src/founder/discovery.ts`.
- **Refusals, not repairs.** A revoked membership, a different existing role, a
  second live founder, a workspace id under another name, or an email already
  held by another subject are all refusals. Bootstrap is not a membership
  manager, not a role-upgrade tool and not account recovery.
- **Who ran it is declared, and the row says so.** `--operator` is required and
  `--ticket` optional; both land in the audit detail as data, alongside
  `operator_reference: "declared"` and `subject_attestation: "declared-not-verified"`.
  The command does not verify the operator and does not invent an identity for
  them: a fabricated actor in the audit table would defeat the table's purpose.
  The cross-check is infrastructure — the Cloudflare audit log, the change ticket —
  not a second authorization system inside the application. `actor_source =
  'provisioning'` records *how* the row was written, not *who* wrote it.
- **The guard is the existing one.** `bootstrap:founder` is declared in
  `COMMAND_ENVIRONMENTS` for `test` and `pilot` only. Demo is refused because demo
  data is seeded, and an unlisted command accepts no environment at all.

The HTTP surface is unchanged: no route imports the module, the Worker bundle does
not contain it, and `test/founder-bootstrap.test.ts` fetches six bootstrap-shaped
paths in two methods and gets `404` for each.

## An audit row records where it came from

`audit_events.actor_id` was nullable, so a provisioning grant could have been
written with a NULL actor and nothing would distinguish "granted by an operator at
a terminal" from "we lost the actor". Migration `0007` adds

```
actor_source TEXT NOT NULL DEFAULT 'app' CHECK (actor_source IN ('app','provisioning'))
```

so the two are different values rather than the same absence. `'app'` is the
default, which leaves every existing row and every existing insert in `src/**`
untouched. The CHECK closes the vocabulary: a third source needs a migration,
which is the point of putting a security-relevant distinction in the schema
instead of a comment.

Consequence recorded deliberately: a bootstrap row has `actor_id` NULL **and**
`memberships.granted_by` NULL. That is not missing data — the granter is a person
who is not an identity in this system, and inventing an identity for them would
put a fabricated actor in the table the product uses to prove who did what.

## Concurrency is safe in one specific way, and the exit code says where it broke

Two `--apply` processes against one local database were run repeatedly during the
rehearsal. The invariant held every time — never two founders, never a partial set
of rows — and a sequential run afterwards always settled at one founder with one
provisioning audit row. What varied was **where the loser lost**:

- it read the state after the winner committed, and refused (`founder_exists`, 3);
- it could not read the database at all, so nothing was written (4);
- its write failed and it could not tell whether the batch landed (1).

The first version of the test asserted that the loser always exits 3 or 4, and it
failed once in five runs with exit 1 — the product was right and the assertion was
wrong. The test now asserts the invariant that holds under every timing: at most
one success, and the four rows a bootstrap writes appear as a set (0 or 4, never
partial). The exit-code ambiguity is documented in the runbook instead of being
papered over with retries: a person who sees exit 1 is told to run the preview and
read the rows, which is the only way to know.

## The restore read-back asks in one row, because five is the local limit

`scripts/db-restore-test.ts` widened its read-back from three tables to ten so a
backup that lost its money rows could not report success. Ten `UNION ALL` terms
did not run: the SQLite inside the local D1 runtime refuses more than five compound
terms (`too many terms in compound SELECT`). The restore itself succeeded, the
read-back did not, and **the script still exited 0** — the exact green that proves
nothing. Two decisions came out of it: the read-back counts ten scalar sub-selects
in one row, and a failed read-back is now a non-zero exit. `test/db-restore-readback.test.ts`
holds the shape so the UNION list cannot come back.

## A deploy does not ask for a founder identity

`deploy:preview` used to refuse without `FOUNDER_EMAIL` or `FOUNDER_SUB`, on the
stated grounds that "bootstrap grants founder_admin only to the identity
configured here". No code read either variable: the Worker has no bootstrap path,
and the grant is made by a command against the database. **Decision: the deploy
requires only `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`**, which the Worker does
verify against, and the founder identity is an argument to the bootstrap command.

This is a correction, not a relaxation. A deploy that demands a value nothing
reads teaches an operator to set it and expect access — which is exactly how the
pilot blocker was created — and a "founder" secret on a Worker is one more place
a value that grants admin can leak from. The access verifier and its fail-closed
behaviour are unchanged.

## The browser suite owns its database directory

The suite ran against `.wrangler/state`, the same D1 directory `pnpm dev` uses.
Preparing a run therefore reset whatever the developer had been working on, and
a run could inherit their drift — two problems a port guard cannot see. **Decision:
the suite passes `SADEC_D1_PERSIST=.wrangler/e2e-state` to both dev servers and to
every `wrangler d1` command it runs, and resets only inside that directory.** With
the variable unset the scripts still use `.wrangler/state`, so `pnpm dev` is
unchanged. `scripts/require-environment.ts` refuses an absolute path, a `..` or
anything outside `.wrangler/`, because this variable is the one that decides which
database a destructive command may delete.

The same rule retired `SADEC_SKIP_FOUNDER_E2E`. Skipping the founder spec made a
green run mean less than it looked, and the full acceptance command now has no
way to skip it: a partial run selects projects or specs on the command line, in
the open, rather than by exporting a flag that outlives the run.
