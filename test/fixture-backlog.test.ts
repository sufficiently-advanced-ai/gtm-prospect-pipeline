// Offline tests for the eval flywheel's mechanical link — evals/fixture-backlog.ts and
// draft-fixture's --decision flag. No network, no model. Ledger + fixtures live in temp dirs;
// the draft-fixture check stages under the repo's evals/fixtures/staging/ with a zz- id and
// removes it afterwards. Run: npm test (or node test/fixture-backlog.test.ts)
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureBacklog } from "../evals/fixture-backlog.ts";

const REPO = join(import.meta.dirname, "..");
let failures = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e: any) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
};

const tmp = mkdtempSync(join(tmpdir(), "fixture-backlog-"));
const ledger = join(tmp, "decisions.jsonl");
const fixtures = join(tmp, "fixtures");
const entry = (o: Record<string, unknown>) => JSON.stringify({
  title: "t", body: "", opened: { date: "2026-03-01", by: "operator" }, accounts: [], ...o,
});
writeFileSync(ledger, [
  // resolved re-triage ruling on a domain that already has a fixture BY DOMAIN
  entry({ id: "d-covered-by-domain", kind: "re-triage", status: "resolved", accounts: ["covered.example"],
    resolution: { date: "2026-03-02", ruling: "scope, not title", by: "operator", verdict: "qualified" } }),
  // resolved re-triage ruling covered BY DECISION ID (fixture cites it, different domain spelling)
  entry({ id: "d-covered-by-id", kind: "re-triage", status: "resolved", accounts: ["www.byid.example"],
    resolution: { date: "2026-03-03", ruling: "confirmed zero", by: "operator" } }),
  // resolved judgment ruling with NO fixture → backlog, task route
  entry({ id: "d-open-route", kind: "policy-ruling", status: "resolved", accounts: ["gap.example"],
    resolution: { date: "2026-03-04", ruling: "a nonstandard title with compliance scope is not the owner", by: "operator", verdict: "qualified" } }),
  // resolved with verdict drop → backlog, task fit-triage
  entry({ id: "d-open-drop", kind: "re-triage", status: "resolved", subject: ["vendor.example"],
    resolution: { date: "2026-03-05", ruling: "they sell the capability", by: "operator", verdict: "drop" } }),
  // process kinds are never candidates
  entry({ id: "d-ops", kind: "ops", status: "resolved", accounts: ["ops.example"],
    resolution: { date: "2026-03-06", ruling: "rotated the key", by: "operator" } }),
  // open entries are never candidates
  entry({ id: "d-still-open", kind: "re-triage", status: "open", accounts: ["open.example"] }),
  // resolved judgment ruling with no account → skipped, not a candidate
  entry({ id: "d-no-account", kind: "policy-ruling", status: "resolved",
    resolution: { date: "2026-03-07", ruling: "agencies are out", by: "operator" } }),
  "not json at all",
].join("\n") + "\n");

