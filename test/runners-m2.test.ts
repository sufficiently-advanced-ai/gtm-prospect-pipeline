// Offline tests for the M2 eval runners (evals/harness/runners/{fit-triage,route}.ts).
// No network and no model calls: the ModelClient is mocked, every fixture is synthetic
// (evals/fixtures/selftest/), and replays are written to a temp dir — evals/replays/ and
// $PIPELINE_DATA are never touched. Run: npm test (or node test/runners-m2.test.ts)
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Must be set BEFORE the runners resolve a replay dir (they read it per call, but be explicit).
const REPLAY_TMP = mkdtempSync(join(tmpdir(), "m2-runner-replays-"));
process.env.EVAL_REPLAY_DIR = REPLAY_TMP;

import fitRunner, { buildTemplate as buildFitTemplate, composePrompt as composeFitPrompt } from "../evals/harness/runners/fit-triage.ts";
import routeRunner, { buildTemplate as buildRouteTemplate, composePrompt as composeRoutePrompt, SWEEP_START } from "../evals/harness/runners/route.ts";
import { loadAllFixtures } from "../evals/harness/loader.ts";
import { ICP_PATH, loadDropClasses } from "../evals/harness/icp.ts";
import { offlineGuardClient } from "../evals/harness/model.ts";
import { readSkillFile } from "../evals/harness/prompt.ts";
import { readReplay } from "../evals/harness/replay.ts";
import type { Fixture, ModelClient, ModelRequest } from "../evals/harness/types.ts";

const SELFTEST_CASES = join(import.meta.dirname, "..", "evals", "fixtures", "selftest", "cases");
const SKILL_PATH = "skills/m2-triage-route/SKILL.md";
const DC = ["vendor_of_the_capability", "staffing_or_agency", "out_of_band_size"];

let failures = 0;
const check = (name: string, fn: () => void | Promise<void>) => {
  const done = (e?: any) => {
    if (e) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
    else console.log(`ok   ${name}`);
  };
  try {
    const r = fn();
    if (r instanceof Promise) return r.then(() => done(), done);
    done();
  } catch (e: any) { done(e); }
  return Promise.resolve();
};
const tests: Array<() => Promise<void> | void> = [];
const t = (name: string, fn: () => void | Promise<void>) => tests.push(() => check(name, fn));

const fixtures = loadAllFixtures(SELFTEST_CASES, { dropClasses: DC });
const byId = (id: string): Fixture => {
  const f = fixtures.find((x) => x.id === id);
  if (!f) throw new Error(`no such selftest fixture: ${id}`);
  return f;
};
const FIT = byId("fit_triage_selftest_vendor");   // gold drop/vendor_of_the_capability, forbidden decision=keep
const ROUTE = byId("route_selftest_scope");        // gold QUALIFIED + [Dana Reyes], forbidden route=SKIP

// A ModelClient that answers with a canned string and records what it was asked.
const mockClient = (response: string) => {
  const calls: ModelRequest[] = [];
  const client: ModelClient = { complete: async (req) => { calls.push(req); return response; } };
  return { client, calls };
};

// ---------------------------------------------------------------------------
// Template composition — the prompt IS the live skill text + the live ICP
// ---------------------------------------------------------------------------

