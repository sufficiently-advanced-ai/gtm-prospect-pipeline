# Eval fixture schema

A fixture is one frozen decision: the inputs a module saw, and the outcome that is now
known to be correct. Gold = the **post-correction** state (after the operator's review,
after the Sales Navigator pass, after the incident write-up) — never the module's first
answer. Fixture shapes are typed in `evals/harness/types.ts`; this file defines the
on-disk layout, the per-task role vocabulary, and the workflow rules.

## Layout

```
evals/fixtures/
  SCHEMA.md                      # this file
  staging/<id>/                  # drafts — NOT loaded by the harness, no immutability
  cases/<task>/<id>/             # committed fixtures — loaded, hashed, gated
    fixture.yaml                 # metadata + gold (+ forbidden traps / rubric)
    inputs/<files>               # excerpted raw evidence, referenced by fixture.yaml
    seed/                        # SYNTHETIC fixtures only: the hand-written canonical answer
  selftest/                      # synthetic fixtures for harness self-tests only
  retired/<id>/                  # withdrawn fixtures + a RETIRED.md saying why — never loaded
```

`<id>` matches `^[a-z0-9_]+$` and starts with the task name, e.g.
`route_northwind_scope_not_title`. The dir name equals the id.

## fixture.yaml

```yaml
id: route_northwind_scope_not_title
task: route
version: 1
description: >-
  A nonstandard C-level title whose actual scope is regulatory compliance must NOT
  read as the owner of the function — scope, not title string, is the test.
provenance:
  domain: northwind-logistics.example
  source: "decision ledger d-2026-02-05-northwind-scope"
  decision_id: d-2026-02-05-northwind-scope   # optional: the ledger ruling this fixture protects;
                                              # evals/fixture-backlog.ts counts it as covered
  incident_date: "2026-02-05"
inputs:
  - path: inputs/apollo-sweep.json
    role: apollo_sweep
  - path: inputs/salesnav-notes.md
    role: salesnav
gold:
  route: QUALIFIED
  evidence_names:
    - Dana Reyes
forbidden:
  - field: route
    value: SKIP
    reason: >-
      Disqualified on the title string without reading scope.
notes: optional free text
```

Gold vocabularies mirror `types.ts`:

- `decision` is `keep | drop`. `drop_class` is REQUIRED on a drop and must be one of the
  slugs listed under `## Drop classes` in `config/icp.md` (`- <slug> — <description>`, one
  per line). It is read at load time, not hardcoded: rename a class in icp.md and every
  fixture carrying the old slug fails to load, by name. A keep carries no drop_class.
- `route` is `QUALIFIED | SKIP | FLAGGED` (lib/status-map.ts ROUTES minus DROPPED, which is
  fit-triage's). `evidence_names` is the optional list of people the classification turns on.
- `verdict` is `confirm | flip_to_skip | flag`, with `evidence_names` as above.
- `account.provisional_route` (read by the scaffolder, not a verdict field) is
  `QUALIFIED | SKIP | DROPPED | FLAGGED`.

Rules:

- **gold** holds exactly the verdict fields the task's scorer compares (see
  `PRIMARY_FIELD` / `SECONDARY_FIELDS` / `VERDICT_FIELDS` in types.ts). Include secondary
  fields when the record supports them; omit when it doesn't (omitted = unscored). A gold
  key that is not a verdict field of the task is rejected.
- **forbidden** entries are the trap — the *specific wrong answer that actually happened*
  (or plausibly regresses), with the reason it matters. Most fixtures born from an incident
  have at least one. A forbidden hit fails the whole run (absolute gate). `field` must be a
  verdict field THIS task actually carries: a misspelling, or another task's field, produces
  a trap that can never fire — scoring looks the field up on the parsed verdict, finds
  nothing, and counts nothing — so the loader rejects it. Traps are enum-task only;
  evidence-synthesis evaluates no verdict object, so a trap there is decorative and is
  rejected too (use a `rubric.must` check). Prefer trapping the *reachable* wrong answer over
  the maximally-wrong one: a trap only a badly-broken model would spring is not guarding much.
- **Enum values in `gold` and `forbidden` must be quoted strings.** YAML coerces `yes` to
  a boolean, `null` to null and `1` to a number; scoring compares stringified values, so
  gold of `true` demands the literal answer "true" and a perfect model reply scores 0
  forever. The loader rejects non-strings.
- **rubric** (evidence-synthesis only, replaces gold): `must` checks are gated
  (must_pass_rate), `should` checks reported. Each check is `{id, text}` where text is a
  single verifiable statement a judge can pass/fail against the produced evidence.md.
