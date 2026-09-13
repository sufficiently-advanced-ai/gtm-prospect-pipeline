// evals/harness/types.ts — shared contracts for the eval harness.
// Erasable-syntax TypeScript (no enums/namespaces), run with `node` 24+ like everything
// else in this repo. Every harness module and runner imports these shapes — never fork
// them locally. Route values mirror lib/status-map.ts ROUTES; on any conflict, status-map.ts
// wins and this file must be updated to match.

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const TASKS = ["fit-triage", "route", "salesnav-verdict", "evidence-synthesis"] as const;
export type Task = (typeof TASKS)[number];

// ---------------------------------------------------------------------------
// Verdicts (what a runner must parse out of the model's response, per task).
// Runners instruct the model to emit exactly one JSON object matching these
// shapes. Parse failures score as wrong, never as skipped.
// ---------------------------------------------------------------------------

// `drop_class` is NOT an enum in code. The operator defines the drop classes in
// config/icp.md ("## Drop classes", one `- slug — description` bullet each) and the loader
// validates fixture gold against whatever is listed there at run time (harness/icp.ts).
// A keep carries no drop_class.
export type FitTriageVerdict = {
  decision: "keep" | "drop";
  drop_class?: string | null;
  rationale: string;
};

// Route values are the M2 CLASSIFICATION vocabulary: lib/status-map.ts ROUTES minus DROPPED,
// which belongs to fit-triage. SKIP is binary and account-level (a confirmed disqualifier per
// config/icp.md); FLAGGED is the never-guess branch for conflicting or thin evidence.
export const ROUTE_VALUES = ["QUALIFIED", "SKIP", "FLAGGED"] as const;
export type RouteValue = (typeof ROUTE_VALUES)[number];

export type RouteVerdict = {
  route: RouteValue;
  evidence_names?: string[]; // the people whose titles/scope decide the classification
  rationale: string;
};

// The vocabulary of `account.provisional_route` (the headless call the Sales Navigator pass
// confirms or flips). Not a verdict field of any task; draft-fixture.ts reads it to infer a
// salesnav-verdict gold, and SCHEMA.md documents it.
export const PROVISIONAL_ROUTES = ["QUALIFIED", "SKIP", "DROPPED", "FLAGGED"] as const;

export const SALESNAV_VERDICTS = ["confirm", "flip_to_skip", "flag"] as const;
export type SalesNavVerdict = {
  verdict: (typeof SALESNAV_VERDICTS)[number];
  evidence_names: string[]; // the people whose titles/scope decide the verdict
  rationale: string;
};

// evidence-synthesis is rubric-scored by a judge, not enum-scored.
export type JudgeCheckResult = { id: string; pass: boolean; why: string };
export type SynthesisJudgeVerdict = {
  must: JudgeCheckResult[];
  should: JudgeCheckResult[];
};

export type Verdict = FitTriageVerdict | RouteVerdict | SalesNavVerdict | SynthesisJudgeVerdict;

// The gold/verdict field that exact-match scoring compares, per enum task.
export const PRIMARY_FIELD: Record<Task, string> = {
  "fit-triage": "decision",
  route: "route",
  "salesnav-verdict": "verdict",
  "evidence-synthesis": "", // rubric-scored; no primary field
};

// Every field a task's verdict object may carry — the authority for validating a fixture's
// `forbidden.field`. A trap on a field the task's verdict does not have (a misspelling like
// `rout`, or another task's field like `decision` on a route fixture) can NEVER fire:
// scoreEnumFixture looks the field up on the parsed verdict, finds undefined, and counts
// nothing. Such a trap is a lesson silently switched off, so the loader rejects it. Keep in
// sync with the verdict types above.
export const VERDICT_FIELDS: Record<Task, string[]> = {
  "fit-triage": ["decision", "drop_class", "rationale"],
  route: ["route", "evidence_names", "rationale"],
  "salesnav-verdict": ["verdict", "evidence_names", "rationale"],
  "evidence-synthesis": [], // rubric-scored: no verdict fields, and therefore no traps
};

// Secondary fields scored for reporting (never gated). `evidence_names` is scored as recall
// against the gold list; every other secondary field is exact-match.
export const SECONDARY_FIELDS: Partial<Record<Task, string[]>> = {
  "fit-triage": ["drop_class"],
  route: ["evidence_names"],
  "salesnav-verdict": ["evidence_names"],
};

// ---------------------------------------------------------------------------
// Fixtures (full field semantics in evals/fixtures/SCHEMA.md)
// ---------------------------------------------------------------------------

export type FixtureInput = {
  path: string; // relative to the fixture dir, always under inputs/
  role: string; // per-task role vocabulary — see SCHEMA.md
};

