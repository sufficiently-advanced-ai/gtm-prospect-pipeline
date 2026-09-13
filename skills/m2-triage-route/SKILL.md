---
name: m2-triage-route
description: >-
  M2 of the prospect pipeline — fit triage, 3-source verification, binary account-level route
  classification (QUALIFIED / SKIP / FLAGGED / DROPPED — classification only, it does not pick
  a sequence). PROCESSING module: reads raw/, writes accounts/, never fetches except the four
  named verification sources — Apollo org people sweep, Firecrawl leadership/about page,
  job-posting evidence, Sales Navigator via browser (each captured to raw/ first). All fit and
  disqualifier judgment comes from config/icp.md. USE WHEN accounts sit at status:pulled,
  re-triaging after new evidence, or accounts sit at status:triaged awaiting the Sales
  Navigator research pass.
---

# M2 · triage-route

Operates on `accounts/*/account.yaml` at `status: pulled` (all paths under `$PIPELINE_DATA`).
Reads `raw/` and the account stub; writes `accounts/`; fetches ONLY the four verification
sources named below, each captured verbatim to `raw/` BEFORE interpretation. Every claim
written to an account cites a `raw/` path — a claim without a pointer is not evidence.
Run `node lib/conflict-scan.ts` before any store write (exit 2 = stop).

**All fit and disqualifier judgment comes from `config/icp.md` — this file says HOW to
triage, `icp.md` says WHAT a fit is.** Nothing here names a vertical, a title, or a
disqualifier; if you find yourself wanting to, the sentence belongs in `icp.md`.

## Fit triage (drop before spending)

Judge each pulled account against the drop classes in `config/icp.md` ("## Drop classes")
from what is already free: domain, name, the source's company description, and a homepage
read when ambiguous (Firecrawl → `raw/firecrawl/<domain>/<date>-home.md`). Source industry
tags lie — a homepage read settles what the company IS, not what its marketing vertical is.

- **Self-description counts wherever the company writes it — including the About/company
  paragraph inside its OWN job posting.** That paragraph is the one place no acquisition
  filter reads (`company_description_pattern_not` in `config/signal.yaml` matches the
  STORED description, which lags live positioning). A drop-class phrase there is a drop
  exactly as if it stood on the homepage.
- **Polarity of the matching phrase.** Read the captured JD span (or `matching_phrases`)
  for negation within ~40 characters before the match ("not a …", "rather than", "no …").
  A negated match is not the signal — remove that posting from the evidence and re-judge
  fit on what remains.
- **Title exclusions apply to the JD's first paragraph too.** A posting cross-posted under
  a boards-friendly alias defeats `job_title_pattern_not` while its own first line names the
  excluded role. A hit in the first paragraph is that role, whatever the title string says.
- **Resolve the employer's own headcount before any spend** when the pulled row's company
  name differs from the domain's org, or the posting sits on a parent's ATS — the size band
  is judged on the entity you would actually pitch.
- **Source mismap is a drop for the pulled domain.** A posting that demonstrably belongs to
  a different company is never this company's signal, however good the company looks.
  Add repeat offenders to `dedupe.exclusion_bug_domains` in `config/signal.yaml`; a domain
  already listed there is dropped on sight — never re-verified.

On drop: `status: dropped`, `route: DROPPED`, `drop_class: <slug from icp.md>`, one-line
`evidence_note`, and the raw pointer that supports it. **Drops are STORE-ONLY** — the account
dir and its evidence stay in the store, M8 never mirrors them to the CRM. An account that
already carries verification history and turns out not-ICP takes SKIP instead (below), so the
suppression decision is mirrored. Keep every survivor that is an operating company inside
the ICP; keep-vs-drop is `icp.md`'s call, not this file's.

**Job-text cost rule.** `search_companies` returns job metadata only; when
`raw/postings/<domain>/` is empty, buy the text per SURVIVOR (never per drop) with
`search_jobs`, `company_domain_or: [<domain>]`, the signal's JD regex, and **`limit: 3`
passed explicitly on every call** (the API default bills 25). Batched calls:
`limit = 3 × domains`, never above 15. Capture to
`raw/theirstack/<date>-<signal-key>-<domain>-jobs.json` before writing the postings files.

