// Offline tests for the eval harness core (icp/loader/scoring/report/replay/model/prompt/CLI/seeder).
// No network, no model calls, no $PIPELINE_DATA access: the model client is mocked and every
// fixture is synthetic (evals/fixtures/selftest/, evals/fixtures/cases/). Run: npm test (or
// node test/evals-harness.test.ts)
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllFixtures, computeFixtureSha, canonicalJson, readInput, MAX_INPUT_BYTES } from "../evals/harness/loader.ts";
import { parseDropClasses, dropClassSlugs, loadDropClasses } from "../evals/harness/icp.ts";
import { aggregateMicro, aggregateRubric, nameRecall, scoreEnumFixture, scoreRubricChecks } from "../evals/harness/scoring.ts";
import {
  appendHistory, baselineSanityProblems, buildReport, checkFixtureCompleteness, checkFixtureImmutability,
  diffAgainstBaseline, gitShortSha, loadBaseline, meanReport, printSkipSummary, toBaseline, writeBaseline, writeReport,
} from "../evals/harness/report.ts";
import { loadValidReplay, isReplayValid, makeReplay, readReplay, writeReplay } from "../evals/harness/replay.ts";
import { liveClient, offlineGuardClient, parseClaudeEnvelope, recordingClient, replayClient } from "../evals/harness/model.ts";
import type { SpawnFn } from "../evals/harness/model.ts";
import { composeTemplate, extractJsonObject, extractSection, readSkillFile, sectionByPrefix, stripHtmlComments } from "../evals/harness/prompt.ts";
import { decodeEnvelope, encodeEnvelope, checkCitations } from "../evals/harness/runners/evidence-synthesis.ts";
import { importRunner, main as mainCli, parseArgs, runTasks, CASES_DIR } from "../evals/run.ts";
import { isSynthetic, seed } from "../evals/seed-synthetic.ts";
import { TASKS } from "../evals/harness/types.ts";
import type { Baseline, Fixture, Report, Runner } from "../evals/harness/types.ts";

const SELFTEST = join(import.meta.dirname, "..", "evals", "fixtures", "selftest");
const VALID_DIR = join(SELFTEST, "cases");
const INVALID_DIR = join(SELFTEST, "invalid");
// The selftest corpus is loaded with an INJECTED drop-class list so these tests never depend
// on what the operator wrote in config/icp.md.
const DC = ["vendor_of_the_capability", "staffing_or_agency", "out_of_band_size"];
const load = (dir: string) => loadAllFixtures(dir, { dropClasses: DC });

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

const tmpDirs: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
const byId = (fixtures: Fixture[], id: string): Fixture => {
  const f = fixtures.find((x) => x.id === id);
  if (!f) throw new Error(`no such selftest fixture: ${id}`);
  return f;
};

const tests: Array<() => Promise<void> | void> = [];
const t = (name: string, fn: () => void | Promise<void>) => tests.push(() => check(name, fn));

// ---------------------------------------------------------------------------
// icp.md — the machine-read drop-class list
// ---------------------------------------------------------------------------

const ICP_SAMPLE = `# ICP

## Who we sell to
- REPLACE

## Drop classes

<!-- MACHINE-READ. One bullet per class: \`- slug — description\`. -->

- vendor_of_the_capability — the company sells the thing we provide
- staffing_or_agency — staffing, recruiting, or a services agency
* out_of_band_size — headcount outside the band

## Disqualifiers
- not a class
`;

t("parseDropClasses reads `- slug — description` bullets and ignores comments and other sections", () => {
  const classes = parseDropClasses(ICP_SAMPLE);
  assert.deepEqual(dropClassSlugs(classes), ["vendor_of_the_capability", "staffing_or_agency", "out_of_band_size"]);
  assert.equal(classes[0].description, "the company sells the thing we provide");
  assert.throws(() => parseDropClasses("# ICP\n\n## Other\n- a — b\n"), /no "## Drop classes" section/);
  assert.throws(() => parseDropClasses("## Drop classes\n\n<!-- nothing -->\n"), /lists no classes/);
  assert.throws(() => parseDropClasses("## Drop classes\n- Bad Slug — x\n"), /malformed drop-class bullet/);
  assert.throws(() => parseDropClasses("## Drop classes\n- slug_only\n"), /malformed drop-class bullet/);
  assert.throws(() => parseDropClasses("## Drop classes\n- a — x\n- a — y\n"), /duplicate drop class "a"/);
  // The live file parses too (the gate depends on it) and EVAL_ICP_FILE redirects for tests.
  assert.ok(loadDropClasses().length > 0, "config/icp.md must list at least one drop class");
  const dir = tmp("evals-icp-");
  writeFileSync(join(dir, "icp.md"), ICP_SAMPLE);
  process.env.EVAL_ICP_FILE = join(dir, "icp.md");
  try {
    assert.deepEqual(dropClassSlugs(loadDropClasses()), DC);
  } finally {
    delete process.env.EVAL_ICP_FILE;
  }
  assert.equal(stripHtmlComments("a <!-- x\ny --> b"), "a  b");
});

// ---------------------------------------------------------------------------
// loader
// ---------------------------------------------------------------------------

t("loader loads only well-formed fixtures, sorted, with 64-hex shas", () => {
  const fixtures = load(VALID_DIR);
  assert.deepEqual(
    fixtures.map((f) => f.id),
    ["evidence_synthesis_selftest_rubric", "fit_triage_selftest_vendor", "route_selftest_scope", "salesnav_verdict_selftest_names"],
  );
  for (const f of fixtures) {
    assert.match(f.sha, /^[0-9a-f]{64}$/, `${f.id} sha`);
    assert.ok(f.dir.endsWith(join(f.task, f.id)), `${f.id} dir`);
  }
  // gold XOR rubric held per task
  assert.equal(byId(fixtures, "evidence_synthesis_selftest_rubric").gold, undefined);
  assert.ok(byId(fixtures, "evidence_synthesis_selftest_rubric").rubric?.must.length);
  assert.equal(byId(fixtures, "route_selftest_scope").rubric, undefined);
});

t("loader rejects every invalid fixture, naming the id and the problem", () => {
  let message = "";
  assert.throws(() => load(INVALID_DIR), (e: any) => { message = e.message; return true; });
  for (const pattern of [
    /route_selftest_missing_role: missing required input role for route: apollo_sweep/,
    /route_selftest_bad_gold: gold\.route: "MAYBE" is not one of QUALIFIED\|SKIP\|FLAGGED/,
    /route_selftest_bad_gold: forbidden\[0\]\.value: "HOLD" is not one of/,
    /fit_triage_selftest_bad_class: gold\.drop_class: "not_a_class" is not one of vendor_of_the_capability\|staffing_or_agency\|out_of_band_size \(the classes listed under "## Drop classes" in config\/icp\.md\)/,
    /fit_triage_selftest_other_id: id must equal its directory name/,
    /fit_triage_selftest_other_id: input file missing: inputs\/theirstack-company\.json/,
    /evidence_synthesis_selftest_gold_not_rubric: evidence-synthesis is rubric-scored — remove gold/,
    /evidence_synthesis_selftest_gold_not_rubric: evidence-synthesis requires a rubric/,
  ]) assert.match(message, pattern);
});