const fx = (rel: string, prov: Record<string, string>) => {
  const dir = join(fixtures, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fixture.yaml"), `id: x\ntask: route\nversion: 1\nprovenance:\n${Object.entries(prov).map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n`);
};
fx("cases/route/route_covered", { domain: "covered.example", source: "x" });
fx("staging/route_byid", { domain: "other.example", source: "x", decision_id: "d-covered-by-id" });

check("backlog lists exactly the uncovered judgment rulings, newest first", () => {
  const b = fixtureBacklog({ ledgerPath: ledger, fixturesRoot: fixtures });
  assert.deepEqual(b.candidates.map((c) => c.id), ["d-open-drop", "d-open-route"]);
  assert.equal(b.covered, 2, "one covered by domain, one by decision id");
  assert.equal(b.skipped, 1, "the account-less ruling is skipped, not a candidate");
});

check("task follows the verdict: drop → fit-triage, otherwise route; command cites the ledger id", () => {
  const b = fixtureBacklog({ ledgerPath: ledger, fixturesRoot: fixtures });
  const drop = b.candidates.find((c) => c.id === "d-open-drop")!;
  const route = b.candidates.find((c) => c.id === "d-open-route")!;
  assert.equal(drop.task, "fit-triage");
  assert.equal(drop.domain, "vendor.example", "subject counts as a named account");
  assert.equal(drop.command, "node evals/draft-fixture.ts vendor.example --task fit-triage --decision d-open-drop");
  assert.equal(route.task, "route");
  assert.match(route.command, /--decision d-open-route$/);
});

check("--all-kinds admits process rulings; the default excludes them", () => {
  const all = fixtureBacklog({ ledgerPath: ledger, fixturesRoot: fixtures, allKinds: true });
  assert.ok(all.candidates.some((c) => c.id === "d-ops"));
  const dflt = fixtureBacklog({ ledgerPath: ledger, fixturesRoot: fixtures });
  assert.ok(!dflt.candidates.some((c) => c.id === "d-ops"));
});

check("CLI: --count prints the number, --json the structure, default text names the draft command", () => {
  const run = (...args: string[]) => spawnSync("node", [join(REPO, "evals", "fixture-backlog.ts"), "--ledger", ledger, "--fixtures", fixtures, ...args], { encoding: "utf8" });
  assert.equal(run("--count").stdout.trim(), "2");
  const j = JSON.parse(run("--json").stdout);
  assert.equal(j.candidates.length, 2);
  const text = run().stdout;
  assert.match(text, /fixture backlog: 2/);
  assert.match(text, /node evals\/draft-fixture\.ts gap\.example --task route --decision d-open-route/);
  assert.equal(run().status, 0, "a backlog is work, not a failure");
});

check("a missing ledger is an empty backlog, not a crash", () => {
  const b = fixtureBacklog({ ledgerPath: join(tmp, "nope.jsonl"), fixturesRoot: fixtures });
  assert.deepEqual(b, { candidates: [], covered: 0, skipped: 0 });
});

// draft-fixture --decision: provenance cites the ledger id, the ruling lands verbatim in notes.
check("draft-fixture --decision writes provenance.decision_id and the ruling into notes", () => {
  const store = mkdtempSync(join(tmpdir(), "fixture-backlog-store-"));
  const domain = "zz-backlog.example";
  mkdirSync(join(store, "accounts", domain), { recursive: true });
  mkdirSync(join(store, "raw", "postings", domain), { recursive: true });
  mkdirSync(join(store, "queue"), { recursive: true });
  writeFileSync(join(store, "raw", "postings", domain, "2026-03-01-role.md"),
    "# Operations Lead\nSource: https://zz-backlog.example/jobs/1\nCaptured: 2026-03-01\n\nWe are a distributor of industrial fasteners hiring an operations lead.\n");
  writeFileSync(join(store, "accounts", domain, "account.yaml"),
    `domain: ${domain}\ncompany: ZZ Backlog\nstatus: dropped\nroute: DROPPED\ndrop_class: vendor_of_the_capability\nsignal_source: "Hiring Signal"\nraw_pointers:\n  - raw/postings/${domain}/2026-03-01-role.md\n`);
  writeFileSync(join(store, "queue", "decisions.jsonl"), entry({
    id: "d-zz-backlog", kind: "re-triage", status: "resolved", accounts: [domain],
    resolution: { date: "2026-03-02", ruling: "they resell the very capability we sell — drop", by: "operator", verdict: "drop" },
  }) + "\n");
  const id = "zz_backlog_fit_triage_test";
  const staged = join(REPO, "evals", "fixtures", "staging", id);
  try {
    const r = spawnSync("node", [join(REPO, "evals", "draft-fixture.ts"), domain, "--task", "fit-triage", "--id", id, "--decision", "d-zz-backlog", "--force"],
      { encoding: "utf8", env: { ...process.env, PIPELINE_DATA: store } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const y = readFileSync(join(staged, "fixture.yaml"), "utf8");
    assert.match(y, /decision_id: d-zz-backlog/);
    assert.match(y, /source: decision ledger d-zz-backlog/);
    assert.match(y, /incident_date: "?2026-03-02"?/);
    const flat = y.replace(/\s+/g, " ");   // YAML folds long notes lines
    assert.match(flat, /RULING \(verbatim, ledger d-zz-backlog, 2026-03-02, verdict drop\): they resell the very capability we sell — drop/, "ruling verbatim");
    // and the backlog now counts it as covered (staging counts)
    const b = fixtureBacklog({ ledgerPath: join(store, "queue", "decisions.jsonl") });
    assert.equal(b.candidates.length, 0);
    assert.equal(b.covered, 1);
  } finally {
    rmSync(staged, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

check("draft-fixture --decision refuses an id that is not a resolved ruling", () => {
  const store = mkdtempSync(join(tmpdir(), "fixture-backlog-store-"));
  const domain = "zz-nodecision.example";
  mkdirSync(join(store, "accounts", domain), { recursive: true });
  writeFileSync(join(store, "accounts", domain, "account.yaml"), `domain: ${domain}\nstatus: dropped\nroute: DROPPED\nraw_pointers: []\n`);
  try {
    const r = spawnSync("node", [join(REPO, "evals", "draft-fixture.ts"), domain, "--task", "fit-triage", "--decision", "d-missing"],
      { encoding: "utf8", env: { ...process.env, PIPELINE_DATA: store } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--decision d-missing: no RESOLVED entry/);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

rmSync(tmp, { recursive: true, force: true });
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("fixture-backlog tests passed");