t("templates quote the LIVE SKILL.md sections and config/icp.md verbatim", () => {
  const skill = readSkillFile(SKILL_PATH);
  const icp = readSkillFile(ICP_PATH);
  const fit = buildFitTemplate().text;
  const route = buildRouteTemplate().text;

  // Phrases that exist only in the live skill file — a paraphrase would not carry them.
  assert.ok(skill.includes("a homepage read settles what the company IS"), "precondition: SKILL.md carries the tags-lie rule");
  assert.ok(fit.includes("a homepage read settles what the company IS"), "fit-triage template must quote the fit triage section");
  assert.ok(fit.includes("Self-description counts wherever the company writes it"), "fit-triage must quote the self-description rule");
  assert.ok(skill.includes("Identity is the domain plus the Apollo org record"), "precondition: identity section");
  assert.ok(route.includes("Identity is the domain plus the Apollo org record"), "route template must quote the identity section");
  assert.ok(route.includes("classifies the account and nothing else"), "route template must quote the routing section");
  assert.match(route, /confirms or\s+flips the provisional call/, "route template must quote the Sales Navigator sweep verdicts");
  assert.ok(route.includes(SWEEP_START), "route template must carry the sweep paragraph");
  assert.ok(!route.includes("Verify the company entity before reading its people"), "route template must not drag in browser mechanics");
  assert.ok(!fit.includes("classifies the account and nothing else"), "fit-triage template must not carry the routing section");

  // The ICP is where judgment lives: both templates quote it, minus its HTML comments.
  assert.ok(icp.includes("## Drop classes"), "precondition: icp.md has the drop-class section");
  for (const text of [fit, route]) {
    assert.ok(text.includes("## Drop classes"), "template must quote config/icp.md");
    assert.ok(!text.includes("<!--"), "HTML comments are template instructions, not rules");
  }
  // The fit-triage contract spells out every live drop class by slug and description.
  for (const c of loadDropClasses()) {
    assert.ok(fit.includes(`"${c.slug}"`), `fit-triage contract must spell out ${c.slug}`);
    assert.ok(fit.includes(c.description), `fit-triage contract must carry the description of ${c.slug}`);
  }
  assert.ok(fit.includes('"decision": "keep" | "drop"'));
  for (const v of ["QUALIFIED", "SKIP", "FLAGGED"])
    assert.ok(route.includes(`"${v}"`), `route contract must spell out ${v}`);
  assert.ok(route.includes('"evidence_names"'), "route contract must ask for the people the call turns on");

  // Guardrails required by the task contract.
  for (const text of [fit, route]) assert.ok(text.includes("Answer ONLY from the provided inputs"), "inputs-only guardrail");
  assert.ok(route.includes("CLASSIFICATION ONLY"), "route classification-only guardrail");
  assert.ok(route.includes("genuinely conflicting or genuinely thin"), "route FLAGGED guardrail");
});

