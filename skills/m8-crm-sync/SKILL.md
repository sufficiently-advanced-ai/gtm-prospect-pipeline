---
name: m8-crm-sync
description: >-
  M8 of the prospect pipeline — Twenty CRM mirror + reconcile (push / mirror-decisions /
  reconcile / audit). USE WHEN a batch/module changed account.yaml state (push), on the
  daily reconcile schedule while sequences are active (reconcile), or weekly (audit).
---

# M8 · crm-sync

**Reads** `accounts/`, the decision ledger, and Apollo contact state (reconcile only).
**Writes** the Twenty CRM (companies, people, notes, tasks, opportunities) and, on
reconcile, store status updates. **Never** activates/deactivates sequences, unpauses
contacts, or lets the CRM trigger a send. Base URL + key from
`~/.config/gtm-prospect-pipeline/env` (`TWENTY_BASE_URL`, `TWENTY_API_KEY`). The store
outranks the CRM on conflict. A CRM outage never blocks a batch — queue the push, retry next
run. Scripts run with `node` (24+) from the repo root.

## push — mirror accounts/ → Twenty

```
node skills/m8-crm-sync/scripts/push.ts <domain>... | --all [--dry-run] [--note "text"]
```
Idempotent (syncHash no-op). Upserts company by stored `crm.twenty_company_id` → domain
filter → create; people by `apolloContactId`. Writes CRM ids back into account.yaml. Run
after M2/M3/M5 touch accounts and at M4 go-live (with `--note`; `--all --note` is refused —
notes are append-only). Drops are STORE-ONLY: `status: dropped` / `route: DROPPED` is
excluded from push unconditionally — even with a leftover crm pointer — and tallied as
`dropped-excluded`. `SKIP` stays mirrored (a verified suppression decision belongs in the
CRM). Signals with `policy.push_to_crm_after: enrolled` are held out of the CRM until
`enrolled-paused` or later (`lib/signal-policy.ts`).

## mirror-decisions — open ledger decisions → Twenty tasks (per batch, after push)

```
node skills/m8-crm-sync/scripts/mirror-decisions.ts [--dry-run]
```
Reads `queue/decisions.jsonl` (canonical — this script never writes it). Open|blocked
decision with ≥1 CRM-mirrored account → ONE task titled `Decision: <id>` (the dedupe key)
targeting every account with a `crm.twenty_company_id`; resolved decision with a TODO task
→ DONE. Policy/ops decisions with no CRM-visible account are NOT mirrored (tasks need a
target) — the dashboard carries them. Idempotent; CRM outage = BLOCKED queue entry.

## remove-dropped — delete stray drops from Twenty (maintenance)

```
node skills/m8-crm-sync/scripts/remove-dropped.ts [--dry-run]
```
Audit-logs to `raw/twenty-maintenance/` first, refuses companies with attached
people/opportunities or a mismatched domain (flags to queue/), verifies each delete
(re-GET → 404), then clears the orphaned `crm:` block in account.yaml (`crm_removed: <date>`).

## reconcile — Apollo drift → store → Twenty (daily while live)

1. GATHER (agent, MCP): page `apollo_contacts_search` for enrolled contacts → capture
   verbatim to `raw/apollo/_exports/<date>-contacts-p<n>.json` BEFORE interpretation.
2. DIFF: compare `contact_campaign_statuses` against account.yaml → build plan.json (shape
   in the `scripts/apply-plan.ts` header).
   - interest reply → account `status: replied` + opportunity (stage NEW) + respond-task +
     note with the reply pasted verbatim
   - unsubscribe/negative → **opt-out procedure (the one pre-authorized Apollo write):**
     (a) `apollo_emailer_campaigns_remove_or_stop_contact_ids` `mode:"stop"` with a
     stop_reason quoting the request/date; add to `suppression.apollo_dnc_list`;
     (b) plan.json: status opted-out, note on company + person. The formal
     `email_unsubscribed` flag isn't API-settable — task the operator to set it in the
     Apollo UI.
   - finishes/bounces → contact `sequence_status` updates.
3. APPLY: `node skills/m8-crm-sync/scripts/apply-plan.ts <plan.json>` — store first, then
   mirror, then notes/tasks/opportunities.
4. AUDIT MERGE FIELDS: `node lib/sequence-resolver.ts --audit-enrolled` (exit 1 = blocking).
   Catches enrolled contacts whose sequence copy renders a merge field the store has no
   value for — adding a `{{variable}}` to live copy retroactively hard-fails every enrolled
   contact (`snippets_missing`), and it once went unnoticed for days. The STORE is the only
   witness, so a BLOCKING line means "account.yaml cannot vouch for this", NOT "Apollo is
   missing it" — confirm per contact with `apollo_contacts_search` before backfilling, or
   you may overwrite a good value. Report blocking counts; never silently clear them.

## audit — weekly

```
node skills/m8-crm-sync/scripts/export.ts     # full CRM export → raw/twenty/
node skills/m8-crm-sync/scripts/audit.ts      # three-way drift report → queue/
```
UI-side edits to M8-owned fields land in queue/ for a human call — never silently absorbed
or clobbered. Schema changes only via `scripts/schema-extend.ts` (idempotent; adds the
route SELECT values QUALIFIED, SKIP, FLAGGED).

## Hard rules
Never activate/deactivate sequences or unpause contacts. The only pre-authorized Apollo
writes are the opt-out stops. Notes are append-only. One ~60s retry on transport flake,
then BLOCKED report.

## Known scope gaps
- Deleting a contact from account.yaml does NOT detach the person in Twenty, and its entry
  stays in `twenty_person_ids` (deliberate: the mirror never deletes). Handle removals as
  status changes (REMOVED/OPTED_OUT), not deletions.
- A company/person deleted in the Twenty UI is recreated by the next push (404 → find →
  create). If a UI-side delete was intentional, adjust the account in the STORE. (Exception:
  dropped accounts — push never touches them, so their absence sticks.)
