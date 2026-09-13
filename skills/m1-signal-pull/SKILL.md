---
name: m1-signal-pull
description: >-
  M1 of the prospect pipeline — signal acquisition (TheirStack + Apollo connectors). Pull
  new companies matching each enabled signal in config/signal.yaml, capture raw payloads and
  job-posting text to the store, feed the dedupe machinery. GATHERING module: writes raw/ +
  minimal account stubs, interprets nothing. USE WHEN running a pipeline batch (invoked by
  /pipeline-batch) or pulling signal manually.
---

# M1 · signal-pull

**Reads** `config/signal.yaml` (signal blocks, `dedupe`, `limits`) and the existing
`accounts/`. **Writes** raw captures under `$PIPELINE_DATA/raw/` and, for genuinely new
domains, a minimal `accounts/<domain>/account.yaml` stub at `status: pulled`. **Never**
routes, judges fit, edits an existing account's `signal_source`, or overwrites an account
file — judgment is M2's, and a blind stub write once destroyed live accounts.

Paths are under `$PIPELINE_DATA` (env: `~/.config/gtm-prospect-pipeline/env`). Run
`node lib/conflict-scan.ts` before writing anything.

**Multi-signal:** run the procedure once per block with `enabled: true`, in file order.
Each pull stamps `signal_source` with THAT signal's `name` and tags its raw captures with the
signal key. A block with `connector: apollo` runs the Apollo procedure instead of steps 1–5;
blocks without `connector` are TheirStack. Label-only blocks (no query) are never pulled —
M2 applies those labels from evidence. Signals with `preflight_free_count: true` get a
0-credit pool check first (`blur_company_data: true`, `include_total_results: true`,
`limit: 1`) — report the total; a runaway pool (>500) is flagged, not pulled blind.

## Procedure (per enabled TheirStack signal)

1. **Credit guard.** `get_billing_credit_balance` — need ≥ `limits.credit_guard_min` credits
   PER enabled pull signal still to run this batch, or STOP with a `BLOCKED:` report.
   Connector flake = one ~60s retry, then BLOCKED. Never substitute a looser source. If
   `search_companies`/`search_jobs` are missing from the tool surface, that is structural —
   report, don't retry-loop.
2. **Dedupe payload — two legs, both mandatory.** Primary: `company_list_id_not` = the dedupe
   list in config (`dedupe.company_list_id`). Second: `company_domain_not` = the output of
   `node lib/dedupe-leg.ts` (READ-ONLY; `--json` for tier counts). It ranks the store into
   the ≤ `company_domain_not_cap` slots the API tolerates so the leg covers what the list
   does NOT: known-bug domains, then every store domain ABSENT from the newest list snapshot
   (live statuses first), then most-recently-modified fill. Never hand-build the leg as "the
   N most recent domains" — that shape leaves live accounts in neither leg and re-buys them
   every posting window (it did, mid-sequence). **Snapshot refresh (0 credits), weekly or
   when the script warns it is out of date:** `get_companies_in_list` for the dedupe list
   (`limit: 1000`) → `raw/theirstack/lists/<date>-<list-id>.json` (raw MCP shape or compact
   `{companies:[{domain,id,added_at}]}`). An old snapshot is safe — it only spends leg
   slots. NEVER exceed the config cap (billed parse failure above it).
3. **Pull.** `search_companies` with THIS signal's filters from config (the endpoint stays
   `search_companies` even for JD-regex signals — `search_jobs` bills per job). `limit` =
   `limits.pull_limit_max`, stepping 15 → 8 → 5 on timeout. Persist the response verbatim
   FIRST, then extract with `rg -o`; never read it whole.
