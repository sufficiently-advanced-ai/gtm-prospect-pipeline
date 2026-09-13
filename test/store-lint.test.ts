// Offline store-lint test — a throwaway store in a temp dir, linted through the CLI.
// No network, no CRM key, no touch of the real $PIPELINE_DATA.
//
// The CLI is invoked as a child process on purpose: lib/env.ts resolves PIPELINE_DATA (and
// PIPELINE_CONFIG_DIR) once at import time, so an in-process override would be read too late.
// Each case builds a fixture store, runs `node lib/store-lint.ts --json`, and asserts on
// findings by `check` id. A fixture config dir (PIPELINE_CONFIG_DIR) carries an ACTIVE
// sequence so the resolver-dependent check can fire — the shipped template is a draft.
//
// Coverage includes the historical incidents the linter exists to catch:
//   1. unparseable YAML from an unescaped ": " in a plain scalar
//   2. `route: FLAG` instead of FLAGGED
//   3. signal_source silently dropped by an edit pass
//   4. raw_pointer to a file that does not exist
//   5. silent M3 deferral (enrollable on every axis, no m3_note, no ledger entry)
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractCitations } from "../lib/store-lint.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const LINT = join(REPO, "lib", "store-lint.ts");

let failures = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e: any) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
};

// --- fixture config: one ACTIVE sequence (hiring-signal) and one RETIRED (held-signal) ----
const hex24 = (n: number): string => n.toString(16).padStart(24, "0");
const cfg = mkdtempSync(join(tmpdir(), "store-lint-config-"));
writeFileSync(join(cfg, "signal.yaml"), `hiring-signal:
  enabled: true
  name: "Hiring Signal"
  aliases: ["legacy-hiring-spelling"]
held-signal:
  enabled: false
  name: "Held Signal"
  aliases: []
dedupe:
  company_list_id: 424242
  exclusion_bug_domains: []
limits:
  salesnav_lookups_per_run: 25
`);
writeFileSync(join(cfg, "sequences.yaml"), `sequences:
  hiring-v1:
    id: ${hex24(1)}
    name: "Hiring v1"
    status: active
    binds: { signals: [hiring-signal] }
  held-v1:
    id: ${hex24(2)}
    name: "Held v1"
    status: retired
    binds: { signals: [held-signal] }
merge_fields: {}
`);

const root = mkdtempSync(join(tmpdir(), "store-lint-"));
const write = (rel: string, body: string) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
};
const account = (domain: string, yaml: string) => write(join("accounts", domain, "account.yaml"), yaml);
const ENV = { ...process.env, PIPELINE_DATA: root, PIPELINE_CONFIG_DIR: cfg };

type LintRun = {
  code: number; accounts: number; errors: number; warnings: number;
  findings: Array<{ domain: string; severity: string; check: string; message: string }>;
};
const lint = (...extra: string[]): LintRun => {
  const r = spawnSync(process.execPath, [LINT, "--json", ...extra], { env: ENV, encoding: "utf8", cwd: REPO });
  if (r.status === 2) return { code: 2, accounts: 0, errors: 0, warnings: 0, findings: [] };
  assert.ok(r.stdout.trim().startsWith("{"), `expected JSON, got: ${r.stdout}\n${r.stderr}`);
  return { code: r.status ?? -1, ...JSON.parse(r.stdout) };
};
const checksFor = (run: LintRun, domain: string) => run.findings.filter((f) => f.domain === domain).map((f) => f.check);

// --- fixture store -----------------------------------------------------------
mkdirSync(join(root, "accounts"), { recursive: true });
write("raw/postings/clean.example/2026-01-11-vp-ops.md", "posting text\n");
write("raw/firecrawl/clean.example/2026-01-11-team.md", "team page\n");

// (0) clean account — everything the linter asks for, nothing it complains about.
account("clean.example", `domain: clean.example
company: Clean Example Inc
status: routed
route: QUALIFIED
signal_source: legacy-hiring-spelling
verification: HEADLESS_3SOURCE
triaged_at: 2026-01-11T12:00:00.000Z
raw_pointers:
  - raw/postings/clean.example/2026-01-11-vp-ops.md
  - raw/firecrawl/clean.example/2026-01-11-team.md
contacts:
  - name: Ann Example
    email: ann@clean.example
    sequence_status: PAUSED
`);
write("accounts/clean.example/evidence.md", `# Clean Example — evidence

Hiring a VP of Operations reporting to the CEO [raw/postings/clean.example/2026-01-11-vp-ops.md · fact].
Leadership bench is thin [raw/firecrawl/clean.example/2026-01-11-team.md · inference].
Both together [raw/postings/clean.example/2026-01-11-vp-ops.md, raw/firecrawl/clean.example/2026-01-11-team.md · fact].
`);

