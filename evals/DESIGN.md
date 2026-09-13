# Eval harness design

Regression evals for the pipeline's LLM-judgment surfaces: frozen fixtures with gold labels
→ runners over the PRODUCTION prompt sources (`skills/*/SKILL.md` + `config/icp.md`) →
scored → gated against a committed baseline, with offline replay as a $0 pre-edit check.

Why: judgment failures in an outbound pipeline are caught live, after the fact — a scope
mis-drop, a Sales Navigator flip the headless pass should have made, a vendor that leaked
past the signal filters — and then encoded as a sentence in a skill file or the ICP. Nothing
else detects when the NEXT edit to `skills/*/SKILL.md`, `config/icp.md`, `config/signal.yaml`
or `config/sequences.yaml` silently regresses one of those lessons. This suite does.
**Run `bash scripts/check-evals.sh` before landing ANY edit to those files.**

The unfair advantage is capture-first: every decision's complete input is already frozen in
`$PIPELINE_DATA/raw/`, and the corrected outcome is recorded in `account.yaml` and the
progress log. Fixtures are assembled from real decisions, not invented — see
`fixtures/SCHEMA.md` and `draft-fixture.ts`. (The fixtures SHIPPED with this repo are the
exception: they are synthetic. See "Shipped corpus" below.)

## Three layers

1. **Fixtures** (`fixtures/cases/<task>/<id>/`) — one frozen decision each: the excerpted
   inputs a module saw, the gold outcome, and usually a `forbidden` trap naming the specific
   wrong answer that once happened. Immutable once baselined (sha-pinned).
2. **Harness** (`harness/`, `run.ts`) — loads and validates fixtures, composes each task's
   prompt from the LIVE skill and ICP text, calls the model (or replays a recorded answer),
   parses the verdict, scores it deterministically, and gates the result against
   `baselines/baseline.json`.
3. **Gate** (`scripts/check-evals.sh`) — harness self-tests + fixture immutability +
   `--offline` replay. No model calls, no credits. Exit 1 blocks the edit.

## Tasks

| task | judges | scoring | gated metric |
|---|---|---|---|
| fit-triage | keep/drop + `drop_class` (a slug from `config/icp.md` "## Drop classes") | exact match (+ drop_class rate, reported) | accuracy |
| route | QUALIFIED / SKIP / FLAGGED + the people the call turns on | exact match (+ name recall, reported) | accuracy |
| salesnav-verdict | confirm / flip_to_skip / flag from captured roster text | exact match (+ name recall, reported) | accuracy |
| evidence-synthesis | produce evidence.md from a full raw set | deterministic citation check + LLM judge on must/should rubric | must_pass_rate |

Plus the absolute gate on every enum task: `forbidden_hits` must be **0** — a forbidden hit
means a specific encoded failure regressed, and no tolerance applies.

