// Offline tests for M7's recording layer — scripts/run-record.ts.
// No network, no CRM key, no real store: the CLI is invoked in child processes with
// PIPELINE_DATA pointed at a temp dir (lib/env.ts resolves PIPELINE_DATA once at import, so
// an in-process override would be read too late). Run: npm test (or node test/m7-scripts.test.ts)
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const RUN_RECORD = join(REPO, "skills", "m7-recorder-sync", "scripts", "run-record.ts");

let failures = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e: any) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
};

// Each check gets a pristine store so ordering never couples the cases.
const stores: string[] = [];
const newStore = (): string => {
  const d = mkdtempSync(join(tmpdir(), "m7-scripts-store-"));
  mkdirSync(join(d, "logs"), { recursive: true });
  stores.push(d);
  return d;
};

type Run = { status: number; stdout: string; stderr: string };
// spawnSync (not execFileSync) so stderr is captured on SUCCESS too — these CLIs put their
// human-facing confirmations on stderr and keep stdout machine-clean.
const run = (script: string, store: string, args: string[], input?: string): Run => {
  const r = spawnSync("node", [script, ...args], {
    env: { ...process.env, PIPELINE_DATA: store },
    encoding: "utf8",
    input: input ?? "",
  });
  return { status: r.status ?? 1, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
};
const record = (store: string, body: unknown, ...args: string[]) =>
  run(RUN_RECORD, store, args, typeof body === "string" ? body : JSON.stringify(body));

const logLines = (store: string): any[] => {
  const p = join(store, "logs", "run-records.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
};
// A DEGRADED headless run: no research pass, no enrollment.
const degradedRun = (date: string, pulled = 15, fresh = 15) => ({
  run_date: date,
  mode: "headless",
  degraded: true,
  degraded_reason: "Claude-in-Chrome unreachable after 1 retry",
  signals: [{ key: "hiring-signal", pulled, new: fresh }],
  funnel: { dropped: 4, routed: 9, skipped: 1, flagged: 1, triaged_gated: 3, held: 0 },
  salesnav: null,
  enrollment: null,
  credits: { theirstack: 54, apollo: 0 },
  incidents: [],
});

// A full run whose Sales Nav pass flipped routes.
const fullRun = (date: string, flips: any[], routed = 8) => ({
  run_date: date,
  mode: "headless",
  degraded: false,
  signals: [{ key: "hiring-signal", pulled: 15, new: 12 }, { key: "title-signal", pulled: 4, new: 4 }],
  funnel: { dropped: 4, routed, skipped: 3, flagged: 1, triaged_gated: 0, held: 2 },
  salesnav: { lookups: 18, backlog_after: 0, flips },
  enrollment: { accounts: 6, contacts: 8 },
  credits: { theirstack: 53, apollo: 9 },
  incidents: ["raw/theirstack/...-pull-1.json found overwritten"],
  notes: "backlog cleared",
});
const FLIP = { domain: "flipped-example.com", from: "QUALIFIED", to: "SKIP", reason: "disqualifying title already in seat" };

// ---------------------------------------------------------------------------
// run-record.ts — schema
// ---------------------------------------------------------------------------
check("a valid record is accepted, echoed, and appended as exactly one line", () => {
  const store = newStore();
  const r = record(store, fullRun("2026-08-07", [FLIP]));
  assert.equal(r.status, 0, r.stderr);
  const echoed = JSON.parse(r.stdout.trim());
  assert.equal(echoed.run_date, "2026-08-07");
  const lines = logLines(store);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], fullRun("2026-08-07", [FLIP]));
  assert.match(r.stderr, /appended run key/);
});