// (1) an agent wrote an evidence_note containing an unescaped ": ", which turns the plain
// scalar into a nested mapping and breaks the whole file.
account("badyaml.example", `domain: badyaml.example
company: Bad YAML Co
status: triaged
signal_source: Hiring Signal
evidence_note: Bad YAML Co, hiring VP Ops: reports to CEO, bench is short
`);

// (2) `route: FLAG` written where the vocabulary says FLAGGED.
account("badroute.example", `domain: badroute.example
company: Bad Route Co
status: routed
route: FLAG
signal_source: Hiring Signal
triaged_at: 2026-01-11T12:00:00.000Z
`);

// (3) an M2 edit pass silently dropped signal_source.
account("nosignal.example", `domain: nosignal.example
company: No Signal Co
status: routed
route: QUALIFIED
triaged_at: 2026-01-11T12:00:00.000Z
`);

// (4) raw_pointer to a file that was never captured (or was moved away).
account("danglingptr.example", `domain: danglingptr.example
company: Dangling Pointer Co
status: routed
route: QUALIFIED
signal_source: Hiring Signal
triaged_at: 2026-01-11T12:00:00.000Z
raw_pointers:
  - raw/postings/danglingptr.example/2026-01-11-nope.md
`);

// (5) the remaining checks, one account each.
account("mismatch.example", `domain: other.example
company: Mismatch Co
status: pulled
signal_source: Hiring Signal
`);
account("noroute.example", `domain: noroute.example
company: No Route Co
status: active
signal_source: Hiring Signal
triaged_at: 2026-01-11T12:00:00.000Z
`);
account("legacy.example", `domain: legacy.example
company: Legacy Co
status: active
route: QUALIFIED
signal_source: Hiring Signal
contacts:
  - name: Bob Legacy
    email: bob@legacy-corporate.example
    sequence_status: PAUSED
`);
account("badseq.example", `domain: badseq.example
company: Bad Sequence Co
status: enrolled-paused
route: QUALIFIED
signal_source: Hiring Signal
triaged_at: 2026-01-11T12:00:00.000Z
contacts:
  - name: Cy Contact
    email: cy@badseq.example
    sequence_status: PAUSED_MANUAL
`);
account("badcite.example", `domain: badcite.example
company: Bad Citation Co
status: active
route: QUALIFIED
signal_source: Hiring Signal
triaged_at: 2026-01-11T12:00:00.000Z
`);
write("accounts/badcite.example/evidence.md", `Cited but never captured [raw/firecrawl/badcite.example/2026-01-11-gone.md · fact].
`);
account("escape.example", `domain: escape.example
company: Escape Co
status: routed
route: QUALIFIED
signal_source: Hiring Signal
triaged_at: 2026-01-11T12:00:00.000Z
raw_pointers:
  - ../../../etc/passwd
`);
// A legacy route value from before the public enum — still an enum error, never silently accepted.
account("oldroute.example", `domain: oldroute.example
company: Old Route Co
status: skipped
route: SKIP_LEGACY_VALUE
signal_source: Hiring Signal
triaged_at: 2026-01-11T12:00:00.000Z
`);

// (6) silent M3 deferral. Four routed + SALES_NAV accounts; only the first is
// enrollable-but-invisible. Signal/route pairs come from the fixture config: Hiring Signal
// binds an active sequence (ENROLL); Held Signal matches only a retired one (HOLD).
const salesNav = (domain: string, extra: string, signal = "Hiring Signal", route = "QUALIFIED") => account(domain, `domain: ${domain}
company: ${domain}
status: routed
route: ${route}
signal_source: ${signal}
verification: SALES_NAV
triaged_at: 2026-01-20T12:00:00.000Z
${extra}`);
salesNav("silent.example", "");                                                  // trips it
salesNav("noted.example", "m3_note: deferred — no verified email yet\n");          // M3 recorded why
salesNav("ledgered.example", "");                                                // an open ledger entry names it
salesNav("hold.example", "", "Held Signal");                                     // resolver HOLDs
write("queue/decisions.jsonl", [
  JSON.stringify({ id: "d-1", status: "open", accounts: ["ledgered.example"], title: "waiting on email" }),
  JSON.stringify({ id: "d-2", status: "resolved", accounts: ["silent.example"], title: "closed long ago" }),
  "{ not json",
].join("\n") + "\n");

const all = lint();

// --- assertions --------------------------------------------------------------
check("clean account produces no findings at all", () => {
  assert.deepEqual(all.findings.filter((f) => f.domain === "clean.example"), []);
});

