// M7 · structured run record — ONE validated JSON line per batch run.
//
// The prose entry in progress.md stays (humans read it); this is the same facts in a shape
// something can trend: funnel counts, credit spend, DEGRADED status, and — the pipeline's real
// error metric — the route flips the Sales Nav pass makes to the headless provisional route.
//
//   node skills/m7-recorder-sync/scripts/run-record.ts < record.json
//   node skills/m7-recorder-sync/scripts/run-record.ts --file record.json [--run-id X] [--force]
//   node skills/m7-recorder-sync/scripts/run-record.ts --report
//
// Appends to $PIPELINE_DATA/logs/run-records.jsonl (append-only, O_APPEND — safe under
// concurrent module runs and across hosts; a file-sync tool replicates whole lines).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { dataPath } from "../../../lib/store.ts";

const LOG = dataPath("logs", "run-records.jsonl");

const MODES = ["headless", "interactive"];
const TOP_KEYS = [
  "run_id", "run_date", "mode", "degraded", "degraded_reason", "signals", "funnel",
  "salesnav", "enrollment", "credits", "incidents", "notes",
];
const FUNNEL_KEYS = ["dropped", "routed", "skipped", "flagged", "triaged_gated", "held"];

// ---------------------------------------------------------------------------
// validation — every rejection is a named error, all of them reported at once
// ---------------------------------------------------------------------------
const isObj = (v: unknown): boolean => !!v && typeof v === "object" && !Array.isArray(v);
const isCount = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isStr = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";

function isIsoDate(v: unknown): boolean {
  if (typeof v !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.test(v)) return false;
  return !Number.isNaN(Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v));
}

