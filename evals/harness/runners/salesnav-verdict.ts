// evals/harness/runners/salesnav-verdict.ts — the Sales Navigator verification pass, as an eval.
//
// The production surface: M2's standing Sales Navigator pass reads a broad Director+VP+C-level
// sweep for one account and returns confirm / flip-to-SKIP / flag with the named evidence (see
// skills/m2-triage-route/SKILL.md §"Sales Nav pass" — each account lookup "returns ONLY a
// structured verdict (confirm / flip-to-SKIP / flag, with the named evidence)"). This runner
// evaluates exactly that judgment with the browsing already done: the fixture carries the
// captured notes (verdict stripped), the per-domain queue checklist the subagent would have
// been handed, and — when the fixture has one — the Apollo sweep the checklist was built from.
//
// Prompt provenance (DESIGN.md: "Prompts come from the live skill text ... never a
// paraphrase"): the template quotes, verbatim, two live sections of M2's SKILL.md —
//   1. §"Routing = classification" — SKIP is binary and account-level; FLAGGED never guesses
//   2. §"Sales Nav pass"           — the sweep itself and the three verdict branches
// plus the whole of config/icp.md (the disqualifiers and the scope-over-string test) and a
// strict-JSON output contract for SalesNavVerdict. Anything else the model needs it must read
// out of the fixture inputs.
//
// Scoring is scoreEnumFixture(): exact match on `verdict` (gated accuracy), `evidence_names`
// as recall (reported), forbidden traps absolute. An unparseable response scores as wrong,
// never as a skip (DESIGN.md).
import { readInput, requireInput } from "../loader.ts";
import { makeReplay, loadValidReplay, writeReplay, REPLAYS_DIR } from "../replay.ts";
import { composeTemplate, extractJsonObject, fenced, readSkillFile, sectionByPrefix, stripHtmlComments } from "../prompt.ts";
import { CONTRACT_HEADER, reasonFirstProtocol } from "../contract.ts";
import { ICP_PATH } from "../icp.ts";
import { scoreEnumFixture } from "../scoring.ts";
import { DEFAULT_RUNNER_MODEL, SALESNAV_VERDICTS } from "../types.ts";
import type { Fixture, ModelClient, Runner, RunnerResult } from "../types.ts";

export const TASK = "salesnav-verdict" as const;
export const SKILL_PATH = "skills/m2-triage-route/SKILL.md";
export const SECTIONS = { routing: "Routing = classification", salesnav: "Sales Nav pass" };

const PREAMBLE = `You are the per-account Sales Navigator verification subagent from M2 of the prospect
pipeline. The browsing for this account is already done and captured; your job is the judgment
the pass returns. The rules below are the live M2 rulebook and the operator's ICP, quoted
verbatim — follow them, not your own priors about what a title means.`;

const CONTRACT = `## Your task

You are given, for ONE account:
- the per-domain queue checklist handed to this lookup (the PRE-pass state: named execs to
  verify current, the absence claims to test, and the recent-hire question),
- the Sales Navigator notes captured during the sweep, verbatim, with the pass's own verdict
  removed,
- and, when one was staged, the Apollo Director+/VP+/C-level sweep the checklist was built from.

Decide the verdict this lookup returns, applying the three branches above:
- "confirm"      — the sweep confirms the absence claim: no sitting owner of the function the
                   ICP names at the ranks it names (scope-verified, not title-string-matched).
                   The provisional route stands.
- "flip_to_skip" — a disqualifier per the ICP IS present and confirmed: SKIP, binary,
                   account-level.
- "flag"         — ambiguous or conflicting evidence. Never guess.

Read the FULL career/profile detail in the notes before letting any title decide: the ICP's
scope-over-string test is why a senior or function-adjacent title string alone never settles
this, in either direction. Answer only from the inputs; never invent a person, a title or a
tenure the notes do not carry.

${reasonFirstProtocol("work the rules above against the evidence: what the notes establish about each person the\n   call could turn on, which rule governs, and what that rule therefore concludes")}

${CONTRACT_HEADER}

{"verdict": ${SALESNAV_VERDICTS.map((v) => `"${v}"`).join(" | ")},
 "evidence_names": ["Full Name", ...],
 "rationale": "one or two sentences"}

evidence_names: the people whose titles or scope DECIDE the verdict, named as the notes name
them. Not the whole roster — the person or people the call turns on.`;

