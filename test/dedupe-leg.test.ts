// Offline test for lib/dedupe-leg.ts — the M1 company_domain_not leg builder.
// No network, no credits, no touch of the real $PIPELINE_DATA. The pure ranker is driven
// in-process; the CLI is exercised in a child process with PIPELINE_DATA pointed at a
// synthetic store and PIPELINE_CONFIG_DIR at a fixture config (lib/env.ts resolves both at
// import — same pattern as test/pull-guard.test.ts).
//
// What is under test is the re-buy class: an ACTIVE account that is neither in the source's
// list nor among the most recently modified store domains gets bought again at full credit
// cost every time it re-enters the source's window. The leg must put not-in-list live
// accounts FIRST, and in merge mode must put accounts already seen in the window first.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TERMINAL_STATUSES as TERMINAL_LIKE, buildLeg, parseListSnapshot, configuredListId, type AccountRow } from "../lib/dedupe-leg.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "lib", "dedupe-leg.ts");

let failures = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e: any) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
};

const row = (domain: string, status: string, mtimeMs: number, extra: Partial<AccountRow> = {}): AccountRow =>
  ({ domain, status, mtimeMs, rawPointers: [], ...extra });

// --- pure ranker: standard mode ----------------------------------------------------------
const accounts: AccountRow[] = [
  row("old-active.invalid", "active", 1_000),                 // the re-buy class: old, live, not in list
  row("old-dropped.invalid", "dropped", 2_000),               // not in list, terminal
  row("fresh-routed.invalid", "routed", 9_000),               // in list, recent
  row("fresh-dropped.invalid", "dropped", 8_000),             // in list, recent
  row("mid-skipped.invalid", "skipped", 5_000),               // in list
];
const inList = new Set(["fresh-routed.invalid", "fresh-dropped.invalid", "mid-skipped.invalid"]);

check("standard: not-in-list live account ranks first, then not-in-list terminal, then recency fill", () => {
  const r = buildLeg({ mode: "standard", cap: 350, accounts, listDomains: inList, bugDomains: ["bug.invalid"] });
  assert.deepEqual(r.domains, [
    "bug.invalid",
    "old-active.invalid", "old-dropped.invalid",
    "fresh-routed.invalid", "fresh-dropped.invalid", "mid-skipped.invalid",
  ]);
  assert.equal(r.tiers.exclusion_bug, 1);
  assert.equal(r.tiers.not_in_list, 2);
  assert.equal(r.tiers.recent_fill, 3);
  assert.deepEqual(Object.values(r.overflow), [0, 0, 0]);
});

check("standard: cap is honoured and overflow is reported per tier", () => {
  const r = buildLeg({ mode: "standard", cap: 2, accounts, listDomains: inList, bugDomains: ["bug.invalid"] });
  assert.deepEqual(r.domains, ["bug.invalid", "old-active.invalid"]);
  assert.equal(r.count, 2);
  assert.equal(r.overflow.not_in_list, 1);   // old-dropped could not fit
  assert.equal(r.overflow.recent_fill, 4);   // everything not already taken (old-active was)
});

check("standard: an empty list snapshot degrades to 'everything is not-in-list' (live first)", () => {
  const r = buildLeg({ mode: "standard", cap: 350, accounts, listDomains: new Set(), bugDomains: [] });
  assert.equal(r.domains[0], "fresh-routed.invalid"); // live, newest
  assert.equal(r.domains[1], "old-active.invalid");   // live, older
  assert.equal(r.tiers.not_in_list, accounts.length);
});

check("standard: domains are de-duplicated across tiers and normalized", () => {
  const r = buildLeg({ mode: "standard", cap: 350, accounts, listDomains: inList, bugDomains: ["OLD-ACTIVE.invalid", "https://bug.invalid/careers"] });
  assert.equal(r.domains.filter((d) => d === "old-active.invalid").length, 1);
  assert.ok(r.domains.includes("bug.invalid"));
});

