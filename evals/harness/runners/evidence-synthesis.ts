// evals/harness/runners/evidence-synthesis.ts — M5 synthesis, as an eval.
//
// The production surface: M5 reads a per-domain raw set and writes accounts/<domain>/evidence.md
// (skills/m5-evidence-collector/SKILL.md §Synthesize — five sections, EVERY claim ending in a
// citation AND an evidence class, never promoting a class upward, `· sensitive` on anything
// invasive, and at least one grounded, recognizable instance in Angles). There is no enum
// verdict here, so this task is rubric-scored: a deterministic citation pre-check plus an LLM
// judge on the fixture's must/should checks (DESIGN.md §Tasks; GATED_METRICS gates
// must_pass_rate).
//
// THREE STAGES
//
//   1. GENERATE (model)   — the template quotes §Synthesize verbatim, plus config/icp.md (M5
//      reads it for what counts as fit, what disqualifies, and what an "angle" is), and asks
//      for a candidate evidence.md built from the fixture inputs ONLY. ONE adaptation of the
//      live contract is made explicit in the instruction: the fixture inputs stand in for
//      `raw/`, so every claim cites the INPUT PATH it derives from —
//      `[inputs/firecrawl-team.md · fact]` — not a raw/<domain>/<date> pointer. Everything
//      else about the citation contract (one citation per claim, the class vocabulary, no
//      upward promotion, `· sensitive`) is the live rule.
//
//   2. CITATION PRE-CHECK (no model) — deterministic, and the reason this runner is not just a
//      judge wrapper. Every claim block in the candidate must carry a citation whose path is
//      one of the fixture's DECLARED inputs and which names an evidence class. Each violation
//      (uncited block, unknown path, missing class) counts one `citation_violations` — a
//      REPORT metric, summed across fixtures by aggregateRubric.
//
//      SHORT-CIRCUIT RULE: if more than 20% of claim blocks carry no citation at all, every
//      must AND should check is failed without calling the judge. Rationale: the citation
//      contract is not one rubric line among many, it is the thing that makes an evidence.md
//      auditable — a document that ignores it is not evaluable on content, and asking a judge
//      to grade its prose would launder a contract failure into a partial pass. Failing loud
//      and skipping the judge also keeps a broken generation from costing judge credits.
//      A candidate that cites everything but cites it WRONGLY (unknown path / missing class)
//      does not short-circuit — it is still auditable, and the violations are reported.
//
//   3. JUDGE (model) — ONE call carrying the candidate, the fixture inputs, and every rubric
//      check (must + should), returning strict JSON {must:[{id,pass,why}], should:[...]}.
//      See "JUDGE BATCHING" below. Scored with scoreRubricChecks().
//
// JUDGE BATCHING — one call, not one per check. The evidence a judge needs (candidate +
// inputs) is identical for every check and dwarfs the check text, so N per-check calls cost
// ~N× for the same evidence. Crispness is preserved structurally rather than by isolation:
// each check is answered in its own object, keyed by the fixture's own check id, and the
// judge must quote the candidate line it judged in `why`. Ids are validated on the way back —
// a check the judge omitted, invented, or duplicated is scored FAIL with an explicit why,
// never silently dropped. The known cost is halo/order effects between checks within a call;
// if per-check variance ever shows up in --runs spread, the escalation path is to split must
// and should into two calls (or to chunk), not to abandon batching. Judge model:
// EVAL_JUDGE_MODEL, else DEFAULT_JUDGE_MODEL.
//
// REPLAY ENVELOPE — offline must be $0, so a replay has to cover BOTH model calls, and
// Replay.response is a single string. Convention (documented here because the type cannot
// express it): this runner serializes a JSON envelope into that string —
//
//     {"v": 1, "generation": "<candidate evidence.md>", "judgments": "<raw judge text>|null"}
//
// `judgments` is null when the pre-check short-circuited (no judge call was made, and replay
// must reproduce that). isReplayValid's semantics are unchanged and still do all the work: the
// envelope is keyed on fixture_sha + prompt_sha, and promptSha() here is the sha of BOTH
// templates joined (generate + judge), so editing either one invalidates the recorded pair —
// which is correct, since a judge-template edit changes what those judgments mean. Offline
// replays the recorded generation through the SAME deterministic pre-check (so a pre-check bug
// is caught offline) and re-parses the recorded judge text; neither stage calls a model.
import { readInputs } from "../loader.ts";
import { REPLAYS_DIR, loadValidReplay, makeReplay, writeReplay } from "../replay.ts";
import { composeTemplate, extractJsonObject, fenced, readSkillFile, sectionByPrefix, stripHtmlComments } from "../prompt.ts";
import { ICP_PATH } from "../icp.ts";
import { scoreRubricChecks } from "../scoring.ts";
import { DEFAULT_JUDGE_MODEL, DEFAULT_RUNNER_MODEL } from "../types.ts";
import type {
  Fixture,
  JudgeCheckResult,
  ModelClient,
  RubricCheck,
  Runner,
  RunnerResult,
  SynthesisJudgeVerdict,
} from "../types.ts";

