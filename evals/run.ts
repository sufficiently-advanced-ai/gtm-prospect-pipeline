#!/usr/bin/env node
// evals/run.ts — the eval CLI (contract: evals/DESIGN.md §CLI).
//
//   node evals/run.ts --task all|<task> [--fixture <id>] [--offline] [--label <s>]
//                     [--baseline] [--tolerance 0.02] [--runs N]
//                     [--compare A.json B.json]
//
// Exit codes:
//   0 — ran; no gated-metric regression beyond tolerance AND every absolute-zero metric is 0
//   1 — regression, forbidden hit, fixture-immutability violation, bad usage, or error
//
// Task runners live in evals/harness/runners/<task>.ts and are imported lazily. Every task in
// TASKS has one, so a runner that fails to import is a BROKEN SUITE, not an absent feature: it
// exits 1 naming the module path. A task silently dropped from the report is a task silently
// ungated, and --baseline would then enshrine its absence.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadAllFixtures } from "./harness/loader.ts";
import { liveClient, offlineGuardClient } from "./harness/model.ts";
import {
  appendHistory,
  baselineSanityProblems,
  buildReport,
  checkFixtureCompleteness,
  checkFixtureImmutability,
  diffAgainstBaseline,
  loadBaseline,
  meanReport,
  printComparison,
  printRegressions,
  printReport,
  printRunsSummary,
  printSkipSummary,
  readReport,
  toBaseline,
  writeBaseline,
  writeReport,
} from "./harness/report.ts";
import { aggregateMicro, aggregateRubric } from "./harness/scoring.ts";
import {
  DEFAULT_JUDGE_MODEL,
  DEFAULT_RUNNER_MODEL,
  DEFAULT_TOLERANCE,
  GATED_METRICS,
  TASKS,
} from "./harness/types.ts";
import type { Fixture, ModelClient, Report, Runner, Task, TaskReport } from "./harness/types.ts";

export const EVALS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(EVALS_DIR, "..");
export const CASES_DIR = join(EVALS_DIR, "fixtures", "cases");
export const RESULTS_DIR = join(EVALS_DIR, "results");
export const BASELINE_PATH = join(EVALS_DIR, "baselines", "baseline.json");

const USAGE = `usage: node evals/run.ts --task all|${TASKS.join("|")} [--fixture <id>] [--offline]
       [--label <s>] [--baseline] [--tolerance 0.02] [--runs N] [--compare A.json B.json]

  --offline                 replay the committed responses in evals/replays/ — $0, no model
                            calls; a fixture with no valid replay is skipped WITH a reason.
  --baseline                rewrite evals/baselines/baseline.json from this run. Requires a
                            full live run (--task all, no --fixture, no --offline).
  --compare A.json B.json   print a metric-by-metric diff of two written reports and exit 0.
                            REPORTING ONLY — it never gates: --compare always exits 0 no matter
                            how far B regressed from A. The gate is a normal run against
                            baselines/baseline.json.`;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export type Args = {
  task: string;
  fixture?: string;
  offline: boolean;
  label?: string;
  baseline: boolean;
  tolerance: number;
  runs: number;
  compare?: [string, string];
  help: boolean;
};

export function parseArgs(argv: string[]): { args?: Args; error?: string } {
  const args: Args = { task: "all", offline: false, baseline: false, tolerance: DEFAULT_TOLERANCE, runs: 1, help: false };
  const need = (i: number, flag: string) => {
    if (i + 1 >= argv.length) throw new Error(`${flag} requires a value`);
    return argv[i + 1];
  };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--task") args.task = need(i++, a);
      else if (a === "--fixture") args.fixture = need(i++, a);
      else if (a === "--label") args.label = need(i++, a);
      else if (a === "--offline") args.offline = true;
      else if (a === "--baseline") args.baseline = true;
      else if (a === "--tolerance") args.tolerance = Number(need(i++, a));
      else if (a === "--runs") args.runs = Number(need(i++, a));
      else if (a === "--compare") {
        if (i + 2 >= argv.length) throw new Error("--compare requires two report paths");
        args.compare = [argv[i + 1], argv[i + 2]];
        i += 2;
      } else if (a === "--help" || a === "-h") args.help = true;
      else return { error: `unknown argument: ${a}` };
    }
  } catch (e: any) {
    return { error: e.message };
  }
  if (!Number.isFinite(args.tolerance) || args.tolerance < 0) return { error: "--tolerance must be a non-negative number" };
  if (!Number.isInteger(args.runs) || args.runs < 1) return { error: "--runs must be an integer >= 1" };
  if (args.runs > 1 && args.baseline) return { error: "--baseline requires a single deterministic run (drop --runs)" };
  return { args };
}

// ---------------------------------------------------------------------------
// Runner resolution
// ---------------------------------------------------------------------------

export type GetRunner = (task: Task) => Promise<Runner | null>;