t("loader rejects an oversize input, a bad id, and a stray sha field", () => {
  const dir = tmp("evals-loader-");
  cpSync(VALID_DIR, dir, { recursive: true });
  const fix = join(dir, "route", "route_selftest_scope");
  writeFileSync(join(fix, "inputs", "apollo-people.json"), "x".repeat(MAX_INPUT_BYTES + 1));
  const yaml = readFileSync(join(fix, "fixture.yaml"), "utf8");
  writeFileSync(join(fix, "fixture.yaml"), `${yaml}\nsha: deadbeef\n`);
  let message = "";
  assert.throws(() => load(dir), (e: any) => { message = e.message; return true; });
  assert.match(message, /over the 51200B per-file cap/);
  assert.match(message, /dir\/sha are loader-filled/);

  const bad = join(dir, "route", "route_selftest_scope");
  writeFileSync(join(bad, "fixture.yaml"), yaml.replace("id: route_selftest_scope", "id: Route-Selftest"));
  assert.throws(() => load(dir), /id must match/);
});

t("fixture sha is stable for identical content and moves on any input byte change", () => {
  const a = load(VALID_DIR);
  const b = load(VALID_DIR);
  for (const f of a) assert.equal(f.sha, byId(b, f.id).sha, `${f.id} must hash identically across loads`);

  const dir = tmp("evals-sha-");
  cpSync(VALID_DIR, dir, { recursive: true });
  const copied = load(dir);
  assert.equal(byId(copied, "route_selftest_scope").sha, byId(a, "route_selftest_scope").sha, "a byte-identical copy hashes the same");

  // one byte in an input file
  const inputPath = join(dir, "route", "route_selftest_scope", "inputs", "apollo-people.json");
  writeFileSync(inputPath, readFileSync(inputPath, "utf8").replace("Dana Reyes", "Dana Reyez"));
  assert.notEqual(byId(load(dir), "route_selftest_scope").sha, byId(a, "route_selftest_scope").sha);

  // trailing newline in an input file counts (byte-exact hashing)
  cpSync(VALID_DIR, dir, { recursive: true });
  writeFileSync(inputPath, `${readFileSync(inputPath, "utf8")}\n`);
  assert.notEqual(byId(load(dir), "route_selftest_scope").sha, byId(a, "route_selftest_scope").sha);

  // fixture.yaml is hashed semantically: reformatting/comments/key order do not move the sha
  cpSync(VALID_DIR, dir, { recursive: true });
  const yamlPath = join(dir, "route", "route_selftest_scope", "fixture.yaml");
  writeFileSync(yamlPath, `# a comment added by a human\n\n${readFileSync(yamlPath, "utf8")}`);
  assert.equal(byId(load(dir), "route_selftest_scope").sha, byId(a, "route_selftest_scope").sha);

  // a seed/ dir or a sidecar in the fixture dir does not participate either
  writeFileSync(join(dir, "route", "route_selftest_scope", ".review.md"), "notes\n");
  mkdirSync(join(dir, "route", "route_selftest_scope", "seed"), { recursive: true });
  writeFileSync(join(dir, "route", "route_selftest_scope", "seed", "response.md"), "canonical\n");
  assert.equal(byId(load(dir), "route_selftest_scope").sha, byId(a, "route_selftest_scope").sha);

  // ...but a gold change does
  writeFileSync(yamlPath, readFileSync(yamlPath, "utf8").replace("route: QUALIFIED", "route: FLAGGED"));
  assert.notEqual(byId(load(dir), "route_selftest_scope").sha, byId(a, "route_selftest_scope").sha);
});

t("canonicalJson sorts keys at every depth and preserves array order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, 1] } }), '{"a":{"c":[3,1],"d":2},"b":1}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
  // dir/sha are excluded from the hash input, so a round-tripped Fixture hashes like the file
  const f = byId(load(VALID_DIR), "route_selftest_scope");
  const { dir, sha, ...doc } = f as any;
  assert.equal(computeFixtureSha({ ...doc, dir, sha }, dir, f.inputs), sha);
});

// --- loader hardening, each probe built as a throwaway fixture tree so the committed
// selftest corpus stays as it is.
const buildFixtureTree = (task: string, doc: Record<string, unknown>, roles: string[]): string => {
  const root = tmp("evals-vtree-");
  const id = doc.id as string;
  const dir = join(root, task, id);
  mkdirSync(join(dir, "inputs"), { recursive: true });
  const inputs = roles.map((role, i) => {
    writeFileSync(join(dir, "inputs", `i${i}.md`), "body\n");
    return { path: `inputs/i${i}.md`, role };
  });
  writeFileSync(join(dir, "fixture.yaml"), JSON.stringify({ task, version: 1, inputs, ...doc }, null, 2));
  return root;
};
const loadProblems = (root: string): string => {
  try {
    load(root);
    return "";
  } catch (e: any) {
    return e.message;
  }
};
const PROV = { domain: "x.invalid", source: "harness self-test — synthetic" };
const ROLES: Record<string, string[]> = {
  route: ["apollo_sweep"],
  "salesnav-verdict": ["salesnav", "checklist"],
  "fit-triage": ["theirstack_company"],
  "evidence-synthesis": ["posting"],
};
const tryFixture = (task: string, extra: Record<string, unknown>): string =>
  loadProblems(buildFixtureTree(task, { id: `${task.replace(/-/g, "_")}_probe`, description: "d", provenance: PROV, ...extra }, ROLES[task]));

t("drop_class is validated against the injected icp.md list; keep carries none; DROPPED is never a route", () => {
  assert.equal(tryFixture("fit-triage", { gold: { decision: "drop", drop_class: "staffing_or_agency" } }), "");
  assert.match(tryFixture("fit-triage", { gold: { decision: "drop", drop_class: "consulting" } }), /gold\.drop_class: "consulting" is not one of vendor_of_the_capability\|staffing_or_agency\|out_of_band_size/);
  assert.match(tryFixture("fit-triage", { gold: { decision: "keep", drop_class: "staffing_or_agency" } }), /gold\.drop_class must be absent \(or null\) when decision is keep/);
  assert.equal(tryFixture("fit-triage", { gold: { decision: "keep", drop_class: null } }), "", "null is the explicit no-class spelling");
  // DROPPED belongs to fit-triage; route's vocabulary is the classification triple.
  assert.match(tryFixture("route", { gold: { route: "DROPPED" } }), /not one of QUALIFIED\|SKIP\|FLAGGED/);
  // A gold key that is not a verdict field of the task is a typo, not an extra.
  assert.match(tryFixture("route", { gold: { route: "QUALIFIED", depth: "short" } }), /gold\.depth is not a route verdict field/);
  assert.match(tryFixture("route", { gold: { route: "QUALIFIED", evidence_names: "Dana" } }), /gold\.evidence_names must be a list of strings/);
});

t("gold and forbidden enum values must be quoted strings, never YAML's coercions", () => {
  // Each of these would load happily otherwise, producing gold a PERFECT model answer scores 0
  // against forever: scoring compares String(verdict.field) to String(gold.field).
  for (const [label, value] of [["null", null], ["true", true], ["1", 1], ["a list", ["keep"]]] as const) {
    assert.match(
      tryFixture("fit-triage", { gold: { decision: value } }),
      /gold\.decision: enum fields must be quoted STRINGS/,
      `gold.decision: ${label}`,
    );
  }
  assert.match(
    tryFixture("fit-triage", { gold: { decision: "drop", drop_class: 7 } }),
    /gold\.drop_class: enum fields must be quoted STRINGS \(got number\)/,
  );
  assert.match(
    tryFixture("route", { gold: { route: "QUALIFIED" }, forbidden: [{ field: "route", value: null, reason: "r" }] }),
    /forbidden\[0\]\.value: enum fields must be quoted STRINGS/,
  );
  assert.equal(tryFixture("fit-triage", { gold: { decision: "keep" } }), "");
});

