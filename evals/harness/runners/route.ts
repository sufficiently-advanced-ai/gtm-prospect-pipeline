// evals/harness/runners/route.ts — the route (account classification) task runner.
//
// The verdict vocabulary is QUALIFIED | SKIP | FLAGGED (types.ts ROUTE_VALUES): SKIP is a
// confirmed disqualifier per config/icp.md, binary and account-level; FLAGGED is the
// never-guess branch. The verdict also names the people the call turns on (`evidence_names`,
// scored as recall, reported only).
//
// DESIGN.md: "Prompts come from the live skill text ... Never paraphrase skill text into the
// runner; quote it." The template is the role preamble + VERBATIM quotes from
// skills/m2-triage-route/SKILL.md — "Identity + 3-source verification", "Routing =
// classification", and the verdict-deciding sweep paragraph of "Sales Nav pass" — plus the
// whole of config/icp.md (the disqualifiers and the scope-over-string test live there), the
// task instruction, and a strict JSON contract matching RouteVerdict. promptSha() is the sha
// of exactly that template (fixture inputs excluded): edit either source and the sha moves,
// the replays die, and the effect on accuracy is measured rather than assumed.
import { composeTemplate, extractJsonObject, fenced, readSkillFile, sectionByPrefix, stripHtmlComments } from "../prompt.ts";
import { CONTRACT_HEADER, INPUTS_ONLY_RULE, reasonFirstProtocol } from "../contract.ts";
import { ICP_PATH } from "../icp.ts";
import { readInputs } from "../loader.ts";
import { recordingClient } from "../model.ts";
import { REPLAYS_DIR, loadValidReplay } from "../replay.ts";
import { scoreEnumFixture } from "../scoring.ts";
import { DEFAULT_RUNNER_MODEL, ROUTE_VALUES } from "../types.ts";
import type { Fixture, ModelClient, Runner, RunnerResult } from "../types.ts";

export const TASK = "route";
export const SKILL_PATH = "skills/m2-triage-route/SKILL.md";

// Heading prefixes — the trailing parenthetical of each heading may be edited freely; losing
// the section NAME fails the run loudly.
export const SECTIONS = {
  identity: "Identity + 3-source verification",
  routing: "Routing = classification",
  salesnav: "Sales Nav pass",
};
// Markers bounding the verdict-deciding part of the Sales Nav section. The rest of that
// section is execution procedure (caps, pacing, capture, degrade) and carries no routing rule.
export const SWEEP_START = "**The sweep:**";
export const SWEEP_END = "**Cap + pacing:**";

const MAX_EXCERPT = 2000;

const replayDir = (): string => process.env.EVAL_REPLAY_DIR || REPLAYS_DIR;

// Verbatim slice of a section: from `start` up to (excluding) `end`. Throws when the markers
// are gone — same fail-loud contract as a missing section.
export function sliceBetween(text: string, start: string, end: string, what: string): string {
  const from = text.indexOf(start);
  if (from === -1) throw new Error(`${SKILL_PATH}: ${what} — marker not found: ${JSON.stringify(start)}`);
  const rest = text.slice(from);
  const to = rest.indexOf(end, start.length);
  if (to === -1) throw new Error(`${SKILL_PATH}: ${what} — end marker not found: ${JSON.stringify(end)}`);
  return rest.slice(0, to).trimEnd();
}

const PREAMBLE = `You are executing module M2 of the prospect pipeline (skills/m2-triage-route),
the routing step: classifying one account from the verification evidence already captured
for it.`;

const OUTPUT_CONTRACT = `${CONTRACT_HEADER}

{
  "route": ${ROUTE_VALUES.map((v) => `"${v}"`).join(" | ")},
  "evidence_names": ["Full Name", ...],
  "rationale": "<one or two sentences naming the people and titles that decided it>"
}

The three route values, spelled exactly as shown:
- "QUALIFIED" — the fit-passed survivor branch: no disqualifier from the ICP in evidence. An
  OPEN, unfilled posting for the owner seat is a buying signal, not a sitting owner.
- "SKIP" — a disqualifier from the ICP is confirmed by a captured source. Binary and
  account-level: one confirmed disqualifier suppresses the whole account.
- "FLAGGED" — conflicting or thin evidence per the ICP. Never guess.

evidence_names: the people whose titles or scope DECIDE the classification, named as the
inputs name them. Not the whole roster — the person or people the call turns on. An empty
list is valid only when no person decides it (a confirmed absence).`;