// ---------------------------------------------------------------------------
// Generic output-contract hygiene
// ---------------------------------------------------------------------------
// Every ENUM runner must make the model reason FIRST in prose and emit the JSON verdict
// LAST, and must bind the enum field to that reasoning. This closes label/rationale
// INVERSION: a reply whose prose applies the rulebook correctly while the enum field states
// the opposite conclusion. Nothing asserted here is fixture-specific — it is a property of
// the output contract, so it holds for every enum template, and the strict single-JSON-object
// requirement must survive it intact.
const assertReasonFirstContract = (text: string, what: string) => {
  assert.match(text, /reason first, label last/i, `${what}: reason-first protocol missing`);
  assert.ok(text.includes("REASONING"), `${what}: no named reasoning part`);
  assert.match(text, /Write no JSON\s+in this part/, `${what}: reasoning part must forbid JSON`);
  assert.match(
    text,
    /the last thing in your reply, and the only JSON\s+object/,
    `${what}: the verdict object must be required last and alone`,
  );
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

t("fit-triage and route contracts reason first and forbid label/rationale inversion", () => {
  assertReasonFirstContract(buildFitTemplate().text, "fit-triage");
  assertReasonFirstContract(buildRouteTemplate().text, "route");
});

t("promptSha is stable, and moves when the skill OR the ICP changes", () => {
  assert.match(fitRunner.promptSha(), /^[0-9a-f]{64}$/);
  assert.match(routeRunner.promptSha(), /^[0-9a-f]{64}$/);
  assert.equal(fitRunner.promptSha(), fitRunner.promptSha(), "fit-triage sha must be stable across calls");
  assert.equal(routeRunner.promptSha(), routeRunner.promptSha(), "route sha must be stable across calls");
  assert.equal(fitRunner.promptSha(), buildFitTemplate().sha);
  assert.equal(routeRunner.promptSha(), buildRouteTemplate().sha);
  assert.notEqual(fitRunner.promptSha(), routeRunner.promptSha());

  // The seam: buildTemplate(skillMd, icpMd) takes injected copies, so an edit to a quoted rule
  // is provably a prompt change (which invalidates every replay keyed to it).
  const skill = readSkillFile(SKILL_PATH);
  const icp = readSkillFile(ICP_PATH);
  const editedFit = skill.replace("a homepage read settles what the company IS", "a homepage read decides what the company IS");
  assert.notEqual(editedFit, skill, "precondition: the fit triage sentence still exists");
  assert.notEqual(buildFitTemplate(editedFit).sha, fitRunner.promptSha(), "a fit-triage rule edit must move the sha");

  const editedRoute = skill.replace("classifies the account and nothing else", "classifies the account");
  assert.notEqual(editedRoute, skill, "precondition: the routing sentence still exists");
  assert.notEqual(buildRouteTemplate(editedRoute).sha, routeRunner.promptSha(), "a routing rule edit must move the sha");

  // An ICP edit moves BOTH — that is where the judgment lives.
  // Anchored to the heading LINE: the phrase also appears inside icp.md's top HTML comment, and an
  // edit inside a comment is (correctly) invisible to the template.
  const editedIcp = icp.replace(/^## Drop classes\s*$/m, "## Drop classes\n\n- probe_class — a class added by the test");
  assert.notEqual(buildFitTemplate(skill, editedIcp).sha, fitRunner.promptSha(), "an ICP edit must move the fit-triage sha");
  assert.notEqual(buildRouteTemplate(skill, editedIcp).sha, routeRunner.promptSha(), "an ICP edit must move the route sha");
  assert.ok(buildFitTemplate(skill, editedIcp).text.includes('"probe_class"'), "the contract lists whatever icp.md lists");
  // ...but an ICP comment edit does not (comments are stripped).
  assert.equal(buildFitTemplate(skill, icp.replace("<!--", "<!-- edited comment ")).sha, fitRunner.promptSha());

  // An edit OUTSIDE the quoted sections must NOT move the sha (only what is quoted counts).
  const unrelated = skill.replace("## Sales Nav mechanics", "## Sales Nav mechanics\n\nfiller paragraph added by the test\n");
  assert.notEqual(unrelated, skill, "precondition: the mechanics section exists");
  assert.equal(buildFitTemplate(unrelated).sha, fitRunner.promptSha(), "fit-triage quotes only its own section");
  assert.equal(buildRouteTemplate(unrelated).sha, routeRunner.promptSha(), "route does not quote the mechanics section");

  // A renamed section or a vanished marker fails LOUD rather than silently dropping the rule.
  assert.throws(() => buildFitTemplate(skill.replace("## Fit triage", "## Prospect screening")), /no section whose heading starts with/);
  assert.throws(() => buildRouteTemplate(skill.replace(SWEEP_START, "**Sweep:**")), /marker not found/);
  assert.throws(() => buildFitTemplate(skill, icp.replace(/^## Drop classes\s*$/m, "## Exclusions")), /no "## Drop classes" section/);
});

t("composePrompt appends every fixture input, fenced and role-labeled", () => {
  const prompt = composeRoutePrompt(ROUTE);
  assert.ok(prompt.startsWith(buildRouteTemplate().text), "prompt must begin with the template");
  assert.ok(prompt.includes("INPUT (role: apollo_sweep, file: inputs/apollo-people.json)"));
  assert.ok(prompt.includes("Chief Innovation Officer"), "the fixture's evidence must reach the model");
  assert.ok(prompt.includes("```json"), "inputs must be fenced");
  const inputsBlock = prompt.slice(buildRouteTemplate().text.length);
  for (const token of ["QUALIFIED", "SKIP", "FLAGGED"])
    assert.ok(!inputsBlock.includes(token), `gold/route vocabulary must never leak into the inputs (${token})`);

  const fitPrompt = composeFitPrompt(FIT);
  assert.ok(fitPrompt.includes("INPUT (role: theirstack_company, file: inputs/theirstack-company.json)"));
  assert.ok(fitPrompt.includes("LLM agent platform"), "the fixture's evidence must reach the model");
});

// ---------------------------------------------------------------------------
// Scoring paths
// ---------------------------------------------------------------------------

t("live run: a correct verdict scores 1 and records verdict/gold/raw in details", async () => {
  const { client, calls } = mockClient('```json\n{"decision":"drop","drop_class":"vendor_of_the_capability","rationale":"Sells an LLM agent platform."}\n```');
  const res = await fitRunner.run(FIT, client, false);
  assert.equal(res.skipped, undefined);
  assert.deepEqual(res.scores, { correct: 1, forbidden_hit: 0, drop_class_correct: 1 });
  const d = res.details as any;
  assert.deepEqual(d.verdict, { decision: "drop", drop_class: "vendor_of_the_capability", rationale: "Sells an LLM agent platform." });
  assert.deepEqual(d.gold, FIT.gold);
  assert.ok(d.raw_response_excerpt.includes('"decision":"drop"'));
  assert.equal(d.parse_ok, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].prompt.includes("selftest-vendor.invalid"), "the model saw the fixture inputs");

  const r = await routeRunner.run(ROUTE, mockClient('{"route":"QUALIFIED","evidence_names":["Dana Reyes"],"rationale":"Scope is facilities/compliance."}').client, false);
  assert.deepEqual(r.scores, { correct: 1, forbidden_hit: 0, name_recall: 1 });
});

t("parse failure is scored WRONG, never skipped, with the raw response in details", async () => {
  for (const garbage of ["I'm not going to answer that.", "```json\n{oops: not json,\n```", ""]) {
    const res = await routeRunner.run(ROUTE, mockClient(garbage).client, false);
    assert.equal(res.skipped, undefined, `must not skip on: ${JSON.stringify(garbage)}`);
    assert.equal(res.scores.correct, 0);
    assert.equal(res.scores.forbidden_hit, 0, "an unparseable answer cannot hit a trap");
    const d = res.details as any;
    assert.equal(d.verdict, null);
    assert.equal(d.parse_ok, false);
    assert.equal(d.raw_response_excerpt, garbage);
  }
  // Same on the fit-triage side, including the secondary field.
  const res = await fitRunner.run(FIT, mockClient("no json here").client, false);
  assert.deepEqual(res.scores, { correct: 0, forbidden_hit: 0 });
});

t("a forbidden answer scores the absolute-gate hit", async () => {
  const res = await routeRunner.run(ROUTE, mockClient('{"route":"SKIP","evidence_names":["Dana Reyes"],"rationale":"Chief Innovation Officer."}').client, false);
  assert.equal(res.scores.correct, 0);
  assert.equal(res.scores.forbidden_hit, 1, "the scope-over-title trap must fire");

  const fit = await fitRunner.run(FIT, mockClient('{"decision":"keep","drop_class":null,"rationale":"Looks like logistics."}').client, false);
  assert.equal(fit.scores.correct, 0);
  assert.equal(fit.scores.forbidden_hit, 1, "the vendor-leak trap must fire");
  assert.equal(fit.scores.drop_class_correct, 0);
});

// ---------------------------------------------------------------------------
// Replay round-trip (the $0 offline corpus)
// ---------------------------------------------------------------------------

t("offline with no replay skips with a reason and never calls the model", async () => {
  const unrecorded = { ...FIT, id: "fit_triage_selftest_never_recorded" } as Fixture;
  const res = await fitRunner.run(unrecorded, offlineGuardClient(), true);
  assert.equal(res.skipped, true);
  assert.match(res.skip_reason ?? "", /no replay recorded/);
  assert.deepEqual(res.scores, {});
});

t("replay round-trip: a live run records, --offline re-parses and re-scores it", async () => {
  const response = '{"route":"QUALIFIED","evidence_names":["Dana Reyes"],"rationale":"Chief Innovation Officer scope is facilities and compliance."}';
  const live = await routeRunner.run(ROUTE, mockClient(response).client, false);
  assert.equal(live.scores.correct, 1);

  const recorded = readReplay("route", ROUTE.id, REPLAY_TMP);
  assert.ok(recorded, "the live run must have written a replay");
  assert.equal(recorded!.fixture_sha, ROUTE.sha);
  assert.equal(recorded!.prompt_sha, routeRunner.promptSha());
  assert.equal(recorded!.response, response);

  // Offline replays it deterministically, with no model client available at all.
  const offline = await routeRunner.run(ROUTE, offlineGuardClient(), true);
  assert.equal(offline.skipped, undefined);
  assert.deepEqual(offline.scores, live.scores);
  assert.deepEqual((offline.details as any).verdict, (live.details as any).verdict);

  // A replay recorded against a different fixture/prompt is stale, not a silent pass.
  const drifted = { ...ROUTE, sha: "0".repeat(64) } as Fixture;
  const stale = await routeRunner.run(drifted, offlineGuardClient(), true);
  assert.equal(stale.skipped, true);
  assert.match(stale.skip_reason ?? "", /replay is stale: fixture sha/);
});

// ---------------------------------------------------------------------------

const run = async () => {
  for (const test of tests) await test();
  rmSync(REPLAY_TMP, { recursive: true, force: true });
  if (failures) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("m2 runner tests passed");
};

await run();