Vocabularies track the production rulebooks, never the other way round. Route values mirror
`lib/status-map.ts` (minus DROPPED, which is fit-triage's). Drop classes are NOT an enum in
code: the loader reads whatever `config/icp.md` lists under "## Drop classes" at run time
(`harness/icp.ts`), and the fit-triage prompt quotes the same list. Rename a class in
icp.md and a fixture still carrying the old slug fails to load, loudly.

## Architecture

```
evals/
  DESIGN.md · run.ts · draft-fixture.ts · seed-synthetic.ts
  harness/
    types.ts        # THE contract — all modules import from here
    icp.ts          # parses "## Drop classes" out of config/icp.md
    loader.ts       # load + validate fixtures, compute immutability shas
    prompt.ts       # read skill/ICP text, extract sections, compose templates, prompt shas
    contract.ts     # the reason-first output protocol every enum runner quotes
    model.ts        # ModelClient impls: live (claude -p --output-format json) + replay
    scoring.ts      # exact-match + secondary fields + micro aggregation
    report.ts       # build/print/write reports, baseline load/diff/rewrite, history
    replay.ts       # read/write evals/replays/<task>/<id>.json
    runners/<task>.ts
  fixtures/         # see fixtures/SCHEMA.md
  replays/          # committed — the $0 offline corpus
  baselines/baseline.json   # committed
  results/          # per-run reports (gitignored) + history.jsonl (committed, live runs only)
```

Principles:

- **Prompts come from the live skill text.** `prompt.ts` reads `skills/*/SKILL.md` and
  `config/icp.md` at run time and composes each task's template from the sections the
  production module would follow — the skill says HOW, the ICP says WHAT a fit is — plus a
  reason-first output protocol: prose reasoning, then exactly one strict JSON object matching
  the verdict type, with the enum field required to state the conclusion the reasoning
  reached (this closes label/rationale inversion, where the prose applies the rule correctly
  and the label says the opposite). `prompt_sha` (template only, inputs excluded) is
  recorded per run and in the baseline — so a skill or ICP edit is visible as a sha change
  and its effect is measured, which is the whole point. Never paraphrase skill text into the
  runner; quote it. A section that has been renamed or removed throws rather than silently
  dropping the rule it carried.
- **Model calls** go through `ModelClient`. The live impl shells out to
  `claude -p --output-format json --model <m>` (no API key in the repo). `EVAL_MODEL` /
  `EVAL_JUDGE_MODEL` override the defaults in types.ts.
- **The store is read-only** for everything under evals/. Nothing here ever reads OR writes
  `$PIPELINE_DATA` at run time; runners assemble context ONLY from fixture inputs plus the
  repo's own skill/ICP text. (`draft-fixture.ts` reads the store to scaffold, and writes only
  under `fixtures/staging/`.)
- **Parse failure = wrong answer**, scored 0 with the raw response in details — never a
  skip. Skips exist only offline (no valid replay recorded).

## CLI (run.ts)

```
node evals/run.ts --task all|<task> [--fixture <id>] [--offline] [--label <s>]
                  [--baseline] [--tolerance 0.02] [--runs N]
                  [--compare A.json B.json]
```

- Exit 0 = ran, no gated-metric regression beyond tolerance AND all absolute-zero
  metrics are 0. Exit 1 = regression, forbidden hit, fixture-immutability violation,
  coverage shrink, unresolvable runner, or error.
- `--baseline` refuses subsets: full task set, no --fixture, no --offline, single run.
- `--offline` replays committed responses; deterministic; skips (with reason) fixtures
  lacking a valid replay; never appends to history.
- `--runs N` repeats live runs and gates on the mean; prints per-run spread.
- `--compare A.json B.json` is REPORTING ONLY and always exits 0 — it never gates.
- Live runs append one line to `results/history.jsonl` (the trend).

### Anti-vacuous-green rules

The failure shape every one of these closes is **the suite reporting green for questions it
never asked.**

- **Loaded-but-none-scored fails, offline too.** Offline skips are expected individually; a
  task that loaded fixtures and scored none of them is the exact post-edit state the gate
  exists to catch (every replay stale). The gated metric is forced to 0 and the run fails.
- **Coverage gate.** Accuracy is a rate, so a shrinking denominator hides a regression: the
  fixture that skipped is the one whose sha moved, i.e. the one most likely to have changed
  answer. Scoring fewer fixtures than the baseline scored fails with "coverage shrank". A
  `--fixture` subset run turns this off; nothing else does.
- **Skips are reported loudly**, grouped by reason, on stderr, after the metrics.
- **Fixture completeness.** Immutability only compares fixtures that still exist, so
  deleting an inconvenient fixture dir would pass silently. On a full run (and in
  `check-evals.sh`), every fixture id in the baseline must still load.
- **No graceful runner absence.** A task whose runner will not import exits 1 naming the
  module path, rather than dropping out of the report ungated.
- **`--baseline` sanity floor.** It refuses to write a baseline from a run containing a
  forced-zero task, a task with `n: 0`, or fewer tasks than `TASKS` — a baseline recorded
  from a broken run becomes the standard every later run is judged against.
- **Dirty prompt provenance.** `git_sha` gains a `-dirty` suffix when `skills/` or `config/`
  have uncommitted edits — scoped there because those are exactly the files that feed
  `prompt_sha`. Whole-tree dirtiness would leave the marker permanently on, which is how a
  warning stops being read.
