# Architecture

The current contract. Every module has a contract against the local store and can run alone;
the orchestrator is thin. Read this before touching `skills/` or `lib/`.

## Code and data are split

Code lives in this git repo. Data lives at `$PIPELINE_DATA` (default
`~/Data/gtm-prospect-pipeline`), a directory of flat files: YAML, Markdown, JSON, JSONL. No
database, no git on the data side, no secrets in either tree. Secrets sit in
`~/.config/gtm-prospect-pipeline/env` (chmod 600) and modules reach the store only through
`PIPELINE_DATA`, never a relative path, so the same code runs on a scheduled host and an
interactive one.

Why flat files:

- They replicate with a file syncer (Syncthing or similar) between a headless host and a
  laptop with no push step and no server.
- They are greppable and diffable. Every question about the pipeline is `rg` over
  `accounts/`.
- The capture layer is append-only by construction: timestamped, host-suffixed filenames
  never collide.

Guardrails that come with the choice: `account.yaml` is the one conflict surface, so the
orchestrator scans for `*.sync-conflict*` files at every run start and routes hits to
`queue/`, never auto-merging; scheduled writes happen on one host and interactive sessions on
another (soft single-writer); enable file versioning on the synced folder for rollback.

## Store layout

```text
$PIPELINE_DATA/
  raw/                        CAPTURE LAYER: immutable, append-only, as received
    theirstack/<date>-pull-<n>.json          full API responses incl. job objects
    theirstack/lists/<date>-<list-id>.json   dedupe list snapshots
    apollo/<domain>/<date>-{org,people,contacts}.json
    apollo/sequences/<date>-<seqid>.json     sequence defs + per-contact step state
    firecrawl/<domain>/<date>-<slug>.{md,html}
    postings/<domain>/<date>-<slug>.md       job posting full text + URL + capture date
    salesnav/<domain>/<date>-notes[-<host>].md   browser findings, written at observation time
    twenty/<date>-export-{companies,people,notes}.jsonl   CRM exports (audits)
  accounts/<domain>/          DERIVED LAYER: always rebuildable from raw/, canonical state
    account.yaml
    evidence.md               synthesized, one citation per fact, cites raw/ paths
  queue/                      flags.md, salesnav-pending.md, decisions.jsonl, sync-conflicts/
  logs/run-records.jsonl      one structured line per run
  registry.md                 human logbook, generated from account.yaml
  progress.md                 one line per run: mode, outcome, blockers
  dashboard/index.html        generated from accounts/, run records, ledger, resolver
```

Filename convention for captures: date plus slug, with a `-<host>` suffix whenever two hosts
could plausibly capture the same object on the same day.

## account.yaml

| Field | Type | Meaning |
|---|---|---|
| `domain` | string | Primary key. Normalized apex domain; the directory name. |
| `company` | string | Display name. |
| `status` | enum | `pulled`, `triaged`, `routed`, `enriched`, `enrolled-paused`, `active`, `replied`, `finished`, `opted-out`, `skipped`, `held`, `flagged`, `dropped`. Status is permission: M3 only touches `routed`, M4 only touches `enrolled-paused`. |
| `route` | enum | `QUALIFIED`, `SKIP`, `FLAGGED`, `DROPPED`. Written by M2 once, account-level, binary. Classification only; it never selects a sequence. |
| `skip_reason` | string | Free text. Why the account is `SKIP` (the disqualifier that fired). |
| `drop_class` | string | One of the slugs under `## Drop classes` in `config/icp.md`. Required when `route: DROPPED`. |
| `classification` | string | Optional free tag from `icp.md`, if your ICP defines classification tags. Informational only; it is not a `binds` qualifier. |
| `verification` | enum | `HEADLESS_3SOURCE` (provisional, from the three named sources), `SALES_NAV` (confirmed by the browser pass), `UNVERIFIED`. |
| `signal_source` | string | The `name` of the `config/signal.yaml` block that pulled the account (or an alias). Provenance of the pull; required. |
| `evidence_note` | string | One-liner that reaches the CRM. Full evidence stays in `evidence.md`. |
| `batch` | string | Batch label the account was processed under. |
| `triaged_at` | date | When M2 classified it; reporting keys off this. |
| `raw_pointers[]` | list | Paths under `raw/` that every derived claim rests on. Store-lint fails on a dangling pointer. |
| `contacts[]` | list | Per person: `name`, `title`, `email`, `apollo_contact_id`, `apollo_sequence_id`, `sequence_status` (`NOT_ENROLLED`, `PAUSED`, `ACTIVE`, `FINISHED`, `REPLIED`, `REMOVED`, `BOUNCED`, `OPTED_OUT`, `FAILED`), `enrolled_at`, `sender_email`, `merge_fields{}` (the values M3 set on the contact). |
| `crm` | block | `twenty_company_id`, `twenty_person_ids{}`, `last_synced_at`, `sync_hash`. Written back by M8 push. |
| `m3_note` | string | Why M3 deferred, when the resolver said ENROLL and it did not. Lint warns on a silent deferral. |