4. **Capture (before any interpretation):** full response →
   `raw/theirstack/<date>-<signal-key>-pull-<n>.json`; per NEW company, job-posting full
   text + source URL + capture date → `raw/postings/<domain>/<date>-<slug>.md` (the richest
   capture — it feeds M2 verification and M5 evidence). CAVEAT: `search_companies` returns
   job METADATA only. When the pull lacks JD text, defer this capture to M2: after fit
   triage, per SURVIVOR run `search_jobs` (`company_domain_or: [<domain>]` + the signal's JD
   regex, `limit: 3`, 1 credit/job) → `raw/theirstack/<date>-<signal-key>-<domain>-jobs.json`
   + the postings files. Paying only for survivors beats paying for drops. **ALWAYS pass
   `limit` explicitly on EVERY `search_jobs` call, anywhere in the chain** — the default is
   25 and bills 25 (one unbounded call once cost more than a batch's whole job-text spend).
   Batched multi-domain calls: `limit = 3 × domains`, never above 15.
5. **Feed the list.** `add_companies_to_list` with ALL returned company IDs (repeats
   included) → the dedupe list. Mandatory — the list does not auto-update.
6. **Stub state — CHECK-THEN-WRITE, never blind.** BEFORE any stub write, run the guard over
   ALL pulled domains in one pass — `node lib/pull-guard.ts <domain> [<domain>...]` (stdin
   one per line also works; `--json` for structured output). READ-ONLY, the FIRST line of
   defense; act on its exit code: **0** = every domain is genuinely new; **1** = at least one
   is not — STOP and reconcile before writing anything. `EXISTS` = repeat (count it, never
   stub-write it); `EXCLUSION_BUG` = drop on sight (step 7); `INVALID` = the pull list is
   malformed. `WARN` near-miss lines (www/bare, case, subdomain, same-base-different-TLD)
   are advisory — read them before calling a domain new. **Pass the raw pull file too:
   `node lib/pull-guard.ts --pull raw/theirstack/<date>-<signal-key>-pull-<n>.json`** — the
   guard compares each row's LinkedIn slug and ATS tenant against every stored domain and
   prints `ALIAS? …` for a rebrand or sibling brand under a NEW domain + NEW company id (a
   class neither dedupe leg can see). Treat `ALIAS?` like an exclusion-bug domain: never a
   separate account — file the posting under the owning account and add the alias to
   `dedupe.exclusion_bug_domains`.
   Then, per cleared domain, create `accounts/<domain>/account.yaml` with only
   `{domain, company, status: pulled, signal_source, linkedin_url, raw_pointers: [...]}`
   (`linkedin_url` from the pull row — it feeds the alias guard); `signal_source` = the
   signal's config `name`. No routing, no judgment. Stub writes go through
   `createAccountStub()` from `lib/store.ts`, which refuses to overwrite and returns
   `false` — count those as repeats. That refusal is the LAST line of defense, not a
   substitute for the guard; a `false` after a clean guard run means the store changed under
   you — stop. NEVER write an account file (script, heredoc, editor) without confirming it
   does not exist: the source calling a domain "new" is NOT evidence (a vendor dedupe once
   returned already-active domains despite full exclusions, and a blind write destroyed
   mid-sequence accounts whose raw provenance was never recovered). A count mismatch between
   "pulled" and "new + repeats" is the tell.
   A domain already in `accounts/` under ANOTHER signal stays with it — **the first signal
   to CREATE the account owns it**; cross-signal reassignment is a human re-triage.
7. **Known-bug domains** (`dedupe.exclusion_bug_domains` + anything already in `accounts/`):
   drop on sight, no re-verification, count as repeats.
8. **Zero new companies** = the signal may be exhausted OR dedupe was partial — say which (a
   half-exclusion pull proves nothing about exhaustion). Report and stop.

## Merge-dedupe mode (per-signal `dedupe_mode: merge`)

A block with `dedupe_mode: merge` deliberately RE-PULLS known domains — for a signal whose
meaning is "this account is still posting / has aged into a window", repeats are the work
cohort. Two deviations, everything else unchanged:

- **Cadence gate:** with `cadence: weekly`, the BILLED pull runs at most once per 7 days —
  if the newest `raw/theirstack/*-<signal-key>-pull-1.json` is younger, run the 0-credit
  preflight, report the count, and record "cadence-skipped" (a re-pull inside the window
  re-bills rows already held for no new information).
- **Step 2:** NO `company_list_id_not` leg. The client-side leg =
  `node lib/dedupe-leg.ts --mode merge --signal-key <key>`: known-bug domains, every
  account already seen in this signal's pulls (terminal statuses first — they can never
  become work items), and accounts whose `dedupe.merge_verified_field` is inside
  `merge_verified_window_days`. The leg is REQUIRED — pull-guard is the correctness
  backstop, the leg is the cost control, both run. Step 5 still runs: the list must stay
  complete for every OTHER signal.
- **Step 6:** pull-guard still runs first, but `EXISTS` is a WORK ITEM: append the new raw
  pointers to the EXISTING account (never `createAccountStub()`, never touch
  `signal_source`) and set a `pending-verification` flag ONLY on accounts in pre-enrollment
  states (triaged/routed/held/flagged). Never flag mid-sequence, skipped, opted-out, or
  dropped accounts — a live enrollment must not acquire a re-check from an intake pull, and
  a suppressed verdict is not reopened by a repost. Raw pointers append unconditionally.

Window math: `posted_at_gte = today − posted_at_max_age_days`, `posted_at_lte = today −
posted_at_min_age_days`, recomputed at pull time. NEVER filter on `is_closed` (non-functional
— openness is M2's, at verification time).

## Apollo connector (per enabled `connector: apollo` signal)

Steps 6–8 apply UNCHANGED — they are the real, connector-agnostic dedupe. Steps 1–5 become:

- **Credit guard:** `apollo_usage_stats_credit_usage_stats` — a search costs 1 credit when
  it returns results, 0 on a miss, so the TheirStack "min × signals" arithmetic does not
  apply. Flake = one ~60s retry then BLOCKED.
- **Pull:** `apollo_mixed_companies_search` with the block's `apollo_query` —
  `q_organization_job_titles` from `job_title_keywords`, `organization_job_posted_at_range`
  computed from `posted_within_days` at pull time. There is NO server-side seen-list: dedupe
  is store-side only (step 6); expect repeats, count them honestly.
- **Capture:** full response → `raw/apollo/pulls/<date>-<signal-key>-search-<n>.json` BEFORE
  reading either bucket — `organizations` and `accounts` carry different id/domain fields.
- **JD text (per SURVIVOR, deferred to M2):** `apollo_organizations_job_postings` →
  `raw/apollo/<domain>/<date>-job-postings.json` + `raw/postings/<domain>/<date>-<slug>.md`.
- **No list-feed:** Apollo results carry no TheirStack ids. The store is the cross-connector
  dedupe; the `company_domain_not` leg draws from `accounts/`, so Apollo-sourced domains
  enter TheirStack exclusion naturally.

## Output
Report the funnel line (pulled → new → handoff to M2) and credit spend PER CONNECTOR to the
orchestrator — M7 writes the run record; M1 writes only raw/ + stubs.