t("a forbidden trap must name a verdict field THIS task actually has", () => {
  const base = { gold: { route: "QUALIFIED" } };
  // A misspelling: scoreEnumFixture looks up verdict["rout"], finds undefined, counts nothing.
  assert.match(
    tryFixture("route", { ...base, forbidden: [{ field: "rout", value: "SKIP", reason: "r" }] }),
    /forbidden\[0\]\.field "rout" is not a route verdict field/,
  );
  // Another task's field is the same silent no-op.
  assert.match(
    tryFixture("route", { ...base, forbidden: [{ field: "decision", value: "drop", reason: "r" }] }),
    /forbidden\[0\]\.field "decision" is not a route verdict field/,
  );
  // The rubric task evaluates no verdict at all, so every trap on it is decorative.
  assert.match(
    tryFixture("evidence-synthesis", {
      rubric: { must: [{ id: "m1", text: "something verifiable" }], should: [] },
      forbidden: [{ field: "verdict", value: "confirm", reason: "r" }],
    }),
    /forbidden traps are enum-task only/,
  );
  // A well-formed trap on a real field still loads.
  assert.equal(tryFixture("route", { ...base, forbidden: [{ field: "route", value: "SKIP", reason: "r" }] }), "");
});

t("readInput reads declared inputs by role", () => {
  const f = byId(load(VALID_DIR), "salesnav_verdict_selftest_names");
  assert.match(readInput(f, "salesnav") ?? "", /Dana Reyes/);
  assert.equal(readInput(f, "no_such_role"), null);
});

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

t("scoreEnumFixture: exact match, secondary fields, and the forbidden trap", () => {
  const fixtures = load(VALID_DIR);
  const route = byId(fixtures, "route_selftest_scope"); // gold QUALIFIED + evidence_names [Dana Reyes]
  assert.deepEqual(scoreEnumFixture(route, { route: "QUALIFIED", evidence_names: ["Dana Reyes"], rationale: "scope is facilities" }), { correct: 1, forbidden_hit: 0, name_recall: 1 });
  assert.deepEqual(scoreEnumFixture(route, { route: "FLAGGED" }), { correct: 0, forbidden_hit: 0, name_recall: 0 });
  // the trap: the specific wrong answer that regressed
  assert.deepEqual(scoreEnumFixture(route, { route: "SKIP" }), { correct: 0, forbidden_hit: 1, name_recall: 0 });
  // parse failure scores wrong, never skipped, and cannot hit a trap
  assert.deepEqual(scoreEnumFixture(route, null), { correct: 0, forbidden_hit: 0 });

  const fit = byId(fixtures, "fit_triage_selftest_vendor");
  assert.deepEqual(scoreEnumFixture(fit, { decision: "drop", drop_class: "vendor_of_the_capability" }), { correct: 1, forbidden_hit: 0, drop_class_correct: 1 });
  assert.deepEqual(scoreEnumFixture(fit, { decision: "drop", drop_class: "staffing_or_agency" }), { correct: 1, forbidden_hit: 0, drop_class_correct: 0 });
  assert.deepEqual(scoreEnumFixture(fit, { decision: "keep", drop_class: null }), { correct: 0, forbidden_hit: 1, drop_class_correct: 0 });
  // A keep fixture (no gold drop_class) never scores the secondary field.
  const keep = { ...fit, gold: { decision: "keep" } } as Fixture;
  assert.deepEqual(scoreEnumFixture(keep, { decision: "keep", drop_class: null }), { correct: 1, forbidden_hit: 1 });
});

t("name_recall is a fraction of gold names, case-insensitive and substring-tolerant", () => {
  const sn = byId(load(VALID_DIR), "salesnav_verdict_selftest_names");
  const s = scoreEnumFixture(sn, { verdict: "confirm", evidence_names: ["dana reyes (CIO)", "Priya Nandan"] });
  assert.equal(s.correct, 1);
  assert.equal(s.name_recall, 0.5);
  assert.equal(scoreEnumFixture(sn, { verdict: "confirm", evidence_names: ["Dana Reyes", "Sam Okoye"] }).name_recall, 1);
  assert.equal(scoreEnumFixture(sn, { verdict: "confirm", evidence_names: [] }).name_recall, 0);
  assert.equal(scoreEnumFixture(sn, { verdict: "flag" }).name_recall, 0);
  assert.equal(nameRecall([], ["anyone"]), null, "no gold names = unscored");
});

// The reverse substring direction must be bounded, or garbage scores full recall —
// "dana reyes".includes("a") would be a match.
t("name_recall rejects a token too short or too small a share of the gold name", () => {
  assert.equal(nameRecall(["Dana Reyes"], ["a"]), 0, "a single letter is not a name");
  assert.equal(nameRecall(["Dana Reyes"], ["an"]), 0);
  assert.equal(nameRecall(["Dana Reyes"], ["Dana"]), 0, "4 of 10 chars is not a name match");
  assert.equal(nameRecall(["Dana Reyes"], ["Reyes"]), 1, "a full surname is");
  // The decoration direction stays unrestricted — that is the useful leniency.
  assert.equal(nameRecall(["Dana Reyes"], ["Dana Reyes, VP Eng"]), 1);
  assert.equal(nameRecall(["Dana Reyes"], ["DANA  REYES"]), 1, "case and whitespace still normalise");
  assert.equal(nameRecall(["Dana Reyes", "Sam Okoye"], ["a", "Sam Okoye"]), 0.5);
});

t("aggregateMicro averages rates, sums forbidden hits, and reports n", () => {
  const micro = aggregateMicro({
    a: { correct: 1, forbidden_hit: 0, drop_class_correct: 1 },
    b: { correct: 0, forbidden_hit: 2, drop_class_correct: 0 },
    c: { correct: 1, forbidden_hit: 0 },
  });
  assert.equal(micro.n, 3);
  assert.equal(micro.accuracy, 2 / 3);
  assert.equal(micro.forbidden_hits, 2);
  assert.equal(micro.drop_class_correct, 0.5, "secondary rate averages only over fixtures that carry it");
  assert.deepEqual(aggregateMicro({}), {});

  assert.deepEqual(scoreRubricChecks([{ pass: true }, { pass: false }], [{ pass: true }]), { must_pass_rate: 0.5, should_pass_rate: 1 });
  const rubric = aggregateRubric({ a: { must_pass_rate: 1, should_pass_rate: 0.5 }, b: { must_pass_rate: 0.5 } });
  assert.equal(rubric.n, 2);
  assert.equal(rubric.must_pass_rate, 0.75);
  assert.equal(rubric.should_pass_rate, 0.5);
});

// ---------------------------------------------------------------------------
// report / baseline gating
// ---------------------------------------------------------------------------

const fakeReport = (tasks: Record<string, Record<string, number>>): Report => ({
  run_id: "20260101T000000Z_abc1234",
  created_at: "2026-01-01T00:00:00.000Z",
  git_sha: "abc1234",
  offline: false,
  models: { runner: "m", judge: "m" },
  prompt_shas: { route: "p1" },
  fixture_shas: {},
  tasks: Object.fromEntries(Object.entries(tasks).map(([k, micro]) => [k, { micro, per_fixture: {}, details: {} }])),
});

const fakeBaseline = (metrics: Record<string, Record<string, number>>, fixtureShas: Record<string, string> = {}): Baseline => ({
  created_at: "2025-12-31T00:00:00.000Z",
  git_sha: "0000000",
  prompt_shas: {},
  fixture_shas: fixtureShas,
  metrics,
});

