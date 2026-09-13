// Offline tests for the salesnav-verdict and evidence-synthesis runners.
// No network and no model calls: every client is a mock, every fixture is either a synthetic
// selftest fixture (evals/fixtures/selftest/) or a tmp copy of one, and every replay written
// goes to a tmp dir — the committed corpus under evals/replays/ is never touched.
// Run: npm test (or node test/runners-verdict-synthesis.test.ts)
import { strict as assert } from "node:assert";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllFixtures } from "../evals/harness/loader.ts";
import { ICP_PATH } from "../evals/harness/icp.ts";
import { offlineGuardClient } from "../evals/harness/model.ts";
import { composeTemplate, readSkillFile, sectionByPrefix } from "../evals/harness/prompt.ts";
import type { Fixture, ModelClient, ModelRequest } from "../evals/harness/types.ts";
import * as salesnav from "../evals/harness/runners/salesnav-verdict.ts";
import * as synth from "../evals/harness/runners/evidence-synthesis.ts";

const SELFTEST_CASES = join(import.meta.dirname, "..", "evals", "fixtures", "selftest", "cases");
const DC = ["vendor_of_the_capability", "staffing_or_agency", "out_of_band_size"];

// Belt and braces: every runner here is constructed with an explicit tmp `replaysDir`, but a
// future edit that forgets one must still not write into the committed corpus. EVAL_REPLAY_DIR
// (the convention shared with the other runners) redirects any such default.
const REPLAY_SANDBOX = mkdtempSync(join(tmpdir(), "replays-guard-"));
process.env.EVAL_REPLAY_DIR = REPLAY_SANDBOX;

let failures = 0;
const tests: Array<() => Promise<void> | void> = [];
const t = (name: string, fn: () => void | Promise<void>) => tests.push(async () => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e: any) {
    failures++;
    console.error(`FAIL ${name}: ${e.message}`);
  }
});

const tmpDirs: string[] = [REPLAY_SANDBOX];
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};

const fixtures = loadAllFixtures(SELFTEST_CASES, { dropClasses: DC });
const byId = (id: string): Fixture => {
  const f = fixtures.find((x) => x.id === id);
  if (!f) throw new Error(`no such selftest fixture: ${id}`);
  return f;
};
const SALESNAV = byId("salesnav_verdict_selftest_names");
const SYNTH = byId("evidence_synthesis_selftest_rubric");

// A client that answers with a queued script and records the requests it saw.
const scriptedClient = (responses: string[]): ModelClient & { calls: ModelRequest[] } => {
  const calls: ModelRequest[] = [];
  return {
    calls,
    async complete(req: ModelRequest) {
      calls.push(req);
      if (responses.length === 0) throw new Error("scripted client ran out of responses");
      return responses.shift()!;
    },
  } as ModelClient & { calls: ModelRequest[] };
};

// ---------------------------------------------------------------------------
// salesnav-verdict — template comes from the LIVE skill text + the ICP
// ---------------------------------------------------------------------------

t("salesnav template quotes the live sweep rules, verdict semantics and the ICP", () => {
  const { text, sha } = salesnav.buildTemplate();
  assert.match(sha, /^[0-9a-f]{64}$/);
  // the three verdict branches, verbatim from §"Sales Nav pass"
  assert.match(text, /confirms or\s+flips the provisional call/, "flip semantics phrase missing");
  assert.ok(text.includes("route flips to SKIP"), "flip-to-SKIP branch missing");
  assert.ok(text.includes("absence confirmed by the sweep"), "confirm branch missing");
  assert.ok(text.includes("ambiguous or conflicting"), "flag branch missing");
  // the sweep itself
  assert.ok(text.includes("broad Director + VP + C-level seniority sweep"), "sweep rule missing");
  // routing semantics: binary, account-level, never guess
  assert.ok(text.includes("Binary and account-level"));
  assert.ok(text.includes("Never guess"));
  // the ICP, minus comments
  assert.ok(text.includes("## Disqualifiers"), "ICP disqualifiers section missing");
  assert.ok(!text.includes("<!--"), "HTML comments are stripped");
  // and the strict JSON contract
  assert.ok(text.includes('"verdict": "confirm" | "flip_to_skip" | "flag"'));
  // an ICP edit moves the sha; a comment edit does not
  const skill = readSkillFile(salesnav.SKILL_PATH);
  const icp = readSkillFile(ICP_PATH);
  assert.equal(salesnav.buildTemplate(skill, icp).sha, sha);
  assert.notEqual(salesnav.buildTemplate(skill, icp.replace("## Disqualifiers", "## Disqualifiers\n\n- added by the test")).sha, sha);
  assert.equal(salesnav.buildTemplate(skill, icp.replace("<!--", "<!-- edited ")).sha, sha);
});

