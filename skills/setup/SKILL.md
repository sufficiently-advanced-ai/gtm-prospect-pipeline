---
name: setup
description: >-
  Agent-led onboarding for gtm-prospect-pipeline. Interviews the operator, writes the three
  config files (signal.yaml, sequences.yaml, icp.md) from their answers, wires real Apollo
  sequence and field ids through the connector, sizes the signal pool at zero cost, and
  leaves the repo ready for a first batch. USE WHEN the repo is freshly cloned, when
  `node scripts/setup-check.ts` reports todos, or when the operator asks to add a signal or
  a sequence. Idempotent — re-running only touches what is still missing.
---

# /setup — from clone to first batch

**Reads** `scripts/setup-check.ts` output, the operator's answers, and the Apollo and
TheirStack connectors (read-only calls, zero-credit where the API offers one). **Writes**
the env file, the data directory skeleton, and the three config files. **Never** enrolls,
sends, activates a sequence, or spends a billed credit. Every write is shown to the operator
before it lands.

Run `node scripts/setup-check.ts` first and again after each step. Work only on lines that
are `todo` or `FAIL`; skip anything already `ok`. Each step ends by re-running the check.

## Step 1 — environment (no questions)

1. Node 24+ present. If not, stop with the install instruction.
2. Env file at `~/.config/gtm-prospect-pipeline/env`, mode 600, with `PIPELINE_DATA` set.
   Default `~/Data/gtm-prospect-pipeline`. Ask only if the operator wants the data somewhere
   else (a synced folder is a good answer; say why: two machines can share one store).
3. Create `raw/ accounts/ queue/ logs/` under `PIPELINE_DATA`.
4. Connectors: confirm the Apollo and TheirStack MCP tools are present in this session
   (`apollo_users_api_profile`, `get_billing_credit_balance` — both free). Report the
   Apollo plan and TheirStack credit balance. If a connector is missing, say which, link to
   its MCP setup, and continue — the rest of setup does not need it.
5. Optional CRM: if the operator has a Twenty instance, add `TWENTY_BASE_URL` and
   `TWENTY_API_KEY` to the env file (never echo the key back) and confirm reachability.
   Otherwise say M8 will be a no-op and move on.
6. Optional browser: ask whether Claude-in-Chrome is installed with a logged-in Sales
   Navigator session. Record the answer; it decides whether
   `policy.require_salesnav_before_route` may be `true` in step 3.

## Step 2 — the ICP interview → `config/icp.md`

Ask these, one at a time, in the operator's language. Short answers are fine; you will
expand them. Do not lead the witness with examples from any specific industry.

1. Who do you sell to? Company size band, geography, ownership type, industry if it matters.
2. What do you sell, in one sentence, and what is the buyer doing when they need it?
3. What is the buying signal — the observable public event that says "now"? A job posting?
   A title that just opened? A technology adopted? A funding event? Something else?
4. What single fact would make you not want to contact a company even if the signal fired?
   (This becomes the SKIP disqualifier. Push for the account-level version: "if X is already
   true at the company, skip the whole company".)
5. What kinds of companies show up in your searches that are never a fit? (Vendors of the
   thing you sell, agencies, staffing firms, public sector, companies too big or too small…)
   Each one becomes a drop class.
6. What looks like a match but isn't? (A mention in a client list. A course syllabus. A
   subsidiary of a mega-corp.) Each becomes a known false positive.
7. Is there anything you'd want to tag on a qualified account for later sorting? (Optional
   classification tags.)

Write `config/icp.md` from the answers, keeping the file's section structure and the
machine-read `## Drop classes` list (`- slug — description`, snake_case slugs). Show the
full file, ask for corrections, write it. Tell the operator this file is theirs: every
future ruling gets appended to `## Rulings log` and turned into an eval fixture.

## Step 3 — the signal → `config/signal.yaml`

From interview answers 1 and 3:

1. Pick the connector. Job-posting language → TheirStack `search_companies` block. Open
   title → Apollo `apollo_mixed_companies_search` block. Manual list → label-only block.
