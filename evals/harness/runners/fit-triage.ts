// evals/harness/runners/fit-triage.ts — the fit-triage task runner.
//
// DESIGN.md: "Prompts come from the live skill text ... Never paraphrase skill text into the
// runner; quote it." The template is the role preamble + the VERBATIM "Fit triage" section of
// skills/m2-triage-route/SKILL.md (HOW to triage) + the whole of config/icp.md (WHAT a fit is
// — the drop classes and the operator's judgment live there, not in the skill) + the task
// instruction + a strict JSON output contract matching FitTriageVerdict. promptSha() is the
// sha of exactly that template (fixture inputs excluded), so an edit to either source shows
// up as a sha change, kills the stale replays, and gets its effect measured.
import { composeTemplate, extractJsonObject, fenced, readIcp, readSkillFile, sectionByPrefix, stripHtmlComments } from "../prompt.ts";
import { CONTRACT_HEADER, INPUTS_ONLY_RULE, reasonFirstProtocol } from "../contract.ts";
import { ICP_PATH, parseDropClasses } from "../icp.ts";
import { readInputs } from "../loader.ts";
import { recordingClient } from "../model.ts";
import { REPLAYS_DIR, loadValidReplay } from "../replay.ts";
import { scoreEnumFixture } from "../scoring.ts";
import { DEFAULT_RUNNER_MODEL } from "../types.ts";
import type { Fixture, ModelClient, Runner, RunnerResult } from "../types.ts";

export const TASK = "fit-triage";
export const SKILL_PATH = "skills/m2-triage-route/SKILL.md";
export const SECTION = "Fit triage"; // heading prefix — the parenthetical may be edited freely

const MAX_EXCERPT = 2000;

// Replays live in evals/replays/<task>/ unless EVAL_REPLAY_DIR overrides it (tests and
// pre-promotion calibration runs write elsewhere so the committed corpus is never touched).
// Read at call time, never at import time, so a test can set it after importing.
const replayDir = (): string => process.env.EVAL_REPLAY_DIR || REPLAYS_DIR;

const PREAMBLE = `You are executing module M2 of the prospect pipeline (skills/m2-triage-route),
the fit-triage step: deciding whether a company pulled by the signal is worth spending
verification effort on, or should be dropped before anything is spent.`;

const INSTRUCTION = `TASK: apply the fit-triage procedure and the ICP above to the single company described in
the INPUTS below, and emit the fit-triage verdict.

Rules for this judgment:
- ${INPUTS_ONLY_RULE.replace(/\n/g, "\n  ")}
- Structured fields lie. Source industry tags, stored descriptions and boolean flags are
  frequently stale or wrong; where a homepage or job-posting capture contradicts them, the
  capture is the better evidence.
- Judge the company that owns THIS domain. If the postings or evidence in the inputs belong
  to a different company (name collision, foreign ATS host, unrelated location or business),
  that is a source mismap, not a signal.
- Decide; do not hedge. There is no "unsure" value in the contract.
- Reason it out before you label it, and make the labels say what the reasoning concluded —
  see the OUTPUT PROTOCOL below. (Should a reply nonetheless contain more than one JSON
  object, the LAST object carrying a "decision" key is the answer that gets scored — but emit
  exactly one.)`;

function outputContract(classes: Array<{ slug: string; description: string }>): string {
  const slugs = classes.map((c) => `"${c.slug}"`).join(" | ");
  const glossary = classes.map((c) => `  - "${c.slug}" — ${c.description}`).join("\n");
  return `${CONTRACT_HEADER}

{
  "decision": "keep" | "drop",
  "drop_class": ${slugs} | null,
  "rationale": "<one or two sentences citing the specific evidence that decided it>"
}

Field semantics:
- "decision": "drop" removes the company from the pipeline; "keep" sends it on to the
  Identity + 3-source verification step.
- "drop_class": REQUIRED on a "drop" and must be exactly one of the classes ${ICP_PATH} lists
  under "## Drop classes", spelled exactly as shown; null on a "keep":
${glossary}
- Classify by what the company IS, not by the vertical its marketing copy names.`;
}

// Compose the prompt TEMPLATE (inputs excluded). `skillMd` and `icpMd` are injectable so tests
// can prove an edit to either source moves the sha; production always reads the live files.
export function buildTemplate(
  skillMd: string = readSkillFile(SKILL_PATH),
  icpMd: string = readSkillFile(ICP_PATH),
): { text: string; sha: string } {
  const fitTriage = sectionByPrefix(skillMd, SECTION, SKILL_PATH);
  const classes = parseDropClasses(icpMd);
  const icp = stripHtmlComments(icpMd).replace(/\n{3,}/g, "\n\n").trim();
  return composeTemplate([
    PREAMBLE,
    `PRODUCTION PROCEDURE — quoted verbatim from ${SKILL_PATH}. This is HOW the step is done.

${fitTriage}`,
    `IDEAL CUSTOMER PROFILE — quoted verbatim from ${ICP_PATH}. This is WHAT a fit is: it names
the drop classes and the judgment behind them, and it outranks any general instinct about
what a good prospect looks like.

${icp}`,
    INSTRUCTION,
    reasonFirstProtocol("work the procedure and the ICP above against the evidence: what the evidence establishes,\n   which drop class (if any) governs it, and what the ICP therefore concludes"),
    outputContract(classes),
  ]);
}

// Full model prompt = template + the fixture's inputs, each labeled by role and fenced.
export function composePrompt(fixture: Fixture, template: string = buildTemplate().text): string {
  const blocks = readInputs(fixture).map((i) =>
    fenced(`INPUT (role: ${i.role}, file: ${i.path})`, i.text, i.path.endsWith(".json") ? "json" : "markdown"),
  );
  return [template, `INPUTS — the complete evidence for one company:\n\n${blocks.join("\n\n")}`].join("\n\n");
}

// Exported for callers that need the live ICP text without the skill (seeding, reports).
export { readIcp };

const excerpt = (raw: string): string =>
  raw.length > MAX_EXCERPT ? `${raw.slice(0, MAX_EXCERPT)}…[truncated ${raw.length - MAX_EXCERPT} chars]` : raw;

// Parse + score one raw model response. Parse failure = wrong answer (correct: 0), never a
// skip, with the raw response kept in details (DESIGN.md).
function scoreResponse(fixture: Fixture, raw: string): RunnerResult {
  // preferKeyed = this task's primary field: a self-corrected double answer scores the
  // model's FINAL decision, not the one it retracted (prompt.ts extractJsonObject).
  const verdict = extractJsonObject(raw, "decision");
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
