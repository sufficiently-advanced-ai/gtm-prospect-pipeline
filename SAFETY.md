# Safety

Every rule here was paid for in a real run, or written to keep one from being paid for. Each
entry gives the rule, the mechanism that enforces it, and the incident behind it where one
exists. Incidents are anonymized: no companies, people, or dates.

Rules live in scripts and config keys. Prose is documentation of the mechanism, not the
mechanism.

## Sending

**Human-only go-live.** Nothing sends until a human names a batch and runs `/m4-go-live`.
Mechanism: M4 is a skill that refuses to run headless or to infer a "go" from context; the
orchestrator has no unpause step; `scripts/headless-batch.sh` never invokes M4.

**Enroll paused, everywhere.** Every enrollment lands in the sequencer with status paused.
Mechanism: `enrollment.always_paused: true` in `config/sequences.yaml`; M3 has no unpaused
code path. Two independent gates protect a contact: the sequence must be active AND the
contact must be active. Deactivating a sequence re-pauses every contact, so contact states
cannot be staged across a deactivate/reactivate.

**Suppression before every enrollment.** Check the opt-out list in the sequencer, the CRM
opt-out statuses, and the store's `opted-out`/`skipped` statuses before any enrollment. Never
re-enroll. Mechanism: `suppression.apollo_dnc_list`, `suppression.never_enroll`,
`suppression.never_reenroll_domains` in `config/sequences.yaml`, checked by M3 as a hard gate.
Opt-outs are honored instantly: stop in the sequencer, `status: opted-out` in the store,
opt-out in the CRM, note on both.

**Never enroll a contact active in another sequence.** Mechanism: M3 cross-sequence gate;
account-level HOLD reason `SEQUENCE_CONFLICT`.

**Caps in config, never in memory.** The mailbox daily and hourly caps, enrichments and
enrollments per run, and the research-pass lookup cap are read from `config/sequences.yaml`
and `config/signal.yaml` at run time. Mechanism: no skill or script restates a number; M4
pre-flight computes remaining capacity from the config cap minus today's sent count.
Incident: the daily cap was changed three times in one month; a skill file that quoted the
old number would have authorized sends past the new one.

**Never use the sequencer's bulk resume/pause toolbar.** Use per-row actions only. Mechanism:
M4 procedure. Incident: a verified selection of 9 of 17 contacts, with the toolbar reading
"9 selected" and a confirm dialog naming "selected contacts", resumed all 17. The sequence was
live for about thirty seconds and dispatched one email, to a contact on go-live hold whose
premise had been falsified that morning. Corollary: remove contacts that must not send
from the sequence before activating it; they can be re-added paused later. Tiptoeing around
a live hazard is not a control.

**Delivered counts are eventually consistent.** Never clear an incident, and never report
"nothing sent", on a single immediate read of the sequencer's delivered count. Re-query
several minutes later. Incident: the immediate read after the bulk-toolbar incident returned
zero delivered when the true figure was one.

## The store

**Capture-first.** Every API, scrape, or browser response is written verbatim to `raw/`
before anything interprets it. Mechanism: gathering modules write `raw/` and nothing else;
processing modules read `raw/` and never fetch; `lib/store-lint.ts` fails on a
`raw_pointers` entry or an `evidence.md` citation that does not resolve to a file.

**Check-then-write.** Never create an `account.yaml` without confirming it does not exist.
A source calling a domain "new" is not evidence. Mechanism: `lib/pull-guard.ts` checks every
returned domain against the store (normalized domain plus alias keys) before a single write;
`createAccountStub()` in `lib/store.ts` refuses to overwrite. Incident: a signal source's
server-side dedupe returned three domains that were already live in the store, two of them
mid-sequence. The stub write was blind and destroyed all three. Outreach state was rebuilt
from the CRM mirror; `raw_pointers` could not be, because the mirror carries no provenance.
One account's provenance is permanently gone. The same run showed that a silent-success run
was indistinguishable from a quiet day, so the headless wrapper now alerts on a run that
exits 0 with no M7 record.

**Store outranks CRM.** The flat-file store is canonical; the CRM is a mirror; the CRM never
triggers a send. Recovering store state from the CRM is emergency-only and lossy: no raw
provenance, and a coarser status enum. Mechanism: M8 push reads `accounts/` and writes the
CRM, never the reverse; reconcile pulls sequencer state through `raw/` first; UI-side edits to
owned fields go to `queue/` for review, never absorbed.

