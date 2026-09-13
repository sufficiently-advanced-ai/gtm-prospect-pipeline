// evals/harness/scoring.ts — exact-match scoring + micro aggregation.
//
// Scoring is deterministic and model-free: a runner parses the model's JSON verdict, hands
// it here, and gets back the per-fixture score dict that lands in the report. A verdict of
// `null` means the model's output could not be parsed into the task's verdict shape —
// DESIGN.md: "Parse failure = wrong answer", scored 0, never a skip.
import { PRIMARY_FIELD, SECONDARY_FIELDS } from "./types.ts";
import type { Fixture, TaskMetrics } from "./types.ts";

// Metric keys that are SUMMED across fixtures rather than averaged.
const COUNT_METRICS = new Set(["forbidden_hit"]);

// Secondary fields scored as name recall rather than exact match.
const NAME_LIST_FIELDS = new Set(["evidence_names"]);

const norm = (v: unknown): string => String(v).trim();
const normName = (v: string): string => v.toLowerCase().replace(/\s+/g, " ").trim();

// Score one enum-task fixture. Returns {correct, forbidden_hit, ...secondary rates}.
export function scoreEnumFixture(
  fixture: Fixture,
  verdict: Record<string, unknown> | null,
): Record<string, number> {
  const gold = (fixture.gold ?? {}) as Record<string, unknown>;
  const primary = PRIMARY_FIELD[fixture.task];
  const scores: Record<string, number> = { correct: 0, forbidden_hit: 0 };

  if (!primary) throw new Error(`${fixture.id}: task ${fixture.task} has no primary field — not enum-scored`);
  if (verdict === null) return scores; // unparseable = wrong, and it can't hit a trap

  if (gold[primary] !== undefined && verdict[primary] !== undefined && norm(verdict[primary]) === norm(gold[primary]))
    scores.correct = 1;

  // Forbidden traps are ABSOLUTE: each hit is a lesson the fixture encodes regressing.
  for (const trap of fixture.forbidden ?? []) {
    const got = verdict[trap.field];
    if (got !== undefined && got !== null && norm(got) === norm(trap.value)) scores.forbidden_hit += 1;
  }

  // Secondary fields are reported, never gated. Gold that omits the field leaves it unscored.
  for (const field of SECONDARY_FIELDS[fixture.task] ?? []) {
    if (gold[field] === undefined || gold[field] === null) continue;
    if (NAME_LIST_FIELDS.has(field)) {
      const recall = nameRecall(gold[field] as unknown[], verdict[field]);
      if (recall !== null) scores.name_recall = recall;
      continue;
    }
    scores[`${field}_correct`] =
      verdict[field] !== undefined && verdict[field] !== null && norm(verdict[field]) === norm(gold[field]) ? 1 : 0;
  }

  return scores;
}

// A predicted name shorter than this, or covering less than MIN_NAME_RATIO of the gold name,
// is not a name match. See nameRecall().
export const MIN_NAME_CHARS = 3;
export const MIN_NAME_RATIO = 0.5;

// Fraction of gold names the model surfaced. Case-insensitive, whitespace-collapsed, and
// substring-tolerant in the DECORATION direction without limit: "Dana Reyes, VP Eng" contains
// "Dana Reyes", so it counts — the point is whether the model looked at the right people, not
// string discipline.
//
// The reverse direction is bounded: a partial prediction has to be a substantial part of the
// gold name it claims — at least MIN_NAME_CHARS characters AND at least MIN_NAME_RATIO of the
// gold name's length ("Reyes" for "Dana Reyes" counts; "Dana" and "a" do not). Otherwise a
// single-letter prediction would score full recall against any name. name_recall is reported,
// never gated, but a metric that cannot be failed by garbage is not a metric.
export function nameRecall(goldNames: unknown[], predicted: unknown): number | null {
  const gold = (goldNames ?? []).filter((n) => typeof n === "string").map((n) => normName(n as string));
  if (gold.length === 0) return null;
  const pred = (Array.isArray(predicted) ? predicted : [])
    .filter((n) => typeof n === "string")
    .map((n) => normName(n as string))
    .filter((n) => n !== "");
  const matches = (g: string, p: string): boolean => {
    if (p.includes(g)) return true; // the prediction carries the whole gold name
    if (!g.includes(p)) return false;
    return p.length >= MIN_NAME_CHARS && p.length / g.length >= MIN_NAME_RATIO;
  };
  let hits = 0;
  for (const g of gold) if (pred.some((p) => matches(g, p))) hits += 1;
  return hits / gold.length;
}

// Micro-average over the scored (non-skipped) fixtures of one task.
//   n             — number of scored fixtures
//   accuracy      — mean of `correct`
//   forbidden_hits— SUM of `forbidden_hit` (absolute-zero gate)
//   *_correct / name_recall — mean over the fixtures that carry them
// Returns {} for an empty input (the caller decides what an empty task means:
// offline-all-skipped is fine, live-all-skipped is a broken run).
export function aggregateMicro(scored: Record<string, Record<string, number>>): TaskMetrics {
  const rows = Object.values(scored);
  if (rows.length === 0) return {};
  const out: TaskMetrics = { n: rows.length };

  const correct = rows.filter((r) => typeof r.correct === "number");
  if (correct.length) out.accuracy = correct.reduce((s, r) => s + r.correct, 0) / correct.length;

  out.forbidden_hits = rows.reduce((s, r) => s + (r.forbidden_hit ?? 0), 0);

  const keys = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) keys.add(k);
  for (const key of [...keys].sort()) {
    if (key === "correct" || COUNT_METRICS.has(key)) continue;
    const present = rows.filter((r) => typeof r[key] === "number");
    if (present.length) out[key] = present.reduce((s, r) => s + r[key], 0) / present.length;
  }
  return out;
}

// Rubric tasks (evidence-synthesis): mean of the per-fixture pass rates, plus any
// deterministic violation counters the runner emitted (summed).
export function aggregateRubric(scored: Record<string, Record<string, number>>): TaskMetrics {
  const rows = Object.values(scored);
  if (rows.length === 0) return {};
  const out: TaskMetrics = { n: rows.length };
  for (const key of ["must_pass_rate", "should_pass_rate"]) {
    const present = rows.filter((r) => typeof r[key] === "number");
    if (present.length) out[key] = present.reduce((s, r) => s + r[key], 0) / present.length;
  }
  for (const key of ["citation_violations", "forbidden_hit"]) {
    if (rows.some((r) => typeof r[key] === "number"))
      out[key === "forbidden_hit" ? "forbidden_hits" : key] = rows.reduce((s, r) => s + (r[key] ?? 0), 0);
  }
  return out;
}

// Score a judge verdict's must/should checks into pass rates.
export function scoreRubricChecks(
  must: Array<{ pass: boolean }>,
  should: Array<{ pass: boolean }>,
): Record<string, number> {
  const rate = (checks: Array<{ pass: boolean }>) =>
    checks.length === 0 ? null : checks.filter((c) => c.pass).length / checks.length;
  const out: Record<string, number> = {};
  const m = rate(must);
  const s = rate(should);
  out.must_pass_rate = m === null ? 0 : m; // no must-checks passed because there were none = fail loud
  if (s !== null) out.should_pass_rate = s;
  return out;
}