function checkKeys(where: string, obj: any, allowed: string[], errors: string[]): void {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}: unknown key "${k}"`);
}

function validate(input: unknown): string[] {
  const e: string[] = [];
  if (!isObj(input)) return ["record must be a JSON object"];
  const r = input as any;
  checkKeys("top level", r, TOP_KEYS, e);

  if (!isIsoDate(r.run_date)) e.push('run_date: required ISO date ("YYYY-MM-DD" or a full ISO timestamp)');
  if (!MODES.includes(r.mode)) e.push(`mode: required, one of ${MODES.join("|")}`);
  if (typeof r.degraded !== "boolean") e.push("degraded: required boolean");
  // A DEGRADED run with no stated reason is exactly the record that can't be trended later.
  if (r.degraded === true && !isStr(r.degraded_reason)) e.push("degraded_reason: required (non-empty) when degraded is true");
  if (r.degraded_reason !== undefined && !isStr(r.degraded_reason)) e.push("degraded_reason: must be a non-empty string");
  if (r.run_id !== undefined && !isStr(r.run_id)) e.push("run_id: must be a non-empty string");
  if (r.notes !== undefined && !isStr(r.notes)) e.push("notes: must be a non-empty string");

  if (!Array.isArray(r.signals)) e.push("signals: required array of {key, pulled, new}");
  else r.signals.forEach((s: any, i: number) => {
    if (!isObj(s)) { e.push(`signals[${i}]: must be an object`); return; }
    checkKeys(`signals[${i}]`, s, ["key", "pulled", "new"], e);
    if (!isStr(s.key)) e.push(`signals[${i}].key: required string`);
    if (!isCount(s.pulled)) e.push(`signals[${i}].pulled: required non-negative integer`);
    if (!isCount(s.new)) e.push(`signals[${i}].new: required non-negative integer`);
    if (isCount(s.pulled) && isCount(s.new) && s.new > s.pulled) e.push(`signals[${i}]: new (${s.new}) > pulled (${s.pulled})`);
  });

  if (!isObj(r.funnel)) e.push(`funnel: required object {${FUNNEL_KEYS.join(", ")}}`);
  else {
    checkKeys("funnel", r.funnel, FUNNEL_KEYS, e);
    for (const k of FUNNEL_KEYS) if (!isCount(r.funnel[k])) e.push(`funnel.${k}: required non-negative integer`);
  }

  if (r.salesnav === undefined) e.push("salesnav: required (object, or null when no pass ran)");
  else if (r.salesnav !== null) {
    if (!isObj(r.salesnav)) e.push("salesnav: must be an object or null");
    else {
      checkKeys("salesnav", r.salesnav, ["lookups", "backlog_after", "flips"], e);
      if (!isCount(r.salesnav.lookups)) e.push("salesnav.lookups: required non-negative integer");
      if (!isCount(r.salesnav.backlog_after)) e.push("salesnav.backlog_after: required non-negative integer");
      if (!Array.isArray(r.salesnav.flips)) e.push("salesnav.flips: required array (empty when nothing flipped)");
      else r.salesnav.flips.forEach((f: any, i: number) => {
        if (!isObj(f)) { e.push(`salesnav.flips[${i}]: must be an object`); return; }
        checkKeys(`salesnav.flips[${i}]`, f, ["domain", "from", "to", "reason"], e);
        for (const k of ["domain", "from", "to", "reason"])
          if (!isStr(f[k])) e.push(`salesnav.flips[${i}].${k}: required string`);
      });
    }
  }

  if (r.enrollment === undefined) e.push("enrollment: required (object, or null when nothing enrolled)");
  else if (r.enrollment !== null) {
    if (!isObj(r.enrollment)) e.push("enrollment: must be an object or null");
    else {
      checkKeys("enrollment", r.enrollment, ["accounts", "contacts"], e);
      if (!isCount(r.enrollment.accounts)) e.push("enrollment.accounts: required non-negative integer");
      if (!isCount(r.enrollment.contacts)) e.push("enrollment.contacts: required non-negative integer");
    }
  }

  if (!isObj(r.credits)) e.push("credits: required object {theirstack, apollo}");
  else {
    // apollo_waterfall is optional: variable-cost waterfall email fills are reported
    // separately from standard Apollo match credits, only on runs that used them.
    checkKeys("credits", r.credits, ["theirstack", "apollo", "apollo_waterfall"], e);
    for (const k of ["theirstack", "apollo"])
      if (typeof r.credits[k] !== "number" || !(r.credits[k] >= 0)) e.push(`credits.${k}: required non-negative number`);
    if (r.credits.apollo_waterfall !== undefined
      && (typeof r.credits.apollo_waterfall !== "number" || !(r.credits.apollo_waterfall >= 0)))
      e.push("credits.apollo_waterfall: must be a non-negative number when present");
  }

  if (!Array.isArray(r.incidents)) e.push("incidents: required array of strings (empty when the run was clean)");
  else r.incidents.forEach((s: any, i: number) => { if (!isStr(s)) e.push(`incidents[${i}]: must be a non-empty string`); });

  return e;
}

// ---------------------------------------------------------------------------
// Idempotency key.
//
// run_date alone CANNOT be the key: one day can carry several headless batches (a BLOCKED
// run, then a reconnected re-run, then a manual drain) and each is a distinct run worth
// trending. So the default key is run_date + mode + the signal fingerprint (every signal's
// key:pulled/new, not just the first — two runs the same day usually differ in what the
// pull returned even when the first signal's pulled count is identical, e.g. 15/12 vs
// 15/15 at the same 15-row cap).
//
// It is still a heuristic: two same-day, same-mode runs whose pulls happen to return
// identical counts collide and the second is REFUSED. That is the safe direction — a loud
// refusal you clear with an explicit `run_id` (or --force) beats a silent duplicate line
// that skews every trend built on this file. Prefer setting `run_id` explicitly for any run
// you know is a re-run or a same-day repeat; the derived key is the fallback for the common
// one-run-a-day case where nothing has to be remembered.
// ---------------------------------------------------------------------------
export function runIdOf(r: any): string {
  if (isStr(r.run_id)) return r.run_id;
  const sig = (r.signals ?? []).map((s: any) => `${s.key}:${s.pulled}/${s.new}`).join(",") || "no-signal";
  return `${String(r.run_date).slice(0, 10)}/${r.mode}/${sig}`;
}

function readRecords(): any[] {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8").split("\n").filter((l) => l.trim() !== "").map((l, i) => {
    try { return JSON.parse(l); }
    catch { throw new Error(`${LOG}:${i + 1} is not valid JSON — repair the line before appending`); }
  });
}

// ---------------------------------------------------------------------------
// --report
// ---------------------------------------------------------------------------
function report(): void {
  const rows = readRecords();
  if (rows.length === 0) { console.log(`no run records yet (${LOG})`); return; }

  const table = rows.map((r) => {
    const flips = r.salesnav && Array.isArray(r.salesnav.flips) ? r.salesnav.flips.length : 0;
    return {
      date: String(r.run_date).slice(0, 10),
      mode: String(r.mode),
      new: (r.signals ?? []).reduce((n: number, s: any) => n + (s.new ?? 0), 0),
      routed: r.funnel?.routed ?? 0,
      enrolled: r.enrollment ? r.enrollment.contacts : null,
      degraded: r.degraded === true,
      flips,
    };
  });

  const cols: Array<[string, (t: any) => string]> = [
    ["date", (t) => t.date],
    ["mode", (t) => t.mode],
    ["new", (t) => String(t.new)],
    ["routed", (t) => String(t.routed)],
    ["enrolled", (t) => (t.enrolled === null ? "—" : String(t.enrolled))],
    ["degraded", (t) => (t.degraded ? "DEGRADED" : "ok")],
    ["flips", (t) => String(t.flips)],
  ];
  const widths = cols.map(([h, get]) => Math.max(h.length, ...table.map((t) => get(t).length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  console.log(line(cols.map(([h]) => h)));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const t of table) console.log(line(cols.map(([, get]) => get(t))));

  // Flip rate: flips are only possible on runs where a Sales Nav pass actually ran, so the
  // denominator is routes from those runs only — counting DEGRADED runs' routes would
  // silently deflate the pipeline's error metric.
  const passed = rows.filter((r) => r.salesnav !== null && r.salesnav !== undefined);
  const flips = passed.reduce((n, r) => n + (r.salesnav.flips?.length ?? 0), 0);
  const routesUnderPass = passed.reduce((n, r) => n + (r.funnel?.routed ?? 0), 0);
  const rate = routesUnderPass === 0 ? "n/a (no routes have been through a pass yet)"
    : `${((flips / routesUnderPass) * 100).toFixed(1)}% (${flips}/${routesUnderPass})`;

  // Consecutive DEGRADED runs ending at the most recent record.
  let streak = 0;
  for (let i = rows.length - 1; i >= 0 && rows[i].degraded === true; i--) streak++;

  console.log("");
  console.log(`runs: ${rows.length}  |  Sales Nav passes: ${passed.length}`);
  console.log(`flip rate: ${rate}`);
  console.log(`DEGRADED streak (current): ${streak}`);
}

// ---------------------------------------------------------------------------
function main(): void {
  const argv = process.argv.slice(2);
  const flag = (name: string) => argv.includes(name);
  const opt = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

  if (flag("--help") || flag("-h")) {
    console.log("usage: run-record.ts [--file <path> | < record.json] [--run-id <id>] [--force]\n       run-record.ts --report");
    return;
  }
  if (flag("--report")) { report(); return; }

  const file = opt("--file");
  let text: string;
  if (file) text = readFileSync(file, "utf8");
  else if (process.stdin.isTTY) { console.error("no input: pass --file <path> or pipe the record JSON on stdin"); process.exit(1); return; }
  else text = readFileSync(0, "utf8");

  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (err: any) { console.error(`input is not valid JSON: ${err.message}`); process.exit(1); return; }

  const runIdFlag = opt("--run-id");
  if (runIdFlag) (parsed as any).run_id = runIdFlag;

  const errors = validate(parsed);
  if (errors.length) {
    console.error(`REJECTED — ${errors.length} schema error(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
    return;
  }

  const record = parsed as any;
  const id = runIdOf(record);
  const existing = readRecords();
  if (existing.some((r) => runIdOf(r) === id)) {
    if (!flag("--force")) {
      console.error(`REFUSED — a record with run key "${id}" is already in ${LOG}.`);
      console.error("  This is a re-run of an already-recorded batch, or a same-day/same-mode run whose");
      console.error('  pull counts collide. Set an explicit "run_id" (or --run-id <id>) for the new run,');
      console.error("  or pass --force if you really mean to append a second line under the same key.");
      process.exit(1);
      return;
    }
    console.error(`WARNING: --force — appending a duplicate line under run key "${id}"`);
  }

  const line = JSON.stringify(record);
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, line + "\n");
  console.log(line);
  console.error(`appended run key "${id}" to ${LOG}`);
}

main();
