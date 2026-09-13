// evals/harness/report.ts — build/print/write run reports, baseline load/diff/rewrite,
// fixture immutability, history trend, multi-run means, report comparison.
//
// Gating semantics:
//  - GATED_METRICS regress when current < baseline - tolerance (higher is better).
//  - ABSOLUTE_ZERO_METRICS (forbidden_hits) must be exactly 0 on EVERY run, with or without
//    a baseline, at any tolerance. A hit means a specific encoded failure came back.
//  - A fixture whose sha differs from the baseline's recorded sha is an immutability
//    violation: the fixture changed under a baseline that was measured against the old one.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ABSOLUTE_ZERO_METRICS, DEFAULT_TOLERANCE, GATED_METRICS, TASKS } from "./types.ts";
import type { Baseline, Fixture, Report, TaskMetrics, TaskReport } from "./types.ts";

export type Regression = {
  task: string;
  metric: string;
  baseline: number;
  current: number;
  delta: number;
  absolute?: boolean; // absolute-zero gate, not a baseline comparison
  coverage?: boolean; // the denominator shrank — fewer fixtures scored than the baseline had
};

// Prompt-source paths whose working-tree state decides whether a recorded run is reproducible
// from its git_sha. See gitShortSha().
export const PROMPT_SOURCE_PATHS = ["skills", "config"];

// A report/baseline records HEAD, but prompt.ts composes every template from the WORKING
// TREE. With uncommitted edits under skills/ or config/, `git_sha` would claim a provenance
// the commit cannot reproduce — the recorded prompt_shas are not what that commit produces.
//
// Scope: the PROMPT SOURCE paths — `skills/` and `config/` — not the whole tree. Those are
// exactly the files that feed promptSha, so a "-dirty" suffix here means precisely "the
// prompts in this run are not reproducible from this commit". Whole-tree dirtiness (an edited
// test, an untracked scratch file) says nothing about prompt provenance and would leave the
// marker permanently on, which is how a warning stops being read.
export function gitShortSha(repoRoot: string): string {
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const sha = git(["rev-parse", "--short", "HEAD"]);
    try {
      const dirty = git(["status", "--porcelain", "--", ...PROMPT_SOURCE_PATHS]);
      return dirty ? `${sha}-dirty` : sha;
    } catch {
      return sha;
    }
  } catch {
    return "nogit";
  }
}

// 20260101T185500Z — sortable, UTC, filename-safe.
export function utcStamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function buildReport(opts: {
  repoRoot: string;
  taskResults: Record<string, TaskReport>;
  promptShas: Record<string, string>;
  fixtures: Fixture[];
  models: { runner: string; judge: string };
  offline: boolean;
  label?: string;
  now?: Date;
}): Report {
  const now = opts.now ?? new Date();
  const gitSha = gitShortSha(opts.repoRoot);
  const label = opts.label ? slug(opts.label) : undefined;
  const fixtureShas: Record<string, string> = {};
  for (const f of [...opts.fixtures].sort((a, b) => (a.id < b.id ? -1 : 1))) fixtureShas[f.id] = f.sha;
  return {
    run_id: `${utcStamp(now)}_${gitSha}${label ? `_${label}` : ""}`,
    label: opts.label,
    created_at: now.toISOString(),
    git_sha: gitSha,
    offline: opts.offline,
    models: opts.models,
    prompt_shas: opts.promptShas,
    fixture_shas: fixtureShas,
    tasks: opts.taskResults,
  };
}

