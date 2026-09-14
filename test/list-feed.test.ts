// Offline test for lib/list-feed.ts — the 0-credit TheirStack list feeder.
// No network, no credits, no touch of the real $PIPELINE_DATA. The harvester and planner
// are driven in-process; the CLI runs once against a synthetic store + raw tree + config.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { harvestIdsFromDoc, harvestIdsFromRaw, planFeed, type IdMap } from "../lib/list-feed.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "lib", "list-feed.ts");
let failures = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e: any) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
};
const A = "AAAAAAAAAAAAAAAAAAAAAA==", B = "BBBBBBBBBBBBBBBBBBBBBB==", G = "GGGGGGGGGGGGGGGGGGGGGG==";

check("harvest: company rows, _company_object (jobs files), list snapshots; integer job ids and blurred rows ignored", () => {
  const ids: IdMap = new Map();
  harvestIdsFromDoc({ _request: {}, data: [
    { id: A, domain: "Alpha.invalid" },
    { id: "blurredXXXXXXXX==", domain: "blur.invalid", has_blurred_data: true },
    { id: 730107131, company_domain: "job.invalid" },
  ] }, ids);
  harvestIdsFromDoc({ _company_object: { id: B, domain: "beta.invalid" }, data: [{ id: 1, job_title: "x" }] }, ids);
  harvestIdsFromDoc({ result: [{ company_object: { id: G, domain: "gamma.invalid" }, added_at: "x" }] }, ids);
  assert.deepEqual([...ids.entries()].sort(), [["alpha.invalid", A], ["beta.invalid", B], ["gamma.invalid", G]]);
});

const accounts = [
  { domain: "alpha.invalid", status: "dropped" },      // terminal, has id
  { domain: "beta.invalid", status: "routed" },        // graduable, has id
  { domain: "gamma.invalid", status: "active" },       // terminal, has id, already in list
  { domain: "delta.invalid", status: "skipped" },      // terminal, NO id anywhere
];
const ids: IdMap = new Map([["alpha.invalid", A], ["beta.invalid", B], ["gamma.invalid", G]]);

check("plan seen: every store account with an id not already in the list; id-less accounts reported", () => {
  const p = planFeed({ list: "seen", listId: 424242, accounts, ids, inList: new Set(["gamma.invalid"]) });
  assert.deepEqual(p.add_ids, [A, B]);
  assert.deepEqual(p.add_domains, ["alpha.invalid", "beta.invalid"]);
  assert.equal(p.already_in_list, 1);
  assert.deepEqual(p.without_id, ["delta.invalid"]);
});

check("plan terminal: terminal statuses only — an account that can still become a work item is never fed", () => {
  const p = planFeed({ list: "terminal", listId: 777777, accounts, ids, inList: new Set() });
  assert.deepEqual(p.add_domains, ["alpha.invalid", "gamma.invalid"]);
  assert.equal(p.eligible, 3);
});

// --- CLI against a synthetic store + fixture config ------------------------------------------
const cfg = mkdtempSync(join(tmpdir(), "list-feed-config-"));
writeFileSync(join(cfg, "signal.yaml"), "dedupe:\n  company_list_id: 424242\n  terminal_list_id: null\n  list_snapshot_dir: raw/theirstack/lists\nlimits: {}\n");
const root = mkdtempSync(join(tmpdir(), "list-feed-"));
for (const a of accounts) {
  mkdirSync(join(root, "accounts", a.domain), { recursive: true });
  writeFileSync(join(root, "accounts", a.domain, "account.yaml"), `domain: ${a.domain}\nstatus: ${a.status}\n`);
}
mkdirSync(join(root, "raw", "theirstack", "lists"), { recursive: true });
writeFileSync(join(root, "raw", "theirstack", "2026-09-01-hiring-signal-pull-1.json"), JSON.stringify({ _request: { limit: 15 }, data: [
  { id: A, domain: "alpha.invalid" }, { id: B, domain: "beta.invalid" }, { id: G, domain: "gamma.invalid" },
] }));
writeFileSync(join(root, "raw", "theirstack", "lists", "2026-09-02-424242.json"), JSON.stringify({ companies: [{ domain: "gamma.invalid", id: G }] }));
writeFileSync(join(root, "raw", "theirstack", "broken.json"), "{not json");
const cli = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [CLI, ...args], {
  env: { ...process.env, PIPELINE_DATA: root, PIPELINE_CONFIG_DIR: cfg, ...env }, encoding: "utf8", cwd: REPO,
});

check("CLI: harvests raw (skipping the broken file), reads the newest snapshot, plans the seen feed", () => {
  const r = cli(["--list", "seen"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.add_domains, ["alpha.invalid", "beta.invalid"]);
  assert.equal(j.raw_files_scanned, 2);
  assert.equal(harvestIdsFromRaw(join(root, "raw", "theirstack")).ids.size, 3);
});

check("CLI: --ids prints one id per line; --census counts ids per status", () => {
  assert.deepEqual(cli(["--list", "seen", "--ids"]).stdout.trim().split("\n"), [A, B]);
  const j = JSON.parse(cli(["--census"]).stdout);
  assert.equal(j.store_accounts, 4);
  assert.equal(j.with_id, 3);
  assert.equal(j.by_status.skipped.with_id, 0);
});

check("CLI: terminal list without a configured id exits 2 with guidance; a snapshot override rescues it", () => {
  const r = cli(["--list", "terminal"]);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /terminal_list_id/);
  const snap = join(root, "raw", "theirstack", "lists", "2026-09-14-777777.json");
  writeFileSync(snap, JSON.stringify({ companies: [] }));
  const r2 = cli(["--list", "terminal", "--list-snapshot", snap]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(JSON.parse(r2.stdout).add_domains, ["alpha.invalid", "gamma.invalid"]);
});

check("CLI: the shipped template (placeholder seen-list id) exits 2, never NaN", () => {
  const r = cli(["--list", "seen"], { PIPELINE_CONFIG_DIR: join(REPO, "config") });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /company_list_id/);
  assert.doesNotMatch(r.stderr, /NaN/);
});

rmSync(root, { recursive: true, force: true });
rmSync(cfg, { recursive: true, force: true });
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("list-feed tests passed");
