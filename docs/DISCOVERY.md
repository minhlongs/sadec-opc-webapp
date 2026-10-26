# Discovery

How to run a founder interview, bring the notes into the app, and turn them into
a parameter change. §12 owns import and export; this file owns the practice.

## Before the interview

An interview answers a question the founder cannot answer from the office. Write
the question down first, with the parameter it would change. "What is the monthly
fee" is a question; "how much does an hour of your time cost when you are
replying to a customer at 9pm" is one that produces evidence.

Record for each prospective client: organization alias, respondent role, date
with the +07:00 offset, and where the notes came from. Use an alias, not a legal
name, unless the founder has permission to store the real one.

## What counts as evidence

Not every statement is the same. `evidence_kind` is a required field on every
observation, and the pilot UI shows the kind next to the number — the point is
that a founder reading their own dashboard can tell a measurement from a
recollection.

| Kind | What it means | Example |
| --- | --- | --- |
| `measured` | Read from the client's own records | A count of last month's quotes from their export |
| `reported` | The respondent stated it from memory | "We do about thirty quotes a month" |
| `observed` | The founder watched it happen | Time spent on the phone during a site visit |
| `inferred` | Derived, not witnessed | An hour figure derived from a monthly total |

`inferred` is not weaker evidence — it is differently sourced, and saying so is
the whole point.

**Distinguish three things the app never conflates:** an unknown ("not measured"),
a blank ("not entered"), and a zero ("measured, and it is zero"). A null value
with a reason is a finding. A null with no reason is a gap in the interview.

## Import

Two formats, both validated, neither applied partially.

- `examples/interview-import.demo.json` — the JSON shape, with `schema_version`
  and a stable `external_id` on every interview and every observation.
- `examples/interview-import.template.csv` — the UTF-8 header to fill in.

Rules that are enforced rather than documented:

- **Nothing is applied until the preview is confirmed.** Import validates the
  whole file, shows errors by row and field, and refuses a partial apply. A file
  with one bad row applies zero rows.
- **Ambiguity is refused, not guessed.** Money is an integer number of dong with
  no separators. A timestamp may have fractional seconds. A value that could be
  either is an error naming the field.
- **Re-importing the same `external_id` with the same content creates nothing.**
  The same id with different content is a proposed correction with its own
  revision, not a silent overwrite.
- **Limits are shown before upload:** 256 KiB and 500 observations per import.
- **Synthetic data never enters a pilot as evidence.** A record marked
  `synthetic` is refused by a pilot import, and has a legitimate path in demo and
  test. The demo fixture is synthetic by design.
- **Interview notes and source files never go into git.** The repo carries the
  schema, the template and a synthetic fixture; `interviews/real/` and
  `*.interview-notes.md` are gitignored.

## Turning evidence into a change

1. Read the observation against the current parameter. The founder area shows the
   current value and the proposed one side by side, with the evidence that
   motivates the change linked to each.
2. Write a change proposal. A proposal names what changes, from what to what, and
   which observations support it.
3. Publish (or reject) as `founder_admin`. Publishing creates a **new parameter
   version** — it never edits the published one — with the previous version
   retained and reachable for comparison and rollback.
4. Re-read §13's economics with the new parameters, and read the label on the
   result: **"KỊCH BẢN — giả định thu đủ"** is required on every simulation. The
   model does not simulate tax, collection timing, depreciation or churn, so its
   output is a scenario surplus and never a verified free cash flow or a net
   profit.

## Export

Export is permission-scoped and carries no tokens. Cells that could be read as
formulas by a spreadsheet are escaped rather than written raw. A founder's
research notes, willingness-to-pay figures and financial model do not cross into
a workspace account.

## Status

Implemented and verified in `src/founder/discovery.ts`, `src/founder/routes.ts`,
`src/ui/components/founder-screen.tsx`, `test/founder-discovery.test.ts`, and
`test/part-a-gates.test.ts`. The interview recording, immutable revisions,
observations with evidence kinds, pain tags, change proposals, config versions
with non-destructive rollback, OPC economics snapshots, contracts, pilot credits,
import-preview/apply with server-side validation, and CSV export are covered by
passing tests and live API routes.