## Identity + 3-source verification (survivors only)

Identity is the domain plus the Apollo org record — NEVER a name-only web search (same-named
companies exist in every country). Confirm domain ↔ org before reading anyone's people.

1. **Apollo full-org people sweep** — `apollo_mixed_people_api_search` with
   `q_organization_domains_list: [<domain>]`, `include_similar_titles: false`,
   `per_page: 25`; 0 credits. Sweep BROAD seniority (C-level, VP, Director, Head — the
   whole senior roster), not just the titles `icp.md` names as disqualifiers: the function
   you sell is often owned under a title that names something else. Apollo containment-
   matches titles even in strict mode, so regex-verify every returned `title` locally before
   counting anything, and note `last_refreshed_at` record age per hit. Capture each response
   verbatim → `raw/apollo/<domain>/<date>-people.json` (or `-q1|q2|q3.json` per query).
2. **Firecrawl leadership/about page** → `raw/firecrawl/<domain>/<date>-<slug>.md`. Catches
   Apollo errors in BOTH directions: a sitting executive Apollo lacks, and an outdated record for
   someone long gone. A 404 is still a capture — it documents why the fallback was taken.
3. **Job-posting evidence** — already in `raw/postings/<domain>/` from M1 (or bought above).
   The posting is the company telling you what seat is open and who owns what.

Web search is a legitimate fourth read when the three above disagree or run thin — run it via
Firecrawl search and capture the result payload verbatim to
`raw/firecrawl/<domain>/<date>-websearch-<slug>.md` before acting on it. A web-search claim
without a raw pointer cannot be cited and therefore cannot change a route.

**Apollo PRESENCE claims get the same skepticism as absence claims.** Phantom executives,
merged rosters from same-named companies, and decade-old records are properties of the
source, not incidents. A disqualifying hit must be confirmed on the person's own profile or
the company's own page; a "clean" Apollo sweep proves nothing on its own.

## Routing = classification (binary, account-level)

`route` classifies the account and nothing else. It does NOT select a sequence: sequences
subscribe to signals via `binds` in `config/sequences.yaml`, and M3 resolves the target with
`node lib/sequence-resolver.ts <domain>`. Classify honestly on the evidence — never bend a
route toward a sequence you would like the account to land in, and never withhold a route
because no sequence is currently bound (an unbound or non-active match simply HOLDs at
`status: routed` until a successor activates).

