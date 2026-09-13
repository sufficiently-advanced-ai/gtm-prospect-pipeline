// evals/harness/loader.ts — load, validate, and hash eval fixtures.
//
// Contract: evals/fixtures/SCHEMA.md (layout, roles, hygiene, immutability) and
// evals/harness/types.ts (shapes). This module never reads $PIPELINE_DATA — fixtures are
// frozen copies, and everything under evals/ is store-read-only.
//
// Fail loud: validation collects EVERY problem across EVERY fixture and throws one Error
// listing them, each line prefixed with the fixture id (or its dir when the id is unusable).
// A skipped-because-broken fixture would silently shrink the suite, so there is no such path.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { TASKS, PRIMARY_FIELD, VERDICT_FIELDS, ROUTE_VALUES, SALESNAV_VERDICTS } from "./types.ts";
import { dropClassSlugs, loadDropClasses } from "./icp.ts";
import type { Fixture, FixtureInput, Task } from "./types.ts";

export const MAX_INPUT_BYTES = 50 * 1024;
export const MAX_FIXTURE_BYTES = 200 * 1024;

const ID_RE = /^[a-z0-9_]+$/;

// Required input roles per task — mirrors the table in SCHEMA.md §"Input roles per task".
// Optional roles are NOT enumerated here: extra roles are allowed (evidence-synthesis takes
// the whole captured raw set, whose role names are open-ended: firecrawl_*, apollo_*, ...).
const REQUIRED_ROLES: Record<Task, string[]> = {
  "fit-triage": ["theirstack_company"],
  route: ["apollo_sweep"],
  "salesnav-verdict": ["salesnav", "checklist"],
  "evidence-synthesis": [], // "the full per-domain raw set" — at least one input, roles open
};

// Allowed values for the verdict fields gold may carry, keyed by TASK and then field.
// THIS MAP IS THE MIRROR of the verdict types in types.ts: any edit to a verdict union there
// must be echoed here, or gold/forbidden validation silently drifts from the shapes the
// runners ask for. A gold typo like `route: SKIPPED` would otherwise be an untestable fixture
// that can never be answered.
//
// Keyed by task, not by bare field name, so two tasks can legitimately carry different
// vocabularies for a same-named field. `drop_class` is filled in at load time from
// config/icp.md (see loadAllFixtures options) — it is the operator's list, not this file's.
type EnumMap = Record<Task, Record<string, readonly string[]>>;
function enumValues(dropClasses: readonly string[]): EnumMap {
  return {
    "fit-triage": { decision: ["keep", "drop"], drop_class: dropClasses },
    route: { route: ROUTE_VALUES },
    "salesnav-verdict": { verdict: SALESNAV_VERDICTS },
    "evidence-synthesis": {},
  };
}

// Fields scored as a list of names (recall), per task — validated as string lists.
const NAME_LIST_FIELDS = new Set(["evidence_names"]);

const isTask = (v: unknown): v is Task => typeof v === "string" && (TASKS as readonly string[]).includes(v);
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Hashing — see SCHEMA.md §"Immutability & change procedure"
// ---------------------------------------------------------------------------

// Deterministic JSON: object keys sorted lexicographically (UTF-16 code-unit order, i.e.
// Array.prototype.sort default) at every depth; array order preserved; undefined dropped.
// No whitespace. Dates/other non-JSON YAML scalars are stringified by JSON.stringify rules,
// so keep fixture.yaml to strings/numbers/bools/null (quote ISO dates — SCHEMA.md does).
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
  }
  return `{${parts.join(",")}}`;
}

