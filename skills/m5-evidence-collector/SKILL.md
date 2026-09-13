---
name: m5-evidence-collector
description: >-
  M5 of the prospect pipeline — per-account deep evidence gathering + synthesis into
  evidence.md (one citation per fact). USE WHEN an account needs deep evidence for
  qualification or reply/call prep, or in backfill mode for already-enrolled accounts.
---

# M5 · evidence-collector

**Reads** the account's existing raw captures and `config/icp.md` (what counts as fit, what
disqualifies, what an "angle" is for your offer). **Writes** new captures to `raw/` and a
synthesized `accounts/<domain>/evidence.md` + `evidence:` flag in `account.yaml`. **Never**
mixes the two phases: GATHER writes raw/ only; SYNTHESIZE reads raw/, writes evidence.md,
fetches nothing. Run `node lib/conflict-scan.ts` before any store write (exit 2 = stop).

## Gather (per account)

Inputs already present: posting text (`raw/postings/<domain>/`), Apollo org + people
(`raw/apollo/<domain>/`). Add:
- Firecrawl: site home, /about|/team|/leadership, /careers, recent press → EVERY response
  verbatim to `raw/firecrawl/<domain>/<date>-<slug>.md` — including search-result payloads
  and 404/error responses (an error page is still a capture; it documents why fallback was
  taken). Leadership pages 404 often; fall back to Firecrawl search + press.
- Optional: Sales Navigator findings if M2's research pass captured them (`raw/salesnav/`).

**Backfill mode** (already-enrolled accounts with no persisted posting): re-hunt via Firecrawl
search `"<company>" "<title>" job` — job-board mirrors usually still carry the text.
Priority: accounts active in sequences, strongest evidence first.

## Synthesize

`evidence.md` sections: Company (identity, vertical, size, ownership) · Leadership map (who
owns the function you sell into; the disqualifier evidence per `config/icp.md`, if any) ·
The signal (posting title, the language that triggered it, what it implies) · Posture
(tools in stack, adoption signals for whatever your offer addresses) · Angles (raw
observations for reply/call prep, NOT play cards). EVERY claim ends with a citation **and an
evidence class**: `[raw/... <date> · fact|inference|hypothesis]` — fact = directly observed
in the source; inference = what the observation suggests; hypothesis = plausible but needs
the company to confirm. Never promote a class upward during synthesis. Add `· sensitive` to
any claim that could feel invasive, accusatory, or embarrassing if echoed back to the company
(anything quoting evidence to a prospect keys off both markers).
**Angles must ground at least one specific, recognizable instance** of the problem the ICP
describes — the workflow, who runs it, its current failure mode, and a measurable pilot
metric candidate. Categories don't count. No groundable instance = `evidence: thin`.
Cheap-model extraction is fine; no claim without a pointer, no padding — thin raw = short
evidence.md, flagged `evidence: thin` in account.yaml.

## Store writes

account.yaml: `evidence: ready` if evidence is solid; thin evidence → `evidence: thin` +
what's missing (upgrade to ready only if a later gather pass fills the gap). Always update
`raw_pointers`; optionally `tech_stack` / `hiring_signals` (mirrored to the CRM by M8).
Then M8 push.
