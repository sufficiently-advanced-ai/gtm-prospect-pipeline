# 0008. Judgment evals for prompt-driven modules

## Context

M2's routing, the browser verdict, and evidence synthesis are prompts: their behaviour is
the text of a `SKILL.md` and `config/icp.md`. Each rule in those files exists because a
specific account was once routed wrong and a human corrected it. A later edit for an
unrelated reason can un-learn that correction, and nothing in a code test suite would
notice, because there is no code.

## Decision

`evals/` is a regression suite for judgment:

- A fixture freezes one decision: excerpted raw inputs, the gold answer (the
  post-correction outcome, after review and after the research pass), and `forbidden`
  traps naming the specific wrong answer that actually happened.
- Runners assemble context only from fixture inputs plus the live skill text, never from
  the live store. The suite is read-only against `$PIPELINE_DATA`.
- Tasks: `fit-triage`, `route`, `salesnav-verdict`, `evidence-synthesis`. Scoring is exact
  match on the task's primary field (gated) plus secondary fields (reported). Evidence
  synthesis uses a deterministic citation check plus a rubric judge.
- Runs are live against the model or replayed from committed responses for $0. Results
  diff against a baseline; `history.jsonl` is the trend line.
- `bash scripts/check-evals.sh` gates every edit to a skill file or a config file. Exit 1
  blocks the edit until fixtures and text agree.
- Human rulings recorded in the decision ledger are quoted verbatim into the fixture that
  encodes them, so the suite carries its own justification.

## Consequences

- A skill edit that flips a frozen decision fails before it lands.
- The fixtures shipped in this public repo are synthetic. They prove the harness works; they
  do not encode anyone's ICP. A private fork replaces them with its own corrected decisions.
- Fixture data is real prospect data in a private fork. That fork must stay private.