- **evidence-synthesis fixtures** also get a deterministic pre-check (no model): every
  claim line in the produced output must end with a `[<citation> · fact|inference|hypothesis]`
  marker whose cited path exists among the fixture's inputs. The runner enforces this;
  the rubric covers content quality.

## Input roles per task

| task | required roles | optional roles |
|---|---|---|
| fit-triage | `theirstack_company` (company block + matching job metadata, excerpted) | `homepage` (Firecrawl md), `jd_text` |
| route | `apollo_sweep` (people JSON, trimmed to name/title/headline/seniority/last_refreshed) | `firecrawl_leadership`, `posting`, `salesnav`, `websearch` |
| salesnav-verdict | `salesnav` (the captured roster/notes text) + `checklist` (the per-domain queue checklist: named execs, absence claims) | `apollo_sweep` |
| evidence-synthesis | the full per-domain raw set as captured (`posting`, `firecrawl_*`, `apollo_*`, `salesnav`) | — |

Runners assemble the model's context ONLY from these inputs plus the live skill/ICP text —
never from the live store. If a role a task needs is missing, the loader errors at load
time (fail loud, not skip). Roles may repeat (three per-query Apollo captures all as
`apollo_sweep`).

## Excerpting and hygiene (hard rules)

- **≤50KB per input file, ≤200KB per fixture.** Source payloads are multi-MB; extract the
  company block and matching jobs only. Apollo people JSON: keep `name`, `title`,
  `headline`, `seniority`, `last_refreshed_at`, org name fields — strip everything else.
- **No secrets, no contact emails, no contact/sequence ids (24-hex), no phone numbers.**
  Names + titles are the evidence; emails never are. Redact with `<redacted>` where
  structure matters.
- **No gold leakage:** inputs must not contain the decision, the correction, or text
  written after the decision (e.g. an evidence_note that states the route). Sales Navigator
  notes files are allowed as inputs for `route`/`salesnav-verdict` but MUST have their
  `## Verdict` / route-conclusion sections stripped — findings stay, conclusions go.
- Inputs come from `$PIPELINE_DATA/raw/` captures verbatim-then-trimmed. Trimming may
  delete, never rewrite: no paraphrasing, no reordering that changes meaning.
- **No identifiers in the rulebooks.** If a lesson goes into `skills/*/SKILL.md` or
  `config/icp.md`, it goes in as a rule, never with the account name — the rulebooks are
  quoted verbatim into every prompt, so a named account is an answer key for its own
  fixture. Names belong in `provenance` and `notes`, which are never quoted.

## Immutability & change procedure

The loader computes `sha` = sha256 over the canonicalized fixture.yaml (sorted keys,
`dir`/`sha` excluded) plus the raw bytes of every declared input file (a `seed/` dir or a
review sidecar does not participate), and `evals/run.ts` refuses to run if any committed
fixture's sha differs from `baselines/baseline.json`. To change a fixture deliberately: bump
`version`, state why in `notes`, and rewrite the baseline in the same change
(`node evals/run.ts --task all --baseline`, full live run — or `node evals/seed-synthetic.ts`
while the corpus is still entirely synthetic). Replays are keyed to fixture sha and die with
it.

**Deleting is a change too:** a full run and `check-evals.sh` also require every fixture id
in the baseline to still LOAD. Removing or renaming a fixture dir would otherwise pass every
gate in silence — the deleted fixture simply stops being asked, and the suite gets easier
without a single error. To withdraw a fixture, move it to `retired/<id>/` with a `RETIRED.md`
saying why, and rewrite the baseline in the same change.

## Staging → committed workflow (the flywheel)

1. `node evals/draft-fixture.ts <domain>` scaffolds into `staging/` from the account's
   `raw_pointers` + corrected account.yaml (gold pre-filled from the corrected state).
2. A human confirms the gold label and writes the `forbidden` trap encoding the observed
   failure. **Unreviewed gold never leaves staging.**
3. Move the dir into `cases/<task>/`, run the suite live once to record replays, and
   rewrite the baseline — adding a fixture is a deliberate baseline change.

## Synthetic fixtures (shipped) vs real fixtures (yours)

The fixtures shipped in `cases/` are synthetic: `provenance.domain` ends in `.example`,
`provenance.source` says so, and each carries a `seed/response.md` (plus
`seed/judgments.json` for evidence-synthesis) — the hand-written canonical answer
`evals/seed-synthetic.ts` turns into a replay so the $0 gate runs without a model. A real
fixture never has a `seed/` dir: its replay comes from a live run, and the seeder refuses to
run on a corpus that contains one. Replace the synthetic set with your own excerpted real
decisions in a PRIVATE fork (DESIGN.md §Shipped corpus).
