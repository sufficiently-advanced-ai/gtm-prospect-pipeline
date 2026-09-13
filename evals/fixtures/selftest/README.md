# Harness self-test fixtures

Synthetic fixtures used ONLY by the tests under `test/` (evals-harness, runners-*). They are
never loaded by `node evals/run.ts` — the harness loads `evals/fixtures/cases/` and nothing
else — and they carry no immutability baseline.

- `cases/` — one well-formed fixture per task, loaded with an injected drop-class list so the
  tests never depend on the operator's `config/icp.md`.
- `invalid/` — one deliberately broken fixture per validation rule the loader must reject.

Every company, person and domain here is invented (`*.invalid`).
