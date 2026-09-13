#!/bin/bash
# Daily headless pipeline batch — the FULL CHAIN on a scheduled host with a logged-in browser:
# M1 signal-pull → M2 triage-route → the M2 browser research pass via Claude-in-Chrome
# (Sales Navigator, view/search ONLY; the ban on any LinkedIn OUTREACH action is absolute)
# → M3 enrich + enroll-paused → M8 push → M7 records. M4 go-live is the SOLE human gate:
# everything still enrolls with Apollo status "paused"; the operator validates a batch by
# activating it.
#
# DEGRADE PATH: browser/extension unreachable or a Sales Nav auth wall is a connector flake —
# one retry, then fall back to M1–M2 + M8 + M7 (survivors queued in queue/salesnav-pending.md,
# NO research pass, NO enrollment) and say DEGRADED. Never a failed batch, never a looser
# verification source.
#
# ALERTS are an optional hook: set ALERT_CMD (in the env file or the environment) to a command
# that reads the message on stdin — e.g. a chat webhook CLI, `mail -s pipeline you@…`, or a
# script — and every alert is piped to it. Unset, alerts are echoed into the log only.
# Alerts fire on hits (accounts that entered or advanced within the in-play set this run),
# DEGRADED runs, DEGRADED STREAKS (≥2 in a row), failures, and BLOCKED reports. Quiet on
# zero-yield runs.
#
# Schedule it with cron/launchd/systemd on the host that has the browser; the prompt below
# is what `claude -p` executes.
set -uo pipefail

export PATH="/opt/homebrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
ENV_FILE="$HOME/.config/gtm-prospect-pipeline/env"
if [ -f "$ENV_FILE" ]; then set -a; source "$ENV_FILE"; set +a; fi
: "${PIPELINE_DATA:?PIPELINE_DATA must be set (env file: $ENV_FILE)}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGDIR="$PIPELINE_DATA/logs"
mkdir -p "$LOGDIR"
TODAY=$(date +%Y-%m-%d)
LOG="$LOGDIR/headless-batch-$TODAY.log"
ALERT_SUBJECT="gtm-prospect-pipeline daily batch"

alert() {
  if [ -n "${ALERT_CMD:-}" ]; then
    printf '%s\n' "$1" | ALERT_SUBJECT="$ALERT_SUBJECT" bash -c "$ALERT_CMD" || echo "alert hook failed (ALERT_CMD exited non-zero)"
  fi
  printf 'ALERT: %s\n' "$1"
}