// --- pure ranker: merge mode ---------------------------------------------------------------
const refreshPtr = "raw/theirstack/2026-09-01-refresh-signal-pull-3.json";
const mergeAccounts: AccountRow[] = [
  row("seen-dropped.invalid", "dropped", 3_000, { rawPointers: [refreshPtr] }),   // terminal, in window → tier 2
  row("seen-active.invalid", "active", 1_000, { rawPointers: [refreshPtr] }),     // terminal (mid-sequence), in window
  row("seen-routed.invalid", "routed", 9_000, { rawPointers: [refreshPtr] }),     // open work item — still excluded once seen
  row("verified-held.invalid", "held", 4_000, { verifiedAt: "2026-08-20" }),       // verified <30d → tier 3
  row("old-verified.invalid", "held", 4_500, { verifiedAt: "2026-06-01" }),        // verified long ago → stays pullable
  row("unseen-dropped.invalid", "dropped", 7_000),                                 // terminal, never in window → fill
  row("other-signal-only.invalid", "skipped", 8_000, { rawPointers: ["raw/theirstack/2026-08-20-hiring-signal-pull-1.json"] }),
];

check("merge: everything already seen in the window first (terminal before open), then recently verified, then terminal fill; unseen open accounts never excluded", () => {
  const r = buildLeg({
    mode: "merge", cap: 350, accounts: mergeAccounts, listDomains: new Set(), bugDomains: [],
    signalKey: "refresh-signal", today: new Date("2026-09-02T12:00:00Z"),
  });
  assert.deepEqual(r.domains, [
    "seen-dropped.invalid", "seen-active.invalid", "seen-routed.invalid",
    "verified-held.invalid",
    "other-signal-only.invalid", "unseen-dropped.invalid",
  ]);
  assert.ok(!r.domains.includes("old-verified.invalid"));
  assert.equal(r.tiers.seen_in_window, 3);
  assert.equal(r.tiers.recently_verified, 1);
  assert.equal(r.tiers.terminal_fill, 2);
});

check("merge: a fresh stub seen in the window (status pulled, no verified date) is excluded — the re-bill class", () => {
  const stub = row("fresh-stub.invalid", "pulled", 9_500, { rawPointers: [refreshPtr] });
  const r = buildLeg({
    mode: "merge", cap: 350, accounts: [...mergeAccounts, stub], listDomains: new Set(), bugDomains: [],
    signalKey: "refresh-signal", today: new Date("2026-09-02T12:00:00Z"),
  });
  assert.ok(r.domains.includes("fresh-stub.invalid"));
  assert.equal(r.tiers.seen_in_window, 4);
});

check("merge: refuses to run without a signal key", () => {
  assert.throws(() => buildLeg({ mode: "merge", cap: 10, accounts: mergeAccounts, listDomains: new Set(), bugDomains: [] }), /signal-key/);
});

// --- terminal list --------------------------------------------------------------------------
check("standard: terminal-listed domains leave not_in_list and sort last in recent_fill", () => {
  const terminal = new Set(["old-dropped.invalid", "fresh-dropped.invalid"]);
  const r = buildLeg({ mode: "standard", cap: 350, accounts, listDomains: inList, terminalDomains: terminal, bugDomains: [] });
  assert.deepEqual(r.domains, [
    "old-active.invalid",                                   // not in either list
    "fresh-routed.invalid", "mid-skipped.invalid",          // fill, unlisted first
    "fresh-dropped.invalid", "old-dropped.invalid",         // fill, terminal-listed last (by mtime)
  ]);
  assert.equal(r.tiers.not_in_list, 1);
});

check("merge: terminal-listed domains sort last inside seen_in_window and terminal_fill (the capless leg carries them)", () => {
  const terminal = new Set(["seen-dropped.invalid", "unseen-dropped.invalid"]);
  const r = buildLeg({
    mode: "merge", cap: 350, accounts: mergeAccounts, listDomains: new Set(), terminalDomains: terminal, bugDomains: [],
    signalKey: "refresh-signal", today: new Date("2026-09-02T12:00:00Z"),
  });
  assert.deepEqual(r.domains, [
    "seen-active.invalid", "seen-routed.invalid", "seen-dropped.invalid",   // listed terminal AFTER the graduable seen account
    "verified-held.invalid",
    "other-signal-only.invalid", "unseen-dropped.invalid",
  ]);
  assert.equal(r.tiers.seen_in_window, 3);
});