export const TASK = "evidence-synthesis" as const;
export const SKILL_PATH = "skills/m5-evidence-collector/SKILL.md";
export const SECTION = "Synthesize";
export const EVIDENCE_CLASSES = ["fact", "inference", "hypothesis"] as const;
export const UNCITED_SHORT_CIRCUIT = 0.2; // >20% uncited claim blocks ⇒ not evaluable
export const REPLAY_ENVELOPE_VERSION = 1;

// ---------------------------------------------------------------------------
// Stage 1 — GENERATE template (live skill text + the one documented adaptation)
// ---------------------------------------------------------------------------

const GENERATE_PREAMBLE = `You are M5 of the prospect pipeline, in its SYNTHESIZE phase. GATHER is
already done: the complete captured raw set for one account is below, and you fetch nothing —
you write \`evidence.md\` from these inputs and nothing else. The contract below is the live M5
rulebook, quoted verbatim, followed by the operator's ICP (what counts as fit, what
disqualifies, and what an "angle" is for this offer).`;

const CITATION_ADAPTATION = `## Citation convention for this run (the ONE adaptation)

In production a citation points at the capture path, \`[raw/<domain>/<date> · class]\`. Here the
fixture inputs ARE the raw set, so cite the INPUT PATH the claim derives from, exactly as it is
listed under "Declared inputs" below:

    [inputs/firecrawl-team.md · fact]
    [inputs/posting-head-of-operations.md · inference]
    [inputs/firecrawl-homepage.md · inference · sensitive]

Nothing else about the contract changes. In particular:
- EVERY claim ends with a citation AND an evidence class — \`fact\`, \`inference\`, or \`hypothesis\`.
- The class is the class the CITED source actually supports. Never promote upward: if the
  source states it, \`fact\`; if it is your read of what the source suggests, \`inference\`; if it
  is plausible but the company would have to confirm it, \`hypothesis\`.
- Add \`· sensitive\` to any claim that would feel invasive, accusatory, or embarrassing if
  echoed back to the company.
- Cite ONLY paths from the declared-inputs list. Do not cite account.yaml, a CRM record, a URL,
  or any path not in that list — there is nothing else in evidence here.
- No claim without a pointer, and no padding: a claim you cannot ground in these inputs does
  not belong in the file.

Output the evidence.md content itself — markdown, starting at its first heading. No preamble,
no explanation of what you did, no code fence around the whole document.`;

// `skillMd` and `icpMd` are injectable so tests can prove an edit to either source moves the
// sha; production always reads the live files.
export function buildGenerateTemplate(
  skillMd: string = readSkillFile(SKILL_PATH),
  icpMd: string = readSkillFile(ICP_PATH),
): string {
  const icp = stripHtmlComments(icpMd).replace(/\n{3,}/g, "\n\n").trim();
  return composeTemplate([
    GENERATE_PREAMBLE,
    sectionByPrefix(skillMd, SECTION, SKILL_PATH),
    `IDEAL CUSTOMER PROFILE — quoted verbatim from ${ICP_PATH}.\n\n${icp}`,
    CITATION_ADAPTATION,
  ]).text;
}

// ---------------------------------------------------------------------------
// Stage 3 — JUDGE template
// ---------------------------------------------------------------------------