t("baseline gate: tolerance edges on gated metrics", () => {
  const baseline = fakeBaseline({ route: { accuracy: 0.9, forbidden_hits: 0 } });
  const at = fakeReport({ route: { accuracy: 0.88, forbidden_hits: 0 } });      // exactly -tolerance
  const beyond = fakeReport({ route: { accuracy: 0.8799, forbidden_hits: 0 } }); // a hair further
  const better = fakeReport({ route: { accuracy: 1, forbidden_hits: 0 } });
  assert.deepEqual(diffAgainstBaseline(at, baseline, 0.02), [], "a drop of exactly the tolerance passes");
  assert.equal(diffAgainstBaseline(beyond, baseline, 0.02).length, 1);
  assert.deepEqual(diffAgainstBaseline(better, baseline, 0.02), []);
  assert.equal(diffAgainstBaseline(at, baseline, 0).length, 1, "zero tolerance catches any drop");
  // non-gated metrics never fail the run
  assert.deepEqual(diffAgainstBaseline(fakeReport({ route: { accuracy: 0.9, forbidden_hits: 0, name_recall: 0 } }), fakeBaseline({ route: { accuracy: 0.9, name_recall: 1 } }), 0.02), []);
});

t("forbidden_hits is an absolute gate — no baseline, no tolerance, no escape", () => {
  const hit = fakeReport({ route: { accuracy: 1, forbidden_hits: 1 } });
  for (const [baseline, tol] of [[null, 0.02], [fakeBaseline({ route: { accuracy: 1, forbidden_hits: 1 } }), 99]] as const) {
    const regs = diffAgainstBaseline(hit, baseline as Baseline | null, tol);
    assert.equal(regs.length, 1, "a forbidden hit always fails");
    assert.equal(regs[0].absolute, true);
    assert.equal(regs[0].metric, "forbidden_hits");
  }
  assert.deepEqual(diffAgainstBaseline(fakeReport({ route: { accuracy: 1, forbidden_hits: 0 } }), null, 0.02), []);
});

t("fixture immutability: changed sha violates, new fixture does not", () => {
  const fixtures = load(VALID_DIR);
  const good = fakeBaseline({}, Object.fromEntries(fixtures.map((f) => [f.id, f.sha])));
  assert.deepEqual(checkFixtureImmutability(good, fixtures), []);
  assert.deepEqual(checkFixtureImmutability(null, fixtures), []);

  const stale = fakeBaseline({}, { ...good.fixture_shas, route_selftest_scope: "f".repeat(64) });
  const violations = checkFixtureImmutability(stale, fixtures);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /fixture route_selftest_scope changed since the baseline/);
  assert.match(violations[0], /bump version/);

  const partial = fakeBaseline({}, { route_selftest_scope: byId(fixtures, "route_selftest_scope").sha });
  assert.deepEqual(checkFixtureImmutability(partial, fixtures), [], "fixtures absent from the baseline are new, not violations");
});

t("report round-trip: build → write → baseline → history → mean", () => {
  const dir = tmp("evals-report-");
  const fixtures = load(VALID_DIR);
  const report = buildReport({
    repoRoot: join(import.meta.dirname, ".."),
    taskResults: { route: { micro: { n: 1, accuracy: 1, forbidden_hits: 0 }, per_fixture: { route_selftest_scope: { correct: 1, forbidden_hit: 0 } }, details: {} } },
    promptShas: { route: "p1" },
    fixtures,
    models: { runner: "claude-opus-5", judge: "claude-opus-5" },
    offline: false,
    label: "Self Test",
    now: new Date("2026-01-01T18:55:00.000Z"),
  });
  // git_sha carries a "-dirty" suffix when skills/ or config/ have uncommitted edits, and
  // "nogit" when the repo has no commits yet.
  assert.match(report.run_id, /^20260101T185500Z_(?:[0-9a-f]+(?:-dirty)?|nogit)_self-test$/);
  assert.deepEqual(Object.keys(report.fixture_shas).sort(), fixtures.map((f) => f.id).sort());

  const path = writeReport(report, dir);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).run_id, report.run_id);

  const baselinePath = join(dir, "baselines", "baseline.json");
  writeBaseline(toBaseline(report), baselinePath);
  const baseline = loadBaseline(baselinePath)!;
  assert.equal(baseline.metrics.route.accuracy, 1);
  assert.equal(baseline.fixture_shas.route_selftest_scope, byId(fixtures, "route_selftest_scope").sha);
  assert.equal(loadBaseline(join(dir, "nope.json")), null, "a missing baseline is the no-baseline state, not an error");

  appendHistory(report, dir);
  appendHistory(report, dir);
  const lines = readFileSync(join(dir, "history.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "one line per live run");
  assert.equal(JSON.parse(lines[0]).metrics.route.accuracy, 1);

  const mean = meanReport([fakeReport({ route: { accuracy: 1, forbidden_hits: 0 } }), fakeReport({ route: { accuracy: 0, forbidden_hits: 2 } })]);
  assert.equal(mean.tasks.route.micro.accuracy, 0.5);
  assert.equal(mean.tasks.route.micro.forbidden_hits, 1, "a hit in any run keeps the mean nonzero and the gate red");
  assert.match(mean.run_id, /_mean2$/);
});

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

t("a replay is valid only while BOTH the fixture sha and the prompt sha match", () => {
  const dir = tmp("evals-replay-");
  const replay = makeReplay({ fixtureId: "route_selftest_scope", task: "route", fixtureSha: "aaa", promptSha: "bbb", model: "m", response: '{"route":"QUALIFIED"}' });
  const path = writeReplay(replay, dir);
  assert.ok(existsSync(path) && path.endsWith(join("route", "route_selftest_scope.json")));
  assert.deepEqual(readReplay("route", "route_selftest_scope", dir), replay);

  assert.equal(isReplayValid(replay, "aaa", "bbb"), true);
  assert.equal(isReplayValid(replay, "aaa2", "bbb"), false);
  assert.equal(isReplayValid(replay, "aaa", "bbb2"), false);
  assert.equal(isReplayValid(null, "aaa", "bbb"), false);

  assert.equal(loadValidReplay("route", "route_selftest_scope", "aaa", "bbb", dir).response, replay.response);
  assert.match(loadValidReplay("route", "route_selftest_scope", "ccc", "bbb", dir).skip_reason ?? "", /replay is stale: fixture sha/);
  assert.match(loadValidReplay("route", "route_selftest_scope", "aaa", "ccc", dir).skip_reason ?? "", /replay is stale: prompt sha/);
  assert.match(loadValidReplay("route", "missing_fixture", "aaa", "bbb", dir).skip_reason ?? "", /no replay recorded/);
});

// The file's path and its body both name (task, fixture_id); a mislabeled replay would be
// scored against a different fixture's gold.
t("readReplay refuses a replay whose body names a different fixture than its path", () => {
  const dir = tmp("evals-replay-id-");
  writeReplay(makeReplay({ fixtureId: "route_selftest_scope", task: "route", fixtureSha: "a", promptSha: "b", model: "m", response: "{}" }), dir);
  assert.ok(readReplay("route", "route_selftest_scope", dir), "a well-labeled replay reads fine");

  const path = join(dir, "route", "route_selftest_scope.json");
  const body = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...body, fixture_id: "route_someone_else" }));
  assert.throws(() => readReplay("route", "route_selftest_scope", dir), /mislabeled/);

  writeFileSync(path, JSON.stringify({ ...body, task: "salesnav-verdict" }));
  assert.throws(() => readReplay("route", "route_selftest_scope", dir), /mislabeled/);
});