`node lib/store-lint.ts` checks required fields, enum values, dangling raw pointers and
citations, and silent deferrals. ERROR stops a run; WARN is reported.

## Separation of concerns

Three kinds of module, and a module is exactly one kind:

| Kind | Reads | Writes | Never |
|---|---|---|---|
| Gathering (M1, M5 fetches, M8 reconcile-pull) | external sources | `raw/` plus minimal state flags | interprets |
| Processing (M2, M5 synthesis) | `raw/` | `accounts/` | fetches, except M2's named verification sources, each captured first |
| Mirroring (M8 push) | `accounts/` | the CRM | fetches, interprets |

Every API, scrape, or browser response is written to `raw/` verbatim before any
interpretation. The derived layer must be reproducible from `raw/`, and every derived claim
carries a raw pointer. The browser has no API, so the research pass follows a capture
protocol: findings are written to `raw/salesnav/` at observation time, never reconstructed
afterwards.

## Label-based sequence resolver

Route does not target a sequence. **Signals label accounts; sequences subscribe to labels;
lifecycle gates enrollment.**

- `config/signal.yaml` is the label catalog. A block is a label (`name`) plus, optionally, an
  acquisition recipe. Label-only blocks with no query are valid: that is how referrals, event
  lists, and browser finds enter the catalog with no code change.
- Each sequence in `config/sequences.yaml` declares one match spec,
  `binds: {signals: [...], routes?: [...]}`. Criteria are ANDed. `binds: {}` matches nothing.
  `routes` is an optional qualifier; route on its own never targets.
- `status: draft | active | retired` gates enrollment only. `active` means M3 may enroll
  paused. The sequencer's send state is a human's (M4), never inferred from config.
- A match on a non-active sequence is a HOLD at `status: routed`, never a fallback to another
  sequence. Held accounts become enrollable the moment a successor flips to `active`, with no
  re-triage and no store edit.
- `supersedes` links make activation carry retirement: if a superseder is `active`, every
  target must be `retired` in the same edit.
- The validator forbids two active sequences with overlapping match domains, so there are no
  precedence rules to remember. It also forbids an active sequence whose rendered merge field
  still has a placeholder id, and rejects alias collisions in the signal catalog.

```yaml
sequences:
  hiring-signal-v1:
    id: REPLACE-WITH-APOLLO-SEQUENCE-ID
    status: retired
    binds: { signals: [hiring-signal] }
  hiring-signal-v2:
    id: REPLACE-WITH-APOLLO-SEQUENCE-ID
    status: active
    binds: { signals: [hiring-signal], routes: [QUALIFIED] }
    supersedes: [hiring-signal-v1]
```

Commands: `node lib/sequence-resolver.ts <domain>` resolves one account to ENROLL (id plus
required merge fields) or HOLD (reason). `--validate` after any config edit. `--all` sweeps
the store read-only. `--audit-enrolled` after any copy or merge-field edit.

