# Ideal customer profile — the operator's judgment

<!--
WHAT THIS FILE IS
  Everything the pipeline needs to know about WHO you sell to and WHAT disqualifies an
  account. skills/m2-triage-route/SKILL.md says HOW to triage (sources, capture, routes,
  store fields); this file says WHAT a fit is. Nothing in skills/ may restate a rule from
  here — if a skill needs a vertical, a title, or a disqualifier, it points at this file.

WHO READS IT
  - M2 (fit triage, route classification, the Sales Navigator pass) reads the prose.
  - The eval harness parses ONE section by machine: "## Drop classes". Each bullet there
    must read `- <slug> — <description>` (lowercase snake_case slug, em-dash separator).
    Fixtures' `drop_class` values are validated against that list at run time.

THIS IS A TEMPLATE
  Every section below is a placeholder plus one small illustrative rule. Replace all of it
  with your own judgment before the first real batch — a pipeline running on a template ICP
  will drop the wrong companies and pitch the wrong people. Run
  `bash scripts/check-evals.sh` after any edit here.
-->

## Who we sell to

<!-- Size band, geography, ownership, and what the buyer is DOING when they need you. -->

- Size: REPLACE (e.g. 10–500 employees; judged on the employer's own headcount, not a
  parent's — see the mechanics in M2).
- Geography: REPLACE (keep in sync with `config/signal.yaml` country codes).
- Ownership / structure: REPLACE (e.g. operating companies with their own P&L and their own
  technology function; a unit being absorbed into a parent's stack is out).
- The moment of need: REPLACE — one sentence describing what the buyer is in the middle of
  when your offer is the obvious next call.

Illustrative rule: *an operating company in any vertical is in; a company whose product IS
the capability we sell is out — they are a competitor or a vendor, not a buyer.*

## The signal we key on and what it implies

<!-- What the enabled block(s) in config/signal.yaml detect, and the inference you draw
     from it. The signal is a FACT you can quote back; the implication is your thesis. -->

- Signal: REPLACE (e.g. "a job posting whose description mentions <phrase>").
- Implication: REPLACE (e.g. "the company has decided to do <thing> and is staffing for
  it, which means the person who owns <function> is about to need <what we sell>").

Example sentence pattern: *"A posting for `<role>` that mentions `<phrase>` implies the
company is `<doing X>` without `<the thing we provide>` — the buyer is the `<title>` who
owns that outcome."*

## Drop classes

<!-- MACHINE-READ. One bullet per class: `- slug — description`. Add, remove, and rename
     freely; every `drop_class` M2 writes and every eval fixture must use a slug listed
     here. Keep descriptions to one line — they are what the model applies. -->

- vendor_of_the_capability — the company sells, builds, or resells the thing we provide; a competitor or supplier, not a buyer
- staffing_or_agency — staffing, recruiting, outsourcing, or a services agency whose posting markets a client offering rather than an internal seat
- out_of_band_size — headcount or revenue outside the size band above, judged on the employer's own org
- job_board_or_aggregator — the domain is a job board, aggregator, or ATS host, not an employer
- public_sector_or_nonprofit — government body, public institution, NGO, or member association with no budget owner for our offer
- source_mismap — the source attached the posting to the wrong company; the evidence is not this domain's signal

## Disqualifiers (route SKIP)

<!-- Account-level, binary. One confirmed disqualifier suppresses the whole account. The
     evidence MUST be a captured raw/ path (Apollo people sweep, leadership page, posting,
     or a Sales Navigator note) — never a recollection or an uncaptured search result. -->

Pattern: *a titled owner of `<the function we sell>` already in seat = SKIP, account-level,
binary.* Fill in:

- Titles that count as "owner of the function": REPLACE (list the leader-rank titles;
  state the minimum rank that counts and say whether individual-contributor "Lead" titles
  trip it).
- Scope over string: a title alone never disqualifies. Read the person's described remit at
  THIS company; a self-authored headline or About counts only when the company corroborates
  it (conferred title, company page, org evidence) — REPLACE with your own corroboration test.
- What does NOT disqualify: REPLACE (e.g. an OPEN, unfilled posting for the owner seat is a
  buying signal, not a sitting owner).

Illustrative rule: *a sitting `Head of <function>` confirmed on the company's own leadership
page = SKIP; the same title held only at a concurrent outside practice = not this company's
seat.*

## Conflicting or thin evidence (route FLAGGED)

<!-- FLAGGED is a verdict, not a failure. Say what gets flagged and what gets decided. -->

- FLAG when two captured sources genuinely contradict each other about who holds the seat
  (e.g. a live posting names an internal owner that neither the leadership page nor the
  people sweep shows) — never resolve by preferring the scarier reading (SKIP) or the
  cleaner one (QUALIFIED).
- FLAG when the only evidence for an absence claim is a single headless source and the
  Sales Navigator pass cannot run.
- Do NOT flag a conflict that dissolves under the corroboration test above — that is a
  decision, not a conflict.
- REPLACE: add your own thin-evidence thresholds (minimum sources, maximum record age).

## Classification tags

<!-- OPTIONAL free-string tags M2 may write to `account.classification`. They describe the
     account for copy selection or reporting; a sequence may qualify on one via `binds`.
     Ship empty. Example:
- owner_absent — no titled owner of the function anywhere on the senior roster
- owner_adjacent — a senior technical seat exists but its remit does not cover the function
-->

(none defined)

## Known false-positive classes

<!-- Mechanical matches that look like the signal and are not. M2 drops these postings
     from the evidence before judging fit; the eval harness expects fixtures for each. -->

- A mention of `<X>` in a client roster, case study, or partner logo wall is not adoption
  of `<X>`.
- A phrase inside a negation ("not a … position", "rather than …") is not the signal.
- REPLACE: add the specific words and contexts your regex over-matches on (course content,
  marketing service lines, product names that collide with your phrase).

## Rulings log

<!-- Append one dated line per judgment call the operator makes at the ledger — the account
     pattern (anonymized to a class, never a company name in this public file), the ruling,
     and which section above it changed. Then turn EACH ruling into an eval fixture
     (`node evals/draft-fixture.ts`) so the rule is regression-tested, not remembered.
     Format:
- <date> — <class of account> — <ruling> — <section updated> — fixture: <id>
-->

(none yet)