t("decodeEnvelope accepts only v:1, and a citation path is normalised before comparison", () => {
  assert.deepEqual(decodeEnvelope(encodeEnvelope("# doc", '{"must":[]}')), { v: 1, generation: "# doc", judgments: '{"must":[]}' });
  assert.deepEqual(decodeEnvelope(encodeEnvelope("# doc", null)), { v: 1, generation: "# doc", judgments: null });
  assert.equal(decodeEnvelope('{"v":99,"generation":"g","judgments":null}'), null, "an unknown version is not decodable");
  assert.equal(decodeEnvelope('{"generation":"g","judgments":null}'), null, "a versionless envelope is not v:1");
  assert.equal(decodeEnvelope("# doc\nplain markdown, not an envelope"), null);
  assert.equal(decodeEnvelope('{"v":1,"generation":"g","judgments":{"must":[]}}'), null, "judgments must be a string or null");

  // `inputs/../inputs/a.md` and `inputs/./a.md` both name a declared input; only a genuine
  // escape stays unknown.
  const declared = ["inputs/a.md"];
  assert.equal(checkCitations("- A real claim about the company [inputs/../inputs/a.md · fact]", declared).unknown_path, 0);
  assert.equal(checkCitations("- A real claim about the company [inputs/./a.md · fact]", declared).unknown_path, 0);
  assert.equal(checkCitations("- A real claim about the company [inputs/a.md · fact]", declared).unknown_path, 0);
  assert.equal(checkCitations("- A real claim about the company [../../etc/passwd · fact]", declared).unknown_path, 1);
});

// ---------------------------------------------------------------------------
// model (mocked spawn — never a live call)
// ---------------------------------------------------------------------------

t("parseClaudeEnvelope pulls result text out of the CLI's JSON shapes", () => {
  assert.equal(parseClaudeEnvelope('{"type":"result","subtype":"success","is_error":false,"result":"{\\"route\\":\\"QUALIFIED\\"}"}'), '{"route":"QUALIFIED"}');
  assert.equal(parseClaudeEnvelope('warning: something\n{"type":"result","result":"hello"}'), "hello");
  assert.equal(parseClaudeEnvelope('{"type":"system"}\n{"type":"result","result":"last line wins"}'), "last line wins");
  assert.equal(parseClaudeEnvelope('[{"type":"system"},{"type":"result","result":"from array"}]'), "from array");
  assert.equal(parseClaudeEnvelope('{"content":[{"type":"text","text":"block text"}]}'), "block text");
  assert.throws(() => parseClaudeEnvelope('{"type":"result","is_error":true,"result":"boom"}'), /error envelope/);
  assert.throws(() => parseClaudeEnvelope("not json at all"), /was not JSON/);
  assert.throws(() => parseClaudeEnvelope("   "), /no output/);
});

t("liveClient shells the documented argv, feeds the prompt on stdin, retries once", async () => {
  const calls: Array<{ cmd: string; args: string[]; input: string }> = [];
  const ok: SpawnFn = async (cmd, args, input) => {
    calls.push({ cmd, args, input });
    return { stdout: '{"type":"result","result":"ANSWER"}', stderr: "", code: 0 };
  };
  const client = liveClient("claude-opus-5", { spawn: ok, retries: 0 });
  assert.equal(await client.complete({ model: "claude-opus-5", prompt: "PROMPT", system: "SYS" }), "ANSWER");
  assert.equal(calls[0].cmd, "claude");
  assert.deepEqual(calls[0].args, ["-p", "--output-format", "json", "--model", "claude-opus-5", "--append-system-prompt", "SYS"]);
  assert.equal(calls[0].input, "PROMPT");

  let attempts = 0;
  const flaky: SpawnFn = async () => {
    attempts++;
    return attempts === 1
      ? { stdout: "", stderr: "connection reset", code: 1 }
      : { stdout: '{"type":"result","result":"SECOND TRY"}', stderr: "", code: 0 };
  };
  assert.equal(await liveClient("m", { spawn: flaky }).complete({ model: "m", prompt: "p" }), "SECOND TRY");
  assert.equal(attempts, 2, "exactly one retry");

  let always = 0;
  const dead: SpawnFn = async () => { always++; return { stdout: "", stderr: "nope", code: 2 }; };
  await assert.rejects(liveClient("m", { spawn: dead }).complete({ model: "m", prompt: "p" }), /failed after 2 attempt\(s\)/);
  assert.equal(always, 2, "flake = one retry then throw, never a looser path");
});

t("replayClient replays, recordingClient persists, offlineGuardClient refuses", async () => {
  const dir = tmp("evals-record-");
  assert.equal(await replayClient("RECORDED").complete({ model: "m", prompt: "anything" }), "RECORDED");
  await assert.rejects(offlineGuardClient().complete({ model: "m", prompt: "p" }), /offline run attempted a live model call/);

  const inner = liveClient("m", { spawn: async () => ({ stdout: '{"result":"FRESH"}', stderr: "", code: 0 }), retries: 0 });
  const rec = recordingClient(inner, { task: "route", fixtureId: "route_selftest_scope", fixtureSha: "sha1", promptSha: "sha2", model: "m" }, dir);
  assert.equal(await rec.complete({ model: "m", prompt: "p" }), "FRESH");
  const saved = readReplay("route", "route_selftest_scope", dir)!;
  assert.equal(saved.response, "FRESH");
  assert.equal(saved.fixture_sha, "sha1");
  assert.equal(saved.prompt_sha, "sha2");
  assert.ok(Date.parse(saved.recorded_at) > 0);
});

// ---------------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------------

t("extractSection / sectionByPrefix take a heading through the next same-or-higher heading", () => {
  const md = ["# Title", "intro", "", "## Rules (v2)", "- one", "", "### Sub", "detail", "", "## After", "nope"].join("\n");
  assert.equal(extractSection(md, "Rules (v2)"), ["## Rules (v2)", "- one", "", "### Sub", "detail"].join("\n"));
  assert.equal(sectionByPrefix(md, "Rules"), ["## Rules (v2)", "- one", "", "### Sub", "detail"].join("\n"));
  assert.equal(extractSection(md, "## Sub"), "### Sub\ndetail");
  assert.equal(extractSection(md, "after"), "## After\nnope");
  assert.equal(extractSection(md, "Title").split("\n").length, 11, "a level-1 heading runs to the end here");
  assert.throws(() => extractSection(md, "Nonexistent"), /section not found/);
  assert.throws(() => sectionByPrefix(md, "Nonexistent", "x.md"), /x\.md: no section whose heading starts with "Nonexistent"/);
});

t("readSkillFile reads repo-relative sources and refuses to escape the repo", () => {
  assert.match(readSkillFile("evals/DESIGN.md"), /Eval harness design/);
  assert.throws(() => readSkillFile("../../etc/passwd"), /escapes the repo/);
  assert.throws(() => readSkillFile("skills/no-such-skill/SKILL.md"), /prompt source not found/);
});

t("composeTemplate joins parts and shas exactly that text", () => {
  const a = composeTemplate(["  alpha  ", "", "beta"]);
  assert.equal(a.text, "alpha\n\nbeta");
  assert.match(a.sha, /^[0-9a-f]{64}$/);
  assert.equal(composeTemplate(["alpha", "beta"]).sha, a.sha, "same template text = same sha");
  assert.notEqual(composeTemplate(["alpha", "beta!"]).sha, a.sha, "prompt drift moves the sha");
});

t("extractJsonObject survives prose and fenced blocks around the verdict", () => {
  assert.deepEqual(extractJsonObject('Here you go:\n```json\n{"route": "QUALIFIED"}\n```\nhope that helps'), { route: "QUALIFIED" });
  assert.deepEqual(extractJsonObject('{"route":"QUALIFIED","rationale":"has a } brace in it"}'), { route: "QUALIFIED", rationale: "has a } brace in it" });
  assert.deepEqual(extractJsonObject("prefix {\"a\":{\"b\":1}} suffix"), { a: { b: 1 } });
  assert.equal(extractJsonObject("no json here"), null);
  assert.equal(extractJsonObject("{unbalanced"), null);
  assert.deepEqual(extractJsonObject('[{"route":"QUALIFIED"}]'), { route: "QUALIFIED" }, "an array-wrapped verdict still yields its object");
});

