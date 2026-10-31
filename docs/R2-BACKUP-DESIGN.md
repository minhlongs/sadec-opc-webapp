# Private R2 backups: design, cost, permissions

A proposal for the owner to approve. **Nothing here has been created.** No bucket,
token, lifecycle rule or lock rule exists; this document is the decision list and
the arithmetic behind it, so the approval is a decision rather than a guess.

Prices are from Cloudflare's R2 pricing page, read 2026-10-31
(<https://developers.cloudflare.com/r2/pricing/>). Every number below is either a
published price or an assumption labelled as one.

---

## 1. The bucket

| Property | Proposal | Why |
| --- | --- | --- |
| Name | `sadec-pilot-backups` | one bucket per purpose, so a mis-scoped token is visible in the name |
| Public access | **off**, no `r2.dev` managed domain, no custom domain | a public bucket holding an export of real business records is a breach, not a preference. The preflight fails if either switch is on |
| Location | Automatic (no location hint), or `apac` if a hint is wanted | see §2 |
| Storage class | Standard | backups are read rarely but must not incur retrieval fees on the day they are needed; Infrequent Access also bills a 30-day minimum |
| Structure | `<env>/<database-id>/sadec_<env>-<timestamp>-run<run-id>.sql` and `receipts/<same key>.json` | environment and database lead, so a lifecycle rule, a lock rule and an eyeball can all work per target; the run id makes the key unique without a database |
| Retention | **30 days**, proposed — awaiting the owner's approval | long enough to cover a bad migration discovered a week later, short enough not to accumulate exports of customer data forever |
| Deletion | lifecycle expiry only; no job deletes objects | a backup tool with a delete permission is one bug away from deleting the backup |

**Identity of an object** is the key: environment + database id + timestamp + run
id. Two runs in the same second cannot collide, and the key names the target, so a
listing shows immediately whether an object was filed against the right database.

## 2. Region, and what it does and does not guarantee

R2 offers two different things and they are not interchangeable:

- **Location hints** (`apac`, `weur`, `wnam`…) — a *best effort* placement for
  performance. Not a guarantee, and only honoured on first creation.
- **Jurisdictions** (`eu`, `fedramp`, `us`) — a guarantee that objects are stored
  and processed inside that jurisdiction. No other jurisdiction is offered, and it
  cannot be changed after the bucket exists.

For a pilot whose data is Vietnamese, **there is no Vietnamese jurisdiction**. So
this proposal claims no data-residency guarantee: it uses automatic placement, and
the honest statement is "Cloudflare places the data at its discretion within its
network". If residency is a requirement, it is a product/legal decision that R2
cannot satisfy today, and it needs to be taken before the pilot holds real
customer records — not after.

## 3. Encryption, stated precisely

- **At rest:** R2 encrypts all objects and their metadata automatically, AES-256,
  GCM mode, with keys **managed by Cloudflare**
  (<https://developers.cloudflare.com/r2/reference/data-security/>). This is
  service-side encryption. It protects against someone reading a disk; it does not
  protect against someone who can read the bucket with a valid token.
- **In transit:** TLS, as for all Cloudflare endpoints.
- **Client-side encryption: not proposed for this round.** It is the only way to
  make the stored bytes unreadable to anyone holding a valid R2 token, and it costs
  something specific: if the key is lost, every backup is lost with it, and a
  restore drill on a machine without the key silently proves nothing. Doing it
  properly needs key custody the owner controls (an offline copy plus a written
  recovery procedure), which is a decision and a process, not a code change.

**What is proposed instead, for now:** private bucket, bucket-scoped token (§4),
no public domain, retention that removes old copies, and a receipt that records
what was stored. If the owner wants client-side encryption, the follow-up is: an
age/XChaCha20-Poly1305 envelope, key held as a GitHub Environment secret **and** in
the owner's offline store, with the drill run only in a job that has the key — and
the recovery procedure written down and tested before the first real backup.

## 4. Permissions

Two different operations, two different scopes. The R2 permission groups are
documented at <https://developers.cloudflare.com/r2/api/tokens/#permissions>.

| Operation | Needs | Must not have |
| --- | --- | --- |
| preflight reads bucket config, lifecycle, lock, public domains | `Workers R2 Storage Read` (account) | write |
| backup job uploads and reads back one object | `Workers R2 Storage Bucket Item Write`, scoped to `sadec-pilot-backups` | Admin Read & Write, delete-bucket, config edit |
| restore drill | **nothing** — it replays a local file into a local SQLite | any R2 permission |

A bucket-scoped `Bucket Item Write` token can read, write and list objects in that
one bucket. It cannot create or delete buckets, and it cannot edit lifecycle or
lock configuration — which is the point: the retention policy is not something the
backup job can change.

`DELETE` is deliberately absent. Objects leave through the lifecycle rule; a
backup job that can delete backups is a backup job that can delete the evidence it
was meant to preserve.

## 5. Retention and immutability

Two mechanisms, and only one of them is required:

- **Lifecycle expiry (required, 30 days proposed).** R2 lifecycle rules expire
  objects after a number of days, per prefix
  (<https://developers.cloudflare.com/r2/buckets/object-lifecycles/>). Configured
  on the `receipts/` prefix separately if the receipts should outlive the exports.
  The preflight fails when no enabled rule expires objects, or when the longest
  expiry is shorter than 30 days.
- **Bucket lock (optional, recommended).** A lock rule prevents overwrite and
  delete for a period, and takes precedence over lifecycle
  (<https://developers.cloudflare.com/r2/buckets/bucket-locks/>). It is what stops
  a mistaken `put` from replacing an existing backup. It is reported as
  information, not a failure, because it is a second layer rather than the
  retention mechanism.

The first thing to check after creating the bucket is that the expiry is on the
`pilot/` prefix and not on the whole bucket — a rule that also expires `receipts/`
would remove the evidence that the backup existed.

## 6. Cost, with the arithmetic

Published prices (Standard class): storage **$0.015 / GB-month**, Class A
operations **$4.50 / million**, Class B **$0.36 / million**, egress **free**,
bucket allowance 100,000. Free tier each month: **10 GB-month**, **1M Class A**,
**10M Class B**.

Per backup run: 1 export put (Class A), 1 read-back (Class B), 1 receipt put
(Class A), 1 drill (local, free). So **2 Class A and 1 Class B per run**.

| Assumption | Value | Source |
| --- | --- | --- |
| export size | 33,280 bytes measured on the local fixture | measured in this repository |
| real pilot export | assumed ≤ 50 MB | **assumption**; the pilot holds one nursery's records |
| backups per day | 2 | assumption: before each mutation |
| retention | 30 days | proposed above |

- Storage at the assumed 50 MB: 60 objects × 50 MB = 3 GB-month at peak →
  **3 × $0.015 = $0.045/month**, entirely inside the 10 GB-month free tier →
  **$0.00**.
- Operations: 60 runs/month × (2 Class A + 1 Class B) = 120 Class A and 60 Class B
  → inside both free tiers → **$0.00**.
- At the measured fixture size (33 KB), storage is 2 MB-month: negligible.
- The first thing that would leave the free tier is **storage at 10 GB**, which at
  50 MB per export is 200 retained objects — 100 days of two-per-day backups with
  30-day retention cannot reach it.

**Expected cost: $0.00/month at pilot scale.** The real risk is not the bill; it is
that `CLOUDFLARE_API_TOKEN` with R2 write is a new credential, and that a bucket
holding customer data exists at all. Both are reasons this document is a proposal.

Prices must be re-read before approval: the page is dated 2026-10-30 and Cloudflare
changes pricing.

## 7. Provisioning, once approved (not executed)

The owner does these, in the dashboard, or gives the commands to whoever runs the
pilot. They are listed so the work is not invented during the approval.

```bash
# 1. Create the bucket. No --jurisdiction: see §2 for why none is claimed.
pnpm exec wrangler r2 bucket create sadec-pilot-backups

# 2. Retention: expire exports 30 days after they are written.
pnpm exec wrangler r2 bucket lifecycle add sadec-pilot-backups \
  --name expire-pilot-exports --prefix "pilot/" --expire-days 30

# 3. Recommended: prevent overwrite/delete for 30 days as well as expiry.
pnpm exec wrangler r2 bucket lock add sadec-pilot-backups retain-30d "pilot/" \
  --retention-days 30

# 4. Confirm it is private. Both must be empty/off.
pnpm exec wrangler r2 bucket dev-url disable sadec-pilot-backups
pnpm exec wrangler r2 bucket domain list sadec-pilot-backups
```

`wrangler r2 bucket lifecycle add` and `r2 bucket lock add` were checked against the
installed wrangler (`4.152.0`) for their argument shapes; the commands themselves
have **not** been run here, because creating the bucket is exactly what this round
must not do.

### How the backup job moves an object

`wrangler r2 object put <bucket>/<key> --remote --file <path>` writes the export and
`wrangler r2 object get <bucket>/<key> --remote --file <path>` reads it back; both
forms are in `.github/actions/pilot-backup/action.yml`. They were checked against
`wrangler 4.152.0 --help` and exercised **locally** (`--local --persist-to`): an
upload followed by a read-back returned a byte-identical file with a matching
SHA-256. `--pipe`/stdin also works in this version, so the action is not relying on
a flag that only exists in one direction.

Two things about the remote path are unobserved and are recorded as such: the first
remote `put`, and the `-y/--force` "Skip Basin Catalog validation prompt" flag this
wrangler build advertises. No workflow passes `-y`, because a prompt this round
cannot see is not a reason to blind a validation; GitHub sets `CI=true`, which makes
wrangler refuse an interactive prompt rather than hang on one.

Then, on GitHub (Settings → Environments → `pilot`):

| Name | Kind | Value |
| --- | --- | --- |
| `R2_BACKUP_BUCKET` | variable | `sadec-pilot-backups` |
| `CLOUDFLARE_API_TOKEN` | secret | the existing token, with `Workers R2 Storage Bucket Item Write` on this bucket added |

The preflight fails until all of this exists, which is intended: a backup job that
finds no bucket must not invent one.

## 8. What this design does not solve

- **It does not protect rows written during the migration.** See
  `docs/OPERATIONS-PILOT.md` §4 for the write window and what to do about it.
- **It does not give the backups a second location.** One bucket, one account, one
  credential. A future decision worth taking is a copy in a second account or
  provider; nothing here does that.
- **It does not make the export encrypted against someone with the token.** That is
  §3's client-side question, unanswered on purpose.
- **It does not decide retention.** 30 days is a proposal, and the owner's decision
  changes one number in the lifecycle rule and one constant in
  `scripts/preflight-facts.ts` (`PROPOSED_RETENTION_DAYS`).