check("--file is equivalent to stdin", () => {
  const store = newStore();
  const p = join(store, "rec.json");
  writeFileSync(p, JSON.stringify(degradedRun("2026-08-09")));
  const r = run(RUN_RECORD, store, ["--file", p]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(logLines(store).length, 1);
});

check("schema rejects unknown keys, bad enums, bad types — and writes nothing", () => {
  const store = newStore();
  const bad = {
    run_date: "August 9th", mode: "batch", degraded: "yes",
    signals: [{ key: "hiring-signal", pulled: 5, new: 9, extra: 1 }],
    funnel: { dropped: -1, routed: 2, skipped: 0, flagged: 0, triaged_gated: 0, held: 0, bonus: 3 },
    salesnav: { lookups: 1, backlog_after: 0, flips: [{ domain: "a-example.com", from: "X" }] },
    enrollment: { accounts: 1 },
    credits: { theirstack: "lots", apollo: 0 },
    incidents: [42],
    bogus: true,
  };
  const r = record(store, bad);
  assert.equal(r.status, 1);
  for (const pattern of [
    /top level: unknown key "bogus"/, /run_date: required ISO date/, /mode: required/,
    /degraded: required boolean/, /signals\[0\]: unknown key "extra"/, /signals\[0\]: new \(9\) > pulled \(5\)/,
    /funnel: unknown key "bonus"/, /funnel\.dropped: required non-negative integer/,
    /salesnav\.flips\[0\]\.to: required string/, /enrollment\.contacts: required non-negative integer/,
    /credits\.theirstack: required non-negative number/, /incidents\[0\]: must be a non-empty string/,
  ]) assert.match(r.stderr, pattern, `missing error for ${pattern}`);
  assert.equal(logLines(store).length, 0, "a rejected record must not be written");
});

check("degraded:true without a reason is rejected; the required fields are enforced", () => {
  const store = newStore();
  const noReason = { ...degradedRun("2026-08-09") } as any;
  delete noReason.degraded_reason;
  assert.match(record(store, noReason).stderr, /degraded_reason: required/);

  const noSalesnavKey = { ...fullRun("2026-08-09", []) } as any;
  delete noSalesnavKey.salesnav;
  assert.match(record(store, noSalesnavKey).stderr, /salesnav: required/);

  assert.match(record(store, "not json").stderr, /not valid JSON/);
  assert.equal(logLines(store).length, 0);
});

check("credits.apollo_waterfall: optional, validated when present", () => {
  const store = newStore();
  const withWf = { ...fullRun("2026-08-14", [FLIP]) } as any;
  withWf.credits = { theirstack: 10, apollo: 2, apollo_waterfall: 3 };
  const r = record(store, withWf);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(logLines(store)[0].credits.apollo_waterfall, 3);

  const bad = { ...fullRun("2026-08-15", [FLIP]) } as any;
  bad.credits = { theirstack: 10, apollo: 2, apollo_waterfall: "some" };
  assert.match(record(store, bad).stderr, /credits\.apollo_waterfall: must be a non-negative number/);

  const unknown = { ...fullRun("2026-08-16", [FLIP]) } as any;
  unknown.credits = { theirstack: 10, apollo: 2, firecrawl: 1 };
  assert.match(record(store, unknown).stderr, /credits: unknown key "firecrawl"/);
  assert.equal(logLines(store).length, 1);
});

check("null salesnav/enrollment are legal (that is what a DEGRADED run looks like)", () => {
  const store = newStore();
  const r = record(store, degradedRun("2026-08-08"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(logLines(store)[0].salesnav, null);
});

// ---------------------------------------------------------------------------
// run-record.ts — idempotency
// ---------------------------------------------------------------------------
check("a re-run under the same key is REFUSED, --force appends anyway", () => {
  const store = newStore();
  assert.equal(record(store, degradedRun("2026-08-08")).status, 0);
  const again = record(store, degradedRun("2026-08-08"));
  assert.equal(again.status, 1, "second append must be refused");
  assert.match(again.stderr, /REFUSED — a record with run key "2026-08-08\/headless\/hiring-signal:15\/15"/);
  assert.equal(logLines(store).length, 1, "refusal must not write");

  const forced = record(store, degradedRun("2026-08-08"), "--force");
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stderr, /WARNING: --force/);
  assert.equal(logLines(store).length, 2);
});

check("same-day repeat runs are distinguished by pull counts, mode, or explicit run_id", () => {
  // One day can carry several headless batches — date alone cannot be the key.
  const store = newStore();
  assert.equal(record(store, degradedRun("2026-08-07", 0, 0)).status, 0, "BLOCKED run: 0 pulled");
  assert.equal(record(store, degradedRun("2026-08-07", 15, 12)).status, 0, "reconnected run");
  assert.equal(record(store, degradedRun("2026-08-07", 15, 15)).status, 0, "full-chain run");
  // same date, same counts, other mode
  assert.equal(record(store, { ...degradedRun("2026-08-07", 15, 15), mode: "interactive" }).status, 0);
  // identical counts in the same mode collide — the explicit run_id is the documented escape
  assert.equal(record(store, degradedRun("2026-08-07", 15, 15)).status, 1);
  const tagged = record(store, { ...degradedRun("2026-08-07", 15, 15), run_id: "2026-08-07-pull-4" });
  assert.equal(tagged.status, 0, tagged.stderr);
  assert.equal(record(store, degradedRun("2026-08-07", 15, 15), "--run-id", "2026-08-07-pull-5").status, 0);
  assert.equal(logLines(store).length, 6);
  // an explicit run_id is itself deduped
  assert.equal(record(store, { ...degradedRun("2026-08-07", 1, 1), run_id: "2026-08-07-pull-4" }).status, 1);
});

// ---------------------------------------------------------------------------
// run-record.ts — --report
// ---------------------------------------------------------------------------
check("--report on an empty log says so", () => {
  const r = run(RUN_RECORD, newStore(), ["--report"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no run records yet/);
});

check("--report trends each run and computes flip rate over Sales-Nav-passed routes only", () => {
  const store = newStore();
  const FLIP2 = { domain: "flipped-two-example.com", from: "QUALIFIED", to: "SKIP", reason: "disqualifying title in seat" };
  record(store, fullRun("2026-08-06", [], 10));                 // pass, 10 routes, 0 flips
  record(store, fullRun("2026-08-07", [FLIP, FLIP2], 10));      // pass, 10 routes, 2 flips
  record(store, degradedRun("2026-08-08"));                     // no pass: 9 routes must NOT count
  const r = run(RUN_RECORD, store, ["--report"]);
  assert.equal(r.status, 0, r.stderr);

  const rows = r.stdout.split("\n").filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l));
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^2026-08-06\s+headless\s+16\s+10\s+8\s+ok\s+0$/);      // new = 12 + 4
  assert.match(rows[1], /^2026-08-07\s+headless\s+16\s+10\s+8\s+ok\s+2$/);
  assert.match(rows[2], /^2026-08-08\s+headless\s+15\s+9\s+—\s+DEGRADED\s+0$/); // no enrollment -> —

  assert.match(r.stdout, /runs: 3\s+\|\s+Sales Nav passes: 2/);
  assert.match(r.stdout, /flip rate: 10\.0% \(2\/20\)/);   // 2 flips / 20 routes under a pass
  assert.match(r.stdout, /DEGRADED streak \(current\): 1/);
});

check("--report reports the consecutive-DEGRADED streak, and 0 once a good run lands", () => {
  const store = newStore();
  record(store, fullRun("2026-08-07", [FLIP]));
  for (const d of ["2026-08-08", "2026-08-09", "2026-08-10", "2026-08-11"]) record(store, degradedRun(d));
  assert.match(run(RUN_RECORD, store, ["--report"]).stdout, /DEGRADED streak \(current\): 4/);

  record(store, fullRun("2026-08-12", []));
  const after = run(RUN_RECORD, store, ["--report"]).stdout;
  assert.match(after, /DEGRADED streak \(current\): 0/);
  // flip rate is unchanged by the DEGRADED runs in between: 1 flip / (8 + 8) passed routes
  assert.match(after, /flip rate: 6\.3% \(1\/16\)/);
});

check("--report with no passed run yet reports n/a rather than dividing by zero", () => {
  const store = newStore();
  record(store, degradedRun("2026-08-08"));
  assert.match(run(RUN_RECORD, store, ["--report"]).stdout, /flip rate: n\/a/);
});

for (const s of stores) rmSync(s, { recursive: true, force: true });

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("m7 scripts test passed");