t("extractJsonObject(preferKeyed) scores the model's FINAL answer, not the retracted one", () => {
  // A verdict, a retraction, a corrected verdict. First-object parsing scored the answer the
  // model had withdrawn.
  const selfCorrected = [
    '{"route":"SKIP","rationale":"A titled owner appears in the sweep."}',
    "",
    "Wait, that contradicts the evidence — the only function-titled hit is a self-styled headline.",
    "",
    '{"route":"QUALIFIED","evidence_names":["Dana Reyes"],"rationale":"No sitting titled owner."}',
  ].join("\n");
  assert.deepEqual(extractJsonObject(selfCorrected, "route"), {
    route: "QUALIFIED",
    evidence_names: ["Dana Reyes"],
    rationale: "No sitting titled owner.",
  });
  // Default behavior is EXACTLY unchanged: omit the parameter and the first object still wins.
  assert.equal((extractJsonObject(selfCorrected) as any).route, "SKIP");

  // Objects that do not carry the key are ignored WHEN THEY PRECEDE the verdict — a quoted
  // input snippet or a worked example must not outrank it.
  const noisy = [
    'Considering the evidence {"name":"Dana Reyes","title":"CIO"} and the schema',
    '{"decision":"keep","drop_class":null,"rationale":"Operating retailer."}',
  ].join("\n");
  assert.deepEqual(extractJsonObject(noisy, "decision"), {
    decision: "keep",
    drop_class: null,
    rationale: "Operating retailer.",
  });

  // Nested objects are not returned separately: the outer verdict wins even when an inner
  // object also carries the key.
  assert.deepEqual(extractJsonObject('{"verdict":"confirm","echo":{"verdict":"quoted from the notes"}}', "verdict"), {
    verdict: "confirm",
    echo: { verdict: "quoted from the notes" },
  });

  // No object carries the key → fall back to the default path rather than returning nothing.
  assert.deepEqual(extractJsonObject('{"verdict":"confirm","evidence_names":["Sam Okoye"]}', "route"), {
    verdict: "confirm",
    evidence_names: ["Sam Okoye"],
  });
  // A fenced single answer behaves identically with and without the preference.
  const fenced = 'Here you go:\n```json\n{"decision":"drop","drop_class":"staffing_or_agency"}\n```';
  assert.deepEqual(extractJsonObject(fenced, "decision"), extractJsonObject(fenced));
  // Unparseable stays unparseable — preferKeyed never invents a verdict.
  assert.equal(extractJsonObject("no json here", "route"), null);
  assert.equal(extractJsonObject("{unbalanced", "route"), null);
  assert.equal(extractJsonObject("", "route"), null);
});

t("preferKeyed: the terminal object must carry the key as a STRING, or it is a parse failure", () => {
  // A trailing object whose key is null / an object / an array is not a verdict. Crucially it
  // must not silently fall back to the earlier one either — the reply broke its contract.
  for (const tail of ['{"route":null}', '{"route":{"value":"QUALIFIED"}}', '{"route":["QUALIFIED"]}']) {
    assert.equal(extractJsonObject(`{"route":"QUALIFIED"}\nfootnote ${tail}`, "route"), null, tail);
  }
  // ...and a well-formed terminal object with a string value is still accepted.
  assert.deepEqual(extractJsonObject('prose\n{"route":"FLAGGED","rationale":"thin"}', "route"), {
    route: "FLAGGED",
    rationale: "thin",
  });
});

t("preferKeyed: a broken FINAL object never falls back to the retracted earlier one", () => {
  const retracted = '{"route":"SKIP","rationale":"retracted"}\nCorrected:\n';
  // Trailing comma: the corrected object does not parse.
  assert.equal(extractJsonObject(`${retracted}{"route":"QUALIFIED","rationale":"final",}`, "route"), null);
  // Truncated mid-emit: the reply stopped before the verdict closed.
  assert.equal(extractJsonObject(`${retracted}{"route":"QUALIFIED","rationale":"fin`, "route"), null);
  // Scoring the RETRACTED SKIP here would register a FORBIDDEN HIT — a lesson reported as
  // regressed because the model fumbled its own JSON.
  assert.notEqual(extractJsonObject(`${retracted}{"route":"QUALIFIED","rationale":"final",}`, "route"), {
    route: "SKIP",
    rationale: "retracted",
  });
});

t("preferKeyed: a nested object is never promoted out of an unparseable outer object", () => {
  assert.equal(extractJsonObject('{"verdict": {"route":"SKIP"}, bad json}', "route"), null);
  // The same shape with the outer object VALID still reads the outer one, not the inner.
  assert.deepEqual(extractJsonObject('{"route":"QUALIFIED","echo":{"route":"SKIP"}}', "route"), {
    route: "QUALIFIED",
    echo: { route: "SKIP" },
  });
});

t("preferKeyed: JSON written AFTER the verdict is a contract violation, not a better answer", () => {
  // The reasoning illustrates the alternative it rejected. Reading the last keyed object would
  // score the hypothetical — on a fixture whose trap IS SKIP that turns a correct reply into a
  // FORBIDDEN HIT. Neither object is terminal and both carry the key: unresolvable, so it
  // scores wrong.
  assert.equal(
    extractJsonObject(
      '{"route":"QUALIFIED","rationale":"real"}\nFor contrast, a SKIP would look like {"route":"SKIP"}.',
      "route",
    ),
    null,
  );
  // But a SINGLE verdict with prose either side is unambiguous and still parses — a common,
  // harmless shape that it would be gratuitous to score as wrong.
  assert.deepEqual(extractJsonObject('Here you go: {"route":"QUALIFIED","rationale":"r"} — done.', "route"), {
    route: "QUALIFIED",
    rationale: "r",
  });
  // A fenced answer IS terminal — a closing ``` is the only non-whitespace tail allowed.
  const fencedAnswer = 'Reasoning first.\n```json\n{"route":"QUALIFIED","rationale":"r"}\n```';
  assert.deepEqual(extractJsonObject(fencedAnswer, "route"), { route: "QUALIFIED", rationale: "r" });
  assert.deepEqual(extractJsonObject(fencedAnswer, "route"), extractJsonObject(fencedAnswer));
});

// ---------------------------------------------------------------------------
// run.ts machinery (mock runner + mock client)
// ---------------------------------------------------------------------------

const mockRunner = (
  scores: Record<string, Record<string, number>>,
  opts: { skipAll?: boolean } = {},
): Runner => ({
  task: "route",
  promptSha: () => "prompt-sha-1",
  run: async (fixture, client) => {
    if (opts.skipAll) return { skipped: true, skip_reason: "no replay recorded", scores: {}, details: null };
    const raw = await client.complete({ model: "mock", prompt: `judge ${fixture.id}` });
    return { scores: scores[fixture.id] ?? { correct: 0, forbidden_hit: 0 }, details: { raw } };
  },
});

t("runTasks scores a task through a mock runner + mock client", async () => {
  const fixtures = load(VALID_DIR);
  const client = replayClient('{"route":"QUALIFIED"}');
  const { taskResults, promptShas } = await runTasks({
    tasks: ["route"],
    fixtures,
    offline: true,
    client,
    getRunner: async () => mockRunner({ route_selftest_scope: { correct: 1, forbidden_hit: 0 } }),
  });
  assert.deepEqual(Object.keys(taskResults), ["route"]);
  assert.equal(promptShas.route, "prompt-sha-1");
  assert.deepEqual(taskResults.route.micro, { n: 1, accuracy: 1, forbidden_hits: 0 });
  assert.deepEqual(taskResults.route.details.route_selftest_scope, { raw: '{"route":"QUALIFIED"}' });
});