export const importRunner: GetRunner = async (task) => {
  const path = join(EVALS_DIR, "harness", "runners", `${task}.ts`);
  if (!existsSync(path)) throw new Error(`runner module not found: ${path} (every task in TASKS must have one)`);
  const mod: any = await import(pathToFileURL(path).href); // a broken runner throws — deliberately
  const runner = mod.default ?? mod.runner ?? (typeof mod.createRunner === "function" ? mod.createRunner() : null);
  if (!runner || typeof runner.run !== "function")
    throw new Error(`harness/runners/${task}.ts exports no Runner (expected \`export default\` or \`export const runner\`)`);
  return runner as Runner;
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

// Live runs record their replays inside the runners (model.ts recordingClient), which is
// where the fixture/prompt shas that key a replay are known.
export async function runTasks(opts: {
  tasks: string[];
  fixtures: Fixture[];
  offline: boolean;
  client: ModelClient;
  getRunner?: GetRunner;
}): Promise<{
  taskResults: Record<string, TaskReport>;
  promptShas: Record<string, string>;
  forcedZero: string[]; // tasks whose gated metrics were forced to 0 by the all-skipped rule
}> {
  const getRunner = opts.getRunner ?? importRunner;
  const taskResults: Record<string, TaskReport> = {};
  const promptShas: Record<string, string> = {};
  const forcedZero: string[] = [];

  for (const task of opts.tasks) {
    const runner = await getRunner(task as Task);
    // No graceful absence. A task in TASKS with no usable Runner is a broken suite.
    if (!runner)
      throw new Error(
        `no Runner for task "${task}" (expected evals/harness/runners/${task}.ts to export one). ` +
          `A task that silently drops out of the report is a task that is silently ungated.`,
      );
    promptShas[task] = runner.promptSha();

    const perFixture: TaskReport["per_fixture"] = {};
    const details: Record<string, unknown> = {};
    for (const fixture of opts.fixtures.filter((f) => f.task === task)) {
      const result = await runner.run(fixture, opts.client, opts.offline);
      if (result.skipped) {
        perFixture[fixture.id] = { skipped: true, skip_reason: result.skip_reason ?? "(no reason given)" };
        continue;
      }
      perFixture[fixture.id] = result.scores;
      details[fixture.id] = result.details;
    }

    const scored: Record<string, Record<string, number>> = {};
    for (const [fid, s] of Object.entries(perFixture)) if (!(s as any).skipped) scored[fid] = s as Record<string, number>;

    let micro =
      task === "evidence-synthesis" ? aggregateRubric(scored) : aggregateMicro(scored);

    // A run where every labeled fixture skipped is a BROKEN run, not a pass — in BOTH modes.
    // Offline skips are expected INDIVIDUALLY; a task that loaded fixtures and scored NONE of
    // them is the exact post-skill-edit state check-evals.sh exists to catch (every replay
    // stale, nothing measured, empty micro, no metric to compare, PASS printed). Force the
    // gated metric to 0 so the baseline gate cannot be silently bypassed.
    if (Object.keys(perFixture).length > 0 && Object.keys(scored).length === 0) {
      micro = { n: 0 };
      for (const metric of GATED_METRICS[task as Task] ?? []) micro[metric] = 0;
      forcedZero.push(task);
      console.error(
        `ERROR: ${task}: all ${Object.keys(perFixture).length} labeled fixture(s) skipped on ` +
          `${opts.offline ? "an offline" : "a live"} run — nothing was measured; forcing ` +
          `${Object.keys(micro).filter((k) => k !== "n").join(", ")} to 0`,
      );
    }

    taskResults[task] = { micro, per_fixture: perFixture, details };
  }

  return { taskResults, promptShas, forcedZero };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`ERROR: ${parsed.error}\n${USAGE}`);
    return 1;
  }
  const args = parsed.args!;
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  if (args.compare) {
    let a: Report;
    let b: Report;
    try {
      a = readReport(args.compare[0]);
      b = readReport(args.compare[1]);
    } catch (e: any) {
      console.error(`ERROR: could not read comparison report: ${e.message}`);
      return 1;
    }
    printComparison(a, b);
    return 0;
  }

  const tasks = args.task === "all" ? [...TASKS] : [args.task];
  const unknown = tasks.filter((t) => !(TASKS as readonly string[]).includes(t));
  if (unknown.length) {
    console.error(`ERROR: unknown task(s): ${unknown.join(", ")}\n${USAGE}`);
    return 1;
  }

  let fixtures: Fixture[];
  try {
    fixtures = loadAllFixtures(CASES_DIR);
  } catch (e: any) {
    console.error(`ERROR: ${e.message}`);
    return 1;
  }
  if (args.fixture) {
    fixtures = fixtures.filter((f) => f.id === args.fixture);
    if (!fixtures.length) {
      console.error(`ERROR: fixture not found: ${args.fixture}`);
      return 1;
    }
  }

  let baseline;
  try {
    baseline = loadBaseline(BASELINE_PATH);
  } catch (e: any) {
    console.error(`ERROR: could not read baseline ${BASELINE_PATH}: ${e.message}`);
    return 1;
  }

  const violations = checkFixtureImmutability(baseline, fixtures);
  // On a FULL run, a baseline fixture that no longer loads (deleted / renamed) is a
  // violation too. A --task or --fixture subset legitimately loads a subset.
  const isFullSet = args.task === "all" && !args.fixture;
  if (isFullSet) violations.push(...checkFixtureCompleteness(baseline, fixtures));
  if (violations.length) {
    // --baseline IS the act of re-recording the standard: SCHEMA.md §Immutability says to
    // change a fixture by bumping version, saying why in notes, and "rewrite the baseline in
    // the same change". Blocking that command on the very change it exists to record would
    // make the documented procedure impossible to follow. Under --baseline the differences are
    // printed as the changes being adopted; every other invocation still exits 1 on them.
    for (const v of violations) console.error(`${args.baseline ? "ADOPTING" : "ERROR"}: ${v}`);
    if (!args.baseline) return 1;
    console.error("(--baseline: the above are the fixture changes this baseline adopts.)\n");
  }

  console.log(
    `Loaded ${fixtures.length} fixtures; tasks: ${tasks.join(", ")}${args.offline ? " (offline)" : ""}`,
  );

  let runs = args.runs;
  if (runs > 1 && args.offline) {
    console.error("Note: --offline is deterministic replay; ignoring --runs > 1");
    runs = 1;
  }

  const models = {
    runner: process.env.EVAL_MODEL ?? DEFAULT_RUNNER_MODEL,
    judge: process.env.EVAL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL,
  };
  const client = args.offline ? offlineGuardClient() : liveClient(models.runner);

  const reports: Report[] = [];
  const forcedZeroTasks = new Set<string>();
  for (let i = 0; i < runs; i++) {
    if (runs > 1) console.log(`\n--- run ${i + 1}/${runs} ---`);
    let taskResults: Record<string, TaskReport>;
    let promptShas: Record<string, string>;
    let forcedZero: string[];
    try {
      ({ taskResults, promptShas, forcedZero } = await runTasks({
        tasks,
        fixtures,
        offline: args.offline,
        client,
      }));
    } catch (e: any) {
      console.error(`ERROR: run failed: ${e.message}`);
      return 1;
    }
    for (const t of forcedZero) forcedZeroTasks.add(t);
    const report = buildReport({
      repoRoot: REPO_ROOT,
      taskResults,
      promptShas,
      fixtures,
      models,
      offline: args.offline,
      label: args.label,
    });
    if (runs > 1) report.run_id = `${report.run_id}_r${i + 1}`;
    const path = writeReport(report, RESULTS_DIR);
    reports.push(report);
    if (runs === 1) {
      printReport(report, baseline);
      console.log(`\nReport written to ${path}`);
    }
  }

  const report = runs > 1 ? meanReport(reports) : reports[0];
  if (runs > 1) printRunsSummary(reports, baseline);

  // Skips are announced loudly, after the numbers, so an unmeasured run cannot read green.
  printSkipSummary(report);

  // One trend line per invocation. Offline scores are not comparable to live ones.
  if (!args.offline) appendHistory(report, RESULTS_DIR);

  if (args.baseline) {
    // A baseline must reflect a full, live run — a subset or replay snapshot would weaken
    // all future gating. (The shipped SYNTHETIC corpus is seeded by evals/seed-synthetic.ts,
    // which refuses any fixture that is not a *.example domain.)
    if (args.fixture || args.task !== "all" || args.offline) {
      console.error("ERROR: --baseline requires a full live run (no --fixture, --task must be 'all', no --offline)");
      return 1;
    }
    // ...and it must reflect a run that actually measured something, for every task.
    const problems = baselineSanityProblems(report, [...forcedZeroTasks]);
    if (problems.length) {
      console.error("ERROR: refusing to write a baseline from a run that did not measure the suite:");
      for (const p of problems) console.error(`  - ${p}`);
      console.error("  A baseline recorded from a broken run becomes the standard every later run is judged against.");
      return 1;
    }
    writeBaseline(toBaseline(report), BASELINE_PATH);
    console.log(`Baseline rewritten at ${BASELINE_PATH}`);
    return 0;
  }

  // A --fixture subset legitimately scores fewer fixtures than the baseline; nothing else does.
  const regressions = diffAgainstBaseline(report, baseline, args.tolerance, { checkCoverage: !args.fixture });
  if (regressions.length) {
    printRegressions(regressions);
    return 1;
  }
  // A forced-zero task fails even with no baseline to compare against: nothing was measured.
  if (forcedZeroTasks.size) {
    console.error(
      `\nFAIL — no fixture was scored for: ${[...forcedZeroTasks].sort().join(", ")}. ` +
        `A run that measured nothing is never a pass.`,
    );
    return 1;
  }
  if (baseline) console.log("PASS — no gated-metric regression vs baseline");
  else console.log("No baseline yet — run with --baseline to record one");
  return 0;
}

// Only run when invoked directly (tests import this module).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
