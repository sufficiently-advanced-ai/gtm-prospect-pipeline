# 0001. Code and data split, data as flat files

## Context

The pipeline runs on two machines: a headless host for scheduled batches and a laptop for
review and go-live. Both need the same account state. Options were a database with a
server, a git repo for data, or a directory of flat files replicated by a file syncer.

Git inside a file-synced folder corrupts. A database adds a server, a schema migration path,
and a query language between the operator and the question "what happened to this account".
Most pipeline questions are one `rg` away if the state is text.

## Decision

Code lives in a git repo. Data lives at `$PIPELINE_DATA`, a directory of YAML, Markdown,
JSON, and JSONL, replicated between hosts by a file syncer with no git and no secrets.
Modules reach the store only through the `PIPELINE_DATA` environment variable, never a
relative path. Secrets live in a per-host env file outside both trees.

Guardrails that come with the choice:

- The capture layer (`raw/`) uses timestamped, host-suffixed filenames, so it is append-only
  and never conflicts.
- `account.yaml` is the one conflict surface. The orchestrator scans for sync-conflict files
  at every run start and routes hits to `queue/`; nothing auto-merges.
- Soft single-writer: scheduled writes on one host, interactive sessions on the other.
- Files that rewrite in place (the decision ledger's `resolve`, queue drains) do so
  atomically via temp-and-rename, so a concurrent rewrite surfaces as a conflict file rather
  than silent loss.

## Consequences

- Every account is greppable and diffable. Store-lint is a script, not a migration.
- Eventual consistency of seconds to minutes is tolerated; it is irrelevant at daily cadence.
- The operator must resolve conflicts by hand when both hosts edit the same account on the
  same day. This happened rarely and always pointed at a process error worth seeing.
- Large capture payloads replicate everywhere unless the syncer is told to ignore them on
  small devices.