check("merge: with a tight cap, terminal-listed domains are the ones that overflow (the capless leg carries them)", () => {
  const seenTerminal = mergeAccounts.find((a) => a.rawPointers.length && TERMINAL_LIKE.has(a.status))!;
  const r = buildLeg({
    mode: "merge", cap: 2, accounts: mergeAccounts, listDomains: new Set(), terminalDomains: new Set([seenTerminal.domain]), bugDomains: [],
    signalKey: "refresh-signal", today: new Date("2026-09-02T12:00:00Z"),
  });
  assert.ok(!r.domains.includes(seenTerminal.domain), `${seenTerminal.domain} should have been pushed past the cap: ${r.domains}`);
  assert.equal(r.count, 2);
});

// --- snapshot parsing + list id ----------------------------------------------------------
check("parseListSnapshot accepts the raw MCP shape and the compact shape", () => {
  const raw = JSON.stringify({ result: [{ added_at: "x", company_object: { id: "a", domain: "Acme.invalid" } }, { company_object: { domain: null } }] });
  const compact = JSON.stringify({ companies: [{ domain: "https://Beta.invalid/", id: "b" }] });
  assert.deepEqual([...parseListSnapshot(raw)], ["acme.invalid"]);
  assert.deepEqual([...parseListSnapshot(compact)], ["beta.invalid"]);
});

check("configuredListId: a numeric id parses, the template placeholder is 'not configured', never NaN", () => {
  assert.equal(configuredListId(424242), 424242);
  assert.equal(configuredListId(" 424242 "), 424242);
  assert.equal(configuredListId("REPLACE-WITH-THEIRSTACK-LIST-ID"), undefined);
  assert.equal(configuredListId(""), undefined);
  assert.equal(configuredListId(undefined), undefined);
  assert.equal(configuredListId(0), undefined);
  assert.equal(configuredListId("12abc"), undefined);
});

// --- CLI against a synthetic store + fixture config ------------------------------------------
const cfg = mkdtempSync(join(tmpdir(), "dedupe-leg-config-"));
writeFileSync(join(cfg, "signal.yaml"), `refresh-signal:
  enabled: true
  name: "Refresh Signal"
  aliases: []
  dedupe_mode: merge
dedupe:
  company_list_id: 424242
  company_domain_not_cap: 350
  list_snapshot_dir: raw/theirstack/lists
  merge_verified_window_days: 30
  merge_verified_field: last_checked_at
  exclusion_bug_domains: ["bug-example.invalid"]
limits: {}
`);
const root = mkdtempSync(join(tmpdir(), "dedupe-leg-"));
const account = (domain: string, yaml: string, mtimeSec: number) => {
  const dir = join(root, "accounts", domain);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "account.yaml");
  writeFileSync(p, yaml);
  utimesSync(p, mtimeSec, mtimeSec);
};
const today = new Date().toISOString().slice(0, 10);
account("oldlive.invalid", "domain: oldlive.invalid\nstatus: active\n", 1_700_000_000);
account("newdrop.invalid", "domain: newdrop.invalid\nstatus: dropped\n", 1_800_000_000);
account("listed.invalid", "domain: listed.invalid\nstatus: routed\n", 1_800_000_100);
account("checked.invalid", `domain: checked.invalid\nstatus: held\nlast_checked_at: ${today}\n`, 1_800_000_200);
account("seen.invalid", "domain: seen.invalid\nstatus: triaged\nraw_pointers:\n  - raw/theirstack/2026-09-01-refresh-signal-pull-1.json\n", 1_800_000_300);
mkdirSync(join(root, "raw", "theirstack", "lists"), { recursive: true });
writeFileSync(join(root, "raw", "theirstack", "lists", "2026-09-01-424242.json"),
  JSON.stringify({ result: [{ company_object: { domain: "oldlive.invalid", id: "y" }, added_at: "2026-09-01" }] }));
writeFileSync(join(root, "raw", "theirstack", "lists", "2026-09-02-424242.json"),
  JSON.stringify({ result: [{ company_object: { domain: "listed.invalid", id: "x" }, added_at: "2026-09-02" }] }));
writeFileSync(join(root, "raw", "theirstack", "lists", "2026-09-03-999999.json"),
  JSON.stringify({ result: [{ company_object: { domain: "newdrop.invalid", id: "z" }, added_at: "2026-09-03" }] }));

const cli = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [CLI, ...args], {
  env: { ...process.env, PIPELINE_DATA: root, PIPELINE_CONFIG_DIR: cfg, ...env }, encoding: "utf8", cwd: REPO,
});