const INSTRUCTION = `TASK: apply the rules above to the single account whose evidence appears in
the INPUTS below, and emit the route verdict.

Rules for this judgment:
- ${INPUTS_ONLY_RULE.replace(/\n/g, "\n  ")}
- \`route\` is a CLASSIFICATION ONLY. It does not select a sequence, and it is not a judgment of
  how good a prospect the account is. Classify honestly on the evidence.
- SKIP is binary and account-level: one sitting, confirmed owner of the function the ICP names
  decides it, however recently hired or promoted, and however attractive the rest of the
  account looks. Conversely, a title string is not a disqualifier until the person's actual
  SCOPE at this company says so — read the described remit, apply the ICP's corroboration
  test, and treat titles the ICP says do not count as not counting.
- FLAGGED is for evidence that is genuinely conflicting or genuinely thin — never a way to
  avoid committing to a call the evidence supports, and never a place to park an account
  merely because it sits outside some segment definition. A confirmed absence, swept for and
  found genuinely empty, is a route, not a flag.
- Where sources disagree, prefer the one that actually looked: a broad seniority sweep with
  full-profile reads beats a stale index or an exact-title query that returned nothing. Two
  captured sources that genuinely contradict each other about who holds the seat is FLAGGED.
- Reason it out before you label it, and make the label say what the reasoning concluded —
  see the OUTPUT PROTOCOL below. (Should a reply nonetheless contain more than one JSON
  object, the LAST object carrying a "route" key is the answer that gets scored — but emit
  exactly one.)`;

// Compose the prompt TEMPLATE (inputs excluded). `skillMd` and `icpMd` are injectable so tests
// can prove an edit to either source moves the sha; production always reads the live files.
export function buildTemplate(
  skillMd: string = readSkillFile(SKILL_PATH),
  icpMd: string = readSkillFile(ICP_PATH),
): { text: string; sha: string } {
  const identity = sectionByPrefix(skillMd, SECTIONS.identity, SKILL_PATH);
  const routing = sectionByPrefix(skillMd, SECTIONS.routing, SKILL_PATH);
  const sweep = sliceBetween(
    sectionByPrefix(skillMd, SECTIONS.salesnav, SKILL_PATH),
    SWEEP_START,
    SWEEP_END,
    "Sales Nav sweep verdicts",
  );
  const icp = stripHtmlComments(icpMd).replace(/\n{3,}/g, "\n\n").trim();

  return composeTemplate([
    PREAMBLE,
    `PRODUCTION PROCEDURE — quoted verbatim from ${SKILL_PATH}. These are the rules you apply;
they outrank any general instinct about titles.

${identity}

${routing}

From "${SECTIONS.salesnav}" — what the seniority sweep confirms or flips:

${sweep}`,
    `IDEAL CUSTOMER PROFILE — quoted verbatim from ${ICP_PATH}. The disqualifiers, the
scope-over-string test, and the conflicting-or-thin thresholds the rules above refer to are
defined here.

${icp}`,
    INSTRUCTION,
    reasonFirstProtocol("work the rules above against the evidence: what the evidence establishes about each person\n   the call could turn on, which rule governs, and what that rule therefore concludes"),
    OUTPUT_CONTRACT,
  ]);
}

// Full model prompt = template + the fixture's inputs, each labeled by role and fenced.
export function composePrompt(fixture: Fixture, template: string = buildTemplate().text): string {
  const blocks = readInputs(fixture).map((i) =>
    fenced(`INPUT (role: ${i.role}, file: ${i.path})`, i.text, i.path.endsWith(".json") ? "json" : "markdown"),
  );
  return [template, `INPUTS — the complete evidence for one account:\n\n${blocks.join("\n\n")}`].join("\n\n");
}

const excerpt = (raw: string): string =>
  raw.length > MAX_EXCERPT ? `${raw.slice(0, MAX_EXCERPT)}…[truncated ${raw.length - MAX_EXCERPT} chars]` : raw;

// Parse + score one raw model response. Parse failure = wrong answer (correct: 0), never a
// skip, with the raw response kept in details (DESIGN.md).
function scoreResponse(fixture: Fixture, raw: string): RunnerResult {
  // preferKeyed = this task's primary field: a self-corrected double answer scores the
  // model's FINAL route, not the one it retracted (prompt.ts extractJsonObject).
  const verdict = extractJsonObject(raw, "route");
  return {
    scores: scoreEnumFixture(fixture, verdict),
    details: {
      verdict,
      gold: fixture.gold ?? null,
      raw_response_excerpt: excerpt(raw),
      parse_ok: verdict !== null,
    },
  };
}

export const runner: Runner = {
  task: TASK,
  promptSha: () => buildTemplate().sha,

  async run(fixture: Fixture, client: ModelClient, offline: boolean): Promise<RunnerResult> {
    const template = buildTemplate();
    const prompt = composePrompt(fixture, template.text);

    if (offline) {
      const { response, skip_reason } = loadValidReplay(TASK, fixture.id, fixture.sha, template.sha, replayDir());
      if (response === undefined) return { skipped: true, skip_reason, scores: {}, details: null };
      return scoreResponse(fixture, response);
    }

    const model = process.env.EVAL_MODEL || DEFAULT_RUNNER_MODEL;
    const recording = recordingClient(
      client,
      { task: TASK, fixtureId: fixture.id, fixtureSha: fixture.sha, promptSha: template.sha, model },
      replayDir(),
    );
    const raw = await recording.complete({ model, prompt });
    return scoreResponse(fixture, raw);
  },
};

export default runner;