check("incident 1: unescaped colon breaks YAML — reported, not crashed", () => {
  const fs = all.findings.filter((f) => f.domain === "badyaml.example");
  assert.equal(fs.length, 1, `expected exactly one finding, got ${JSON.stringify(fs)}`);
  assert.equal(fs[0].check, "yaml-parse");
  assert.equal(fs[0].severity, "error");
  assert.equal(fs[0].message.split("\n").length, 1, "finding must stay one line");
});

check("incident 2: route: FLAG is an enum error naming the valid set", () => {
  const f = all.findings.find((x) => x.domain === "badroute.example" && x.check === "enum-route");
  assert.ok(f, "no enum-route finding");
  assert.equal(f.severity, "error");
  assert.match(f.message, /FLAG/);
  assert.match(f.message, /QUALIFIED\|SKIP\|FLAGGED\|DROPPED/, "the valid set is the public four-value enum");
});

check("a legacy route value outside the public enum is an enum error", () => {
  const f = all.findings.find((x) => x.domain === "oldroute.example" && x.check === "enum-route");
  assert.ok(f && f.severity === "error", "no enum-route finding for the legacy value");
});

check("incident 3: missing signal_source is an error", () => {
  const f = all.findings.find((x) => x.domain === "nosignal.example" && /signal_source/.test(x.message));
  assert.ok(f, "no signal_source finding");
  assert.equal(f.severity, "error");
  assert.equal(f.check, "required-field");
});

check("incident 4: raw_pointer to a nonexistent file is an error", () => {
  const f = all.findings.find((x) => x.domain === "danglingptr.example" && x.check === "raw-pointer");
  assert.ok(f, "no raw-pointer finding");
  assert.equal(f.severity, "error");
  assert.match(f.message, /2026-01-11-nope\.md/);
});

check("domain must equal the directory name", () => {
  assert.deepEqual(checksFor(all, "mismatch.example"), ["domain-mismatch"]);
});

check("route is required once the account is past triage", () => {
  const f = all.findings.find((x) => x.domain === "noroute.example" && x.check === "required-field");
  assert.ok(f && f.severity === "error", "missing route must be an error at status active");
});

check("legacy tolerance: missing triaged_at and off-domain email are warns, never errors", () => {
  const fs = all.findings.filter((x) => x.domain === "legacy.example");
  assert.deepEqual(fs.map((f) => f.check).sort(), ["contact-email-domain", "required-field"]);
  assert.ok(fs.every((f) => f.severity === "warn"), JSON.stringify(fs));
});

check("bad contact sequence_status is an enum error", () => {
  const f = all.findings.find((x) => x.domain === "badseq.example" && x.check === "enum-sequence-status");
  assert.ok(f && f.severity === "error");
  assert.match(f.message, /PAUSED_MANUAL/);
});

check("evidence.md citing an uncaptured raw path is an error", () => {
  const f = all.findings.find((x) => x.domain === "badcite.example" && x.check === "evidence-citation");
  assert.ok(f && f.severity === "error");
  assert.match(f.message, /2026-01-11-gone\.md/);
});

check("a raw_pointer escaping the store root is a finding, not a crash", () => {
  const f = all.findings.find((x) => x.domain === "escape.example" && x.check === "raw-pointer");
  assert.ok(f && f.severity === "error");
  assert.match(f.message, /escapes store root/);
});

check("incident 5: silent M3 deferral is a WARN with the exact text; note, open ledger entry, or HOLD silences it", () => {
  const f = all.findings.find((x) => x.domain === "silent.example" && x.check === "silent-deferral");
  assert.ok(f, `no silent-deferral finding: ${JSON.stringify(all.findings.filter((x) => x.domain === "silent.example"))}`);
  assert.equal(f.severity, "warn", "never an error — the store is right, the record is missing");
  assert.equal(f.message, "silent-deferral — resolver says ENROLL, no m3_note and no open ledger entry (M3 must record every deferral)");
  assert.deepEqual(checksFor(all, "silent.example"), ["silent-deferral"], "a resolved ledger entry does not count as open");
  assert.deepEqual(checksFor(all, "noted.example"), []);
  assert.deepEqual(checksFor(all, "ledgered.example"), []);
  assert.deepEqual(checksFor(all, "hold.example"), []);

  const human = spawnSync(process.execPath, [LINT, "--domain", "silent.example"], { env: ENV, encoding: "utf8", cwd: REPO });
  assert.equal(human.status, 0, "a warn-only account exits 0");
  assert.match(human.stdout, /^WARN  silent\.example: silent-deferral — resolver says ENROLL, no m3_note and no open ledger entry \(M3 must record every deferral\)$/m);
});