check("CLI: discovers the newest snapshot for the configured list id, ranks not-in-list live first, prints one domain per line", () => {
  const r = cli([]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  // tier 1 bug domain; tier 2 not-in-list — LIVE statuses first by mtime desc (seen: triaged,
  // checked: held, oldlive: active), then terminal (newdrop); tier 3 recency fill (listed).
  assert.deepEqual(lines, ["bug-example.invalid", "seen.invalid", "checked.invalid", "oldlive.invalid", "newdrop.invalid", "listed.invalid"]);
});

check("CLI: --json reports tiers, snapshot path, list id and store size", () => {
  const r = cli(["--json", "--cap", "500"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.mode, "standard");
  assert.equal(j.list_id, 424242);
  assert.equal(j.store_accounts, 5);
  assert.equal(j.list_domains, 1);
  assert.equal(j.tiers.exclusion_bug, 1);
  assert.equal(j.tiers.not_in_list, 4);
  assert.ok(String(j.list_snapshot).endsWith("2026-09-02-424242.json"), `newest snapshot for OUR list, not another list's: ${j.list_snapshot}`);
});

check("CLI: --list-id and --list-snapshot override the config", () => {
  const byId = JSON.parse(cli(["--json", "--list-id", "999999"]).stdout);
  assert.ok(String(byId.list_snapshot).endsWith("2026-09-03-999999.json"));
  assert.equal(byId.list_id, 999999);
  const byPath = JSON.parse(cli(["--json", "--list-snapshot", join(root, "raw", "theirstack", "lists", "2026-09-01-424242.json")]).stdout);
  assert.ok(String(byPath.list_snapshot).endsWith("2026-09-01-424242.json"));
  assert.equal(byPath.list_domains, 1);
  assert.notEqual(cli(["--list-id", "not-a-number"]).status, 0);
});

check("CLI: merge mode keys on the config-named verified field and this signal's raw pointers", () => {
  const r = cli(["--json", "--mode", "merge", "--signal-key", "refresh-signal"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.verified_field, "last_checked_at");
  assert.equal(j.tiers.seen_in_window, 1, "seen.invalid carries a pointer into this signal's pull");
  assert.equal(j.tiers.recently_verified, 1, "checked.invalid was verified today under the config-named field");
  assert.equal(j.tiers.terminal_fill, 2);
  assert.deepEqual(j.domains, ["bug-example.invalid", "seen.invalid", "checked.invalid", "newdrop.invalid", "oldlive.invalid"]);
});

check("CLI: --terminal-snapshot (or dedupe.terminal_list_id) moves its members to the back of the leg", () => {
  const snap = join(root, "raw", "theirstack", "lists", "2026-09-14-777777.json");
  writeFileSync(snap, JSON.stringify({ companies: [{ domain: "newdrop.invalid", id: "t" }] }));
  const r = cli(["--json", "--terminal-snapshot", snap]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.terminal_list_domains, 1);
  assert.equal(j.domains[j.domains.length - 1], "newdrop.invalid");
  assert.equal(j.tiers.not_in_list, 3, "newdrop left the not_in_list tier");
});

check("CLI: merge mode without --signal-key fails loudly", () => {
  const r = cli(["--mode", "merge"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /signal-key/);
});

check("CLI: the shipped template (placeholder list id) exits 2 with a clear 'not configured' message, not NaN", () => {
  const r = cli([], { PIPELINE_CONFIG_DIR: join(REPO, "config") });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /dedupe\.company_list_id is not configured/);
  assert.match(r.stderr, /REPLACE-WITH-THEIRSTACK-LIST-ID/);
  assert.doesNotMatch(r.stderr, /NaN/);
  // an explicit --list-id rescues the run without editing config
  assert.equal(cli(["--list-id", "424242"], { PIPELINE_CONFIG_DIR: join(REPO, "config") }).status, 0);
});

check("CLI: empty store exits 2 instead of answering", () => {
  const empty = mkdtempSync(join(tmpdir(), "dedupe-leg-empty-"));
  const r = cli([], { PIPELINE_DATA: empty });
  assert.equal(r.status, 2);
  rmSync(empty, { recursive: true, force: true });
});

rmSync(root, { recursive: true, force: true });
rmSync(cfg, { recursive: true, force: true });
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("dedupe-leg tests passed");