// Every ENUM runner must make the model reason FIRST in prose and emit the JSON verdict
// LAST, and must bind the enum field to that reasoning (label/rationale inversion guard).
const assertReasonFirstContract = (text: string, what: string) => {
  assert.match(text, /reason first, label last/i, `${what}: reason-first protocol missing`);
  assert.ok(text.includes("REASONING"), `${what}: no named reasoning part`);
  assert.match(text, /Write no JSON\s+in this part/, `${what}: reasoning part must forbid JSON`);
  assert.match(text, /the last thing in your reply, and the only JSON\s+object/, `${what}: the verdict object must be required last and alone`);
  assert.ok(text.includes("CONSISTENCY REQUIREMENT"), `${what}: consistency requirement missing`);
  assert.match(text, /must state the\s+conclusion your reasoning reached/, `${what}: the enum field must be bound to the reasoning`);
  assert.match(text, /Never emit a label your own reasoning\s+contradicts/, `${what}: the inversion prohibition is the point of the block`);
  assert.match(text, /EXACTLY ONE JSON\s+object/, `${what}: single-object requirement lost`);
  assert.ok(
    text.search(/EXACTLY ONE JSON\s+object/) > text.search(/reason first, label last/i),
    `${what}: the JSON contract must follow the reasoning protocol, not precede it`,
  );
  assert.ok(!text.includes("no prose before or after"), `${what}: prose-forbidding leftover`);
};

t("salesnav contract reasons first and forbids label/rationale inversion", () => {
  assertReasonFirstContract(salesnav.buildTemplate().text, "salesnav-verdict");
});

t("salesnav template extraction fails loudly when a section disappears", () => {
  assert.throws(() => sectionByPrefix("# Other\n\ntext\n", "Sales Nav pass", salesnav.SKILL_PATH), /no section whose heading/);
  const skill = readSkillFile(salesnav.SKILL_PATH);
  assert.throws(() => salesnav.buildTemplate(skill.replace("## Sales Nav pass", "## Browser pass")), /no section whose heading starts with "Sales Nav pass"/);
  assert.throws(() => salesnav.buildTemplate(skill.replace("## Routing = classification", "## Routing")), /no section whose heading starts with "Routing = classification"/);
});

t("salesnav prompt carries checklist + notes, and omits an absent apollo sweep", () => {
  const prompt = salesnav.buildPrompt(SALESNAV, "TEMPLATE");
  assert.ok(prompt.startsWith("TEMPLATE"));
  assert.ok(prompt.includes("Dana Reyes (Chief Innovation Officer)"), "checklist text missing");
  assert.ok(prompt.includes("No profile in the roster carries an AI"), "salesnav notes missing");
  assert.ok(!prompt.includes("APOLLO DIRECTOR+"), "absent apollo_sweep must not be announced");
  assert.ok(prompt.includes("selftest-roster.invalid"));
});

// ---------------------------------------------------------------------------
// salesnav-verdict — parse + score
// ---------------------------------------------------------------------------

const runSalesnav = async (response: string, fixture: Fixture = SALESNAV, replaysDir?: string) => {
  const runner = salesnav.createRunner({ replaysDir: replaysDir ?? tmp("replays-sn-") });
  return runner.run(fixture, scriptedClient([response]), false);
};

t("salesnav scores an exact verdict + full name recall", async () => {
  const r = await runSalesnav(
    '```json\n{"verdict":"confirm","evidence_names":["Dana Reyes","Sam Okoye"],"rationale":"scope is facilities"}\n```',
  );
  assert.equal(r.scores.correct, 1);
  assert.equal(r.scores.forbidden_hit, 0);
  assert.equal(r.scores.name_recall, 1);
});