- **QUALIFIED** — a fit-passed survivor with no disqualifier from `icp.md` in evidence.
  → `status: routed` (or `status: triaged` when the signal's policy gate below holds).
- **SKIP** — a disqualifier from `icp.md` ("## Disqualifiers") is confirmed by a captured
  source. Binary and account-level: one confirmed disqualifier suppresses the whole account,
  never a contact. Write the reason in free-text `skip_reason` (which disqualifier, who/what,
  and the raw pointer). A positive find is trustworthy once confirmed on the profile or page
  itself; it is ABSENCE claims that need the Sales Navigator pass. → `status: skipped`.
  SKIP is mirrored to the CRM as a verified suppression decision.
- **FLAGGED** — conflicting or thin evidence per `icp.md` ("## Conflicting or thin
  evidence"). FLAGGED is a first-class verdict, not a failure state: when two captured
  sources genuinely contradict each other about who holds what seat, the answer is FLAGGED —
  never resolved by preferring the scarier reading (SKIP) or the cleaner one (QUALIFIED).
  Never guess. → `status: flagged`, plus a decision-ledger entry:
  `node skills/m7-recorder-sync/scripts/decisions.ts add --kind re-triage --accounts <domain>
  --title "<domain>: <the conflict>" --body "<what evidence resolves it>"`. The entry
  surfaces in the dashboard inbox; a recorded verdict is executed at the next run start.
- **DROPPED** — fit triage only (above). Never assigned at this step.

Optional `classification` — a free-string tag from `icp.md` ("## Classification tags") when
the operator defines any. It is descriptive, never a route, and never read by the resolver
unless a sequence's `binds` names it. Leave it unset when `icp.md` defines no tags.

Every route carries `verification: HEADLESS_3SOURCE` at this point. That is PROVISIONAL —
it says three sources were read headlessly, not that absence was proven.

## Policy gates (config/signal.yaml, per signal block)

- `policy.require_salesnav_before_route: true` — every account from that signal STOPS at
  `status: triaged` + `verification: HEADLESS_3SOURCE`, never `routed` from headless
  evidence alone, because the route rests on an absence claim and absence is exactly where
  headless sources are hit-or-miss. M3 refuses any such account whose `verification` is not
  `SALES_NAV`. With the gate `false`, QUALIFIED writes `status: routed` directly and the pass
  below still runs (it may flip the route before enrollment).
- `policy.push_to_crm_after: routed | enrolled` — when M8 first mirrors the account. M2
  never calls the CRM; it only writes the store state M8 reads (`lib/signal-policy.ts`).

Read both from the signal's block by its canonical key — never from memory.

## Sales Nav pass (standing, every batch)

Every survivor gets a Sales Navigator research pass before enrollment. Headless 3-source
routing is provisional; this pass is what proves an absence or surfaces the disqualifier the
headless sources missed. It runs autonomously via Claude-in-Chrome whenever a logged-in
browser is reachable, interactively by the operator when one is not. Go-live (M4) remains the
sole human gate either way.

**VIEW/SEARCH ONLY — absolute.** Never connection requests, messages, InMail, follows,
reactions, posts, or any other outreach action. LinkedIn's internal search API
(`/sales-api/…`) is FORBIDDEN, read-only or not — programmatic hits are the automation-
detection pattern, and text roster reads make it unnecessary.

**The sweep:** a broad Director + VP + C-level seniority sweep of the company entity (not an
exact-title probe), with a full-profile read of any senior hit before accepting or rejecting
it as a disqualifier — scope per `icp.md`, never title string alone. The pass confirms or
flips the provisional call:
- a disqualifier found here → route flips to SKIP (`status: skipped`, `skip_reason` cites the
  Sales Navigator note).
- absence confirmed by the sweep → final route, `status: routed`,
  `verification: SALES_NAV`. Upgrade HEADLESS_3SOURCE → SALES_NAV only after the pass — never
  by inference.
- ambiguous or conflicting → `status: flagged` + ledger entry, never a guess.

**Cap + pacing:** ≤ `limits.salesnav_lookups_per_run` ACCOUNT lookups per run (read
`config/signal.yaml`, never hardcode the number). Each account subagent gets a PROFILE-VIEW
budget of 2–3; rosters are read as page text, never by opening profiles. Human-like pacing:
sequential, one tab, natural dwell time between page loads — no parallel tabs, no rapid-fire
scripted navigation. Work the `queue/salesnav-pending.md` backlog FIRST, then the current
run's survivors; overflow and auth-walled accounts stay queued.

**Capture-first:** findings → `raw/salesnav/<domain>/<date>-notes.md` AT observation time,
never reconstructed later (suffix the filename with the host when two machines write notes
into a synced store). Each queued account carries a structured checklist: the named execs
found (verify current), the absence claims to test, and "any senior hire into the function
we sell in the last 12 months?".

**Context discipline — one subagent per account, strictly sequential, never backgrounded.**
Each lookup runs in its own subagent that gets the checklist for that domain, does the
sweep, writes its own `raw/salesnav/` notes, and returns ONLY a structured verdict (confirm /
flip-to-SKIP / flag, with the named evidence). The parent keeps verdicts, never the browsing.
Parallel subagents would mean parallel tabs — the exact pattern the pacing rule forbids. The
parent blocks on each subagent; a backgrounded pass gets killed by print-mode timeouts and the
run never reaches M3. A subagent that dies or returns nothing leaves that account QUEUED —
never a verdict inferred by the parent from a partial return.

**Restriction = stop.** Any LinkedIn restriction warning, verification challenge, or
"unusual activity" interstitial = stop ALL LinkedIn actions for the run and report it. Never
retry through it, never switch accounts, never continue on another tab.

**Degrade:** browser/extension unreachable or a Sales Navigator auth wall = connector flake —
one ~60s retry, then degrade: stop before enrollment, queue survivors with the checklist
above, report DEGRADED. Never a looser verification source, never an enrollment on
unverified routing.

## Sales Nav mechanics — proven traps

Mechanics for EXECUTING the pass, kept outside the section above so verdict semantics stay
quotable on their own. Each one was paid for in a real run.

1. **Verify the company entity before reading its people — scope by the structured company
   URN, never by name string.** Name scoping leaks rows from same-named orgs across
   countries. Quoted company-name search with `spellCorrectionEnabled:false` (correction
   silently substitutes a different company), click through to the account page, read the
   numeric id from the URL — never "the first company id in the DOM" (anchor order is not
   visual order). Corroborate the id against headcount + HQ + About first; a lookup that
   starts from the wrong entity produces a confident, fully-cited, wrong verdict.
2. **Never click a name/row in a roster — navigate directly to `/sales/lead/<id>`.** The
   Message icon sits beside the name link and list re-hydration moves elements under a
   stored ref; compose dialogs have opened by accident this way. Direct navigation never has.
3. **Title-filter absence claims are structurally unsafe.** CURRENT_TITLE matches the
   structured title token-by-token, not the headline: the acronym and the spelled-out form
   return different sets (probe BOTH, always), a company's own typo manufactures a zero, the
   seniority facet hides real C-levels, and a multi-word filter can drop SILENTLY (a filtered
   count equal to the unfiltered baseline = broken filter). Never run a filtered pass alone;
   pair every zero with a positive-control query; enumerate the FULL roster for small
   companies, the Director+ persona plus an unfiltered spot-check for larger ones.
4. **Scope text is invisible to every facet.** Role descriptions, About text, and concurrent
   roles are unsearchable; a SCOPE claim needs a profile view — spend one of the per-account
   views on the top seat of the function you sell.
5. **A hire can land under a non-obvious title,** invisible to every keyword facet. The
   recent-hire check reads the WHOLE senior roster for arrival recency + remit — and reads the
   TENURE FIGURE on the row, never the "Recently hired/promoted" badge (it fires on people
   years in role). Duplicate profiles and roster leakage (outside counsel returned as an
   employee) occur inside URN-scoped searches — count people, not rows.
6. **Read text, never screenshots.** `get_page_text` first; when it fails on the SPA's
   search/roster pages, fall back to `javascript_tool` + `document.body.textContent`
   (`innerText` cannot see hydrated rows). Rows hydrate only on scroll-into-view — scroll,
   wait, then read; keep per-call work small or the renderer wedges. Recover a wedged tab by
   closing and reopening it — that is NOT a LinkedIn restriction, do not degrade the run.
   Use `computer` screenshots only to LOCATE something you must click, never to READ.

## Store writes

Per account, via `lib/store.ts` (`setStatus()` stamps `status_since`):

- `status`: `dropped` | `triaged` | `routed` | `skipped` | `flagged`
- `route`: `DROPPED` | `QUALIFIED` | `SKIP` | `FLAGGED`
- `skip_reason` (SKIP only): free text — the disqualifier, the evidence, the raw pointer
- `drop_class` (DROPPED only): a slug from `config/icp.md` "## Drop classes"
- `verification`: `HEADLESS_3SOURCE` after the three sources; `SALES_NAV` only after the
  pass; `UNVERIFIED` is never written by M2
- `evidence_note`: one line — what decided it
- `raw_pointers`: every `raw/` path the verdict rests on
- `classification` (optional): a free string from `icp.md` tags; omit when none defined
- `triaged_at`: ISO date — the run record and reporting key off it

Every suppression decision gets an account file: a SKIP that lives only in `raw/` + prose
re-enters intake as NEW and costs a full re-verification. Never create an `account.yaml`
without `createAccountStub()` confirming it does not exist (check-then-write). Drops stay in
the store; nothing M2 writes touches the CRM directly.

## Output (to the orchestrator)

- Counts: pulled → dropped (by `drop_class`) / QUALIFIED / SKIP / FLAGGED, and how many
  hold at `triaged` behind a policy gate.
- The Sales Navigator pass result: lookups used vs cap, verdicts per account (confirm /
  flip / flag), accounts left in `queue/salesnav-pending.md`, and DEGRADED or RESTRICTED if
  either fired (with the reason).
- Ledger ids opened for FLAGGED accounts.
- Credits spent by source (job-text buys per survivor, Apollo 0-credit sweeps noted as such).
- Any new mismap domain proposed for `dedupe.exclusion_bug_domains`.