**Conflict-scan before any store write.** Mechanism: `node lib/conflict-scan.ts` is step one
of the run-start ritual; exit 2 stops the run until `queue/sync-conflicts/` is resolved.
Sync conflicts are never auto-merged.

**Connector flake = one retry, then BLOCKED.** A connector that fails gets one retry after
about 60 seconds, then a BLOCKED report that ends the module cleanly. Never a looser source,
never a guess, never a failed batch. Mechanism: every gathering module and M8 share the rule;
the browser pass degrades the run to DEGRADED with survivors queued and no enrollment.

## Spend

**The dedupe leg comes from `lib/dedupe-leg.ts`, never hand-built.** The signal source's
domain-exclusion leg is a ranked list that covers what the server-side dedupe list does not:
store domains absent from the list first, live statuses first, capped at
`dedupe.company_domain_not_cap`. Mechanism: M1 runs the script; the script is read-only
against the store. Incident: a hand-built "most recent domains" leg re-bought dozens of
known accounts in two weeks, most of them mid-sequence, because recency is not the same as
"not already excluded".

**Every job-search call passes `limit` explicitly.** The default bills for 25 results.
Mechanism: M1 procedure plus `limits.pull_limit_max` in `config/signal.yaml`; a 0-credit
preflight count runs before any billed pull when `preflight_free_count: true`.

**Credit guard.** M1 refuses to pull when the source's balance is below
`limits.credit_guard_min` per enabled signal. Spend is reported in every run record, not
gated per run.

**Feed the dedupe list after every pull.** The server-side list does not update itself.
Mechanism: `dedupe.feed_list_after_every_pull: true`.

## Sequence copy

**Copy is retroactive.** The sequencer resolves `{{merge_fields}}` at send time, so adding a
variable to live copy hard-fails every contact already enrolled, and a failed contact is never
revived by the field appearing later; it must be re-added paused. Mechanism:
`node lib/sequence-resolver.ts --audit-enrolled` after any copy or `merge_fields` edit and on
every M8 reconcile; `renders_in_copy: true` fields are send-blocking when unset; the validator
refuses an active sequence whose rendered field still has a placeholder id. Incident: a
merge field added to live copy stranded roughly forty enrolled contacts with a
missing-snippet failure, unnoticed for days.

## LinkedIn

**View and search only.** The browser research pass may search Sales Navigator and read
rosters as page text. It never sends connection requests, messages, or InMail, never follows,
reacts, or posts. Mechanism: the pass is a skill step with no outreach actions; connection
automation is not shipped in this repo (see `docs/decisions/0009`).

**Caps and pacing.** At most `limits.salesnav_lookups_per_run` account lookups per run, with
human-like pacing; overflow waits in `queue/salesnav-pending.md` for the next run.

**Restriction warning = stop.** Any restriction warning, challenge, or auth wall stops all
LinkedIn actions for the run and reports. Never retry through it, never rotate identity, never
open a second account.

**Terms of service.** Automating a browser against LinkedIn, even view-only, may violate its
terms and can get an account restricted. This repo ships the pass as optional and off unless a
logged-in browser is reachable. The operator owns that risk.

## Evals

**Judgment edits are gated.** `bash scripts/check-evals.sh` runs before any edit to
`skills/*/SKILL.md`, `config/icp.md`, `config/signal.yaml`, or `config/sequences.yaml` lands.
It costs nothing (replayed responses, no model calls) and exits 1 until the fixtures and the
skill text agree. A fixture that must change follows the procedure in
`evals/fixtures/SCHEMA.md`, with the ruling that changed it quoted in the fixture.

## Deliverability

Not a mechanism in this repo, but the rules the pipeline ran under:

- Warm up any new sending domain before it carries cold volume. Keep the daily cap low while
  it warms, and raise it in `config/sequences.yaml`, not in your head.
- Run an inbox-placement test before the first batch and after any DNS or tracking change.
  Pick a placement threshold in advance; below it, freeze cold sends (every sequence
  inactive, M4 unpauses nothing) until the cause is found and the test clears.
- Keep open and click tracking off if it hurts placement. A tracked link on a shared tracking
  domain is a reputation you do not control.
- Publish SPF, DKIM, and a single DMARC record. Duplicate DMARC records are treated as none.
- Pre-fix statistics are not copy signal. Do not judge sequence copy on replies collected while
  placement was broken.