## Per-signal policy gates

Each signal block carries a `policy` map, read by `lib/signal-policy.ts` and enforced in both
code and skills:

| Key | Effect |
|---|---|
| `require_salesnav_before_route: true` | Accounts stop at `status: triaged` until the browser pass confirms the routing. M3 refuses to enroll anything not at `verification: SALES_NAV`. |
| `push_to_crm_after: routed \| enrolled` | When the CRM first sees this signal's accounts. `enrolled` is a holdout: no CRM presence until enrolled-paused or later. `skipped` still mirrors either way. |

## Module table

| Module | Reads | Writes | Never |
|---|---|---|---|
| M1 signal-pull | signal source APIs, `config/signal.yaml`, the store (pull-guard) | `raw/theirstack`, `raw/postings`, new `account.yaml` stubs at `status: pulled`, dedupe list | interprets; touches the CRM; overwrites an existing account |
| M2 triage-route | `raw/`, `config/icp.md`, the four named verification sources (org sweep, leadership page, posting text, browser roster) | `account.yaml` route, verification, evidence_note, raw_pointers; `queue/flags.md`; decision ledger | picks a sequence; guesses on thin evidence; name-only web search for identity |
| Browser research pass | logged-in Sales Navigator session, `queue/salesnav-pending.md` | `raw/salesnav/`, `verification: SALES_NAV` or a flipped route | any outreach action; more than `limits.salesnav_lookups_per_run` |
| M3 enrich-enroll | `status: routed` accounts, resolver output, `config/sequences.yaml` caps and suppression | `raw/apollo/<domain>/`, `contacts[]`, `status: enrolled-paused` | enrolls unpaused; touches sequence active state; guesses an email; enrolls a contact active in another sequence |
| M4 go-live | the batch a human names | sequencer contact state (unpause), `status: active`, immediate M8 push | runs headless; infers a go; uses bulk toolbar actions |
| M5 evidence-collector | `account.yaml`, `raw/postings`, `raw/apollo`, site scrapes | `raw/firecrawl/`, `evidence.md` | writes the CRM |
| M7 recorder-sync | `account.yaml` diffs, run facts | `registry.md`, `progress.md`, `logs/run-records.jsonl`, `queue/decisions.jsonl`, `dashboard/` | writes the CRM |
| M8 crm-sync | `account.yaml`; the sequencer (reconcile) | the CRM (push), `raw/apollo` then `account.yaml` (reconcile), `raw/twenty` (audit), `crm` block | triggers a send; writes the sequencer except the pre-authorized opt-out stop; interprets |

## Orchestrator

`/pipeline-batch` is a thin Claude Code command. Caps and rules live in the modules; the
orchestrator only sequences them.

Run-start ritual, always:

1. `node lib/conflict-scan.ts`. Exit 2 means sync conflicts exist: stop, resolve
   `queue/sync-conflicts/` first.
2. `node lib/store-lint.ts`. Any ERROR stops the run.
3. `node skills/m7-recorder-sync/scripts/decisions.ts list`. Surface open decisions touching
   this run; scan `queue/` for anything not yet in the ledger.
4. `node skills/m7-recorder-sync/scripts/decisions.ts verdicts`. Each line is a human ruling
   the store does not reflect yet. Apply the flip per account, quote the ruling verbatim in the
   evidence trail, include the domain in this run's push, then `ack` every verdict executed or
   consciously left alone. Buttons record rulings; this step executes them.

Chain: M1 → M2 → browser research pass → M3 → M8 push → M7. A BLOCKED report from M1 ends the
run cleanly (M7 still records it). FLAG is a queue, not a gate: the research pass resolves
entries whose evidence now suffices and leaves the rest queued. M8 reconcile is not part of
the chain; it runs on its own daily schedule while any sequence is active.