2. Draft the block: `name`, the regex (`(?i)`, word boundaries, alternation; explain that a
   bare common word will match names of people), country, size band, `posted_at_max_age_days`,
   `company_type: direct_employer`. Leave `industry_id_not` empty — say it is tuned later from
   measured drops, never guessed.
3. Size the pool at zero cost: TheirStack `search_companies` with the block's filters plus
   `blur_company_data: true`, `include_total_results: true`, `limit: 1`. Report the total.
   Under ~20 → loosen (age, regex, size). Over ~500 → tighten, or the first pull will be
   expensive noise. Iterate with the operator until the number feels like a week of work.
4. Dedupe list: `get_company_lists` on TheirStack. If a "Companies seen" list exists, use its
   id; otherwise tell the operator to create one in the TheirStack app (there is no create
   tool) and paste the id. Write it to `dedupe.company_list_id`.
5. Policy: `require_salesnav_before_route: true` only if step 1.6 said a browser is
   available. `push_to_crm_after: routed` unless the operator wants the CRM to see accounts
   only once enrolled.
6. Write the file, run `node lib/sequence-resolver.ts --validate`.

## Step 4 — the sequence → `config/sequences.yaml`

1. `apollo_emailer_campaigns_search` — list the operator's sequences with id, name, active
   state, contact count. Ask which one this signal feeds, or whether to create a new one.
   If new: `apollo_sequences_create` with `active: false` and a name they give; the copy is
   written in Apollo by them, later.
2. Write the sequence entry: real `id`, `name`, `status: draft`, `binds: {signals: [<key>]}`.
   Say plainly: it stays `draft` until they have approved the copy, and draft means the first
   batches qualify and stage but hold at `routed`. That is the lifecycle, not a bug.
3. Sender: `apollo_email_accounts_index` — show the linked mailboxes and their daily limits.
   Write `enrollment.sender`, and set `caps.mailbox_daily` to match the Apollo limit, never
   above it. If the mailbox is under warm-up, say so and keep the cap low.
4. Suppression: `apollo_labels_index` / lists — confirm the DNC list name exists or tell the
   operator to create it in Apollo. Write `suppression.apollo_dnc_list`.
5. Merge fields: ask what the copy will personalize on (default: the posting title). For each,
   `apollo_fields_index` to find an existing contact custom field or create one via the
   connector; write `apollo_field_id`, `value` (how M3 sources it), `signals`, and
   `renders_in_copy`. Explain the retroactivity rule once: a field added to live copy breaks
   every already-enrolled contact, so fields are created before copy references them.
6. Caps: show the defaults and ask whether to lower them for the first weeks. Never raise
   `mailbox_daily` above the Apollo mailbox setting.
7. Write the file, run `node lib/sequence-resolver.ts --validate`, then
   `node lib/sequence-resolver.ts <any-domain>` to show the operator what HOLD looks like.

## Step 5 — prove it

1. `npm test` and `bash scripts/check-evals.sh` — both must pass; the shipped fixtures are
   synthetic, and the check confirms the skill text and config still agree with them.
2. `node scripts/setup-check.ts` — expect no `FAIL`, and only the sequence-placeholder
   `todo`s that draft status permits.
3. Offer a dry first batch: `/pipeline-batch` now will pull, qualify, verify, and stage; with
   every sequence in `draft` nothing can be enrolled. Show the operator where to look
   afterwards: `$PIPELINE_DATA/registry.md`, `queue/decisions.jsonl` via
   `node skills/m7-recorder-sync/scripts/decisions.ts list`, and the dashboard via
   `npm run dashboard`.

## Closing summary

Print, in this order: what was written (files, keys), what is still `todo`, the three
commands they will run most (`/pipeline-batch`, `decisions.ts list`, `/m4-go-live`), and
the one-line reminder that the sequence goes `active` only by their edit to
`config/sequences.yaml` after the copy is approved.

## Rules

- Zero billed credits during setup. Preflight counts and list reads only.
- Never activate a sequence, never enroll, never unpause.
- Never write a key or token into the repo or into chat output.
- Show every config file in full before writing it; write only after a yes.
- Re-running `/setup` on a configured repo asks nothing already answered.
