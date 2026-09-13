---
name: m3-enrich-enroll
description: >-
  M3 of the prospect pipeline — Apollo contact enrichment + PAUSED enrollment for routed
  accounts. USE WHEN accounts sit at status:routed with a confident route, within the
  per-run caps in config/sequences.yaml.
---

# M3 · enrich-enroll

**Reads** `config/sequences.yaml` (sequence ids via the resolver, caps, labels, sender,
suppression, merge fields), `config/signal.yaml` per-signal `policy`, and `accounts/` at
`status: routed`. **Writes** `raw/apollo/<domain>/` captures, contact records and
`status: enrolled-paused` into `account.yaml`, and ledger entries for deferrals. **Never**
activates a sequence, unpauses a contact, guesses an email address, or picks a sequence by
route intuition — sequence ids come from the resolver only and are hardcoded nowhere else.

## Suppression gate (HARD, before anything)

For every candidate contact/account check: the Apollo list named by `suppression.apollo_dnc_list`,
store `status: opted-out|skipped`, CRM `outreachStatus=OPTED_OUT` / person
`sequenceStatus=OPTED_OUT`, and config `suppression.never_enroll` / `never_reenroll_domains`.
Any hit → do not enroll, note why.

## Cross-sequence gate (HARD, all signals)

Never enroll a contact who is ACTIVE — or PAUSED awaiting go-live — in ANOTHER sequence, and
never enroll any contact at an account that has one: the account HOLDs at `status: routed`
with reason `SEQUENCE_CONFLICT` (ledger entry per the deferral procedure below). Check the
store first (`contacts[].apollo_sequence_id` + `sequence_status` on the account and on any
account sharing the domain); FINISHED/REPLIED/REMOVED/BOUNCED are non-blocking.
Re-enrolling a FINISHED-no-reply contact into a DIFFERENT sequence additionally needs a
30-day cool-off and a fresh suppression pass. Why: two signals can fire on the same
executive and the same req, and two sequences would land in one inbox.

## Per-signal policy gates

The account's signal block in `config/signal.yaml` may carry `policy` keys; enforce them
here, headless or not. `require_salesnav_before_route: true` → refuse to enrich or enroll
unless the account carries `verification: SALES_NAV` (normally satisfied by M2's in-run
research pass). Any other per-signal gate defined in config is enforced the same way: a
missing or expired precondition is a HOLD at `status: routed`, never a "probably fine".

## Enrichment (cap: `caps.enrichments_per_run`, 1 credit/match)

- Multi-thread by default: the operator-level buyer (CEO/COO/Founder/President) + the owner
  of the function the ICP names (`config/icp.md`).
- Credit spend is NOT a confirmation gate: state the exact credit line in the run report and
  proceed (`people_bulk_match` ≤10/call). The per-run cap still binds — read it from config,
  never from memory.
- Capture responses verbatim → `raw/apollo/<domain>/<date>-contacts.json`.
- Email-domain discipline: alternate internal domains are OK when evidence links them;
  same-named-different-company = HOLD (`status: held`); enrichment can return
  `email_status: unavailable` even for a confirmed executive — waterfall tier below, then
  single-thread or hold, NEVER fabricate or guess an address.
- **Waterfall email tier** (cap: `caps.waterfall_email_per_run`): on `email_status:
  unavailable` for a wanted contact, re-run the match with `run_waterfall_email: true`.
  Once per run, precheck `apollo_users_api_profile` with `include_waterfall_capability=true`
  — `waterfall_email_enabled: false` = skip the tier, report it. Waterfall is ASYNC: the
  response carries only a `request_id`; poll `apollo_webhook_result_show` with backoff
  (~15s, ~30s, up to ~3 min). Capture BOTH the accepted response and the polled result to
  `raw/apollo/<domain>/<date>-waterfall-*.json`. A fill is VENDOR DATA, not a guess; record
  `email_source: waterfall` + `waterfall_request_id` on the contact. Cost is VARIABLE —
  report actual spend as its own line (`credits.apollo_waterfall`). `run_waterfall_phone`
  stays OFF unless a sequence has call steps.