t("salesnav scores a wrong verdict and partial name recall", async () => {
  const r = await runSalesnav('{"verdict":"flag","evidence_names":["Dana Reyes, Chief Innovation Officer"],"rationale":"x"}');
  assert.equal(r.scores.correct, 0);
  assert.equal(r.scores.name_recall, 0.5);
});

t("salesnav treats an unparseable response as wrong, never a skip", async () => {
  const r = await runSalesnav("I think the account should be confirmed, but I won't emit JSON.");
  assert.equal(r.skipped, undefined);
  assert.equal(r.scores.correct, 0);
  assert.equal((r.details as any).parse_failure, true);
  assert.match((r.details as any).raw, /won't emit JSON/);
});

t("salesnav counts a forbidden hit on the trap value", async () => {
  // Copy the selftest fixture and add the trap the shipped selftest fixture does not carry.
  const cases = tmp("cases-sn-");
  const dir = join(cases, "salesnav-verdict", "salesnav_verdict_selftest_names");
  mkdirSync(join(cases, "salesnav-verdict"), { recursive: true });
  cpSync(SALESNAV.dir, dir, { recursive: true });
  appendFileSync(
    join(dir, "fixture.yaml"),
    '\nforbidden:\n  - field: verdict\n    value: flip_to_skip\n    reason: "synthetic trap — a scope-verified non-owner C-level must never flip (test)"\n',
  );
  const trapped = loadAllFixtures(cases, { dropClasses: DC })[0];
  const r = await runSalesnav('{"verdict":"flip_to_skip","evidence_names":["Dana Reyes"],"rationale":"title"}', trapped);
  assert.equal(r.scores.correct, 0);
  assert.equal(r.scores.forbidden_hit, 1);
});

t("salesnav records a replay live and replays it offline with identical scores", async () => {
  const replaysDir = tmp("replays-sn-");
  const response = '{"verdict":"confirm","evidence_names":["Dana Reyes","Sam Okoye"],"rationale":"ok"}';
  const live = await runSalesnav(response, SALESNAV, replaysDir);
  const runner = salesnav.createRunner({ replaysDir });
  const offline = await runner.run(SALESNAV, offlineGuardClient(), true);
  assert.deepEqual(offline.scores, live.scores);
  const recorded = JSON.parse(readFileSync(join(replaysDir, "salesnav-verdict", `${SALESNAV.id}.json`), "utf8"));
  assert.equal(recorded.prompt_sha, runner.promptSha());
  assert.equal(recorded.fixture_sha, SALESNAV.sha);
});

t("salesnav skips offline when no replay is recorded", async () => {
  const runner = salesnav.createRunner({ replaysDir: tmp("replays-sn-") });
  const r = await runner.run(SALESNAV, offlineGuardClient(), true);
  assert.equal(r.skipped, true);
  assert.match(r.skip_reason ?? "", /no replay recorded/);
});

// ---------------------------------------------------------------------------
// evidence-synthesis — templates
// ---------------------------------------------------------------------------

t("synthesis generate template quotes the live M5 citation contract, the ICP, and the adaptation", () => {
  const { generate, judge, sha } = synth.buildTemplates();
  assert.match(sha, /^[0-9a-f]{64}$/);
  // one citation per claim, with an evidence class — verbatim from §Synthesize
  assert.match(generate, /EVERY claim ends with a citation \*\*and an\s+evidence class\*\*/, "one-citation-per-fact rule missing");
  assert.ok(generate.includes("`[raw/... <date> · fact|inference|hypothesis]`"));
  assert.ok(generate.includes("Never promote a class upward during synthesis"));
  assert.ok(generate.includes("· sensitive"));
  assert.ok(generate.includes("Angles must ground at least one specific, recognizable instance"));
  assert.ok(generate.includes("Categories don't count"));
  // the five sections
  for (const section of ["Company", "Leadership map", "The signal", "Posture", "Angles"])
    assert.ok(generate.includes(section), `section ${section} missing from the quoted contract`);
  // the ICP (M5 reads it for what an angle is)
  assert.ok(generate.includes("## Drop classes"), "ICP missing from the generate template");
  assert.ok(!generate.includes("<!--"));
  // the documented adaptation: cite the INPUT PATH
  assert.ok(generate.includes("[inputs/firecrawl-team.md · fact]"), "citation adaptation example missing");
  assert.ok(generate.includes("cite the INPUT PATH"));
  // promptSha covers BOTH templates
  assert.equal(sha, composeTemplate([generate, judge]).sha);
  assert.notEqual(sha, composeTemplate([generate]).sha);
  // injected sources: a skill edit or an ICP edit moves the sha; a renamed section throws
  const skill = readSkillFile(synth.SKILL_PATH);
  const icp = readSkillFile(ICP_PATH);
  assert.equal(synth.buildTemplates(skill, icp).sha, sha);
  assert.notEqual(synth.buildTemplates(skill.replace("Never promote a class upward", "Never promote a class"), icp).sha, sha);
  assert.notEqual(synth.buildTemplates(skill, icp.replace(/^## Drop classes\s*$/m, "## Drop classes\n\n- probe — added")).sha, sha);
  assert.throws(() => synth.buildTemplates(skill.replace("## Synthesize", "## Write it up"), icp), /no section whose heading starts with "Synthesize"/);
});

t("synthesis judge prompt carries the candidate, the inputs and every check id", () => {
  const prompt = synth.buildJudgePrompt(SYNTH, "# CANDIDATE DOC\nclaim [inputs/posting.md · fact]", synth.buildJudgeTemplate());
  assert.ok(prompt.includes("# CANDIDATE DOC"));
  assert.ok(prompt.includes("Director of Operations Technology"), "input text missing from the judge prompt");
  for (const c of [...SYNTH.rubric!.must, ...SYNTH.rubric!.should]) assert.ok(prompt.includes(`id: \`${c.id}\``));
  assert.ok(prompt.includes("`inputs/posting.md`"), "declared-inputs list missing");
});

// ---------------------------------------------------------------------------
// evidence-synthesis — deterministic citation pre-check
// ---------------------------------------------------------------------------

const DECLARED = ["inputs/posting.md", "inputs/firecrawl-team.md"];

const WELL_CITED = `# evidence.md — selftest

## Company
The company is modernizing claims intake. [inputs/posting.md · fact]
It has no automation team today. [inputs/posting.md · fact] Read: the new hire would be the first with that remit. [inputs/posting.md · inference]

## Leadership map
The role reports to the COO, and no technology executive is named. [inputs/firecrawl-team.md] [inputs/posting.md · fact]
Nobody owns the function today. [inputs/posting.md · inference · sensitive]
`;

// The same document, citing only the ONE input the selftest synthesis fixture declares —
// used for the end-to-end run tests so the pre-check has nothing to complain about.
const CANDIDATE = WELL_CITED.replace("[inputs/firecrawl-team.md] ", "");

t("pre-check passes a well-cited candidate with zero violations", () => {
  const r = synth.checkCitations(WELL_CITED, DECLARED);
  assert.equal(r.claim_blocks, 4);
  assert.equal(r.uncited, 0);
  assert.equal(r.unknown_path, 0);
  assert.equal(r.missing_class, 0);
  assert.equal(r.violations, 0);
  assert.equal(r.short_circuit, false);
});

t("pre-check counts uncited claims, unknown paths and missing classes", () => {
  const md = `## Company
A cited claim about the company. [inputs/posting.md · fact]
A claim with no citation at all that trails the file.

## Leadership map
A claim citing something that is not an input. [accounts/x.com/account.yaml · fact]
A claim whose citation carries no evidence class. [inputs/posting.md]
See the [team page](https://example.com/team) for the roster, with a real citation. [inputs/posting.md · fact]
`;
  const r = synth.checkCitations(md, DECLARED);
  assert.equal(r.claim_blocks, 5);
  assert.equal(r.uncited, 1, "the trailing uncited paragraph");
  assert.equal(r.unknown_path, 1, "account.yaml is not a declared input");
  assert.equal(r.missing_class, 1, "citation without fact|inference|hypothesis");
  assert.equal(r.violations, 3);
  assert.equal(r.short_circuit, false, "20% uncited is at the cap, not over it");
  // a markdown link is not a citation
  assert.deepEqual(synth.extractCitations("See the [team page](https://x) here. [inputs/posting.md · fact]"), [
    "inputs/posting.md · fact",
  ]);
});

t("pre-check short-circuits above 20% uncited claim blocks", () => {
  const md = `## Company
One cited claim. [inputs/posting.md · fact]
An uncited claim about the company.
Another uncited claim about the company.

A separate uncited paragraph after a blank line.
`;
  const r = synth.checkCitations(md, DECLARED);
  // The two adjacent uncited lines merge into ONE block (documented rule: a citation closes a
  // block, a blank line ends one), so this is 3 blocks — 1 cited, 2 uncited — i.e. 67% uncited.
  assert.equal(r.claim_blocks, 3);
  assert.equal(r.uncited, 2);
  assert.ok(r.uncited_rate > synth.UNCITED_SHORT_CIRCUIT);
  assert.equal(r.short_circuit, true);
  // an empty candidate is the degenerate case of the same failure
  assert.equal(synth.checkCitations("", DECLARED).short_circuit, true);
});

t("pre-check ignores structural lines (headings, rules, bold labels, code fences)", () => {
  const md = `# Title

## Company

---

**Company**

\`\`\`
raw json dump with no citation
\`\`\`

A real claim here. [inputs/posting.md · fact]
`;
  const r = synth.checkCitations(md, DECLARED);
  assert.equal(r.claim_blocks, 1);
  assert.equal(r.violations, 0);
});

// ---------------------------------------------------------------------------
// evidence-synthesis — judge parsing
// ---------------------------------------------------------------------------

t("judge JSON parses per-check verdicts, and unanswered ids fail loudly", () => {
  const rubric = SYNTH.rubric!;
  const good = synth.parseJudge(
    '```json\n{"must":[{"id":"cites_posting","pass":true,"why":"every line ends with a citation"},' +
      '{"id":"no_invented_headcount","pass":false,"why":"claims 40 employees"}],' +
      '"should":[{"id":"names_the_role","pass":true,"why":"names Director of Operations Technology"}]}\n```',
    rubric,
  );
  assert.deepEqual(good.must.map((c) => [c.id, c.pass]), [["cites_posting", true], ["no_invented_headcount", false]]);
  assert.equal(good.should[0].pass, true);

  const partial = synth.parseJudge('{"must":[{"id":"cites_posting","pass":true,"why":"ok"}],"should":[]}', rubric);
  assert.equal(partial.must[1].pass, false);
  assert.match(partial.must[1].why, /no verdict for this check id/);

  const broken = synth.parseJudge("the candidate looks fine to me", rubric);
  assert.deepEqual(broken.must.map((c) => c.pass), [false, false]);
  assert.match(broken.must[0].why, /not parsable JSON/);
});

t("judge alignment ignores duplicate and invented ids", () => {
  const checks = [{ id: "a", text: "x" }, { id: "b", text: "y" }];
  const aligned = synth.alignJudgeResults(checks, [
    { id: "a", pass: true, why: "first wins" },
    { id: "a", pass: false, why: "duplicate ignored" },
    { id: "zz", pass: true, why: "invented" },
  ]);
  assert.deepEqual(aligned.map((c) => [c.id, c.pass]), [["a", true], ["b", false]]);
});

// ---------------------------------------------------------------------------
// evidence-synthesis — two-stage run, replay envelope
// ---------------------------------------------------------------------------

const JUDGE_JSON = JSON.stringify({
  must: [
    { id: "cites_posting", pass: true, why: "every claim ends with inputs/posting.md" },
    { id: "no_invented_headcount", pass: false, why: "invents a headcount" },
  ],
  should: [{ id: "names_the_role", pass: true, why: "names the role" }],
});

t("synthesis runs both stages, scores rubric rates and reports citation violations", async () => {
  const replaysDir = tmp("replays-es-");
  const client = scriptedClient([CANDIDATE, JUDGE_JSON]);
  const runner = synth.createRunner({ replaysDir });
  const r = await runner.run(SYNTH, client, false);

  assert.equal(client.calls.length, 2, "one generate call + one batched judge call");
  assert.ok(client.calls[1].prompt.includes(CANDIDATE.trim().slice(0, 40)), "judge must see the candidate");
  assert.equal(r.scores.must_pass_rate, 0.5);
  assert.equal(r.scores.should_pass_rate, 1);
  assert.equal(r.scores.citation_violations, 0);
  assert.equal((r.details as any).must.length, 2);

  // The same candidate scored against a fixture that does NOT declare one of its cited paths
  // counts that pointer as a violation without short-circuiting (it is still auditable).
  const strayPath = synth.checkCitations(WELL_CITED, ["inputs/posting.md"]);
  assert.equal(strayPath.unknown_path, 1);
  assert.equal(strayPath.short_circuit, false);
});

t("synthesis short-circuits an uncited candidate without calling the judge", async () => {
  const client = scriptedClient([
    "## Company\nThe company is modernizing claims intake.\n\nIt has no automation team today.\n\nThe role reports to the COO.\n",
  ]);
  const runner = synth.createRunner({ replaysDir: tmp("replays-es-") });
  const r = await runner.run(SYNTH, client, false);
  assert.equal(client.calls.length, 1, "the judge must not be called on a short-circuited candidate");
  assert.equal(r.scores.must_pass_rate, 0);
  assert.equal(r.scores.should_pass_rate, 0);
  assert.equal(r.scores.citation_violations, 3, "three uncited claim blocks");
  assert.match((r.details as any).must[0].why, /short-circuit/);
});

t("synthesis replay envelope round-trips both stages at \$0", async () => {
  const replaysDir = tmp("replays-es-");
  const runner = synth.createRunner({ replaysDir });
  const live = await runner.run(SYNTH, scriptedClient([CANDIDATE, JUDGE_JSON]), false);

  const raw = JSON.parse(readFileSync(join(replaysDir, "evidence-synthesis", `${SYNTH.id}.json`), "utf8"));
  const envelope = synth.decodeEnvelope(raw.response)!;
  assert.equal(envelope.v, synth.REPLAY_ENVELOPE_VERSION);
  assert.equal(envelope.generation, CANDIDATE);
  assert.equal(envelope.judgments, JUDGE_JSON);
  assert.equal(raw.prompt_sha, runner.promptSha());

  // offlineGuardClient throws on any model call — the replay must need none.
  const offline = await runner.run(SYNTH, offlineGuardClient(), true);
  assert.deepEqual(offline.scores, live.scores);
  assert.deepEqual((offline.details as any).must, (live.details as any).must);
});

t("synthesis records judgments:null when it short-circuited, and replays that", async () => {
  const replaysDir = tmp("replays-es-");
  const runner = synth.createRunner({ replaysDir });
  const bad = "## Company\nA claim.\nAnother claim.\nA third claim.\n";
  const live = await runner.run(SYNTH, scriptedClient([bad]), false);
  const raw = JSON.parse(readFileSync(join(replaysDir, "evidence-synthesis", `${SYNTH.id}.json`), "utf8"));
  assert.equal(synth.decodeEnvelope(raw.response)!.judgments, null);
  const offline = await runner.run(SYNTH, offlineGuardClient(), true);
  assert.deepEqual(offline.scores, live.scores);
});

t("synthesis rejects a replay that is not a {generation, judgments} envelope", async () => {
  const replaysDir = tmp("replays-es-");
  const runner = synth.createRunner({ replaysDir });
  mkdirSync(join(replaysDir, "evidence-synthesis"), { recursive: true });
  writeFileSync(
    join(replaysDir, "evidence-synthesis", `${SYNTH.id}.json`),
    JSON.stringify({
      fixture_id: SYNTH.id,
      task: "evidence-synthesis",
      fixture_sha: SYNTH.sha,
      prompt_sha: runner.promptSha(),
      model: "test",
      response: "# a bare evidence.md, recorded by an older single-stage runner",
      recorded_at: new Date().toISOString(),
    }),
  );
  const r = await runner.run(SYNTH, offlineGuardClient(), true);
  assert.equal(r.skipped, true);
  assert.match(r.skip_reason ?? "", /envelope/);
  assert.equal(synth.decodeEnvelope("not json"), null);
});

// ---------------------------------------------------------------------------

const run = async () => {
  for (const test of tests) await test();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  if (failures) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("verdict/synthesis runner tests passed");
};

await run();