// A task that silently drops out of the report is silently ungated, and --baseline would
// enshrine its absence forever.
t("a task whose runner cannot be resolved fails the run, naming the module path", async () => {
  const fixtures = load(VALID_DIR);
  await assert.rejects(
    runTasks({
      tasks: ["route", "salesnav-verdict"],
      fixtures,
      offline: true,
      client: replayClient("{}"),
      getRunner: async (task) => (task === "route" ? mockRunner({}) : null),
    }),
    /no Runner for task "salesnav-verdict".*runners\/salesnav-verdict\.ts/s,
  );
  // The real resolver names the file it looked for rather than returning null.
  await assert.rejects(importRunner("no-such-task" as any), /runner module not found:.*no-such-task\.ts/s);
  // ...and every task in TASKS resolves to a real runner.
  for (const task of TASKS) assert.equal((await importRunner(task))?.task, task);
});

// Offline skips are expected individually; a task that loaded fixtures and scored NONE is the
// post-edit state check-evals.sh exists to catch, and must never print PASS.
t("a run of ANY mode that scores none of its loaded fixtures forces the gated metric to 0", async () => {
  const fixtures = load(VALID_DIR);
  const skipping = { tasks: ["route"], fixtures, client: offlineGuardClient(), getRunner: async () => mockRunner({}, { skipAll: true }) };

  for (const offline of [true, false]) {
    const res = await runTasks({ ...skipping, offline });
    assert.deepEqual(res.taskResults.route.micro, { n: 0, accuracy: 0 }, `mode offline=${offline} must fail loudly`);
    assert.deepEqual(res.forcedZero, ["route"], `mode offline=${offline} must report the forced task`);
    assert.deepEqual(res.taskResults.route.per_fixture.route_selftest_scope, {
      skipped: true,
      skip_reason: "no replay recorded",
    });
    // ...and it reaches the gate as a regression against any real baseline.
    const regs = diffAgainstBaseline(
      fakeReport({ route: res.taskResults.route.micro }),
      fakeBaseline({ route: { accuracy: 0.9 } }),
      0.02,
    );
    assert.ok(regs.length >= 1, `mode offline=${offline} must regress`);
  }

  // A task with NO loaded fixtures at all is a filtered-out task, not a broken one.
  const none = await runTasks({ ...skipping, fixtures: fixtures.filter((f) => f.task === "route"), tasks: ["salesnav-verdict"], offline: true });
  assert.deepEqual(none.forcedZero, []);
});

t("the skip summary names every unscored fixture and its reason", () => {
  const report = fakeReport({ route: {} });
  report.tasks.route.per_fixture = {
    route_a: { skipped: true, skip_reason: "replay is stale: prompt sha deadbeefcafe != 0123456789ab" },
    route_b: { skipped: true, skip_reason: "replay is stale: prompt sha deadbeefcafe != 0123456789ab" },
    route_c: { correct: 1, forbidden_hit: 0 },
  } as any;
  const lines: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    assert.equal(printSkipSummary(report), 2, "two fixtures were never asked");
  } finally {
    console.error = realError;
  }
  const text = lines.join("\n");
  assert.match(text, /2 FIXTURE\(S\) NOT SCORED/);
  assert.match(text, /route\/route_a/);
  assert.match(text, /route\/route_b/);
  assert.doesNotMatch(text, /route_c/, "a scored fixture is not a skip");
  assert.equal(printSkipSummary(fakeReport({ route: { n: 1, accuracy: 1 } })), 0);
});

// Accuracy is a rate: the same injected wrong answer scores 0.889 (FAIL) when its replay is
// valid and 1.000 (PASS) when that one replay is stale, because the failing fixture simply
// leaves the pool.
t("scoring fewer fixtures than the baseline is a coverage failure, not a pass", () => {
  const baseline = fakeBaseline({ route: { n: 9, accuracy: 1, forbidden_hits: 0 } });
  const shrunk = fakeReport({ route: { n: 8, accuracy: 1, forbidden_hits: 0 } });
  const regs = diffAgainstBaseline(shrunk, baseline, 0.02);
  assert.equal(regs.length, 1, "a perfect 8-of-9 must not pass a 9-fixture baseline");
  assert.equal(regs[0].coverage, true);
  assert.equal(regs[0].metric, "n");
  assert.deepEqual([regs[0].baseline, regs[0].current], [9, 8]);

  // Same n passes; MORE fixtures than the baseline (a newly added fixture) passes.
  assert.deepEqual(diffAgainstBaseline(fakeReport({ route: { n: 9, accuracy: 1 } }), baseline, 0.02), []);
  assert.deepEqual(diffAgainstBaseline(fakeReport({ route: { n: 10, accuracy: 1 } }), baseline, 0.02), []);
  // A --fixture subset run turns the check off deliberately.
  assert.deepEqual(diffAgainstBaseline(shrunk, baseline, 0.02, { checkCoverage: false }), []);
});

t("a baseline fixture that no longer loads is a completeness violation", () => {
  const fixtures = load(VALID_DIR);
  const complete = fakeBaseline({}, Object.fromEntries(fixtures.map((f) => [f.id, f.sha])));
  assert.deepEqual(checkFixtureCompleteness(complete, fixtures), []);
  assert.deepEqual(checkFixtureCompleteness(null, fixtures), []);

  // Deleted, and renamed (which is a delete plus an add).
  const survivors = fixtures.filter((f) => f.id !== "route_selftest_scope");
  const gone = checkFixtureCompleteness(complete, survivors);
  assert.equal(gone.length, 1);
  assert.match(gone[0], /fixture route_selftest_scope is in the baseline but was not loaded/);
  assert.match(gone[0], /deleted or renamed/);
  // Immutability alone says nothing about it — that is exactly the hole.
  assert.deepEqual(checkFixtureImmutability(complete, survivors), []);
});

t("--baseline refuses a run that measured nothing, or that is missing a task", () => {
  const full = Object.fromEntries(TASKS.map((task) => [task, { n: 3, accuracy: 1, forbidden_hits: 0 }]));
  assert.deepEqual(baselineSanityProblems(fakeReport(full)), [], "a complete, measured run is fine");

  const forced = baselineSanityProblems(fakeReport({ ...full, route: { n: 0, accuracy: 0 } }), ["route"]);
  assert.equal(forced.length, 1);
  assert.match(forced[0], /route: every fixture skipped/);

  const zeroN = baselineSanityProblems(fakeReport({ ...full, "salesnav-verdict": { n: 0, accuracy: 0 } }));
  assert.equal(zeroN.length, 1);
  assert.match(zeroN[0], /salesnav-verdict: scored n=0/);

  const { route: _dropped, ...missingTask } = full;
  const missing = baselineSanityProblems(fakeReport(missingTask));
  assert.equal(missing.length, 1);
  assert.match(missing[0], /missing: route/);
});