const JUDGE_TEMPLATE = `You are the rubric judge for the prospect pipeline's evidence-synthesis eval.

You are given: a CANDIDATE evidence.md produced by another model, the full set of INPUTS it was
allowed to use (the same ones it saw), and a list of rubric CHECKS. Decide each check
independently: does the candidate satisfy it?

Rules for judging:
- Judge the CANDIDATE against the CHECK and the INPUTS. There is no reference answer, and a
  check never requires the candidate to phrase things the way the check does.
- A check that asks for something specific is satisfied only if the candidate actually contains
  it. Do not credit a near-miss, a category where the check demands an instance, or a claim the
  inputs do not support.
- A check with several requirements passes only if ALL of them hold.
- Judge each check on its own. A weak candidate can still pass an easy check; a strong one can
  still fail a hard one.
- In \`why\`, quote the specific candidate line (or name the specific absence) that decided it.
  One or two sentences.

Reply with EXACTLY ONE JSON object and nothing else:

{"must": [{"id": "<check id>", "pass": true|false, "why": "..."}, ...],
 "should": [{"id": "<check id>", "pass": true|false, "why": "..."}, ...]}

Return one entry per check, with the check's EXACT id, in the order given. A missing or
misnamed id is scored as a failure, so answer every check.`;

export function buildJudgeTemplate(): string {
  return JUDGE_TEMPLATE;
}

// promptSha covers BOTH templates: a judge-template edit changes what a recorded judgment
// means just as surely as a generate-template edit changes what was asked, and either must
// invalidate the replay envelope.
export function buildTemplates(skillMd?: string, icpMd?: string): { generate: string; judge: string; sha: string } {
  const generate = buildGenerateTemplate(skillMd, icpMd);
  const judge = buildJudgeTemplate();
  return { generate, judge, sha: composeTemplate([generate, judge]).sha };
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

const declaredInputsBlock = (inputs: Array<{ role: string; path: string }>): string =>
  ["## Declared inputs (the only citable paths)", ...inputs.map((i) => `- \`${i.path}\` — role: ${i.role}`)].join("\n");

const inputsBlock = (inputs: Array<{ role: string; path: string; text: string }>): string =>
  inputs.map((i) => fenced(`INPUT ${i.path} (role: ${i.role})`, i.text, "markdown")).join("\n\n");

export function buildGeneratePrompt(fixture: Fixture, template: string): string {
  const inputs = readInputs(fixture);
  return [
    template,
    `## Account: ${fixture.provenance.domain}`,
    declaredInputsBlock(inputs),
    inputsBlock(inputs),
    "Now write the evidence.md.",
  ].join("\n\n");
}

export function buildJudgePrompt(fixture: Fixture, candidate: string, template: string): string {
  const inputs = readInputs(fixture);
  const rubric = fixture.rubric ?? { must: [], should: [] };
  const checkList = (label: string, checks: RubricCheck[]): string =>
    [`### ${label} checks`, ...checks.map((c) => `- id: \`${c.id}\`\n  ${c.text.trim().replace(/\n/g, "\n  ")}`)].join("\n");
  return [
    template,
    `## Account: ${fixture.provenance.domain}`,
    declaredInputsBlock(inputs),
    // The judge gets the inputs' TEXT, not just their paths: checks like "no claim is marked
    // with a higher evidence class than its source supports" or "names every executive on the
    // team page" are only verifiable against input content.
    inputsBlock(inputs),
    fenced("CANDIDATE evidence.md", candidate, "markdown"),
    "## Rubric",
    checkList("must", rubric.must),
    checkList("should", rubric.should),
    "Now emit the JSON judgement object.",
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Stage 2 — deterministic citation pre-check
// ---------------------------------------------------------------------------

export type CitationReport = {
  claim_blocks: number;
  cited: number;
  uncited: number;
  unknown_path: number;
  missing_class: number;
  violations: number;
  uncited_rate: number;
  short_circuit: boolean;
  examples: string[]; // first few offending blocks, truncated — for the report's details
};

// A "claim block" is one content-bearing unit of the candidate. Block boundaries follow the
// shape M5 actually writes: claims are one per line, each CLOSED BY ITS CITATION, sometimes
// with a second "Read: ..." claim and citation on the same line, and successive claims are not
// separated by blank lines. So:
//   - a blank line, heading, horizontal rule or table-separator row ends the current block;
//   - a bullet/numbered marker starts a new one;
//   - a citation at end of line CLOSES the block (this is what keeps wrapped prose and wrapped
//     bullets in one block instead of scoring their continuation lines as uncited claims);
//   - anything else accumulates.
// Consequence, accepted deliberately: an uncited line immediately followed by a cited one
// merges into that cited block, so this check UNDER-counts rather than over-counts uncited
// claims. Under-counting costs a little sensitivity; over-counting would short-circuit
// well-formed documents, which is the far worse failure.
// Excluded as STRUCTURAL, never counted: blank lines, headings, horizontal rules, fenced code,
// table separator rows, standalone bold labels (`**Company**`), blocks of fewer than 3 words.
export function extractClaimBlocks(md: string): string[] {
  const withoutFences = md.replace(/^```[\s\S]*?^```/gm, "");
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) blocks.push(current.join(" ").trim());
    current = [];
  };
  for (const raw of withoutFences.split("\n")) {
    const line = raw.trimEnd();
    if (
      line.trim() === "" ||
      /^\s*#{1,6}\s/.test(line) ||
      /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || // horizontal rule
      /^\s*\|[\s|:-]+\|\s*$/.test(line) // table separator row
    ) {
      flush();
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) flush(); // a new bullet starts a new block
    current.push(line.trim());
    if (/\]\s*$/.test(line)) flush(); // a citation closes the claim
  }
  flush();
  return blocks.filter((b) => !isStructural(b));
}