check("silent-deferral tolerates a missing ledger (still warns) ", () => {
  const noLedger = mkdtempSync(join(tmpdir(), "store-lint-noledger-"));
  mkdirSync(join(noLedger, "accounts", "silent.example"), { recursive: true });
  writeFileSync(join(noLedger, "accounts", "silent.example", "account.yaml"),
    "domain: silent.example\ncompany: S\nstatus: routed\nroute: QUALIFIED\nsignal_source: Hiring Signal\nverification: SALES_NAV\ntriaged_at: 2026-01-20\n");
  const r = spawnSync(process.execPath, [LINT, "--json"], { env: { ...ENV, PIPELINE_DATA: noLedger }, encoding: "utf8", cwd: REPO });
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.findings.map((f: any) => f.check), ["silent-deferral"]);
  rmSync(noLedger, { recursive: true, force: true });
});

check("with the shipped template (draft sequence) nothing is enrollable, so no silent-deferral fires", () => {
  const r = spawnSync(process.execPath, [LINT, "--json", "--domain", "silent.example"], {
    env: { ...process.env, PIPELINE_DATA: root }, encoding: "utf8", cwd: REPO,   // no PIPELINE_CONFIG_DIR
  });
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.findings.map((f: any) => f.check), []);
});

check("citation parser handles annotations, multiple paths per bracket, and non-citations", () => {
  assert.deepEqual(
    extractCitations("a [raw/x.md · fact] b [raw/y.md, accounts/z/evidence.md · inference · sensitive] c [not a path]"),
    ["raw/x.md", "raw/y.md", "accounts/z/evidence.md"],
  );
  assert.deepEqual(extractCitations("no citations here at all"), []);
  assert.deepEqual(extractCitations("[raw/a.md]\n[raw/b.md · hypothesis]"), ["raw/a.md", "raw/b.md"]);
});

check("exit codes and counts: 1 with errors, 0 when clean, 2 when the store is unusable", () => {
  assert.equal(all.code, 1, "errors present must exit 1");
  assert.equal(all.errors, all.findings.filter((f) => f.severity === "error").length);
  assert.equal(all.warnings, all.findings.filter((f) => f.severity === "warn").length);

  const clean = lint("--domain", "clean.example");
  assert.equal(clean.code, 0);
  assert.equal(clean.accounts, 1);
  assert.equal(clean.errors, 0);

  assert.equal(lint("--domain", "no-such-account.example").code, 2, "unknown domain must exit 2");

  const noStore = spawnSync(process.execPath, [LINT, "--json"], {
    env: { ...ENV, PIPELINE_DATA: join(root, "nope") }, encoding: "utf8", cwd: REPO,
  });
  assert.equal(noStore.status, 2, "missing store must exit 2");
  assert.match(noStore.stderr, /PIPELINE_DATA does not exist/);

  // an existing but empty data dir is also "no store", said plainly
  const emptyData = mkdtempSync(join(tmpdir(), "store-lint-emptydata-"));
  const empty = spawnSync(process.execPath, [LINT], { env: { ...ENV, PIPELINE_DATA: emptyData }, encoding: "utf8", cwd: REPO });
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /no accounts\/ directory/);
  rmSync(emptyData, { recursive: true, force: true });
});

check("--strict promotes warns to errors and flips the exit code", () => {
  const lenient = lint("--domain", "legacy.example");
  assert.equal(lenient.code, 0);
  assert.equal(lenient.errors, 0);
  assert.ok(lenient.warnings > 0);

  const strict = lint("--domain", "legacy.example", "--strict");
  assert.equal(strict.code, 1);
  assert.equal(strict.errors, lenient.warnings);
  assert.equal(strict.warnings, 0);
});

check("human output is one line per finding plus a summary", () => {
  const r = spawnSync(process.execPath, [LINT, "--domain", "badroute.example"], { env: ENV, encoding: "utf8", cwd: REPO });
  const lines = r.stdout.trim().split("\n");
  assert.match(lines[0], /^ERROR badroute\.example: /);
  assert.match(lines[lines.length - 1], /^1 account\(s\) linted — \d+ error\(s\), \d+ warn\(s\)$/);
});

check("the linter writes nothing into the store", () => {
  // A lint run must leave the fixture store byte-identical (no queue file, no repairs).
  const before = spawnSync("find", [root, "-type", "f"], { encoding: "utf8" }).stdout;
  lint();
  const after = spawnSync("find", [root, "-type", "f"], { encoding: "utf8" }).stdout;
  assert.equal(after, before);
});

rmSync(root, { recursive: true, force: true });
rmSync(cfg, { recursive: true, force: true });

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("store-lint test passed");