- Bad match (email domain ≠ company domain, no alternate-domain evidence) = drop the match —
  waterfall fills a MISSING email for a CONFIRMED person, never overrides a bad match.

## Enrollment (cap: `caps.enrollments_per_run`, ALWAYS paused)

- `emailer_campaigns_add_contact_ids` with `status:"paused"` — no exceptions
  (`enrollment.always_paused`). M4 go-live is the SOLE human gate: a raised cap buys volume,
  not autonomy. Sender = `enrollment.sender`.
- Labels: `enrollment.labels` + `<route>`.
- A second same-company contact REQUIRES `enrollment.same_company_flag: true` or Apollo
  silently skips it.
- **Target sequence comes from the resolver:** `node lib/sequence-resolver.ts <domain>`
  canonicalizes the account's `signal_source` (aliases included), matches it against each
  sequence's `binds`, and applies the `draft|active|retired` lifecycle.
  - **ENROLL** → enroll with the printed sequence id + required merge fields. Nothing else
    selects a sequence: not the route, not the name, not a prior batch's choice.
  - **HOLD** → do NOT enroll and do NOT substitute another sequence. Leave `status: routed`,
    report `<domain> — HOLD: <reason>`. Held accounts flow automatically when a successor
    sequence flips to `active` (`supersedes`) — no re-triage, no store edit.
- **Merge fields MUST be set on every contact BEFORE enrollment** — take the required set
  from the resolver's ENROLL line (derived from config `merge_fields`), never from memory.
  A missing value renders an unresolved variable in step 1. Set via `contacts_update`
  typed_custom_fields; record the value in `account.yaml` per contact.
  - Each field's `value` line in config says what it holds. The template `hiring_signal` is
    the TITLE of the posting that triggered the signal, sourced from the account's raw
    capture (`raw/theirstack/`, `raw/postings/`) — as posted, title only, no company name,
    no seniority gloss, no trailing punctuation (it renders mid-sentence). No usable title
    in the raw = HOLD the contact and report it; never enroll on a guessed value.
  - **Recording the value in `account.yaml` is not optional bookkeeping** — the store is the
    only witness the pipeline has, and `node lib/sequence-resolver.ts --audit-enrolled` is
    what reads it. A value set in Apollo but unrecorded in the store reads as a defect.
  - **A field with `renders_in_copy: true` is retroactive across the whole sequence.** Apollo
    resolves `{{variables}}` at SEND time, so adding one to live copy hard-fails every
    ALREADY-enrolled contact (`snippets_missing`). Never edit copy to add a variable without
    running `--audit-enrolled` and backfilling first; a failed contact is not revived when
    the field appears — it must be re-added PAUSED.
  - A field whose `apollo_field_id` is still a placeholder does not exist in Apollo: NO
    enrollment into a sequence that renders it (validator-enforced for `active` sequences).

## Store writes

`status: enrolled-paused`; per contact: `apollo_contact_id`, `apollo_sequence_id`,
`sequence_status: PAUSED`, `enrolled_at`, `sender_email`, `apollo_email_status`, and — when
the address came from the waterfall tier — `email_source: waterfall` + `waterfall_request_id`.
Any deferral (cap reached, no valid email, missing merge-field source, bad match, policy
gate) → keep `status: routed` and open a ledger entry:
`node skills/m7-recorder-sync/scripts/decisions.ts add --kind deferred-enrollment --accounts <domain> --title "<domain>: <why>" --body "<what unblocks it>"`
— one entry per account, resolved (`decisions.ts resolve`) by whichever run enrolls or
drops it. A prose "deferred" line alone is never acceptable.

Handoff: M8 push mirrors the account; M7 records the batch.