Headless profile: the full chain, enroll-paused, digest. If the browser or the Sales
Navigator session is unreachable, one retry, then degrade to M1 → M2 → M8 → M7 with the
gated survivors queued, no enrollment, and the run reported DEGRADED. Never a failed batch,
never a looser verification source. A run that exits 0 without an M7 record is treated as an
alert, not a quiet day.

Every module is idempotent against the store: a mid-run failure means fix, re-invoke the
module, continue.

## Two machine-readable logs

**Decision ledger** (`queue/decisions.jsonl`, `skills/m7-recorder-sync/scripts/decisions.ts`).
Every pending decision is a record with a kind (`policy-ruling`, `go-live`,
`sequence-lifecycle`, `re-triage`, `deferred-enrollment`, `data-bug`, `ops`, `relabel`), a
status (`open`, `blocked`, `resolved`), the accounts it gates, and, once resolved, the ruling
verbatim. Markdown queues are views; the ledger is canonical. A prose line may accompany an
entry, never replace it. Only the newest ruling per domain is ever pending; older ones report
as superseded. `add` is append-only and safe from any session; `resolve` and `ack` rewrite
the file atomically and follow the single-writer convention.

**Run record** (`logs/run-records.jsonl`, `scripts/run-record.ts`). One validated JSON line
per run: date, mode, degraded flag and reason, per-signal pulled/new counts, funnel counts,
research-pass lookups and route flips, enrollment counts, credit spend, incidents. The flip
rate (provisional route versus post-browser final) is the pipeline's real error metric. A
second append under the same run key is refused. `--report` prints the trend.

## CRM mirror contract

- The store outranks the CRM on every conflict. The CRM never triggers a send.
- Push is idempotent. A `sync_hash` over the owned fields makes a re-push a no-op when nothing
  changed. Notes, tasks, and opportunities dedupe on a deterministic title key, so a re-run
  never duplicates them; distinct events on one account use distinct titles.
- Notes are append-only.
- Drops are store-only. `status: dropped` / `route: DROPPED` is excluded from push
  unconditionally, a stale `crm` pointer never resurrects a dropped company, and audit treats
  their absence as correct. `SKIP` accounts are mirrored: a verified suppression decision is
  worth keeping.
- A CRM outage degrades gracefully: the push is queued and retried next run. CRM down never
  blocks a batch.
- Reconcile pulls sequencer state through `raw/` first, then updates `account.yaml`, then
  mirrors. UI-side edits to M8-owned fields go to `queue/` for review, never absorbed silently.
- Recovering store state from the CRM is emergency-only and lossy: the mirror carries no raw
  provenance, and its status enum is coarser than the store's.

Field map summary (store → CRM, M8-owned):

| Store | CRM |
|---|---|
| `domain` | company domain (upsert key) |
| `status` | company `outreachStatus`: routed/enriched/flagged → `PENDING_VERIFY`; enrolled-paused → `ENROLLED_PAUSED`; active → `LIVE`; replied → `REPLIED`; finished → `FINISHED`; opted-out → `OPTED_OUT`; skipped → `SKIPPED`; held → `HELD_NO_EMAIL`; pulled/triaged/dropped → not present |
| `route`, `verification`, `signal_source`, `evidence_note`, `batch` | company `route`, `verificationMethod`, `signalSource`, `evidenceNote`, `batchLabel` |
| enrichment | company industry, employee count, revenue, description, founded year, LinkedIn URL, last enriched |
| `contacts[]` | person `apolloContactId`, `apolloSequenceId`, `sequenceStatus`, `sequenceStep`, `enrolledAt`, `senderEmail`, `apolloEmailStatus` |

The mapping lives in `lib/status-map.ts`; the transport in `lib/twenty.ts`.

## System of record

| Rank | Layer | Role |
|---|---|---|
| 1 | `raw/` | Capture truth. What the source actually said, when. |
| 2 | `accounts/` | Canonical derived state. Wins every conflict. |
| 3 | CRM | Mirror and activity log. Query UI for humans. |
| 4 | Sequencer | Send layer. Ground truth for sequence step state only, and only via reconcile through `raw/`. Never the record. |