// THE canonicalization rule (reproduce exactly or every replay and baseline dies):
//
//   h = sha256()
//   h.update("fixture.yaml\n", "utf8")
//   h.update(canonicalJson(YAML.parse(fixture.yaml) minus top-level `dir` and `sha`), "utf8")
//   h.update("\n", "utf8")
//   for each input, ordered by its posix `path` string ascending (default sort):
//       h.update(path + "\n", "utf8")
//       h.update(<raw bytes of the input file, unmodified>)
//       h.update("\n", "utf8")
//   sha = h.digest("hex")
//
// Consequences, on purpose:
//  - fixture.yaml is hashed SEMANTICALLY (parsed then canonicalized): reformatting, comment
//    edits, key reordering and quote-style changes do not break replays; changing a value,
//    adding/removing a key, or reordering the `inputs` array (array order is significant) do.
//  - input files are hashed BYTE-EXACT: a single changed byte, or a trailing-newline edit,
//    changes the sha.
//  - `dir` and `sha` are loader-filled and never present in fixture.yaml; they are excluded
//    explicitly so a round-tripped Fixture object hashes identically to the file.
//  - files in the fixture dir that are NOT declared inputs (a seed/ dir, a review sidecar) do
//    not participate in the hash.
export function computeFixtureSha(doc: Record<string, unknown>, dir: string, inputs: FixtureInput[]): string {
  const bare: Record<string, unknown> = { ...doc };
  delete bare.dir;
  delete bare.sha;
  const h = createHash("sha256");
  h.update("fixture.yaml\n", "utf8");
  h.update(canonicalJson(bare), "utf8");
  h.update("\n", "utf8");
  for (const input of [...inputs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(`${input.path}\n`, "utf8");
    h.update(readFileSync(join(dir, input.path))); // raw bytes, no decoding
    h.update("\n", "utf8");
  }
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function listDirs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort();
}

export type LoadOptions = {
  // The drop-class vocabulary fixtures are validated against. Defaults to the live
  // config/icp.md; tests inject a list so they never depend on the operator's file.
  dropClasses?: readonly string[];
};

// Load every fixture under <casesDir>/<task>/<id>/fixture.yaml.
// `staging/` and `selftest/` live outside cases/ and are therefore never loaded by a normal
// run; tests load selftest trees by passing their path explicitly.
export function loadAllFixtures(casesDir: string, opts: LoadOptions = {}): Fixture[] {
  const root = resolve(casesDir);
  if (!existsSync(root)) throw new Error(`fixtures dir not found: ${root}`);
  const enums = enumValues(opts.dropClasses ?? dropClassSlugs(loadDropClasses()));
  const errors: string[] = [];
  const fixtures: Fixture[] = [];
  const seen = new Map<string, string>(); // id -> dir

  for (const taskDir of listDirs(root)) {
    const taskPath = join(root, taskDir);
    for (const idDir of listDirs(taskPath)) {
      const dir = join(taskPath, idDir);
      const yamlPath = join(dir, "fixture.yaml");
      const label = `${taskDir}/${idDir}`;
      if (!existsSync(yamlPath)) {
        errors.push(`${label}: no fixture.yaml (every fixture dir must contain one)`);
        continue;
      }
      let doc: unknown;
      try {
        doc = YAML.parse(readFileSync(yamlPath, "utf8"));
      } catch (e: any) {
        errors.push(`${label}: fixture.yaml is not valid YAML — ${e.message}`);
        continue;
      }
      if (!isPlainObject(doc)) {
        errors.push(`${label}: fixture.yaml must be a mapping`);
        continue;
      }
      const problems = validateFixtureDoc(doc, dir, idDir, taskDir, enums);
      const id = typeof doc.id === "string" ? doc.id : label;
      if (problems.length) {
        for (const p of problems) errors.push(`${id}: ${p}`);
        continue;
      }
      const prior = seen.get(doc.id as string);
      if (prior) {
        errors.push(`${id}: duplicate fixture id — also defined at ${prior}`);
        continue;
      }
      seen.set(doc.id as string, dir);
      const inputs = (doc.inputs as FixtureInput[]).map((i) => ({ path: i.path, role: i.role }));
      fixtures.push({
        ...(doc as any),
        inputs,
        dir,
        sha: computeFixtureSha(doc, dir, inputs),
      } as Fixture);
    }
  }

  if (errors.length) throw new Error(`invalid fixture(s) under ${root}:\n  - ${errors.join("\n  - ")}`);
  return fixtures.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Returns a list of human-readable problems (empty = valid). Never throws.
function validateFixtureDoc(
  doc: Record<string, unknown>,
  dir: string,
  idDir: string,
  taskDir: string,
  enums: EnumMap,
): string[] {
  const p: string[] = [];

  if (typeof doc.id !== "string" || !ID_RE.test(doc.id)) {
    p.push(`id must match ${ID_RE} (got ${JSON.stringify(doc.id)})`);
  } else if (doc.id !== idDir) {
    p.push(`id must equal its directory name (id=${doc.id}, dir=${idDir})`);
  }

  if (!isTask(doc.task)) {
    p.push(`task ${JSON.stringify(doc.task)} is not one of ${TASKS.join("|")}`);
    return p; // everything below is task-dependent
  }
  const task = doc.task;
  if (task !== taskDir) p.push(`task "${task}" does not match its cases/<task>/ dir "${taskDir}"`);

  if (typeof doc.version !== "number" || !Number.isInteger(doc.version) || doc.version < 1) {
    p.push(`version must be a positive integer (got ${JSON.stringify(doc.version)})`);
  }
  if (typeof doc.description !== "string" || doc.description.trim() === "") {
    p.push("description is required (what this fixture stresses and the trap it encodes)");
  }

  const prov = doc.provenance;
  if (!isPlainObject(prov)) p.push("provenance is required (domain + source)");
  else {
    if (typeof prov.domain !== "string" || !prov.domain.trim()) p.push("provenance.domain is required");
    if (typeof prov.source !== "string" || !prov.source.trim())
      p.push("provenance.source is required (where the gold outcome is recorded)");
    if (prov.incident_date !== undefined && typeof prov.incident_date !== "string")
      p.push("provenance.incident_date must be a quoted ISO date string");
  }

  // ----- inputs
  const roles = new Set<string>();
  let totalBytes = 0;
  try {
    totalBytes = statSync(join(dir, "fixture.yaml")).size;
  } catch {
    /* already reported */
  }
  if (!Array.isArray(doc.inputs) || doc.inputs.length === 0) {
    p.push("inputs must be a non-empty list");
  } else {
    for (const [i, raw] of (doc.inputs as unknown[]).entries()) {
      if (!isPlainObject(raw) || typeof raw.path !== "string" || typeof raw.role !== "string") {
        p.push(`inputs[${i}] must be {path, role}`);
        continue;
      }
      const { path: rel, role } = raw as { path: string; role: string };
      if (!role.trim()) p.push(`inputs[${i}] has an empty role`);
      roles.add(role);
      const abs = resolve(dir, rel);
      if (abs !== dir && !abs.startsWith(dir + sep)) {
        p.push(`inputs[${i}] path escapes the fixture dir: ${rel}`);
        continue;
      }
      if (!rel.startsWith("inputs/")) p.push(`inputs[${i}] path must live under inputs/ (got ${rel})`);
      if (!existsSync(abs)) {
        p.push(`input file missing: ${rel} (role ${role})`);
        continue;
      }
      const size = statSync(abs).size;
      totalBytes += size;
      if (size > MAX_INPUT_BYTES)
        p.push(`input ${rel} is ${size}B — over the ${MAX_INPUT_BYTES}B per-file cap; excerpt it`);
    }
    if (totalBytes > MAX_FIXTURE_BYTES)
      p.push(`fixture totals ${totalBytes}B — over the ${MAX_FIXTURE_BYTES}B cap`);
  }
  for (const need of REQUIRED_ROLES[task]) {
    if (!roles.has(need)) p.push(`missing required input role for ${task}: ${need}`);
  }

  // ----- gold XOR rubric
  const isRubricTask = task === "evidence-synthesis";
  if (isRubricTask) {
    if (doc.gold !== undefined) p.push("evidence-synthesis is rubric-scored — remove gold");
    const rubric = doc.rubric;
    if (!isPlainObject(rubric)) p.push("evidence-synthesis requires a rubric {must, should}");
    else {
      p.push(...validateChecks(rubric.must, "rubric.must", true));
      p.push(...validateChecks(rubric.should, "rubric.should", false));
    }
  } else {
    if (doc.rubric !== undefined) p.push(`rubric is evidence-synthesis only (task=${task}) — use gold`);
    const gold = doc.gold;
    if (!isPlainObject(gold) || Object.keys(gold).length === 0) {
      p.push(`gold is required for ${task} and must contain ${PRIMARY_FIELD[task]}`);
    } else {
      const primary = PRIMARY_FIELD[task];
      if (gold[primary] === undefined) p.push(`gold is missing the primary field "${primary}"`);
      for (const [field, value] of Object.entries(gold)) {
        if (!VERDICT_FIELDS[task].includes(field)) {
          p.push(`gold.${field} is not a ${task} verdict field (expected one of ${VERDICT_FIELDS[task].join("|")})`);
          continue;
        }
        if (NAME_LIST_FIELDS.has(field)) {
          if (!Array.isArray(value) || value.some((n) => typeof n !== "string"))
            p.push(`gold.${field} must be a list of strings`);
          continue;
        }
        if (field === "drop_class" && value === null) continue; // the explicit no-class spelling (keep)
        p.push(...validateEnumValue(`gold.${field}`, task, field, value, enums));
      }
      // A keep never names a drop class; a drop always does (SCHEMA.md).
      if (task === "fit-triage") {
        const hasClass = gold.drop_class !== undefined && gold.drop_class !== null;
        if (gold.decision === "keep" && hasClass) p.push("gold.drop_class must be absent (or null) when decision is keep");
        if (gold.decision === "drop" && !hasClass) p.push("gold.drop_class is required when decision is drop (a slug from config/icp.md \"## Drop classes\")");
      }
    }
  }

  // ----- forbidden traps
  if (doc.forbidden !== undefined) {
    // A rubric task has no verdict object, so scoreEnumFixture never runs and a trap here
    // could never fire. Rejecting outright beats shipping decorative traps.
    if (isRubricTask) {
      p.push(
        `forbidden traps are enum-task only — ${task} is rubric-scored and never evaluates a verdict field, ` +
          `so a trap here can never fire. Encode the requirement as a rubric.must check instead.`,
      );
    } else if (!Array.isArray(doc.forbidden)) p.push("forbidden must be a list");
    else
      for (const [i, raw] of (doc.forbidden as unknown[]).entries()) {
        if (!isPlainObject(raw)) {
          p.push(`forbidden[${i}] must be {field, value, reason}`);
          continue;
        }
        for (const k of ["field", "value", "reason"]) {
          if (typeof raw[k] !== "string" || !(raw[k] as string).trim())
            p.push(`forbidden[${i}].${k} is required (the failure this trap encodes and why it matters)`);
        }
        // The field must be one THIS task's verdict actually carries. A misspelling (`rout`)
        // or another task's field (`decision` on a route fixture) yields a trap that silently
        // never fires — a lesson switched off without anyone noticing.
        if (typeof raw.field === "string" && raw.field.trim()) {
          const allowedFields = VERDICT_FIELDS[task];
          if (!allowedFields.includes(raw.field))
            p.push(
              `forbidden[${i}].field "${raw.field}" is not a ${task} verdict field ` +
                `(expected one of ${allowedFields.join("|")}) — a trap on an absent field can never fire`,
            );
        }
        if (typeof raw.field === "string")
          p.push(...validateEnumValue(`forbidden[${i}].value`, task, raw.field, raw.value, enums));
      }
  }

  if (doc.notes !== undefined && typeof doc.notes !== "string") p.push("notes must be a string");
  if (doc.dir !== undefined || doc.sha !== undefined)
    p.push("dir/sha are loader-filled and must not appear in fixture.yaml");

  return p;
}

// An enum field's value must be a quoted string. YAML's own coercions would otherwise walk
// straight through — `decision: yes` parses to the BOOLEAN true, `decision: null` to null,
// `decision: 1` to a number — and scoring compares String(verdict.field) against
// String(gold.field), so gold of `true` demands the literal answer "true" and a PERFECT model
// reply scores 0 forever.
function validateEnumValue(where: string, task: Task, field: string, value: unknown, enums: EnumMap): string[] {
  const allowed = enums[task][field];
  if (!allowed) return [];
  if (typeof value !== "string")
    return [
      `${where}: enum fields must be quoted STRINGS (got ${
        value === null ? "null" : Array.isArray(value) ? "a list" : typeof value
      }) — expected one of ${allowed.join("|")}`,
    ];
  if (allowed.includes(value)) return [];
  const hint = field === "drop_class" ? " (the classes listed under \"## Drop classes\" in config/icp.md)" : "";
  return [`${where}: "${value}" is not one of ${allowed.join("|")}${hint}`];
}

function validateChecks(value: unknown, where: string, required: boolean): string[] {
  const p: string[] = [];
  if (value === undefined) {
    if (required) p.push(`${where} is required and must be non-empty`);
    return p;
  }
  if (!Array.isArray(value)) return [`${where} must be a list of {id, text}`];
  if (required && value.length === 0) p.push(`${where} must be non-empty`);
  const ids = new Set<string>();
  for (const [i, raw] of value.entries()) {
    if (!isPlainObject(raw) || typeof raw.id !== "string" || typeof raw.text !== "string") {
      p.push(`${where}[${i}] must be {id, text}`);
      continue;
    }
    if (ids.has(raw.id)) p.push(`${where}[${i}] duplicate check id "${raw.id}"`);
    ids.add(raw.id);
    if (!raw.text.trim()) p.push(`${where}[${i}].text must be a verifiable statement`);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Input access (runners assemble context ONLY from these — never from the live store)
// ---------------------------------------------------------------------------

export function inputPath(fixture: Fixture, role: string): string | null {
  const hit = fixture.inputs.find((i) => i.role === role);
  return hit ? join(fixture.dir, hit.path) : null;
}

export function readInput(fixture: Fixture, role: string): string | null {
  const p = inputPath(fixture, role);
  return p ? readFileSync(p, "utf8") : null;
}

export function requireInput(fixture: Fixture, role: string): string {
  const text = readInput(fixture, role);
  if (text === null) throw new Error(`${fixture.id}: no input with role "${role}"`);
  return text;
}

// Every input in declared order, with text — for tasks (evidence-synthesis) that take the
// whole raw set. `path` stays fixture-relative so citations in produced output can match it.
export function readInputs(fixture: Fixture): Array<{ role: string; path: string; text: string }> {
  return fixture.inputs.map((i) => ({
    role: i.role,
    path: i.path,
    text: readFileSync(join(fixture.dir, i.path), "utf8"),
  }));
}

export function fixturesForTask(fixtures: Fixture[], task: Task): Fixture[] {
  return fixtures.filter((f) => f.task === task);
}

// Repo-relative dir for messages ("evals/fixtures/cases/route/foo").
export function shortDir(fixture: Fixture, root: string): string {
  return relative(root, fixture.dir) || fixture.dir;
}
