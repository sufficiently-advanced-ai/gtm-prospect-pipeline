#!/usr/bin/env node
// evals/seed-synthetic.ts — make the shipped SYNTHETIC corpus runnable at $0.
//
//   node evals/seed-synthetic.ts            # write replays + baseline for the synthetic corpus
//   node evals/seed-synthetic.ts --check    # report which seeds are stale, write nothing
//
// The public repo ships invented fixtures (every provenance.domain ends in `.example`) so the
// harness, the loader, the gate and the flywheel can be exercised out of the box. A replay is
// normally a RECORDED model response, keyed to the fixture sha and the prompt-template sha;
// the shipped fixtures instead carry a hand-written canonical answer at
// `<fixture>/seed/response.md` (and, for evidence-synthesis, `seed/judgments.json`). This
// tool turns those seeds into replays under evals/replays/ keyed to the CURRENT shas, runs the
// offline suite over them, and writes evals/baselines/baseline.json — no model call anywhere.
//
// What it proves: that the harness scores, gates and replays correctly. What it does NOT
// prove: that a model applies your rules correctly — that is what a live run measures.
//
// It REFUSES any fixture whose provenance.domain is not a `.example` domain. A real fixture
// (excerpted from a real decision, in your private fork) can only ever get its replay from a
// live model run and its baseline from `node evals/run.ts --task all --baseline`; hand-written
// answers for real fixtures would turn the regression gate into a self-fulfilling one. Once
// you have real fixtures, delete the synthetic ones and stop using this tool.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadAllFixtures } from "./harness/loader.ts";
import { offlineGuardClient } from "./harness/model.ts";
import { baselineSanityProblems, buildReport, printReport, toBaseline, writeBaseline } from "./harness/report.ts";
import { REPLAYS_DIR, loadValidReplay, makeReplay, writeReplay } from "./harness/replay.ts";
import { encodeEnvelope } from "./harness/runners/evidence-synthesis.ts";
import { DEFAULT_JUDGE_MODEL, DEFAULT_RUNNER_MODEL, TASKS } from "./harness/types.ts";
import type { Fixture, Runner, Task } from "./harness/types.ts";
import { BASELINE_PATH, CASES_DIR, REPO_ROOT, importRunner, runTasks } from "./run.ts";

export const SYNTHETIC_TLD = ".example";
export const SEED_MODEL = "synthetic-seed";
export const SEED_RESPONSE = "seed/response.md";
export const SEED_JUDGMENTS = "seed/judgments.json";

export function isSynthetic(fixture: Fixture): boolean {
  return fixture.provenance.domain.toLowerCase().endsWith(SYNTHETIC_TLD);
}

// The replay text for one fixture, built from its seed files. Throws when a seed is missing —
// a synthetic fixture without a canonical answer cannot be gated and must not ship silently.
export function seedResponse(fixture: Fixture): string {
  const responsePath = join(fixture.dir, SEED_RESPONSE);
  if (!existsSync(responsePath)) throw new Error(`${fixture.id}: no ${SEED_RESPONSE} — every synthetic fixture needs a canonical answer`);
  const response = readFileSync(responsePath, "utf8");
  if (fixture.task !== "evidence-synthesis") return response;
  // The synthesis replay is a {generation, judgments} envelope (see the runner). A missing
  // judgments file means "the pre-check short-circuited" only if it really would; otherwise the
  // offline runner fails the checks loudly, which is the right outcome for a half-written seed.
  const judgmentsPath = join(fixture.dir, SEED_JUDGMENTS);
  const judgments = existsSync(judgmentsPath) ? readFileSync(judgmentsPath, "utf8") : null;
  return encodeEnvelope(response, judgments);
}