- **Verdict parsing follows the stated output protocol.** The object the reply ENDS with is
  the verdict; it must parse and carry the primary field as a string, or the answer is a
  parse failure. The parser never falls back to an earlier object — the retracted one it
  would find is frequently the forbidden value, which would report a lesson as regressed on
  a reply that answered correctly.
- **De-identified prompts.** The rulebooks are quoted verbatim into every prompt, so a rule
  that names the account it was learned from is an answer key for the fixture built from
  that account. Rules live in the skill and the ICP; identifiers live in the fixture's
  provenance and notes, which are never quoted into a prompt. A harness self-test fails the
  moment a fixture's domain or a trap's person name appears in composed prompt text.

## check-evals.sh (the $0 pre-edit gate)

`scripts/check-evals.sh`: harness self-tests + fixture immutability/completeness +
`--offline` replay run. No model calls, no credits. Blocks (exit 1) on any regression the
replays can detect. Full live confirmation happens in deliberate live runs
(`node evals/run.ts --task all`), not per edit.

## Adding a fixture from a real decision (the flywheel)

1. Something went wrong live and was corrected: a route flipped, a drop reversed, a
   synthesis invented an owner. The corrected state is in `account.yaml`; the inputs are in
   `raw/`.
2. `node evals/draft-fixture.ts <domain> [--task <task>]` scaffolds into
   `fixtures/staging/<id>/` from the account's `raw_pointers`, with gold pre-filled from the
   corrected account and every prefill explained in `notes`. It excerpts, trims and redacts
   mechanically; it never labels.
3. A human confirms the gold and writes the `forbidden` trap — the specific wrong answer that
   happened. Read `.review.md` in the staged dir: it lists everything deleted and every
   BLOCKER (a conclusion the stripper refused to delete because it carried the only statement
   of the evidence).
4. Move the dir into `fixtures/cases/<task>/`, run the suite live once to record replays, and
   `node evals/run.ts --task all --baseline`. Adding a fixture is a deliberate baseline change.

Excerpting rules (enforced by the loader and the scaffolder; full text in SCHEMA.md):
≤50KB per input, ≤200KB per fixture; **no emails, no phone numbers, no contact or sequence
ids** (names + titles are the evidence; contact details never are); no gold leakage — the
inputs must not contain the decision, the correction, or text written after the decision.
Trimming deletes, never paraphrases.

## Shipped corpus is synthetic — replace it

The fixtures under `fixtures/cases/` in this repository are **invented**: every company,
person and domain (`*.example`) is made up, and the captures are written in the shape the
real connectors produce so the runners exercise the same reading. They exist so the harness,
loader, gate and flywheel can be run out of the box, and so each task has a worked example of
the judgment it tests (a vendor of the capability, a titled owner in seat, a scope-over-title
call, a genuine conflict, a confirm and a flip).

They are gated at $0 by `node evals/seed-synthetic.ts`, which turns each fixture's
hand-written `seed/response.md` into a replay keyed to the current shas and writes the
baseline from an offline run. That proves the harness works; it does not prove a model
applies YOUR rules. The seeder refuses any fixture whose domain is not `*.example`.

Once you run the pipeline, replace them: your own excerpted real decisions, in a **PRIVATE
fork** — real fixtures carry named individuals and titles into git history permanently, and
the excerpting rules above bound but do not remove that exposure. Delete the synthetic
fixtures, record replays with a live run, rewrite the baseline, and stop using the seeder.

## Live metric this suite predicts

The **flip rate** — headless provisional route vs. post-Sales-Navigator final — is the
production error rate, tracked per batch in M7's run record. When the offline suite is green
but flip rate climbs, new failure modes exist → turn the flips into fixtures.

## Non-goals

- Not a test of connector data quality (that is the mismap / known-bug machinery).
- Not an orchestrator test — module wiring is covered by `test/smoke.ts` + store-lint.
- No automated gold relabeling, ever: gold changes are human decisions with provenance.