// An outcome the model must NOT produce. A forbidden hit is an ABSOLUTE gate
// failure (not tolerance-subject): it means a lesson the fixture encodes regressed.
export type Forbidden = {
  field: string;  // verdict field, e.g. "route"
  value: string;  // the forbidden value, e.g. "SKIP"
  reason: string; // the failure this trap encodes — what went wrong and why it matters
};

export type RubricCheck = { id: string; text: string };

export type FixtureProvenance = {
  domain: string;        // the account domain the fixture derives from (synthetic: *.example)
  source: string;        // where the gold outcome is recorded (progress line, registry entry, icp.md ruling)
  incident_date?: string; // ISO date of the original decision/correction, quoted
};

export type Fixture = {
  id: string;      // ^[a-z0-9_]+$, prefixed with task, e.g. route_northwind_scope_not_title
  task: Task;
  version: number; // bump ONLY via the deliberate change procedure in SCHEMA.md
  description: string; // what this fixture stresses and the trap it encodes
  provenance: FixtureProvenance;
  inputs: FixtureInput[];
  gold: Record<string, unknown>; // task verdict shape (rubric tasks: omit; use rubric)
  forbidden?: Forbidden[];
  rubric?: { must: RubricCheck[]; should: RubricCheck[] }; // evidence-synthesis only
  notes?: string;
  // Filled by the loader, never present in fixture.yaml:
  dir: string; // absolute fixture directory
  sha: string; // immutability hash (see SCHEMA.md §Hashing)
};

// ---------------------------------------------------------------------------
// Runner interface
// ---------------------------------------------------------------------------

export type RunnerResult = {
  skipped?: boolean;    // offline with no replay recorded → skipped, with reason
  skip_reason?: string;
  scores: Record<string, number>; // per-fixture scores, e.g. {correct: 1, forbidden_hit: 0}
  details: unknown;               // parsed verdict + gold, for the report's details block
};

export type ModelRequest = {
  model: string;
  system?: string;
  prompt: string;
  max_tokens?: number;
};

export type ModelClient = {
  complete: (req: ModelRequest) => Promise<string>;
};

export type Runner = {
  task: Task;
  // sha of the composed prompt TEMPLATE (skill/config sections + instructions,
  // EXCLUDING fixture inputs) — recorded per run, gates on prompt drift.
  promptSha: () => string;
  run: (fixture: Fixture, client: ModelClient, offline: boolean) => Promise<RunnerResult>;
};

// ---------------------------------------------------------------------------
// Replay (recorded model responses for offline/$0 runs)
// Stored at evals/replays/<task>/<fixture_id>.json — committed to git.
// ---------------------------------------------------------------------------

export type Replay = {
  fixture_id: string;
  task: Task;
  fixture_sha: string; // replay is invalid if the fixture changed
  prompt_sha: string;  // replay is invalid if the prompt template changed
  model: string;
  response: string;    // raw model text, re-parsed/re-scored on replay
  recorded_at: string; // ISO timestamp
};

// ---------------------------------------------------------------------------
// Reports, baseline, gating
// ---------------------------------------------------------------------------

export type TaskMetrics = Record<string, number>;
// Enum tasks emit: { n, accuracy, forbidden_hits } (+ secondary-field rates).
// evidence-synthesis emits: { n, must_pass_rate, should_pass_rate, citation_violations }.

export type TaskReport = {
  micro: TaskMetrics;
  per_fixture: Record<string, Record<string, number> | { skipped: true; skip_reason: string }>;
  details: Record<string, unknown>;
};

export type Report = {
  run_id: string;
  label?: string;
  created_at: string;
  git_sha: string;
  offline: boolean;
  models: { runner: string; judge: string };
  prompt_shas: Record<string, string>;
  fixture_shas: Record<string, string>;
  tasks: Record<string, TaskReport>;
};

export type Baseline = {
  created_at: string;
  git_sha: string;
  prompt_shas: Record<string, string>;
  fixture_shas: Record<string, string>;
  metrics: Record<string, TaskMetrics>;
};

// Metrics compared against baseline with tolerance (higher is better).
export const GATED_METRICS: Record<Task, string[]> = {
  "fit-triage": ["accuracy"],
  route: ["accuracy"],
  "salesnav-verdict": ["accuracy"],
  "evidence-synthesis": ["must_pass_rate"],
};

// Metrics that must be EXACTLY 0 on every run — no tolerance, no baseline
// comparison. A nonzero value fails the run outright.
export const ABSOLUTE_ZERO_METRICS = ["forbidden_hits"] as const;

export const DEFAULT_TOLERANCE = 0.02;

// Model defaults. EVAL_MODEL / EVAL_JUDGE_MODEL env vars override. Runners use
// the model the production modules actually run under; the judge stays fixed
// so rubric scores are comparable across runs.
export const DEFAULT_RUNNER_MODEL = "claude-opus-5";
export const DEFAULT_JUDGE_MODEL = "claude-opus-5";