function isStructural(block: string): boolean {
  const text = block.replace(/^\s*([-*+]|\d+[.)])\s+/, "").trim();
  if (text === "") return true;
  if (/^\*\*[^*]{0,120}\*\*:?$/.test(text)) return true; // standalone bold label
  if (/^[_*~`>|\-\s]+$/.test(text)) return true;
  return text.split(/\s+/).filter(Boolean).length < 3;
}

// Bracketed spans that are citations, i.e. NOT markdown links (`[text](url)`) and not empty.
export function extractCitations(block: string): string[] {
  const out: string[] = [];
  const re = /\[([^\][]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    if (block[m.index + m[0].length] === "(") continue; // markdown link
    out.push(m[1].trim());
  }
  return out;
}

// Resolve `.` and `..` segments so a traversal spelling of a declared path compares equal to
// it: `inputs/../inputs/a.md` and `inputs/./a.md` both name inputs/a.md, and a raw string
// compare would call them unknown paths and charge a citation violation against a
// correctly-sourced claim. Traversal above the root collapses to the empty segment list, which
// matches nothing — an escape attempt stays an unknown path.
function normalizeSegments(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

const normPath = (p: string): string =>
  normalizeSegments(p.trim().replace(/^`|`$/g, "").toLowerCase());
const basename = (p: string): string => normPath(p).split("/").pop() ?? "";

// Split a citation on the interpunct the skill uses (`·`), tolerating the ASCII fallbacks a
// model may emit for it. First segment carries the path (plus, in production form, a date);
// later segments carry the evidence class and markers like `sensitive`.
export function parseCitation(citation: string): { path: string; classes: string[]; segments: string[] } {
  const segments = citation.split(/\s*[·•]\s*|\s+\|\s+/).map((s) => s.trim()).filter(Boolean);
  const head = segments[0] ?? "";
  const path = head.split(/\s+/)[0] ?? "";
  const classes = segments
    .slice(1)
    .map((s) => s.toLowerCase().replace(/[^a-z]/g, ""))
    .filter((s) => (EVIDENCE_CLASSES as readonly string[]).includes(s));
  return { path, classes, segments };
}

export function checkCitations(candidate: string, declaredPaths: string[]): CitationReport {
  const declared = new Set(declaredPaths.map(normPath));
  const declaredBases = new Set(declaredPaths.map(basename));
  const blocks = extractClaimBlocks(candidate);
  const report: CitationReport = {
    claim_blocks: blocks.length,
    cited: 0,
    uncited: 0,
    unknown_path: 0,
    missing_class: 0,
    violations: 0,
    uncited_rate: 0,
    short_circuit: false,
    examples: [],
  };

  for (const block of blocks) {
    const citations = extractCitations(block);
    if (citations.length === 0) {
      report.uncited += 1;
      if (report.examples.length < 5) report.examples.push(`uncited: ${block.slice(0, 160)}`);
      continue;
    }
    report.cited += 1;
    let classesInBlock = 0;
    for (const citation of citations) {
      const { path, classes } = parseCitation(citation);
      const p = normPath(path);
      classesInBlock += classes.length;
      // Path leniency: the declared path, or the same file named by basename. Anything else
      // (account.yaml, a URL, an invented raw/ pointer) is an unknown path — counted per
      // citation, since each pointer is separately checkable.
      if (!declared.has(p) && !declaredBases.has(basename(p))) {
        report.unknown_path += 1;
        if (report.examples.length < 5) report.examples.push(`unknown path: [${citation.slice(0, 120)}]`);
      }
    }
    // Class is checked per BLOCK, not per citation: the live convention hangs the class off
    // the LAST citation of a multi-source claim — `... [A.md] [B.md · fact]` — so requiring a
    // class on every pointer would flag correctly-formatted claims.
    if (classesInBlock === 0) {
      report.missing_class += 1;
      if (report.examples.length < 5) report.examples.push(`no evidence class: ${block.slice(0, 160)}`);
    }
  }

  report.violations = report.uncited + report.unknown_path + report.missing_class;
  report.uncited_rate = blocks.length === 0 ? 1 : report.uncited / blocks.length;
  // An empty candidate (no claim blocks at all) is the degenerate case of the same failure.
  report.short_circuit = blocks.length === 0 || report.uncited_rate > UNCITED_SHORT_CIRCUIT;
  return report;
}

// ---------------------------------------------------------------------------
// Judge parsing
// ---------------------------------------------------------------------------

// Map the judge's answers onto the fixture's checks BY ID. Unjudged, misnamed and duplicate
// ids fail with an explicit why — an unanswered check is never a pass.
export function alignJudgeResults(checks: RubricCheck[], answers: unknown): JudgeCheckResult[] {
  const rows = Array.isArray(answers) ? answers : [];
  const byId = new Map<string, JudgeCheckResult>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || byId.has(r.id)) continue;
    byId.set(r.id, { id: r.id, pass: r.pass === true, why: typeof r.why === "string" ? r.why : "" });
  }
  return checks.map(
    (c) => byId.get(c.id) ?? { id: c.id, pass: false, why: "judge returned no verdict for this check id" },
  );
}

export function parseJudge(response: string, rubric: { must: RubricCheck[]; should: RubricCheck[] }): SynthesisJudgeVerdict {
  const obj = extractJsonObject(response);
  if (obj === null) {
    const fail = (c: RubricCheck): JudgeCheckResult => ({ id: c.id, pass: false, why: "judge output was not parsable JSON" });
    return { must: rubric.must.map(fail), should: rubric.should.map(fail) };
  }
  return { must: alignJudgeResults(rubric.must, obj.must), should: alignJudgeResults(rubric.should, obj.should) };
}

// ---------------------------------------------------------------------------
// Replay envelope
// ---------------------------------------------------------------------------

export type Envelope = { v: number; generation: string; judgments: string | null };

export const encodeEnvelope = (generation: string, judgments: string | null): string =>
  JSON.stringify({ v: REPLAY_ENVELOPE_VERSION, generation, judgments });

// Returns null for anything that is not a well-formed envelope of THIS version — the caller
// treats that as a dead replay (skip with a reason offline), never as an empty candidate. The
// version field is enforced, not merely read: an envelope written by a future format must not
// be scored under today's assumptions about what `generation` and `judgments` mean.
export function decodeEnvelope(response: string): Envelope | null {
  try {
    const parsed = JSON.parse(response) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.generation !== "string") return null;
    if (parsed.v !== REPLAY_ENVELOPE_VERSION) return null;
    const judgments = parsed.judgments;
    if (judgments !== null && typeof judgments !== "string") return null;
    return { v: parsed.v, generation: parsed.generation, judgments };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export type RunnerOptions = {
  model?: string;
  judgeModel?: string;
  replaysDir?: string; // overridable so calibration runs never touch the committed corpus
};

const shortCircuitResults = (checks: RubricCheck[], rate: number): JudgeCheckResult[] =>
  checks.map((c) => ({
    id: c.id,
    pass: false,
    why: `citation pre-check short-circuit: ${(rate * 100).toFixed(0)}% of claim blocks carry no citation (cap ${UNCITED_SHORT_CIRCUIT * 100}%) — the document is not evaluable on content`,
  }));

// Same convention as the other runners: EVAL_REPLAY_DIR wins, else the committed corpus.
const defaultReplayDir = (): string => process.env.EVAL_REPLAY_DIR || REPLAYS_DIR;

export function createRunner(opts: RunnerOptions = {}): Runner {
  const model = opts.model ?? process.env.EVAL_MODEL ?? DEFAULT_RUNNER_MODEL;
  const judgeModel = opts.judgeModel ?? process.env.EVAL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;
  // Resolved per run, not at import time, so EVAL_REPLAY_DIR set after import still applies.
  const replaysDir = (): string => opts.replaysDir ?? defaultReplayDir();

  return {
    task: TASK,
    promptSha: () => buildTemplates().sha,
    async run(fixture: Fixture, client: ModelClient, offline: boolean): Promise<RunnerResult> {
      const { generate, judge, sha: promptSha } = buildTemplates();
      const rubric = fixture.rubric ?? { must: [], should: [] };
      const declaredPaths = fixture.inputs.map((i) => i.path);

      // --- stage 1: the candidate (live) or the recorded envelope (offline)
      let candidate: string;
      let judgeResponse: string | null;
      if (offline) {
        const replay = loadValidReplay(TASK, fixture.id, fixture.sha, promptSha, replaysDir());
        if (replay.response === undefined)
          return { skipped: true, skip_reason: replay.skip_reason, scores: {}, details: null };
        const envelope = decodeEnvelope(replay.response);
        if (!envelope)
          return {
            skipped: true,
            skip_reason: "replay is not a {generation, judgments} envelope — re-record it live",
            scores: {},
            details: null,
          };
        candidate = envelope.generation;
        judgeResponse = envelope.judgments;
      } else {
        candidate = await client.complete({ model, prompt: buildGeneratePrompt(fixture, generate) });
        judgeResponse = null;
      }

      // --- stage 2: deterministic citation pre-check (runs identically live and offline)
      const citations = checkCitations(candidate, declaredPaths);

      // --- stage 3: judge (skipped, live and offline, when the pre-check short-circuits)
      let verdict: SynthesisJudgeVerdict;
      if (citations.short_circuit) {
        verdict = {
          must: shortCircuitResults(rubric.must, citations.uncited_rate),
          should: shortCircuitResults(rubric.should, citations.uncited_rate),
        };
        judgeResponse = null;
      } else {
        if (!offline)
          judgeResponse = await client.complete({
            model: judgeModel,
            prompt: buildJudgePrompt(fixture, candidate, judge),
          });
        verdict =
          judgeResponse === null
            ? // Offline with a short-circuit envelope but a now-passing pre-check (or a
              // truncated recording): fail loud rather than invent verdicts.
              parseJudge("", rubric)
            : parseJudge(judgeResponse, rubric);
      }

      if (!offline)
        writeReplay(
          makeReplay({
            fixtureId: fixture.id,
            task: TASK,
            fixtureSha: fixture.sha,
            promptSha,
            model,
            response: encodeEnvelope(candidate, judgeResponse),
          }),
          replaysDir(),
        );

      const scores = scoreRubricChecks(verdict.must, verdict.should);
      scores.citation_violations = citations.violations;

      return {
        scores,
        details: {
          citations,
          must: verdict.must,
          should: verdict.should,
          candidate_chars: candidate.length,
          candidate_excerpt: candidate.slice(0, 2000),
        },
      };
    },
  };
}

export default createRunner();
