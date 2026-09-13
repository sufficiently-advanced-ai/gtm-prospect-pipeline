---
name: m4-go-live
description: >-
  M4 of the prospect pipeline — HUMAN-ONLY activation. Unpause exactly the batch the
  operator names, confirm counts back. USE WHEN the operator explicitly says to make a named
  batch live. NEVER run headless, NEVER infer a "go".
---

# M4 · go-live

**Reads** `config/sequences.yaml` caps and the named batch's accounts. **Writes** contact
resume state in Apollo, `status: active` in the store, and an M8 push. **Never** runs
without an explicit human "go" naming the batch, never infers one from a schedule, a
dashboard, or a ledger entry, and never touches contacts outside the named batch.

## Pre-flight

1. Restate exactly what will be unpaused: sequence(s), contact count, sender, mailbox caps.
   **Read the caps from `config/sequences.yaml` `caps.*` at run time — never quote a number
   from this file or from memory** (the cap moves; an outdated figure here is a wrong number
   read to a human at the one gate that authorizes real sends). Get confirmation.
2. Suppression re-check on the batch (same gate as M3). Any per-signal `policy` in
   `config/signal.yaml` that requires re-verification before send is re-run here, per
   account, with the finding captured to raw/; a failed re-check pulls the account from the
   batch (re-route per M2), never a "probably still fine" — step 1 copy makes a first-party
   claim to the one person who knows instantly if it is wrong.
3. **Mailbox budget:** check current-day sent counts before unpausing — remaining capacity =
   `caps.mailbox_daily` − sent (and `caps.mailbox_hourly`). The hourly cap with
   `mailbox_delay_seconds` is usually the binding one, so a full batch rolls into following
   days; the "go" statement must reflect the real send timeline, not imply same-day delivery.

## Go

- **NEVER use Apollo's BULK contact actions (the toolbar Resume/Pause above the contact
  list). They do NOT honour the selection** — a verified partial selection with a confirm
  dialog reading "selected contacts" once resumed every contact in the sequence, including
  held ones, and one email went out before it was caught. Use the PER-ROW `...` menu →
  "Resume Sequence now" / "Pause Sequence", which respects the single contact.
- **Get contacts that must not send OUT of the sequence before activating it**
  (`apollo_emailer_campaigns_remove_or_stop_contact_ids`, mode `remove`). That makes the
  whole class of bulk-action mistakes harmless; they are re-addable PAUSED later. Tiptoeing
  around a live hazard is not a control.
- **`unique_delivered` is EVENTUALLY CONSISTENT.** Never clear an incident, and never tell
  the operator "nothing sent", on a single immediate read — re-query several minutes later.
- Two independent gates: a contact sends only if the SEQUENCE is active AND the CONTACT is
  active. Activating a sequence does not disturb contact-level pause state; **deactivating
  it re-pauses every contact**, so contact states cannot be staged across a
  deactivate/reactivate.
- Unpause exactly the named contacts. Nothing else.
- Store: account `status: active`, contacts `sequence_status: ACTIVE`, note the go-live date.
- M8 push immediately (mirrors `outreachStatus: LIVE`) + a "Sequence live" note per company
  (`push.ts <domains> --note`).
- Confirm counts back to the operator: per sequence, activated / still paused / excluded + why.

## Watch items after any go
Bounce rate >3% = stop and re-verify. First replies route through M8 reconcile (opportunity
on interest, opt-out procedure on unsubscribe).
