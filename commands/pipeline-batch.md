---
name: pipeline-batch
description: >-
  Orchestrator for a prospect-pipeline batch run: M1→M2→M3→M8(push)→M7, autonomous end to
  end — go-live is the sole human gate. Thin by design — caps and rules live IN the modules.
---

# /pipeline-batch — one batch run

## Run-start ritual (always, before anything)
1. `node lib/conflict-scan.ts` — exit 2 = STOP, resolve queue/sync-conflicts first.
2. `node lib/store-lint.ts` — read-only store integrity check. Any ERROR (unparseable
   account.yaml, bad enum, missing signal_source/route, dangling raw pointer or citation) =
   STOP and fix before the run; WARNs are legacy tolerance — note them and continue.
3. On a scheduled host: `git pull --ff-only` in the repo first.
4. `node skills/m7-recorder-sync/scripts/decisions.ts list` — surface open decisions
   touching this run's work (blocked enrollments, pending rulings); then scan `queue/` for
   anything not yet in the ledger.
5. **Execute recorded verdicts:** `node skills/m7-recorder-sync/scripts/decisions.ts verdicts`
   — each line is an operator ruling (dashboard or CLI) the store doesn't reflect yet. Apply
   the flip per account (`setStatus()` from lib/store.ts; skip→skipped, drop→dropped,
   hold→held, qualified→routed; enroll = leave to M3's normal gates this run), quote
   `resolution.ruling` verbatim as the authority in the account's evidence trail, and
   include the touched domains in this run's M8 push. Buttons record rulings; THIS step
   executes them — never skip it, or dashboard resolutions silently do nothing. **Then
   `ack <id> --note "…"` every verdict you executed OR consciously left alone** — only the
   newest ruling per domain is pending, and an acked entry never resurfaces (without the
   ack, runs re-judge the same old verdicts by hand). A ruling about a lead with no
   account file carries `subject:` and is reported "no account file — not executable";
   never map it onto a bystander account.

## Chain
1. **M1 signal-pull** — a `BLOCKED:` report ends the run cleanly (still do step 6).
2. **M2 triage-route** — per new account, against `config/icp.md`. FLAG → the ledger
   (resolve in the research pass when the evidence is there; never guess).
3. **Sales Navigator research pass (EVERY batch)** — M2's pass, agent-driven via
   Claude-in-Chrome when a browser is reachable, view/search only (no connection requests,
   messages, or any outreach action, ever); backlog in queue/salesnav-pending.md first,
   then this run's survivors, ≤ config `limits.salesnav_lookups_per_run`; findings →
   raw/salesnav/ at observation time; routing confirmed (`SALES_NAV`) or flipped before any
   enrollment. Browser unreachable/auth-walled → one retry, then degrade: queue survivors,
   skip step 4, mark the run DEGRADED, continue to steps 5–6.
4. **M3 enrich-enroll** — respects caps; credit spend stated in the report, not gated.
   Enroll-paused only, suppression gate hard.
5. **M8 push** — `node skills/m8-crm-sync/scripts/push.ts <touched domains> --note "<batch summary>"`,
   then `node skills/m8-crm-sync/scripts/mirror-decisions.ts` (idempotent; BLOCKED-not-fail
   on CRM outage).
6. **M7 recorder-sync** — registry entry + digest (headless) + progress.md + run record +
   decision ledger sweep + dashboard.

## Human gates (never crossed by this command)
- Go-live — ONLY via m4-go-live with the operator naming the batch. The research pass is
  not a human stop.

## Profiles
- **Headless/scheduled** (`scripts/headless-batch.sh`): full chain when the browser is
  reachable via Claude-in-Chrome. Degrades automatically to M1–M2+M8+M7 (survivors queued,
  no enrollment, DEGRADED report) when the browser/extension/Sales Navigator session is
  unreachable. Block reports begin with the literal marker `BLOCKED:` — that is what the
  alerting greps; the bare word in prose must never carry the colon.
- **Interactive:** full chain, unchanged.

Every module is idempotent against the store; a mid-run failure = fix, re-invoke the module,
continue. M8 reconcile is NOT part of this chain — it runs on its own daily schedule.
