# gtm-prospect-pipeline

Signal-driven outbound engine run by Claude Code. Read README.md, then ARCHITECTURE.md and
SAFETY.md, before changing anything.

- CODE here (git). DATA at `$PIPELINE_DATA` (default `~/Data/gtm-prospect-pipeline`) — no
  git, no secrets. Secrets in `~/.config/gtm-prospect-pipeline/env` (chmod 600).
- `config/` is the single source of truth for signals, sequences, caps, suppression, and
  your ICP (`config/icp.md`). Never hardcode a sequence id or a cap anywhere else.
- Run `node lib/sequence-resolver.ts --validate` after ANY config edit and
  `node lib/sequence-resolver.ts --audit-enrolled` after ANY sequence-copy or merge-field edit.
- Run `bash scripts/check-evals.sh` before landing any edit to `skills/*/SKILL.md`,
  `config/icp.md`, `config/signal.yaml`, or `config/sequences.yaml`.
- Scripts are plain TypeScript run with `node <script>.ts` (node 24+, erasable syntax only).
- Hard rules live in SAFETY.md. The short version: nothing sends without a human "go";
  everything enrolls paused; suppression check before every enrollment; capture-first;
  check-then-write; the store outranks the CRM; connector flake = one retry then BLOCKED.
