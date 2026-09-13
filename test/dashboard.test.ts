// Offline test for M7's dashboard generator — scripts/dashboard.ts.
// Child-process + temp PIPELINE_DATA, same contract as the other M7 script tests.
// Assertions stick to facts derived from the fabricated store (tallies, gating, velocity,
// HTML emission) against the SHIPPED template config, whose one sequence is a draft with a
// placeholder id — so routed accounts land in the HOLD pile and enrolled contacts group under
// the sequence key.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const DASHBOARD = join(REPO, "skills", "m7-recorder-sync", "scripts", "dashboard.ts");

let failures = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e: any) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
};

const store = mkdtempSync(join(tmpdir(), "dashboard-store-"));
const account = (domain: string, yaml: string) => {
  mkdirSync(join(store, "accounts", domain), { recursive: true });
  writeFileSync(join(store, "accounts", domain, "account.yaml"), yaml);
};

// The template sequence's id — the tally groups by sequence key via config, and the key
// (not its lifecycle) is what is pinned.
const SEQ_ID = "REPLACE-WITH-APOLLO-SEQUENCE-ID";
account("a-example.com", `domain: a-example.com\nstatus: enrolled-paused\nsignal_source: Hiring Signal\ncontacts:\n  - name: A One\n    apollo_sequence_id: ${SEQ_ID}\n    sequence_status: PAUSED\n`);
account("b-example.com", `domain: b-example.com\nstatus: active\nsignal_source: Hiring Signal\ncontacts:\n  - name: B One\n    apollo_sequence_id: ${SEQ_ID}\n    sequence_status: REPLIED\n`);
account("c-example.com", `domain: c-example.com\nstatus: routed\nroute: QUALIFIED\nsignal_source: hiring-signal\nstatus_since: 2026-01-01\n`);
account("d-example.com", `domain: d-example.com\nstatus: dropped\nroute: DROPPED\nsignal_source: hiring-signal\n`);

mkdirSync(join(store, "logs"), { recursive: true });
writeFileSync(join(store, "logs", "run-records.jsonl"), [
  JSON.stringify({ run_date: "2026-01-13", mode: "headless", degraded: true, degraded_reason: "x", signals: [{ key: "hiring-signal", pulled: 5, new: 5 }], funnel: { dropped: 1, routed: 2, skipped: 0, flagged: 0, triaged_gated: 0, held: 0 }, salesnav: null, enrollment: null, credits: { theirstack: 15, apollo: 0 }, incidents: [] }),
  JSON.stringify({ run_date: "2026-01-14", mode: "headless", degraded: true, degraded_reason: "y", signals: [{ key: "hiring-signal", pulled: 3, new: 3 }], funnel: { dropped: 0, routed: 1, skipped: 0, flagged: 0, triaged_gated: 0, held: 0 }, salesnav: null, enrollment: null, credits: { theirstack: 9, apollo: 0, apollo_waterfall: 2 }, incidents: [] }),
].join("\n") + "\n");

mkdirSync(join(store, "queue"), { recursive: true });
writeFileSync(join(store, "queue", "decisions.jsonl"),
  JSON.stringify({ id: "q1", kind: "policy-ruling", status: "open", title: "t", body: "", opened: { date: "2026-01-10", by: "x" }, accounts: ["c-example.com"], resolution: null }) + "\n"
  + JSON.stringify({ id: "q2", kind: "ops", status: "resolved", title: "t2", body: "", opened: { date: "2026-01-10", by: "x" }, accounts: [], resolution: { date: "2026-01-11", ruling: "r", by: "x" } }) + "\n");

const run = (...args: string[]) => {
  const r = spawnSync("node", [DASHBOARD, ...args], { env: { ...process.env, PIPELINE_DATA: store }, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
};

check("terminal summary reflects the fabricated store", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /lifetime replies: 1 of 2 contacts/);
  assert.match(r.stdout, /hiring-signal-v1\s+\[draft.*paused:1.*replied:1/);
  assert.match(r.stdout, /Hiring Signal\s+paused:1 replied:1/, "by-signal row uses the canonical name");
  assert.match(r.stdout, /open decisions: 1 \(1 accounts gated\)/);
  assert.match(r.stdout, /routed:1\s+enrolled-paused:1\s+active:1.*dropped:1/);
  assert.match(r.stdout, /awaiting M4 go: 0 paused contacts in ACTIVE sequences \(1 more are frozen/);
  assert.match(r.stdout, /HOLD pile[\s\S]*1\s+hiring-signal-v1 is draft — awaiting successor\s+\(e\.g\. c-example\.com\)/);
  assert.match(r.stdout, /2026-01-14\s+headless\s+3\/3.*9\/0\s+\/2\s+DEGRADED/);
  assert.match(r.stdout, /consecutive-DEGRADED streak: 2/);
  assert.doesNotMatch(r.stdout, /fill rate/i, "no signal-specific metric sections");
});

check("--html writes a self-contained page with the same facts", () => {
  const r = run("--html");
  assert.equal(r.status, 0, r.stderr);
  const p = join(store, "dashboard", "index.html");
  assert.ok(existsSync(p), "index.html written");
  const html = readFileSync(p, "utf8");
  assert.match(html, /<title>gtm-prospect-pipeline/);
  assert.match(html, /awaiting M4 go/);
  assert.match(html, /DEGRADED/);
  assert.match(html, /q1/, "open decision listed");
  assert.doesNotMatch(html, /q2/, "resolved decision not in the open list");
  assert.doesNotMatch(html, /<script src=|https?:\/\/cdn/, "no external deps");
});

check("empty store still renders (no crash on missing files)", () => {
  const empty = mkdtempSync(join(tmpdir(), "dashboard-empty-"));
  const r = spawnSync("node", [DASHBOARD], { env: { ...process.env, PIPELINE_DATA: empty }, encoding: "utf8" });
  assert.equal(r.status ?? 1, 0, String(r.stderr));
  assert.match(String(r.stdout), /no run records/);
  rmSync(empty, { recursive: true, force: true });
});

rmSync(store, { recursive: true, force: true });
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("dashboard test passed");
