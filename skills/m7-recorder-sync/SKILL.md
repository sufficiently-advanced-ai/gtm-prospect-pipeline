---
name: m7-recorder-sync
description: >-
  M7 of the prospect pipeline — human-facing records: registry/digest append, progress.md,
  structured run record, decision-ledger sweep, dashboard regeneration. USE WHEN closing out
  a batch run (after M8 push).
---

# M7 · recorder-sync

**Reads** the store, this run's module reports, and the decision ledger. **Writes** the
human records under `$PIPELINE_DATA` (registry, digest, progress.md), the structured run
record (`logs/run-records.jsonl`), ledger entries, and the dashboard HTML. **Never** writes
the CRM (M8's target — same account.yaml diffs, disjoint destinations) and never touches
account state, Apollo, or sequences.

## Per batch run

1. **Registry entry** (`$PIPELINE_DATA/registry.md`): batch header with date + mode,
   per-account lines (enrolled/skipped/dropped/flagged/held with evidence one-liners),
   funnel line (pulled → new → fit → confident → contacts enrolled-paused), credit spend
   (TheirStack + Apollo + Firecrawl), lessons. Include the "awaiting go-live" line with the
   running paused total — **computed, never carried forward from the previous entry**, and
   counting ONLY contacts whose `sequence_status` is `PAUSED` AND whose `apollo_sequence_id`
   belongs to a sequence that is `status: active` in `config/sequences.yaml`. Contacts
   paused on RETIRED sequences are frozen history, never go-live candidates. This is the
   number M4 pre-flight reads to a human at the one gate that authorizes real sends
   (repeating a prior entry once reported dozens awaiting go when the true figure was one).
2. **Digest** (`digests/BATCH_<date>.md`) for scheduled runs.
3. **progress.md** append: one line per run with mode, outcome, blockers.
4. **Structured run record:** append the same facts as the prose entry via
   `node skills/m7-recorder-sync/scripts/run-record.ts --file <record.json>` (one line per
   run → `$PIPELINE_DATA/logs/run-records.jsonl`). Prose can't be trended; this can. Schema
   (validated, unknown keys rejected): `run_date` (ISO) · `mode` headless|interactive ·
   `degraded` + `degraded_reason` (required when degraded) · `signals[] {key, pulled, new}` ·
   `funnel {dropped, routed, skipped, flagged, triaged_gated, held}` ·
   `salesnav {lookups, backlog_after, flips[{domain, from, to, reason}]}` or `null` when no
   pass ran · `enrollment {accounts, contacts}` or `null` · `credits {theirstack, apollo,
   apollo_waterfall?}` · `incidents[]` · optional `notes`, `run_id`. Record the flips
   honestly — provisional route vs post-research final is the pipeline's real error metric.
   A second append under the same run key is refused; a same-day repeat run gets an
   explicit `--run-id`, never `--force` by reflex. `--report` prints the trend table, flip
   rate, and the consecutive-DEGRADED streak.
5. **Decision ledger sweep** (`node skills/m7-recorder-sync/scripts/decisions.ts`): every
   pending decision this run surfaced — a FLAG needing a ruling, a deferred enrollment, a
   policy question for the operator, a go-live batch awaiting M4 — gets `add` (kind ∈
   policy-ruling | go-live | sequence-lifecycle | re-triage | deferred-enrollment |
   data-bug | ops | relabel; one entry per decision, `--accounts` when domains are gated on
   it). Anything this run RESOLVED — the operator ruled, an account enrolled/dropped past its
   deferral — gets `resolve <id> --ruling "<verbatim>"` (rulings feed the eval-fixture
   loop; quote them exactly). M2 and M3 write the ledger directly; if a stray prose flag
   still appears anywhere, convert it to a ledger entry here — a prose line may accompany an
   entry, never replace it (prose-only "pending" lines can never be drained). Close with
   `decisions.ts report` and include its open-count line in the digest. `add` is append-safe
   from any session; `resolve` rewrites the file — one resolving session at a time.
   **Then close the flywheel:** `node evals/fixture-backlog.ts` lists every resolved
   judgment ruling (re-triage, policy-ruling, data-bug) that names an account and has no
   eval fixture yet. For each line, run the printed
   `node evals/draft-fixture.ts <domain> --task <task> --decision <id>` now — it stages the
   fixture from the account's raw captures with the ruling cited by id and quoted verbatim in
   notes. The operator finishes it (confirms the gold, names the forbidden trap, promotes it
   into `cases/`, rewrites the baseline). A ruling that never becomes a fixture is a lesson
   the next skill edit can silently undo; report the backlog count in the digest.
6. **Dashboard regeneration — LAST step, after the run-record append** (it reads
   run-records.jsonl and must include this run):
   `node skills/m7-recorder-sync/scripts/dashboard.ts --html` → terminal summary +
   `$PIPELINE_DATA/dashboard/index.html`. Reads canonical sources only (accounts/,
   run-records, decision ledger, resolver); outcome row first — replies are the metric,
   throughput is context. To serve it, run
   `node skills/m7-recorder-sync/scripts/dashboard-server.ts` (binds 127.0.0.1 only; put
   your own authenticated proxy in front). The server adds the live decision inbox:
   `GET /api/decisions` and `POST /api/resolve` — a RULINGS-ONLY write path that shells out
   to `decisions.ts resolve`; it never touches account.yaml, Apollo, or the CRM. Verdicts
   recorded there are executed by the /pipeline-batch run-start step (`decisions.ts verdicts`).

## Cadence guarantees
EVERY batch run produces a registry entry and a progress.md line — including zero-yield runs
(0 pulled or 0 new) and BLOCKED runs, which record the failure mode + credit spend. A run
that leaves progress.md untouched did not complete its contract, whatever it exited.