// Prompts are composed from the WORKING TREE while git_sha records HEAD, so a baseline could
// otherwise claim a provenance its own commit does not reproduce.
t("git_sha is marked -dirty when a prompt source has uncommitted edits", () => {
  const repo = tmp("evals-git-");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.invalid");
  git("config", "user.name", "t");
  mkdirSync(join(repo, "skills"), { recursive: true });
  writeFileSync(join(repo, "skills", "SKILL.md"), "rule one\n");
  writeFileSync(join(repo, "README.md"), "unrelated\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  assert.match(gitShortSha(repo), /^[0-9a-f]+$/, "a clean prompt tree is not dirty");

  // An edit OUTSIDE skills//config/ says nothing about prompt provenance.
  writeFileSync(join(repo, "README.md"), "changed\n");
  assert.doesNotMatch(gitShortSha(repo), /-dirty$/);

  // An edit to a prompt source does.
  writeFileSync(join(repo, "skills", "SKILL.md"), "rule one, amended\n");
  assert.match(gitShortSha(repo), /^[0-9a-f]+-dirty$/);
  assert.equal(gitShortSha(join(repo, "no-such-dir")), "nogit");
});

t("a forbidden hit from a runner reaches the gate as a run failure", async () => {
  const fixtures = load(VALID_DIR);
  const { taskResults } = await runTasks({
    tasks: ["route"],
    fixtures,
    offline: true,
    client: replayClient('{"route":"SKIP"}'),
    getRunner: async () => mockRunner({ route_selftest_scope: scoreEnumFixture(byId(fixtures, "route_selftest_scope"), { route: "SKIP" }) }),
  });
  assert.equal(taskResults.route.micro.forbidden_hits, 1);
  const regs = diffAgainstBaseline(fakeReport({ route: taskResults.route.micro }), null, 0.02);
  assert.equal(regs.length, 1);
  assert.equal(regs[0].absolute, true);
});

t("parseArgs enforces the CLI contract", () => {
  assert.equal(parseArgs([]).args?.task, "all");
  const a = parseArgs(["--task", "route", "--fixture", "x", "--offline", "--label", "v2", "--tolerance", "0", "--runs", "3"]).args!;
  assert.deepEqual([a.task, a.fixture, a.offline, a.label, a.tolerance, a.runs], ["route", "x", true, "v2", 0, 3]);
  assert.deepEqual(parseArgs(["--compare", "a.json", "b.json"]).args?.compare, ["a.json", "b.json"]);
  assert.match(parseArgs(["--runs", "2", "--baseline"]).error ?? "", /--baseline requires a single deterministic run/);
  assert.match(parseArgs(["--tolerance", "-1"]).error ?? "", /non-negative/);
  assert.match(parseArgs(["--runs", "0"]).error ?? "", />= 1/);
  assert.match(parseArgs(["--nope"]).error ?? "", /unknown argument/);
  assert.match(parseArgs(["--task"]).error ?? "", /--task requires a value/);
  assert.match(parseArgs(["--compare", "only-one.json"]).error ?? "", /two report paths/);
});

// The rulebooks are quoted VERBATIM into every prompt. A rule that names the account it was
// learned from is an answer key for the fixture built from that account (removing one such
// clause once moved a fixture from 3/3 to 0/3). Rules stay in the skill and the ICP; the
// identifiers live in fixture provenance and notes, which are never quoted. This guard fails
// the moment a committed fixture's domain, company or gold person name reappears in composed
// prompt text — for the shipped synthetic corpus and for whatever the operator adds later.
t("no committed fixture's identifiers appear in any composed prompt (de-identification guard)", async () => {
  const templates: Record<string, string> = {};
  for (const task of ["fit-triage", "route", "salesnav-verdict"]) {
    const mod: any = await import(`../evals/harness/runners/${task}.ts`);
    templates[task] = mod.buildTemplate().text;
  }
  const mod: any = await import("../evals/harness/runners/evidence-synthesis.ts");
  const t4 = mod.buildTemplates();
  templates["evidence-synthesis"] = `${t4.generate}\n${t4.judge}`;

  // What counts as an identifier: the domain, its label with the hyphens as spaces (the
  // company name as prose), the label's FIRST token (the brand — later tokens like
  // "automation" or "freight" are ordinary words a rulebook may legitimately use), and every
  // full gold person name.
  const banned = new Set<string>();
  for (const f of loadAllFixtures(CASES_DIR)) {
    const label = f.provenance.domain.split(".")[0];
    banned.add(f.provenance.domain);
    banned.add(label.replace(/[-_]+/g, " "));
    banned.add(label.split(/[-_]/)[0]);
    const names = (f.gold?.evidence_names as unknown[] | undefined) ?? [];
    for (const n of names) if (typeof n === "string" && n.trim().length >= 5) banned.add(n.trim());
  }
  assert.ok(banned.size > 0, "the committed corpus yields identifiers to guard");
  const leaks: string[] = [];
  for (const [task, text] of Object.entries(templates)) {
    const lower = text.toLowerCase();
    for (const term of banned) if (lower.includes(term.toLowerCase())) leaks.push(`${task}: "${term}"`);
  }
  assert.deepEqual(leaks, [], `fixture identifiers leaked into quoted prompt text:\n  ${leaks.join("\n  ")}`);

  // Sanity: the guard is reading real templates, not empty strings.
  for (const [task, text] of Object.entries(templates)) assert.ok(text.length > 500, `${task} template looks empty`);
});

// ---------------------------------------------------------------------------
// seed-synthetic.ts — the $0 path for the shipped synthetic corpus
// ---------------------------------------------------------------------------

t("seed-synthetic writes replays + a baseline for a synthetic corpus and refuses a real fixture", async () => {
  const root = tmp("evals-seed-");
  const cases = join(root, "cases");
  cpSync(CASES_DIR, cases, { recursive: true });
  const replays = join(root, "replays");
  const baselinePath = join(root, "baseline.json");
  const quiet = async (fn: () => Promise<number>) => {
    const realLog = console.log;
    const realErr = console.error;
    const err: string[] = [];
    console.log = () => {};
    console.error = (...a: unknown[]) => void err.push(a.join(" "));
    try {
      return { code: await fn(), err: err.join("\n") };
    } finally {
      console.log = realLog;
      console.error = realErr;
    }
  };
  const first = await quiet(() => seed({ casesDir: cases, replaysDir: replays, baselinePath }));
  assert.equal(first.code, 0, first.err);
  const baseline = loadBaseline(baselinePath)!;
  assert.ok(baseline, "baseline written");
  for (const task of TASKS) assert.ok((baseline.metrics[task]?.n ?? 0) > 0, `${task} measured`);
  assert.equal(Object.values(baseline.metrics).reduce((s, m) => s + (m.forbidden_hits ?? 0), 0), 0);
  // Every seeded replay is keyed to the CURRENT shas — --check reports nothing stale.
  const check = await quiet(() => seed({ check: true, casesDir: cases, replaysDir: replays, baselinePath }));
  assert.equal(check.code, 0);

  // A single non-synthetic fixture refuses the whole corpus: real replays come from live runs.
  const someFixture = loadAllFixtures(cases)[0];
  const yamlPath = join(someFixture.dir, "fixture.yaml");
  writeFileSync(yamlPath, readFileSync(yamlPath, "utf8").replace(someFixture.provenance.domain, "real-company.com"));
  const refused = await quiet(() => seed({ casesDir: cases, replaysDir: replays, baselinePath }));
  assert.equal(refused.code, 1);
  assert.match(refused.err, /not synthetic/);
  assert.equal(isSynthetic({ provenance: { domain: "a.example" } } as Fixture), true);
  assert.equal(isSynthetic({ provenance: { domain: "a.com" } } as Fixture), false);
});

t("USAGE states that --compare never gates", async () => {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  let code: number;
  try {
    code = await mainCli(["--help"]);
  } finally {
    console.log = realLog;
  }
  assert.equal(code, 0);
  assert.match(lines.join("\n"), /--compare[\s\S]*never gates/);
});

// ---------------------------------------------------------------------------

const run = async () => {
  for (const test of tests) await test();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  if (failures) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("evals harness tests passed");
};

await run();
