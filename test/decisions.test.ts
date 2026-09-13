// Offline tests for M7's decision ledger — scripts/decisions.ts.
// Same harness contract as test/m7-scripts.test.ts: the CLI runs in a child process with
// PIPELINE_DATA pointed at a temp dir (lib/env.ts resolves PIPELINE_DATA once at import, so
// an in-process override would be read too late). Run: npm test (or node test/decisions.test.ts)
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const DECISIONS = join(REPO, "skills", "m7-recorder-sync", "scripts", "decisions.ts");

let failures = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e: any) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
};

const stores: string[] = [];
const newStore = (): string => {
  const d = mkdtempSync(join(tmpdir(), "decisions-store-"));
  stores.push(d);
  return d;
};

type Run = { status: number; stdout: string; stderr: string };
const run = (store: string, args: string[], input?: string): Run => {
  const r = spawnSync("node", [DECISIONS, ...args], {
    env: { ...process.env, PIPELINE_DATA: store },
    encoding: "utf8",
    input: input ?? "",
  });
  return { status: r.status ?? 1, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
};

const ledgerLines = (store: string): any[] => {
  const p = join(store, "queue", "decisions.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
};

const TODAY = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// add — flag mode, JSON mode, defaults, validation
// ---------------------------------------------------------------------------
check("add via flags: defaults id/status/opened, echoes the record, appends one line", () => {
  const store = newStore();
  const r = run(store, ["add", "--kind", "policy-ruling", "--title", "Open-tracking off: deliberate?",
    "--body", "Open tracking is disabled. Deliberate deliverability choice or unexamined default?",
    "--by", "operator"]);
  assert.equal(r.status, 0, r.stderr);
  const e = JSON.parse(r.stdout.trim());
  assert.equal(e.id, `d-${TODAY}-open-tracking-off-deliberate`);
  assert.equal(e.status, "open");
  assert.deepEqual(e.accounts, []);
  assert.equal(e.opened.date, TODAY);
  assert.equal(e.opened.by, "operator");
  assert.equal(e.resolution, null);
  assert.equal(ledgerLines(store).length, 1);
  assert.match(r.stderr, /opened d-.*policy-ruling/);
});

check("add via JSON stdin and --file are equivalent; accounts/unblocks/run_id carried", () => {
  const store = newStore();
  const entry = {
    id: "hiring-successor", kind: "sequence-lifecycle", title: "Hiring-signal successor sequence",
    body: "v1 retired; survivors HOLD.", accounts: ["acme-example.com", "beta-example.com"],
    unblocks: "68 HOLD accounts become enrollable", opened: { date: "2026-08-06", by: "operator", run_id: "r1" },
  };
  const viaStdin = run(store, ["add"], JSON.stringify(entry));
  assert.equal(viaStdin.status, 0, viaStdin.stderr);
  const e = ledgerLines(store)[0];
  assert.equal(e.id, "hiring-successor");
  assert.equal(e.opened.run_id, "r1");
  assert.equal(e.unblocks, "68 HOLD accounts become enrollable");
  assert.deepEqual(e.accounts, ["acme-example.com", "beta-example.com"]);

  const p = join(store, "entry.json");
  writeFileSync(p, JSON.stringify({ ...entry, id: "hiring-successor-2" }));
  assert.equal(run(store, ["add", "--file", p]).status, 0);
  assert.equal(ledgerLines(store).length, 2);
});

check("add rejects unknown keys, bad kind/status/id/accounts, premature resolution — writes nothing", () => {
  const store = newStore();
  const bad = {
    id: "Bad Slug!", kind: "vibes", status: "maybe", title: "",
    accounts: ["has space.example"], opened: { date: "yesterday", by: "" },
    resolution: { date: TODAY, ruling: "x", by: "y" }, bogus: 1,
  };
  const r = run(store, ["add"], JSON.stringify(bad));
  assert.equal(r.status, 1);
  for (const pattern of [
    /unknown key "bogus"/, /id: "Bad Slug!"/, /kind: required, one of/, /status: required, one of/,
    /title: required/, /opened\.date: required ISO date/, /opened\.by: required/,
    /accounts: "has space\.example"/, /resolution: must be null\/absent unless status is resolved/,
  ]) assert.match(r.stderr, pattern, `missing error for ${pattern}`);
  assert.equal(ledgerLines(store).length, 0, "a rejected entry must not be written");
});

check("duplicate id is refused; --blocked sets status blocked", () => {
  const store = newStore();
  assert.equal(run(store, ["add", "--kind", "ops", "--title", "same thing"]).status, 0);
  const dup = run(store, ["add", "--kind", "ops", "--title", "same thing"]);
  assert.equal(dup.status, 1);
  assert.match(dup.stderr, /already exists/);
  assert.equal(ledgerLines(store).length, 1);

  const b = run(store, ["add", "--kind", "deferred-enrollment", "--title", "gamma no valid contact",
    "--accounts", "gamma-example.com", "--blocked"]);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(JSON.parse(b.stdout.trim()).status, "blocked");
});

// ---------------------------------------------------------------------------
// list / resolve / report
// ---------------------------------------------------------------------------
const seed = (store: string) => {
  run(store, ["add"], JSON.stringify({
    id: "old-open", kind: "policy-ruling", title: "an old question",
    opened: { date: "2026-08-01", by: "operator" },
  }));
  run(store, ["add", "--kind", "deferred-enrollment", "--title", "delta coo email unavailable",
    "--accounts", "DELTA-EXAMPLE.com", "--blocked"]);
  run(store, ["add", "--kind", "go-live", "--title", "192 paused contacts await M4 go"]);
};

check("list shows unresolved oldest-first with age; --kind filters; --json emits JSONL", () => {
  const store = newStore();
  seed(store);
  const r = run(store, ["list"]);
  assert.equal(r.status, 0, r.stderr);
  const rows = r.stdout.split("\n").filter((l) => /OPEN|BLOCKED/.test(l));
  assert.equal(rows.length, 3);
  assert.match(rows[0], /old-open/, "oldest first");
  assert.match(rows[0], /\d+d\s+policy-ruling/);
  assert.match(rows[1], /BLOCKED.*\[1 acct\].*delta coo email unavailable/);
  assert.match(r.stdout, /open\+blocked: 3\s+\|\s+resolved: 0/);

  const filtered = run(store, ["list", "--kind", "go-live"]);
  assert.equal(filtered.stdout.split("\n").filter((l) => /OPEN/.test(l)).length, 1);

  const json = run(store, ["list", "--json"]);
  assert.equal(json.stdout.trim().split("\n").length, 3);
  assert.equal(JSON.parse(json.stdout.trim().split("\n")[0]).id, "old-open");
});

check("resolve stamps ruling + flips status; re-resolve refused; list hides it, --all shows it", () => {
  const store = newStore();
  seed(store);
  const r = run(store, ["resolve", "old-open", "--ruling", "Believed; suppress conservatively.", "--by", "operator"]);
  assert.equal(r.status, 0, r.stderr);
  const e = ledgerLines(store).find((x) => x.id === "old-open");
  assert.equal(e.status, "resolved");
  assert.deepEqual(e.resolution, { date: TODAY, ruling: "Believed; suppress conservatively.", by: "operator" });
  assert.equal(ledgerLines(store).length, 3, "resolve rewrites in place, order preserved");

  assert.doesNotMatch(run(store, ["list"]).stdout, /old-open/);
  assert.match(run(store, ["list", "--all"]).stdout, new RegExp(`resolved ${TODAY}.*old-open`));

  const again = run(store, ["resolve", "old-open", "--ruling", "changed my mind"]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already resolved/);

  assert.match(run(store, ["resolve", "nope", "--ruling", "x"]).stderr, /no decision "nope"/);
  assert.match(run(store, ["resolve", "old-open"]).stderr, /--ruling is required/);
});

check("report: counts by kind, oldest age, gated accounts, aged section", () => {
  const store = newStore();
  seed(store);
  const r = run(store, ["report"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /decisions: 3 total \| 3 open\+blocked \| 0 resolved/);
  assert.match(r.stdout, /policy-ruling\s+1 open\s+\(oldest \d+d\)/);
  assert.match(r.stdout, /accounts gated on an open decision: 1/);
  assert.match(r.stdout, /open ≥7 days \(1\):/);
  assert.match(r.stdout, /old-open\s+an old question/);
});

check("empty-store behaviors", () => {
  const store = newStore();
  assert.match(run(store, ["list"]).stdout, /0 open/);
  assert.match(run(store, ["report"]).stdout, /no decisions recorded yet/);
  assert.match(run(store, ["bogus"]).stderr, /unknown subcommand/);
  assert.match(run(store, ["add"]).stderr, /no input/);
});

// ---------------------------------------------------------------------------
// verdicts — subject targeting, recency precedence, explicit superseded_by, ack
// ---------------------------------------------------------------------------
const writeAccount = (store: string, domain: string, status: string) => {
  mkdirSync(join(store, "accounts", domain), { recursive: true });
  writeFileSync(join(store, "accounts", domain, "account.yaml"), `domain: ${domain}\ncompany: ${domain}\nstatus: ${status}\n`);
};
// A resolved-with-verdict entry, dated explicitly (resolve stamps today, so seed via JSON).
const ruled = (store: string, e: { id: string; accounts: string[]; subject?: string[]; verdict: string; date: string; superseded_by?: string; executed?: any }) =>
  run(store, ["add"], JSON.stringify({
    id: e.id, kind: "re-triage", status: "resolved", title: e.id, accounts: e.accounts,
    ...(e.subject ? { subject: e.subject } : {}),
    opened: { date: e.date, by: "operator" },
    resolution: { date: e.date, ruling: `ruling for ${e.id}`, by: "operator", verdict: e.verdict,
      ...(e.superseded_by ? { superseded_by: e.superseded_by } : {}), ...(e.executed ? { executed: e.executed } : {}) },
  }));
const verdictsJson = (store: string, ...flags: string[]) => {
  const r = run(store, ["verdicts", "--json", ...flags]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim());
};

check("subject targets the verdict; accounts bystander is never nagged; no account file is informational", () => {
  const store = newStore();
  writeAccount(store, "oldbrand-example.com", "active"); // live mid-sequence neighbour
  // newbrand-example.com (a rebrand of the same company) has no account file. Without
  // subject, the old behaviour nagged the live neighbour.
  assert.equal(ruled(store, { id: "drop-newbrand", accounts: ["oldbrand-example.com"], subject: ["newbrand-example.com"], verdict: "drop", date: "2026-08-21" }).status, 0);
  const j = verdictsJson(store);
  assert.deepEqual(j.pending, []);
  assert.deepEqual(j.superseded, []);
  assert.equal(j.no_account.length, 1);
  assert.equal(j.no_account[0].id, "drop-newbrand");
  assert.deepEqual(j.no_account[0].domains, ["newbrand-example.com"]);
  const t = run(store, ["verdicts"]);
  assert.match(t.stdout, /no verdicts awaiting execution/);
  assert.match(t.stdout, /no account file — not executable \(1, informational\):/);
  assert.match(t.stdout, /DROP\s+drop-newbrand\s+newbrand-example\.com/);
  assert.doesNotMatch(t.stdout, /oldbrand-example\.com\s+currently/);

  // subject with a real account file IS executable — and the bystander still isn't touched.
  writeAccount(store, "newbrand-example.com", "routed");
  const j2 = verdictsJson(store);
  assert.equal(j2.pending.length, 1);
  assert.equal(j2.pending[0].id, "drop-newbrand");
  assert.deepEqual(j2.pending[0].accounts, [{ domain: "newbrand-example.com", status: "routed" }]);
  assert.match(run(store, ["verdicts"]).stdout, /DROP\s+drop-newbrand\s+\(ruled 2026-08-21, subject-targeted\)/);

  // add --subject flag mode + validation
  const viaFlag = run(store, ["add", "--kind", "re-triage", "--title", "subj via flag", "--accounts", "a-example.com", "--subject", "b-example.com, c-example.com"]);
  assert.equal(viaFlag.status, 0, viaFlag.stderr);
  assert.deepEqual(JSON.parse(viaFlag.stdout.trim()).subject, ["b-example.com", "c-example.com"]);
  const bad = run(store, ["add"], JSON.stringify({ id: "bad-subj", kind: "ops", title: "x", accounts: [], subject: ["has space.example", ""], opened: { date: TODAY, by: "s" } }));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /subject: "has space\.example"/);
  assert.match(run(store, ["add"], JSON.stringify({ id: "bad-subj2", kind: "ops", title: "x", accounts: [], subject: [], opened: { date: TODAY, by: "s" } })).stderr, /subject: when present, a non-empty array/);
});

check("recency: only the newest ruling per domain is pending; older ones are superseded, not flip-flopped", () => {
  const store = newStore();
  writeAccount(store, "acme-example.com", "dropped"); // the 08-21 drop was executed; the 08-14 qualified must NOT resurface
  ruled(store, { id: "qual-acme", accounts: ["acme-example.com"], verdict: "qualified", date: "2026-08-14" });
  ruled(store, { id: "drop-acme", accounts: ["acme-example.com"], verdict: "drop", date: "2026-08-21" });
  const j = verdictsJson(store);
  assert.deepEqual(j.pending, [], "store already reflects the newest ruling");
  assert.equal(j.superseded.length, 1);
  assert.equal(j.superseded[0].id, "qual-acme");
  assert.equal(j.superseded[0].superseded_by, "drop-acme");
  assert.deepEqual(j.superseded[0].domains, ["acme-example.com"]);
  const dflt = run(store, ["verdicts"]).stdout;
  assert.match(dflt, /no verdicts awaiting execution/);
  assert.match(dflt, /superseded by a newer ruling on the same domain — not pending: 1\s+\(--all to list\)/);
  assert.doesNotMatch(dflt, /qual-acme/, "default output hides the superseded list");
  const all = run(store, ["verdicts", "--all"]).stdout;
  assert.match(all, /superseded — not pending \(1\):/);
  assert.match(all, /QUALIFIED\s+qual-acme\s+superseded by drop-acme\s+\[acme-example\.com\]\s+\(ruled 2026-08-14\)/);

  // Newest not yet executed → it (and only it) is pending.
  writeAccount(store, "acme-example.com", "routed");
  const j2 = verdictsJson(store);
  assert.deepEqual(j2.pending.map((p: any) => p.id), ["drop-acme"]);
  assert.deepEqual(j2.superseded.map((s: any) => s.id), ["qual-acme"]);

  // Same-date tie → later position in the file wins.
  writeAccount(store, "tie-example.com", "routed");
  ruled(store, { id: "tie-first", accounts: ["tie-example.com"], verdict: "skip", date: "2026-09-01" });
  ruled(store, { id: "tie-second", accounts: ["tie-example.com"], verdict: "drop", date: "2026-09-01" });
  const j3 = verdictsJson(store);
  assert.deepEqual(j3.pending.map((p: any) => p.id).sort(), ["drop-acme", "tie-second"]);
  assert.ok(j3.superseded.some((s: any) => s.id === "tie-first" && s.superseded_by === "tie-second"));

  // Recency is per-domain: a multi-account entry stays pending for the domains nobody newer ruled on.
  writeAccount(store, "solo-example.com", "routed");
  ruled(store, { id: "skip-both", accounts: ["solo-example.com", "tie-example.com"], verdict: "skip", date: "2026-08-01" });
  const j4 = verdictsJson(store);
  const both = j4.pending.find((p: any) => p.id === "skip-both");
  assert.deepEqual(both.accounts, [{ domain: "solo-example.com", status: "routed" }]);
  assert.ok(j4.superseded.some((s: any) => s.id === "skip-both" && s.superseded_by === "tie-second" && s.domains.join() === "tie-example.com"));
});

check("explicit resolution.superseded_by is honoured regardless of dates", () => {
  const store = newStore();
  writeAccount(store, "x-example.com", "routed");
  // The later-dated entry defers explicitly to the earlier one — the earlier one is what's pending.
  ruled(store, { id: "x-old", accounts: ["x-example.com"], verdict: "drop", date: "2026-08-10" });
  ruled(store, { id: "x-new", accounts: ["x-example.com"], verdict: "skip", date: "2026-08-20", superseded_by: "x-old" });
  const j = verdictsJson(store);
  assert.deepEqual(j.pending.map((p: any) => p.id), ["x-old"]);
  assert.equal(j.superseded.length, 1);
  assert.equal(j.superseded[0].id, "x-new");
  assert.equal(j.superseded[0].superseded_by, "x-old");
  assert.equal(j.superseded[0].explicit, true);
  assert.match(run(store, ["verdicts", "--all"]).stdout, /x-new\s+superseded by x-old \(explicit\)/);
  assert.match(run(store, ["add"], JSON.stringify({ id: "bad", kind: "ops", status: "resolved", title: "x", accounts: [],
    opened: { date: TODAY, by: "s" }, resolution: { date: TODAY, ruling: "r", by: "s", superseded_by: 7 } })).stderr, /resolution\.superseded_by: must be the id/);
});

check("ack stamps resolution.executed, removes the entry from pending; refuses unresolved/no-verdict/repeat", () => {
  const store = newStore();
  writeAccount(store, "held-example.com", "routed");
  ruled(store, { id: "hold-it", accounts: ["held-example.com"], verdict: "hold", date: "2026-08-25" });
  assert.deepEqual(verdictsJson(store).pending.map((p: any) => p.id), ["hold-it"]);

  const r = run(store, ["ack", "hold-it", "--by", "batch-2026-09-02", "--note", "already in a paused sequence; hold is moot"]);
  assert.equal(r.status, 0, r.stderr);
  const e = JSON.parse(r.stdout.trim());
  assert.deepEqual(e.resolution.executed, { date: TODAY, by: "batch-2026-09-02", note: "already in a paused sequence; hold is moot" });
  assert.equal(ledgerLines(store).find((x) => x.id === "hold-it").resolution.executed.date, TODAY, "rewritten in place");
  assert.match(r.stderr, /acknowledged hold-it \(hold\)/);

  const j = verdictsJson(store);
  assert.deepEqual(j.pending, []);
  assert.equal(j.executed.length, 1);
  assert.equal(j.executed[0].id, "hold-it");
  assert.match(run(store, ["verdicts"]).stdout, /no verdicts awaiting execution/);
  assert.doesNotMatch(run(store, ["verdicts"]).stdout, /hold-it/);
  assert.match(run(store, ["verdicts", "--all"]).stdout, new RegExp(`executed / acknowledged \\(1\\):\\n\\s+HOLD\\s+hold-it\\s+ack ${TODAY} by batch-2026-09-02 — already in`));

  // An acked entry is still the newest ruling for its domain — an older one doesn't resurface.
  ruled(store, { id: "older-held", accounts: ["held-example.com"], verdict: "skip", date: "2026-08-01" });
  const j2 = verdictsJson(store);
  assert.deepEqual(j2.pending, []);
  assert.ok(j2.superseded.some((s: any) => s.id === "older-held" && s.superseded_by === "hold-it"));

  const again = run(store, ["ack", "hold-it"]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already acknowledged/);
  run(store, ["add", "--kind", "ops", "--id", "still-open", "--title", "open one"]);
  const unresolved = run(store, ["ack", "still-open"]);
  assert.equal(unresolved.status, 1);
  assert.match(unresolved.stderr, /is open, not resolved/);
  run(store, ["resolve", "still-open", "--ruling", "no verdict here"]);
  const noVerdict = run(store, ["ack", "still-open"]);
  assert.equal(noVerdict.status, 1);
  assert.match(noVerdict.stderr, /has no verdict/);
  assert.match(run(store, ["ack", "nope"]).stderr, /no decision "nope"/);
  assert.match(run(store, ["ack"]).stderr, /ack needs the decision id/);
  // Validation of a hand-written executed block.
  assert.match(run(store, ["add"], JSON.stringify({ id: "bad-x", kind: "ops", status: "resolved", title: "x", accounts: [],
    opened: { date: TODAY, by: "s" }, resolution: { date: TODAY, ruling: "r", by: "s", verdict: "skip", executed: { date: "soon", by: "", extra: 1 } } })).stderr,
    /resolution\.executed: unknown key "extra"[\s\S]*resolution\.executed\.date: required ISO date[\s\S]*resolution\.executed\.by: required/);
});

check("list --json shape is unchanged for old-shape entries (no subject key) and resolve output is untouched", () => {
  const store = newStore();
  seed(store);
  run(store, ["resolve", "old-open", "--ruling", "fine", "--verdict", "acknowledge"]);
  for (const e of run(store, ["list", "--all", "--json"]).stdout.trim().split("\n").map((l) => JSON.parse(l))) {
    assert.ok(!("subject" in e), `unexpected subject key on ${e.id}`);
    assert.deepEqual(Object.keys(e).filter((k) => !["unblocks"].includes(k)).sort(),
      ["accounts", "body", "id", "kind", "opened", "resolution", "status", "title"]);
  }
  const resolved = ledgerLines(store).find((x) => x.id === "old-open");
  assert.deepEqual(Object.keys(resolved.resolution).sort(), ["by", "date", "ruling", "verdict"]);
});

for (const s of stores) rmSync(s, { recursive: true, force: true });

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("decisions ledger test passed");