export async function seed(opts: { check?: boolean; casesDir?: string; replaysDir?: string; baselinePath?: string } = {}): Promise<number> {
  const casesDir = opts.casesDir ?? CASES_DIR;
  const replaysDir = opts.replaysDir ?? REPLAYS_DIR;
  const baselinePath = opts.baselinePath ?? BASELINE_PATH;

  const fixtures = loadAllFixtures(casesDir);
  const real = fixtures.filter((f) => !isSynthetic(f));
  if (real.length) {
    console.error(
      `ERROR: ${real.length} fixture(s) are not synthetic (provenance.domain does not end in ${SYNTHETIC_TLD}):\n` +
        real.map((f) => `  - ${f.id} (${f.provenance.domain})`).join("\n") +
        `\nA real fixture's replay comes only from a live run, and its baseline only from ` +
        `\`node evals/run.ts --task all --baseline\`. Seeding refuses to touch a mixed corpus.`,
    );
    return 1;
  }
  if (fixtures.length === 0) {
    console.error("ERROR: no fixtures under " + casesDir);
    return 1;
  }

  const runners = new Map<Task, Runner>();
  for (const task of TASKS) runners.set(task, (await importRunner(task))!);

  let stale = 0;
  for (const fixture of fixtures) {
    const runner = runners.get(fixture.task)!;
    const promptSha = runner.promptSha();
    const current = loadValidReplay(fixture.task, fixture.id, fixture.sha, promptSha, replaysDir);
    if (current.response !== undefined && current.response === seedResponse(fixture)) continue;
    stale += 1;
    if (opts.check) {
      console.log(`stale: ${fixture.task}/${fixture.id} — ${current.skip_reason ?? "seed text changed"}`);
      continue;
    }
    writeReplay(
      makeReplay({ fixtureId: fixture.id, task: fixture.task, fixtureSha: fixture.sha, promptSha, model: SEED_MODEL, response: seedResponse(fixture) }),
      replaysDir,
    );
  }
  if (opts.check) {
    console.log(stale ? `${stale} seed replay(s) stale — run without --check to refresh` : "all seed replays current");
    return stale ? 1 : 0;
  }
  console.log(`seeded ${stale} replay(s) (${fixtures.length - stale} already current) under ${replaysDir}`);

  // Score the seeded corpus offline and record the baseline from that run. EVAL_REPLAY_DIR is
  // how the runners find a non-default replay dir.
  const prior = process.env.EVAL_REPLAY_DIR;
  process.env.EVAL_REPLAY_DIR = replaysDir;
  let taskResults, promptShas, forcedZero;
  try {
    ({ taskResults, promptShas, forcedZero } = await runTasks({ tasks: [...TASKS], fixtures, offline: true, client: offlineGuardClient() }));
  } finally {
    if (prior === undefined) delete process.env.EVAL_REPLAY_DIR;
    else process.env.EVAL_REPLAY_DIR = prior;
  }
  const report = buildReport({
    repoRoot: REPO_ROOT,
    taskResults,
    promptShas,
    fixtures,
    models: { runner: SEED_MODEL, judge: SEED_MODEL },
    offline: true,
    label: "synthetic-seed",
  });
  printReport(report);
  const problems = baselineSanityProblems(report, forcedZero);
  if (problems.length) {
    console.error("ERROR: the seeded run did not measure the suite — baseline NOT written:");
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  const forbidden = Object.values(taskResults).reduce((s, tr) => s + (tr.micro.forbidden_hits ?? 0), 0);
  if (forbidden) {
    console.error(`ERROR: ${forbidden} forbidden hit(s) in the seeded answers — a seed contradicts its own fixture's trap; fix the seed, not the trap`);
    return 1;
  }
  writeBaseline(toBaseline(report), baselinePath);
  console.log(`Baseline written at ${baselinePath} (models ${DEFAULT_RUNNER_MODEL}/${DEFAULT_JUDGE_MODEL} are what a LIVE run would use; this one recorded ${SEED_MODEL})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  seed({ check }).then((code) => {
    process.exitCode = code;
  });
}