{
  echo "=== headless batch start $(date -u +%FT%TZ) on $(hostname -s) ==="
  cd "$REPO" || { alert "FAILED: repo missing at $REPO"; exit 1; }
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git remote get-url origin >/dev/null 2>&1; then
    git pull --ff-only || alert "WARNING: git pull failed — ran on unrefreshed code"
  fi

  SALESNAV_CAP=$(awk '/^ *salesnav_lookups_per_run:/{print $2; exit}' "$REPO/config/signal.yaml")
  SALESNAV_CAP=${SALESNAV_CAP:-25}

  run_claude() {
    # --chrome is required: -p runs do NOT auto-attach the Claude-in-Chrome extension even
    # when paired. Without it the browser tools never load and every run degrades. If the
    # extension is truly unreachable the tools are absent and the prompt's DEGRADE path
    # takes over — the flag itself never fails the run.
    # BG_WAIT_CEILING=0: print mode kills still-running background tasks after a timeout and
    # exits — a backgrounded research pass once died mid-flight and never reached M3. The
    # prompt also forbids backgrounding the pass; this is the backstop.
    # The pass runs one SEQUENTIAL SUBAGENT PER ACCOUNT: a synchronous subagent is not a
    # background task, and a fresh context per account keeps one session from accumulating
    # every company's page reads. The sequential/one-tab pacing rule is what matters.
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 \
    claude -p --chrome --dangerously-skip-permissions \
      "Run /pipeline-batch in the HEADLESS/SCHEDULED profile — FULL CHAIN: run-start ritual (conflict-scan, store-lint, open-decisions check, EXECUTE recorded verdicts per decisions.ts verdicts, queue check), M1 signal-pull, M2 triage-route, then the M2 browser research pass via Claude-in-Chrome, run as ONE SEQUENTIAL SUBAGENT PER ACCOUNT (fresh context each, one at a time, one tab — never in parallel, never backgrounded; each subagent writes its own raw/salesnav notes and returns only a structured verdict) (view/search ONLY — no connection requests, messages, InMail, follows, or any outreach action, ever; work the queue/salesnav-pending.md backlog first, then this run's survivors; at most $SALESNAV_CAP lookups (config/signal.yaml limits.salesnav_lookups_per_run) with human-like pacing; READ WITH get_page_text — screenshots only to locate something you must click, never to read a roster; findings to raw/salesnav/<domain>/<date>-notes.md at observation time; overflow stays queued), then M3 enrich-enroll (suppression gate hard, sequence from lib/sequence-resolver.ts, enroll Apollo status:'paused' ONLY — never activate a sequence, never unpause a contact), M8 push for touched domains, M7 records (registry entry + digest + progress.md + run-record). If Claude-in-Chrome is unreachable, tab operations error out, or Sales Nav shows an auth wall: one retry, then DEGRADE — skip the pass and ALL enrollment, queue survivors to queue/salesnav-pending.md, include the word DEGRADED in your output, and still run M8+M7. A BLOCKED M1 report ends the run cleanly (still record via M7). When you
report a block, write it as a line whose FIRST word is the literal marker \`BLOCKED:\` followed by
the reason (connector down after its retry, credits exhausted, etc). That colon-suffixed marker is
what the alerting greps for — the bare word BLOCKED in ordinary prose (e.g. a signal's rollout gate
being 'still BLOCKED') must NEVER carry the marker, because it is not a blocked run."
  }

  # M7 appends exactly one progress.md record per run — including BLOCKED runs. So a run
  # that leaves progress.md untouched did NOT complete its contract, whatever it exited.
  # That is the no-op tell (see the alert block below).
  progress_lines() {
    if [ -f "$PIPELINE_DATA/progress.md" ]; then wc -l < "$PIPELINE_DATA/progress.md" | tr -d ' '; else echo 0; fi
  }
  PROGRESS_BEFORE=$(progress_lines)

  # Snapshot the in-play set BEFORE the run so hits are a set difference, not a timestamp
  # query. Filtering on an optional field like `triaged_at: <today>` misses every account
  # whose module contract never required the field; detection must not depend on optional
  # fields.
  #
  # The set members are domain<TAB>status PAIRS, not bare domains. Under the full chain an
  # account can be pulled, triaged, routed AND enrolled inside one run: with bare domains it
  # would either never appear in the after-set (it left triaged|routed) or, if it was already
  # in-play from a previous night's backlog, produce no addition at all — `comm -13` only ever
  # shows additions. A status transition mints a new pair, so triaged→enrolled-paused and
  # drained backlog accounts both register as hits.
  in_play_set() {
    for f in "$PIPELINE_DATA"/accounts/*/account.yaml; do
      [ -f "$f" ] || continue
      acct_st=$(awk '/^status:/{print $2; exit}' "$f")      # not `status` — read-only in zsh
      case "$acct_st" in
        triaged|routed|enriched|enrolled-paused|held)
          printf '%s\t%s\n' "$(awk '/^domain:/{print $2; exit}' "$f")" "$acct_st" ;;
      esac
    done | sort
  }
  IN_PLAY_BEFORE=$(in_play_set)

  # claude auth can flake when concurrent processes share one OAuth token. Only retry that
  # specific failure mode — a fast, no-op auth rejection — never a run that got partway
  # through, to avoid duplicate M7 records.
  CLAUDE_OUTPUT=$(run_claude 2>&1)
  CLAUDE_EXIT=$?
  printf '%s\n' "$CLAUDE_OUTPUT"

  if [ "$CLAUDE_EXIT" -ne 0 ] && printf '%s' "$CLAUDE_OUTPUT" | grep -qi "OAuth session expired\|Failed to authenticate"; then
    echo "auth failure on first attempt — retrying once after 60s (connector-flake convention)"
    sleep 60
    CLAUDE_OUTPUT=$(run_claude 2>&1)
    CLAUDE_EXIT=$?
    printf '%s\n' "$CLAUDE_OUTPUT"
  fi

  # Hit detection is deterministic — scan the store, don't trust the run's own summary.
  # A hit = a domain<TAB>status pair present AFTER the run but not BEFORE it: either the domain
  # entered the in-play set, or it advanced within it (triaged = parked for the research gate,
  # routed = classified, held = resolver HOLD, enrolled-paused = in a sequence awaiting M4).
  # Set difference, so it survives contract drift; dropped/skipped/flagged never enter the set.
  # Route-agnostic — route never selects a sequence (config binds do).
  HITS=""
  ENROLLED_COUNT=0
  PENDING_COUNT=0
  while IFS=$'\t' read -r domain acct_status; do
    [ -n "$domain" ] || continue
    f="$PIPELINE_DATA/accounts/$domain/account.yaml"
    [ -f "$f" ] || continue
    route=$(awk '/^route:/{print $2; exit}' "$f")
    signal=$(awk -F': ' '/^signal_source:/{print substr($0, index($0,": ")+2); exit}' "$f")
    note=$(awk -F': ' '/^evidence_note:/{print substr($0, index($0,": ")+2); exit}' "$f")
    HITS+="• ${domain} — status:${acct_status} route:${route:-—} signal:${signal:-—}: ${note:0:140}"$'\n'
    if [ "$acct_status" = "enrolled-paused" ]; then
      ENROLLED_COUNT=$((ENROLLED_COUNT + 1))
    else
      PENDING_COUNT=$((PENDING_COUNT + 1))
    fi
  done < <(comm -13 <(printf '%s\n' "$IN_PLAY_BEFORE") <(in_play_set))

  # Every test below reads THIS run's output, never the log file: the log accumulates all of
  # today's runs, so grepping the log would let one blocked run poison every later run's alert.
  PROGRESS_AFTER=$(progress_lines)

  # BLOCKED is checked OUTSIDE the elif chain, for two reasons:
  #  1. False positive. A bare `grep -q "BLOCKED"` over the run's own prose pages on routine
  #     lines like "signal X skipped per its rollout gate (still BLOCKED)". The run emits a
  #     colon-suffixed `BLOCKED:` MARKER (see the prompt) and only that marker alerts — prose
  #     can say the word freely.
  #  2. Suppression. As an `elif` it swallows the alert that matters: a run can enroll accounts
  #     AND report a per-signal block. A block must ANNOTATE a run, not replace its result.
  #     Terminal failures (auth/non-zero exit) still short-circuit — there is no result there.
  if [ "$CLAUDE_EXIT" -eq 0 ] && printf '%s' "$CLAUDE_OUTPUT" | grep -qE '(^|[^A-Za-z])BLOCKED:'; then
    alert "BLOCKED report this run (connector/credits — see log). The rest of the run's outcome
alerts separately: $LOG"
  fi

  if [ "$CLAUDE_EXIT" -ne 0 ] && printf '%s' "$CLAUDE_OUTPUT" | grep -qi "OAuth session expired\|Failed to authenticate"; then
    alert "AUTH FAILED — claude could not authenticate (retry exhausted, not a flake). Re-login on
the scheduled host's console session. Note: a CLAUDE_CODE_OAUTH_TOKEN env var authenticates but
may strip the claude.ai MCP connectors (TheirStack/Apollo), which blocks M1. Log: $LOG"
  elif [ "$CLAUDE_EXIT" -ne 0 ]; then
    alert "FAILED (claude exit $CLAUDE_EXIT). Log: $LOG"
  elif printf '%s' "$CLAUDE_OUTPUT" | grep -v "NOT DEGRADED" | grep -q "DEGRADED"; then
    # "NOT DEGRADED" filtered first: a run summary that opens with "full chain, NOT DEGRADED"
    # would otherwise page a false DEGRADED alert on the bare substring.
    alert "DEGRADED run — no research pass, no enrollment, survivors queued.
Check that the browser is running, the Claude-in-Chrome extension is connected (the relay
between the extension and Claude Code can wedge even when the browser is fine — restart the
extension's native host process, not just the browser), and the Sales Nav session is logged in.
Log: $LOG"
  elif [ "$PROGRESS_AFTER" -le "$PROGRESS_BEFORE" ]; then
    alert "NO-OP run — claude exited 0 but M7 recorded nothing in progress.md, so the run did
no work. Silent-success is the dangerous case: it is indistinguishable from a quiet day in
every other signal (a session that idles at its ready prompt and exits 0 looks exactly like
this). Log: $LOG"
  elif [ "$ENROLLED_COUNT" -gt 0 ] || [ "$PENDING_COUNT" -gt 0 ]; then
    alert "$ENROLLED_COUNT enrolled paused — awaiting M4 go-live; $PENDING_COUNT triaged/routed
awaiting the research pass or resolver HOLD (queue/salesnav-pending.md; deferrals in the
decision ledger — node skills/m7-recorder-sync/scripts/decisions.ts list):
$HITS"
  fi
  # zero-yield, non-blocked runs stay silent

  # DEGRADED-STREAK ESCALATION. One DEGRADED run reads as a bad night, and so does the fourth —
  # which is exactly how a streak goes by unescalated while the research backlog grows past
  # the per-run drain cap. A backlog that outruns the drain rate cannot be worked off by the
  # nightly run alone, so the streak is its own signal and gets its own alert.
  #
  # Streak state is DERIVED, never stored: count consecutive DEGRADED run records from the TAIL
  # of the record trail. Source of truth is logs/run-records.jsonl (top-level `degraded: bool`,
  # one JSON object per line) when it exists; otherwise fall back to M7's progress.md run-record
  # lines. Both are appended by M7 inside THIS run, so the current run is already counted. If the
  # run died before M7 the tail is the previous run's — an unrefreshed streak keeps escalating,
  # which is the safe direction. The progress.md fallback matches prose, so a recovery run whose
  # record merely mentions the word can over-report by one; run-records.jsonl is exact.
  RUN_RECORDS="$PIPELINE_DATA/logs/run-records.jsonl"

  degraded_streak() {
    if [ -f "$RUN_RECORDS" ]; then
      # whitespace stripped first so `"degraded": true` and `"degraded":true` both match
      tail -n 60 "$RUN_RECORDS" | tr -d ' \t' | awk '/"degraded":true/{n++; next} {n=0} END{print n+0}'
    elif [ -f "$PIPELINE_DATA/progress.md" ]; then
      grep 'HEADLESS/SCHEDULED batch' "$PIPELINE_DATA/progress.md" | tail -n 60 \
        | awk '/NOT DEGRADED/{n=0; next} /DEGRADED/{n++; next} {n=0} END{print n+0}'
    else
      echo 0
    fi
  }

  # Accounts still waiting on the research pass: bullet lines under a section header not marked
  # RESOLVED. Approximate by design (the file is human-maintained), but it moves the right way.
  salesnav_backlog() {
    local f="$PIPELINE_DATA/queue/salesnav-pending.md"
    [ -f "$f" ] || { echo 0; return; }
    awk '/^## /{skip=($0 ~ /RESOLVED/)} /^- /{if (!skip && $0 !~ /RESOLVED/) n++} END{print n+0}' "$f"
  }

  DEGRADED_STREAK=$(degraded_streak)
  if [ "${DEGRADED_STREAK:-0}" -ge 2 ]; then
    alert "DEGRADED STREAK — $DEGRADED_STREAK consecutive runs with NO research pass and NO
enrollment. queue/salesnav-pending.md holds $(salesnav_backlog) entries awaiting the pass; the
pass drains at most $SALESNAV_CAP/run (config/signal.yaml limits.salesnav_lookups_per_run), so a
backlog above that can never catch up on nightly runs alone — it needs a manual drain.
A streak is not a flake: stop waiting for the next run to fix it. Check the Claude-in-Chrome
extension's native host process on the scheduled host, not just the browser or the LinkedIn
session. Log: $LOG"
  fi

  echo "=== headless batch end $(date -u +%FT%TZ) claude_exit=$CLAUDE_EXIT ==="
} >> "$LOG" 2>&1
