# 0003. Signals label accounts; sequences bind to labels; lifecycle gates enrollment

## Context

The first version used the triage route to pick a sequence: one route, one sequence. When
a second signal arrived, a sequence was retired, and a successor was drafted, the route enum
grew to carry targeting meaning it did not have. Retiring a sequence meant editing the
skills that mentioned it, an `inactive` flag meant three different things, and there was no
answer to "what happens to accounts routed to a sequence that no longer exists".

## Decision

Route is classification only (see 0004). Targeting is a separate, declarative model:

- `config/signal.yaml` is a label catalog. A block is a label plus, optionally, an
  acquisition recipe. Label-only blocks with no query are valid and are how referrals, event
  lists, and browser finds enter the pipeline with no code change.
- Each sequence in `config/sequences.yaml` declares one match spec,
  `binds: {signals: [...], routes?: [...]}`. Criteria are ANDed; `binds: {}` matches nothing.
- `status: draft | active | retired` gates enrollment only. The sequencer's send state
  remains a human decision.
- A match on a non-active sequence is a HOLD at `status: routed`, never a fallback. Held
  accounts become enrollable automatically when a successor flips to active.
- `supersedes` links make activation carry retirement in the same edit.
- `lib/sequence-resolver.ts` is the only code that maps an account to a sequence. Its
  validator forbids two active sequences with overlapping match domains, so no precedence
  rules exist to be remembered.

## Consequences

- Sequence ids live in exactly one file. No skill or script hardcodes one.
- A rebuilt sequence enters as a new key with a new id; a retired entry's id is never
  repointed, because the paused enrollments that reference it are frozen history.
- Every config edit is followed by `--validate`. The validator, not a reviewer, catches an
  overlap or a placeholder id on an active sequence.
- "Why did this account not enroll" has a one-command answer:
  `node lib/sequence-resolver.ts <domain>`.
