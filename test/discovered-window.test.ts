// Offline test for lib/discovered-window.ts — the discovered_at_max_age_days planner.
// The rule under test: N covers the gap since the last BILLED pull of this signal plus a
// pad, and is NULL (full posted_at window) whenever the previous pull could not have
// drained the pool — because a posting that ages out of the discovered_at window unfetched
// never re-enters it. The CLI reads the signal block through PIPELINE_CONFIG_DIR, so a
// fixture config decides which keys opt in.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findLastPull, optOutReason, planWindow } from "../lib/discovered-window.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "lib", "discovered-window.ts");
let failures = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e: any) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
};
const today = new Date("2026-09-14T00:00:00Z");
const KEY = "hiring-signal";

check("findLastPull: newest date wins, then highest page; other signals' files ignored", () => {
  const files = [`2026-09-10-${KEY}-pull-1.json`, `2026-09-12-${KEY}-pull-1.json`, `2026-09-12-${KEY}-pull-2.json`,
    "2026-09-13-title-signal-pull-1.json", `2026-09-12-${KEY}-preflight.json`, `2026-09-12-${KEY}-acme.example-jobs.json`];
  const docs: Record<string, any> = { [`2026-09-12-${KEY}-pull-2.json`]: { _request: { limit: 15 }, data: [1, 2, 3] } };
  const r = findLastPull(KEY, files, (f) => docs[f] ?? null);
  assert.deepEqual(r, { date: "2026-09-12", n: 2, file: `2026-09-12-${KEY}-pull-2.json`, returned: 3, limit: 15 });
  assert.equal(findLastPull("refresh-signal", files, () => null), null);
});

check("optOutReason: only `discovered_at_lookback: auto` on a non-merge block opts in", () => {
  assert.equal(optOutReason({ discovered_at_lookback: "auto" }), null);
  assert.match(optOutReason({ discovered_at_lookback: "auto", dedupe_mode: "merge" }) ?? "", /how OLD/);
  assert.match(optOutReason({ enabled: true }) ?? "", /does not opt in/);
  assert.match(optOutReason(null) ?? "", /not a mapping/);
});

check("plan: drained pool → gap + pad", () => {
  const p = planWindow({ signalKey: KEY, last: { date: "2026-09-12", n: 1, file: "x", returned: 3, limit: 15 }, today });
  assert.equal(p.discovered_at_max_age_days, 4);
  assert.equal(p.drained, true);
});

check("plan: previous pull returned exactly limit → null (pool not drained)", () => {
  const p = planWindow({ signalKey: KEY, last: { date: "2026-09-13", n: 1, file: "x", returned: 15, limit: 15 }, today });
  assert.equal(p.discovered_at_max_age_days, null);
  assert.equal(p.drained, false);
});

check("plan: no previous pull, unknown limit, --sweep, or an opt-out reason → null", () => {
  assert.equal(planWindow({ signalKey: KEY, last: null, today }).discovered_at_max_age_days, null);
  assert.equal(planWindow({ signalKey: KEY, last: { date: "2026-09-13", n: 1, file: "x", returned: 2, limit: null }, today }).discovered_at_max_age_days, null);
  assert.equal(planWindow({ signalKey: KEY, last: { date: "2026-09-13", n: 1, file: "x", returned: 2, limit: 15 }, today, sweep: true }).discovered_at_max_age_days, null);
  const p = planWindow({ signalKey: KEY, last: { date: "2026-09-13", n: 1, file: "x", returned: 2, limit: 15 }, today, optOut: "not opted in" });
  assert.equal(p.discovered_at_max_age_days, null);
  assert.equal(p.reason, "not opted in");
});

check("plan: a same-day re-run still asks for pad days, never 0", () => {
  const p = planWindow({ signalKey: KEY, last: { date: "2026-09-14", n: 1, file: "x", returned: 0, limit: 15 }, today });
  assert.equal(p.discovered_at_max_age_days, 2);
});

// --- CLI against a synthetic raw tree + fixture config -----------------------------------------
const cfg = mkdtempSync(join(tmpdir(), "discovered-window-config-"));
writeFileSync(join(cfg, "signal.yaml"), [
  `${KEY}:`, "  enabled: true", "  discovered_at_lookback: auto",
  "posting-age-signal:", "  enabled: true", "  dedupe_mode: merge", "  discovered_at_lookback: auto",
  "opted-out-signal:", "  enabled: true",
  "dedupe: {}", "limits: {}", "",
].join("\n"));
const root = mkdtempSync(join(tmpdir(), "discovered-window-"));
mkdirSync(join(root, "raw", "theirstack"), { recursive: true });
for (const k of [KEY, "posting-age-signal", "opted-out-signal"]) {
  writeFileSync(join(root, "raw", "theirstack", `2026-09-09-${k}-pull-1.json`), JSON.stringify({ _request: { limit: 8 }, data: [{}, {}] }));
}
const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [CLI, ...args], {
  env: { ...process.env, PIPELINE_DATA: root, PIPELINE_CONFIG_DIR: cfg, ...env }, encoding: "utf8", cwd: REPO,
});

check("CLI: reads the store's raw tree and honours --today/--pad/--sweep", () => {
  const a = JSON.parse(run(["--signal-key", KEY, "--today", "2026-09-14"]).stdout);
  assert.equal(a.discovered_at_max_age_days, 7);
  const b = JSON.parse(run(["--signal-key", KEY, "--today", "2026-09-14", "--pad", "0"]).stdout);
  assert.equal(b.discovered_at_max_age_days, 5);
  const c = JSON.parse(run(["--signal-key", KEY, "--sweep"]).stdout);
  assert.equal(c.discovered_at_max_age_days, null);
  const d = run(["--signal-key"]);
  assert.notEqual(d.status, 0);
});

check("CLI: a merge-mode block or a block without the opt-in plans the full window (exit 0, null) without reading raw", () => {
  const m = run(["--signal-key", "posting-age-signal", "--today", "2026-09-14"]);
  assert.equal(m.status, 0, m.stderr);
  const mj = JSON.parse(m.stdout);
  assert.equal(mj.discovered_at_max_age_days, null);
  assert.equal(mj.last_pull, null);
  assert.match(mj.reason, /how OLD/);
  const o = JSON.parse(run(["--signal-key", "opted-out-signal", "--today", "2026-09-14"]).stdout);
  assert.equal(o.discovered_at_max_age_days, null);
  assert.match(o.reason, /does not opt in/);
});

check("CLI: an unknown signal key (or the dedupe/limits sections) exits 2 with a clear message", () => {
  const r = run(["--signal-key", "no-such-signal"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no signal block "no-such-signal"/);
  assert.equal(run(["--signal-key", "dedupe"]).status, 2);
});

check("CLI: the shipped template opts hiring-signal in through the real config", () => {
  const r = run(["--signal-key", KEY, "--today", "2026-09-14"], { PIPELINE_CONFIG_DIR: join(REPO, "config") });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).discovered_at_max_age_days, 7);
});

rmSync(root, { recursive: true, force: true });
rmSync(cfg, { recursive: true, force: true });
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("discovered-window tests passed");