// `skillMd` and `icpMd` are injectable so tests can prove an edit to either source moves the
// sha; production always reads the live files.
export function buildTemplate(
  skillMd: string = readSkillFile(SKILL_PATH),
  icpMd: string = readSkillFile(ICP_PATH),
): { text: string; sha: string } {
  const icp = stripHtmlComments(icpMd).replace(/\n{3,}/g, "\n\n").trim();
  return composeTemplate([
    PREAMBLE,
    `The following two sections are quoted verbatim from ${SKILL_PATH}.`,
    sectionByPrefix(skillMd, SECTIONS.routing, SKILL_PATH),
    sectionByPrefix(skillMd, SECTIONS.salesnav, SKILL_PATH),
    `IDEAL CUSTOMER PROFILE — quoted verbatim from ${ICP_PATH}. The disqualifiers and the
scope-over-string test the sections above refer to are defined here.

${icp}`,
    CONTRACT,
  ]);
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

export function buildPrompt(fixture: Fixture, template: string): string {
  const parts = [
    template,
    `## Account under verification: ${fixture.provenance.domain}`,
    fenced("QUEUE CHECKLIST (pre-pass)", requireInput(fixture, "checklist"), "markdown"),
    fenced("SALES NAVIGATOR NOTES (captured during the sweep)", requireInput(fixture, "salesnav"), "markdown"),
  ];
  const apollo = readInput(fixture, "apollo_sweep");
  if (apollo) parts.push(fenced("APOLLO DIRECTOR+/VP+/C-LEVEL SWEEP (the pre-pass roster)", apollo, "json"));
  parts.push("Now write your REASONING, then emit the single JSON verdict object.");
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export type RunnerOptions = {
  model?: string;
  replaysDir?: string; // overridable so calibration runs never touch the committed corpus
};

// Replays live in evals/replays/ (committed). EVAL_REPLAY_DIR — the convention the other
// runners use — redirects BOTH the offline read and the live recording; the explicit
// `replaysDir` option wins over it, for tests that need a per-case dir.
const defaultReplayDir = (): string => process.env.EVAL_REPLAY_DIR || REPLAYS_DIR;

export function createRunner(opts: RunnerOptions = {}): Runner {
  const model = opts.model ?? process.env.EVAL_MODEL ?? DEFAULT_RUNNER_MODEL;
  // Resolved per run, not at import time, so EVAL_REPLAY_DIR set after import still applies.
  const replaysDir = (): string => opts.replaysDir ?? defaultReplayDir();

  return {
    task: TASK,
    promptSha: () => buildTemplate().sha,
    async run(fixture: Fixture, client: ModelClient, offline: boolean): Promise<RunnerResult> {
      const { text: template, sha: promptSha } = buildTemplate();
      const prompt = buildPrompt(fixture, template);

      let response: string;
      if (offline) {
        const replay = loadValidReplay(TASK, fixture.id, fixture.sha, promptSha, replaysDir());
        if (replay.response === undefined)
          return { skipped: true, skip_reason: replay.skip_reason, scores: {}, details: null };
        response = replay.response;
      } else {
        response = await client.complete({ model, prompt });
        writeReplay(
          makeReplay({
            fixtureId: fixture.id,
            task: TASK,
            fixtureSha: fixture.sha,
            promptSha,
            model,
            response,
          }),
          replaysDir(),
        );
      }

      // preferKeyed = this task's primary field, so a self-corrected double answer scores the
      // model's FINAL verdict rather than the one it retracted (prompt.ts extractJsonObject).
      const verdict = extractJsonObject(response, "verdict");
      const scores = scoreEnumFixture(fixture, verdict);
      return {
        scores,
        details: {
          verdict,
          gold: fixture.gold,
          parse_failure: verdict === null,
          raw: verdict === null ? response.slice(0, 2000) : undefined,
        },
      };
    },
  };
}

export default createRunner();