export function writeReport(report: Report, resultsDir: string): string {
  mkdirSync(resultsDir, { recursive: true });
  const path = join(resultsDir, `${report.run_id}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

export function readReport(path: string): Report {
  return JSON.parse(readFileSync(path, "utf8")) as Report;
}

// Missing baseline is not an error — it is the "no baseline yet" state (run --baseline).
export function loadBaseline(path: string): Baseline | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Baseline;
}

export function toBaseline(report: Report): Baseline {
  const metrics: Record<string, TaskMetrics> = {};
  for (const [task, tr] of Object.entries(report.tasks)) metrics[task] = tr.micro;
  return {
    created_at: report.created_at,
    git_sha: report.git_sha,
    prompt_shas: report.prompt_shas,
    fixture_shas: report.fixture_shas,
    metrics,
  };
}

export function writeBaseline(baseline: Baseline, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
}

// `checkCoverage` (default true) enables the shrinking-denominator gate. run.ts turns it
// off only for a --fixture subset run, where a smaller n is the point of the invocation.
export function diffAgainstBaseline(
  report: Report,
  baseline: Baseline | null,
  tolerance: number = DEFAULT_TOLERANCE,
  opts: { checkCoverage?: boolean } = {},
): Regression[] {
  const checkCoverage = opts.checkCoverage !== false;
  const out: Regression[] = [];
  for (const [task, tr] of Object.entries(report.tasks)) {
    const micro = tr.micro ?? {};

    // Absolute-zero gates first: no baseline, no tolerance, no excuses.
    for (const metric of ABSOLUTE_ZERO_METRICS) {
      const current = micro[metric];
      if (typeof current === "number" && current !== 0)
        out.push({ task, metric, baseline: 0, current, delta: current, absolute: true });
    }

    if (!baseline) continue;
    const base = baseline.metrics?.[task];
    if (!base) continue;

    // Accuracy is a RATE, so a shrinking denominator hides a real regression. A stale replay
    // makes its fixture skip; the fixture that skipped is exactly the one whose sha or prompt
    // moved, i.e. the one most likely to have changed answer. Eight of nine fixtures still at
    // 1.000 reads as PASS while the ninth — the one encoding the lesson — is simply not being
    // asked. Scoring fewer fixtures than the baseline scored is therefore a run failure in its
    // own right, offline and live alike.
    if (checkCoverage && typeof base.n === "number" && typeof micro.n === "number" && micro.n < base.n)
      out.push({ task, metric: "n", baseline: base.n, current: micro.n, delta: micro.n - base.n, coverage: true });

    for (const metric of GATED_METRICS[task as keyof typeof GATED_METRICS] ?? []) {
      const b = base[metric];
      const c = micro[metric];
      if (typeof b !== "number" || typeof c !== "number") continue;
      if (c < b - tolerance) out.push({ task, metric, baseline: b, current: c, delta: c - b });
    }
  }
  return out;
}

// A loaded fixture whose sha differs from the baseline's is a violation. Fixtures absent
// from the baseline are NEW (adding one is a deliberate baseline change, not a violation);
// baseline entries absent from the loaded set are not checked here, because --fixture/--task
// subsets legitimately load a subset (see checkFixtureCompleteness for the full-run rule).
export function checkFixtureImmutability(baseline: Baseline | null, fixtures: Fixture[]): string[] {
  if (!baseline?.fixture_shas) return [];
  const out: string[] = [];
  for (const f of fixtures) {
    const recorded = baseline.fixture_shas[f.id];
    if (!recorded || recorded === f.sha) continue;
    out.push(
      `fixture ${f.id} changed since the baseline (${recorded.slice(0, 12)} -> ${f.sha.slice(0, 12)}). ` +
        `To change a fixture deliberately: bump version, say why in notes, and rewrite the baseline ` +
        `in the same change (SCHEMA.md §Immutability).`,
    );
  }
  return out;
}

// checkFixtureImmutability only compares fixtures that are STILL THERE, so deleting or
// renaming an inconvenient fixture dir would pass every gate silently — the deleted one just
// stops being checked, and the suite gets easier without a single error. On a FULL run (no
// --task/--fixture filter) every id the baseline recorded must still load. Subset runs
// legitimately load a subset and keep the old semantics, so the caller decides when to apply
// this.
export function checkFixtureCompleteness(baseline: Baseline | null, fixtures: Fixture[]): string[] {
  if (!baseline?.fixture_shas) return [];
  const loaded = new Set(fixtures.map((f) => f.id));
  const out: string[] = [];
  for (const id of Object.keys(baseline.fixture_shas).sort()) {
    if (loaded.has(id)) continue;
    out.push(
      `fixture ${id} is in the baseline but was not loaded — deleted or renamed. A fixture that ` +
        `stops being asked is a lesson that stops being tested. Restore it, or retire it ` +
        `deliberately (fixtures/retired/<id>/RETIRED.md) and rewrite the baseline in the same change.`,
    );
  }
  return out;
}

// --baseline needs a sanity floor, or a broken run can be enshrined AS the standard. Two ways
// that happens: (a) a task whose fixtures all skipped writes accuracy 0.0, and every future
// run then clears a floor of zero — the gate is dead but green; (b) a task missing from the
// report entirely (runner import failure) writes no metrics for it, and that task is ungated
// FOREVER, silently. Both are permanent damage applied by a command whose whole purpose is to
// define correctness.
export function baselineSanityProblems(report: Report, forcedZeroTasks: string[] = []): string[] {
  const out: string[] = [];
  const present = Object.keys(report.tasks);
  const missing = (TASKS as readonly string[]).filter((t) => !present.includes(t));
  if (missing.length)
    out.push(`report covers ${present.length}/${TASKS.length} tasks — missing: ${missing.join(", ")}`);
  for (const task of present.sort()) {
    const micro = report.tasks[task]?.micro ?? {};
    if (forcedZeroTasks.includes(task))
      out.push(`${task}: every fixture skipped (gated metrics were forced to 0) — a broken run, not a standard`);
    else if (typeof micro.n !== "number" || micro.n === 0)
      out.push(`${task}: scored n=${micro.n ?? "—"} — a baseline may not record a task that measured nothing`);
  }
  return out;
}

// One committed line per LIVE invocation — the trend. Offline scores are not comparable to
// live ones and never land here.
export function appendHistory(report: Report, resultsDir: string): string {
  mkdirSync(resultsDir, { recursive: true });
  const path = join(resultsDir, "history.jsonl");
  const metrics: Record<string, TaskMetrics> = {};
  for (const [task, tr] of Object.entries(report.tasks)) metrics[task] = tr.micro;
  const line = {
    run_id: report.run_id,
    created_at: report.created_at,
    git_sha: report.git_sha,
    label: report.label,
    models: report.models,
    prompt_shas: report.prompt_shas,
    metrics,
  };
  appendFileSync(path, `${JSON.stringify(line)}\n`);
  return path;
}

// Mean of N repeated live runs — what --runs N gates on. Metric-wise mean over the runs
// that reported the metric; per_fixture/details come from the last run (the reports for the
// individual runs are all written to results/ anyway).
export function meanReport(reports: Report[]): Report {
  if (reports.length === 0) throw new Error("meanReport: no reports");
  if (reports.length === 1) return reports[0];
  const last = reports[reports.length - 1];
  const tasks: Record<string, TaskReport> = {};
  const taskNames = new Set<string>();
  for (const r of reports) for (const t of Object.keys(r.tasks)) taskNames.add(t);
  for (const task of [...taskNames].sort()) {
    const micros = reports.map((r) => r.tasks[task]?.micro).filter((m): m is TaskMetrics => !!m);
    const keys = new Set<string>();
    for (const m of micros) for (const k of Object.keys(m)) keys.add(k);
    const micro: TaskMetrics = {};
    for (const k of [...keys].sort()) {
      const vals = micros.map((m) => m[k]).filter((v): v is number => typeof v === "number");
      if (vals.length) micro[k] = vals.reduce((s, v) => s + v, 0) / vals.length;
    }
    tasks[task] = {
      micro,
      per_fixture: last.tasks[task]?.per_fixture ?? {},
      details: last.tasks[task]?.details ?? {},
    };
  }
  return {
    ...last,
    run_id: `${reports[0].run_id.replace(/_r\d+$/, "")}_mean${reports.length}`,
    tasks,
  };
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

const fmt = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(3));

export function printReport(report: Report, baseline: Baseline | null = null): void {
  console.log(`\nrun ${report.run_id}${report.offline ? "  (offline replay)" : ""}`);
  console.log(`  models: runner=${report.models.runner} judge=${report.models.judge}`);
  const taskNames = Object.keys(report.tasks).sort();
  if (taskNames.length === 0) console.log("  (no tasks ran)");
  for (const task of taskNames) {
    const tr = report.tasks[task];
    const skipped = Object.values(tr.per_fixture).filter((v: any) => v && v.skipped).length;
    const base = baseline?.metrics?.[task];
    const parts = Object.entries(tr.micro).map(([k, v]) => {
      const b = base?.[k];
      const delta = typeof b === "number" ? ` (${v - b >= 0 ? "+" : ""}${(v - b).toFixed(3)})` : "";
      return `${k}=${fmt(v)}${delta}`;
    });
    console.log(
      `  ${task}: ${parts.join("  ") || "(no scored fixtures)"}${skipped ? `  [${skipped} skipped]` : ""}`,
    );
    for (const [fid, scores] of Object.entries(tr.per_fixture)) {
      const s = scores as any;
      if (s?.skipped) {
        console.log(`      - ${fid}: SKIP (${s.skip_reason})`);
        continue;
      }
      const bad = (s.correct === 0 ? " WRONG" : "") + (s.forbidden_hit ? " FORBIDDEN-HIT" : "");
      if (bad) console.log(`      - ${fid}:${bad}`);
    }
  }
}

export function printRunsSummary(reports: Report[], baseline: Baseline | null = null): void {
  console.log(`\nspread over ${reports.length} runs:`);
  const taskNames = new Set<string>();
  for (const r of reports) for (const t of Object.keys(r.tasks)) taskNames.add(t);
  for (const task of [...taskNames].sort()) {
    for (const metric of GATED_METRICS[task as keyof typeof GATED_METRICS] ?? []) {
      const vals = reports
        .map((r) => r.tasks[task]?.micro?.[metric])
        .filter((v): v is number => typeof v === "number");
      if (!vals.length) continue;
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
      const b = baseline?.metrics?.[task]?.[metric];
      console.log(
        `  ${task}.${metric}: mean=${mean.toFixed(3)} min=${Math.min(...vals).toFixed(3)} ` +
          `max=${Math.max(...vals).toFixed(3)}${typeof b === "number" ? ` baseline=${b.toFixed(3)}` : ""}`,
      );
    }
  }
}

export function printComparison(a: Report, b: Report): void {
  console.log(`\nA: ${a.run_id}  (${a.models.runner})`);
  console.log(`B: ${b.run_id}  (${b.models.runner})`);
  const taskNames = new Set([...Object.keys(a.tasks), ...Object.keys(b.tasks)]);
  for (const task of [...taskNames].sort()) {
    const ma = a.tasks[task]?.micro ?? {};
    const mb = b.tasks[task]?.micro ?? {};
    const keys = [...new Set([...Object.keys(ma), ...Object.keys(mb)])].sort();
    console.log(`  ${task}:`);
    for (const k of keys) {
      const va = ma[k];
      const vb = mb[k];
      if (typeof va !== "number" || typeof vb !== "number") {
        console.log(`      ${k}: ${va ?? "—"} -> ${vb ?? "—"}`);
        continue;
      }
      const d = vb - va;
      console.log(`      ${k}: ${fmt(va)} -> ${fmt(vb)} (${d >= 0 ? "+" : ""}${d.toFixed(3)})`);
    }
    if (a.prompt_shas[task] && a.prompt_shas[task] !== b.prompt_shas[task])
      console.log(`      prompt_sha changed: ${a.prompt_shas[task].slice(0, 12)} -> ${(b.prompt_shas[task] ?? "—").slice(0, 12)}`);
  }
}

// Skips are summarised LOUDLY, on stderr, grouped by reason, after the report. Buried as one
// dim line per fixture inside the per-task listing, an offline run in which every replay had
// died still printed a wall of green numbers and "PASS", and the reader had to notice an
// absence to understand that nothing had been measured.
export function printSkipSummary(report: Report): number {
  const rows: Array<{ task: string; fixture: string; reason: string }> = [];
  for (const task of Object.keys(report.tasks).sort()) {
    for (const [fid, v] of Object.entries(report.tasks[task].per_fixture)) {
      const s = v as any;
      if (s?.skipped) rows.push({ task, fixture: fid, reason: s.skip_reason ?? "(no reason given)" });
    }
  }
  if (!rows.length) return 0;
  console.error(`\n!! ${rows.length} FIXTURE(S) NOT SCORED — these questions were never asked:`);
  const byReason = new Map<string, string[]>();
  for (const r of rows) {
    const key = r.reason.replace(/\b[0-9a-f]{12,}\b/g, "<sha>");
    if (!byReason.has(key)) byReason.set(key, []);
    byReason.get(key)!.push(`${r.task}/${r.fixture}`);
  }
  for (const [reason, ids] of [...byReason.entries()].sort()) {
    console.error(`   ${reason}`);
    for (const id of ids.sort()) console.error(`      - ${id}`);
  }
  console.error("   A stale replay usually means a fixture or a prompt source moved: re-record live (or re-seed the synthetic corpus).");
  return rows.length;
}

export function printRegressions(regressions: Regression[]): void {
  console.error("\nFAIL — gated metric regressions vs baseline:");
  for (const r of regressions) {
    if (r.coverage) {
      console.error(
        `  ${r.task}.n: ${fmt(r.baseline)} -> ${fmt(r.current)} — coverage shrank (stale replays?). ` +
          `Accuracy is a rate: scoring fewer fixtures than the baseline hides the ones that stopped being asked.`,
      );
      continue;
    }
    if (r.absolute) {
      console.error(`  ${r.task}.${r.metric}: ${fmt(r.current)} — must be 0 (absolute gate, no tolerance)`);
      continue;
    }
    console.error(
      `  ${r.task}.${r.metric}: ${r.baseline.toFixed(3)} -> ${r.current.toFixed(3)} (${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(3)})`,
    );
  }
}
