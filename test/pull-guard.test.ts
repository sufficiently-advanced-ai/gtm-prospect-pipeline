// Offline test for lib/pull-guard.ts — the M1 pre-write dedupe guard.
// No network, no CRM key, no touch of the real $PIPELINE_DATA: a synthetic accounts/ tree is
// built in a temp dir and the CLI is invoked in a child process with PIPELINE_DATA pointed at
// it (lib/env.ts resolves PIPELINE_DATA and PIPELINE_CONFIG_DIR once at import, so the
// fixture config dir is exported BEFORE the guard is imported below).
//
// What is under test is the blind-stub-write class: a pull that calls an already-known
// domain "new". createAccountStub() refuses the write one domain at a time (test/smoke.ts
// covers that); this guard answers for the WHOLE pull before any write is attempted, and it
// must catch the alias shapes a string compare misses — mixed case and www/bare.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = join(REPO, "lib", "pull-guard.ts");

// Fixture config: the shipped template ships an EMPTY exclusion_bug_domains list, so the
// known-bug verdict is exercised against a fixture config instead.
const cfg = mkdtempSync(join(tmpdir(), "pull-guard-config-"));
writeFileSync(join(cfg, "signal.yaml"), `hiring-signal:\n  enabled: true\n  name: "Hiring Signal"\n  aliases: []\ndedupe:\n  exclusion_bug_domains: ["bug-example.invalid"]\nlimits: {}\n`);
process.env.PIPELINE_CONFIG_DIR = cfg;
const { exclusionBugDomains, normalizeDomain, bareForm, atsTenantKey, linkedinSlug } = await import("../lib/pull-guard.ts");

let failures = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e: any) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
};

// --- fixture store -----------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "pull-guard-"));
const account = (domain: string, yaml: string) => {
  mkdirSync(join(root, "accounts", domain), { recursive: true });
  writeFileSync(join(root, "accounts", domain, "account.yaml"), yaml);
};

account("knownactive.invalid", "domain: knownactive.invalid\nstatus: active\n");       // the incident's own class
account("mixedcase.invalid", "domain: mixedcase.invalid\nstatus: enrolled-paused\n");   // case-variant target
account("wwwvariant.invalid", "domain: wwwvariant.invalid\nstatus: routed\n");         // www/bare target
account("samelabel.invalid", "domain: samelabel.invalid\nstatus: enrolled-paused\n");   // near-miss base label
account("parentdom.invalid", "domain: parentdom.invalid\nstatus: skipped\n");          // near-miss parent domain
mkdirSync(join(root, "accounts", "nostatus.invalid"), { recursive: true });            // dir with no account.yaml

// --- rebrand / sibling-brand fixtures (`--pull`) ------------------------------------------
// Store side: an earlier raw pull vouches for three known accounts' identity keys, and one
// account carries linkedin_url in its account.yaml. ghost.invalid has a tenant in the raw file
// but NO accounts/ dir — it must not be indexed (only store accounts can be aliased).
account("oldbrand.invalid", "domain: oldbrand.invalid\nstatus: active\n");
account("gh-parent.invalid", "domain: gh-parent.invalid\nstatus: routed\n");
account("agg-parent.invalid", "domain: agg-parent.invalid\nstatus: skipped\n");
account("li-parent.invalid", "domain: li-parent.invalid\nstatus: enrolled-paused\nlinkedin_url: http://www.linkedin.com/company/li-parent-co\n");
mkdirSync(join(root, "raw", "theirstack"), { recursive: true });
const pullRow = (domain: string, linkedin_url: string | null, urls: string[]) => ({
  domain, linkedin_url, name: domain, id: `id-${domain}`,
  jobs_found: urls.map((url, i) => ({ id: i, job_title: "x", url, source_url: url, final_url: null })),
});
writeFileSync(join(root, "raw", "theirstack", "2026-08-17-hiring-signal-pull-1.json"), JSON.stringify({
  metadata: {},
  data: [
    pullRow("oldbrand.invalid", "https://www.linkedin.com/company/old-brand/", ["https://oldbrand.applytojob.com/apply/8izffXhJci/Manager"]),
    pullRow("gh-parent.invalid", "https://www.linkedin.com/company/gh-parent/", ["https://job-boards.greenhouse.io/ghparent/jobs/1", "https://www.linkedin.com/jobs/view/1/"]),
    pullRow("agg-parent.invalid", "https://www.linkedin.com/company/agg-parent/", ["https://www.linkedin.com/jobs/view/2/", "https://indeed.com/viewjob?jk=abc", "https://www.glassdoor.com/job-listing/x"]),
    pullRow("ghost.invalid", "https://www.linkedin.com/company/ghost/", ["https://job-boards.greenhouse.io/ghost/jobs/1"]),
  ],
}));
writeFileSync(join(root, "raw", "theirstack", "not-a-pull.json"), "{ this is not json");
// The pull under test — captured first (capture-first), so it lives in raw/ too and the guard
// must not let it vouch for itself.
const PULL = join(root, "raw", "theirstack", "2026-09-02-hiring-signal-pull-1.json");
writeFileSync(PULL, JSON.stringify({
  metadata: {},
  data: [
    pullRow("newbrand.invalid", "https://www.linkedin.com/company/new-brand/", ["https://oldbrand.applytojob.com/apply/Zz9/Buyer", "https://www.linkedin.com/jobs/view/9/"]),
    pullRow("gh-child.invalid", "https://www.linkedin.com/company/gh-child/", ["https://job-boards.greenhouse.io/ghparent/jobs/77"]),
    pullRow("li-child.invalid", "https://www.linkedin.com/company/li-parent-co/", ["https://www.linkedin.com/jobs/view/10/"]),
    pullRow("agg-child.invalid", "https://www.linkedin.com/company/agg-child/", ["https://www.linkedin.com/jobs/view/2/", "https://indeed.com/viewjob?jk=abc", "https://www.glassdoor.com/job-listing/x"]),
    pullRow("ghost-child.invalid", null, ["https://job-boards.greenhouse.io/ghost/jobs/2"]),
    pullRow("clean-new.invalid", "https://www.linkedin.com/company/clean-new/", ["https://cleannew.applytojob.com/apply/1/Role", "https://apply.workable.com/j/ABC123"]),
  ],
}));
// A second pull that returns an already-known account — EXISTS as ever, and its own tenant
// must not be reported as an alias of itself.
const PULL_KNOWN = join(root, "raw", "theirstack", "2026-09-02-hiring-signal-pull-2.json");
writeFileSync(PULL_KNOWN, JSON.stringify({
  metadata: {},
  data: [pullRow("oldbrand.invalid", "https://www.linkedin.com/company/old-brand/", ["https://oldbrand.applytojob.com/apply/8izffXhJci/Manager"])],
}));

// Read back through the config reader, so the test tracks the config instead of a literal.
const BUG_DOMAIN = [...exclusionBugDomains()][0];

type Run = { code: number; stdout: string; stderr: string; json?: any };
const guard = (args: string[], opts: { store?: string; input?: string } = {}): Run => {
  const r = spawnSync(process.execPath, [GUARD, ...args], {
    env: { ...process.env, PIPELINE_DATA: opts.store ?? root },
    input: opts.input ?? "", encoding: "utf8", cwd: REPO,
  });
  const out: Run = { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  if (args.includes("--json") && out.stdout.trim().startsWith("{")) out.json = JSON.parse(out.stdout);
  return out;
};
const verdictOf = (run: Run, domain: string) => run.json.checks.find((c: any) => c.domain === domain);

// Fingerprint the fixture store so we can prove the guard never wrote to it.
const fingerprint = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${p.slice(root.length)}:${statSync(p).size}:${statSync(p).mtimeMs}`);
    }
  };
  walk(dir);
  return out.sort();
};
const before = fingerprint(root);

// --- cases -------------------------------------------------------------------
check("normalizeDomain strips scheme/path/port/case; bareForm strips www.", () => {
  assert.equal(normalizeDomain("HTTPS://WWW.Acme.COM/careers?x=1"), "www.acme.com");
  assert.equal(normalizeDomain(" Acme.Com. "), "acme.com");
  assert.equal(normalizeDomain("acme.com:8443"), "acme.com");
  assert.equal(bareForm("www.acme.com"), "acme.com");
});

check("all-new pull exits 0 and says so", () => {
  const r = guard(["--json", "brand-new-one.invalid", "brand-new-two.invalid"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.new, 2);
  assert.equal(r.json.blocked, 0);
  const human = guard(["brand-new-one.invalid"]);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /OK — all 1 domain\(s\) are new/);
  assert.match(human.stdout, /createAccountStub\(\)/, "must still point at the last line of defense");
});

check("a domain already in the store exits 1 and names its status", () => {
  const r = guard(["--json", "knownactive.invalid", "brand-new.invalid"]);
  assert.equal(r.code, 1, "any overlap must exit 1");
  const hit = verdictOf(r, "knownactive.invalid");
  assert.equal(hit.verdict, "EXISTS");
  assert.equal(hit.status, "active", "the operator needs the status to judge the damage");
  assert.equal(hit.match, "knownactive.invalid");
  assert.equal(verdictOf(r, "brand-new.invalid").verdict, "NEW", "one bad domain must not taint the rest");

  const human = guard(["knownactive.invalid"]);
  assert.match(human.stdout, /STOP/);
  assert.match(human.stdout, /is not evidence/, "the summary must say WHY the pull's novelty claim cannot be trusted");
  assert.match(human.stdout, /blind stub write destroys mid-sequence accounts/);
  assert.match(human.stdout, /count them as repeats, never/);
  assert.match(human.stdout, /status: active/);
});

check("case variants are caught — the mixed-case class", () => {
  const r = guard(["--json", "MixedCase.INVALID"]);
  assert.equal(r.code, 1);
  const hit = verdictOf(r, "mixedcase.invalid");
  assert.equal(hit.verdict, "EXISTS");
  assert.equal(hit.status, "enrolled-paused");
  assert.ok(hit.warnings.some((w: string) => /case-normalized/.test(w)), hit.warnings.join(" | "));
});

check("www./bare variants are caught in both directions", () => {
  const withWww = guard(["--json", "www.wwwvariant.invalid"]);
  assert.equal(withWww.code, 1);
  const hit = verdictOf(withWww, "www.wwwvariant.invalid");
  assert.equal(hit.verdict, "EXISTS");
  assert.equal(hit.match, "wwwvariant.invalid");
  assert.ok(hit.warnings.some((w: string) => /www\/bare/.test(w)), hit.warnings.join(" | "));

  // and a store dir that itself carries www.
  const wwwStore = mkdtempSync(join(tmpdir(), "pull-guard-www-"));
  mkdirSync(join(wwwStore, "accounts", "www.acme.invalid"), { recursive: true });
  writeFileSync(join(wwwStore, "accounts", "www.acme.invalid", "account.yaml"), "domain: www.acme.invalid\nstatus: routed\n");
  const bare = guard(["--json", "acme.invalid"], { store: wwwStore });
  assert.equal(bare.code, 1);
  assert.equal(verdictOf(bare, "acme.invalid").match, "www.acme.invalid");
  rmSync(wwwStore, { recursive: true, force: true });
});

check("exclusion_bug_domains from config are flagged and exit 1", () => {
  assert.equal(BUG_DOMAIN, "bug-example.invalid", "read from the fixture config via PIPELINE_CONFIG_DIR");
  const r = guard(["--json", BUG_DOMAIN]);
  assert.equal(r.code, 1);
  const hit = verdictOf(r, BUG_DOMAIN);
  assert.equal(hit.verdict, "EXCLUSION_BUG");
  assert.match(hit.reason, /exclusion_bug_domains/);
  assert.match(guard([BUG_DOMAIN]).stdout, /known exclusion-bug/);
});

check("near-misses are advisory warnings, never verdicts", () => {
  // samelabel.invalid is in the store; samelabel.example is a DIFFERENT registrable domain
  // (the acme.info/acme.com class) — flagged for a human, but still NEW and still exit 0.
  const r = guard(["--json", "samelabel.example", "tech.parentdom.invalid"]);
  assert.equal(r.code, 0, "warnings must not block a pull");
  const tld = verdictOf(r, "samelabel.example");
  assert.equal(tld.verdict, "NEW");
  assert.ok(tld.warnings.some((w: string) => /same base label, different TLD/.test(w)), tld.warnings.join(" | "));
  const sub = verdictOf(r, "tech.parentdom.invalid");
  assert.equal(sub.verdict, "NEW");
  assert.ok(sub.warnings.some((w: string) => /subdomain/.test(w)), sub.warnings.join(" | "));
});

check("an account dir without account.yaml still counts as EXISTS", () => {
  const r = guard(["--json", "nostatus.invalid"]);
  assert.equal(r.code, 1, "a half-built account is still not new");
  assert.match(verdictOf(r, "nostatus.invalid").status, /no account\.yaml/);
});

check("domains arrive on stdin, one per line", () => {
  const r = guard(["--json"], { input: "brand-new.invalid\nknownactive.invalid\n" });
  assert.equal(r.code, 1);
  assert.equal(r.json.checked, 2);
  assert.equal(r.json.exists, 1);
});

check("empty input is handled — nothing to check, exit 0", () => {
  const r = guard([], { input: "" });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no domains given/);
  const j = guard(["--json"], { input: "   \n\n" });
  assert.equal(j.code, 0);
  assert.equal(j.json.checked, 0);
});

check("malformed input is INVALID, never NEW", () => {
  const r = guard(["--json", "../../etc/passwd", "not a domain", "localhost"]);
  assert.equal(r.code, 1, "a malformed pull list must stop the run, not be waved through");
  assert.equal(r.json.new, 0);
  assert.equal(r.json.invalid, 3);
});

check("an unreadable store exits 2 rather than answering 'all new'", () => {
  const r = guard(["--json", "anything.invalid"], { store: join(root, "does-not-exist") });
  assert.equal(r.code, 2);
});

// --- rebrand / sibling-brand aliases (--pull) --------------------------------
check("alias keys: LinkedIn slug and ATS tenant extraction; aggregators and shared hosts yield nothing", () => {
  assert.equal(linkedinSlug("https://www.linkedin.com/company/Old-Brand/"), "old-brand");
  assert.equal(linkedinSlug("http://www.linkedin.com/company/acme-inc-"), "acme-inc-");
  assert.equal(linkedinSlug("https://www.linkedin.com/jobs/view/123/"), undefined);
  assert.equal(linkedinSlug(null), undefined);
  assert.equal(atsTenantKey("https://oldbrand.applytojob.com/apply/x/Role"), "oldbrand.applytojob.com");
  assert.equal(atsTenantKey("https://acme.wd5.myworkdayjobs.com/en-US/Acme/job/x"), "acme.wd5.myworkdayjobs.com");
  assert.equal(atsTenantKey("https://careers-acme.icims.com/jobs/14080/x"), "careers-acme.icims.com");
  assert.equal(atsTenantKey("https://job-boards.greenhouse.io/acmeco/jobs/4"), "job-boards.greenhouse.io/acmeco");
  assert.equal(atsTenantKey("https://jobs.lever.co/acme/uuid"), "jobs.lever.co/acme");
  assert.equal(atsTenantKey("https://apply.workable.com/acmelabs/j/ABC/"), "apply.workable.com/acmelabs");
  assert.equal(atsTenantKey("https://apply.workable.com/j/443C1E1AEE"), undefined, "/j/<id> is not a tenant");
  assert.equal(atsTenantKey("https://recruiting.ultipro.com/ACM1000ACMES/JobBoard/x"), "recruiting.ultipro.com/acm1000acmes");
  assert.equal(atsTenantKey("https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?ccId=1&cid=ABC-123&jobId=5"), "workforcenow.adp.com/cid=abc-123");
  for (const agg of [
    "https://www.linkedin.com/jobs/view/1/", "https://indeed.com/viewjob?jk=1", "https://www.glassdoor.co.uk/job/x",
    "https://www.ziprecruiter.com/c/x", "https://www.adzuna.com.au/x", "https://jooble.org/x", "https://www.google.com/x",
  ]) assert.equal(atsTenantKey(agg), undefined, agg);
  assert.equal(atsTenantKey("https://recruiting.paylocity.com/recruiting/jobs/Details/1"), undefined, "shared host, no tenant in URL");
  assert.equal(atsTenantKey("https://jobs.workable.com/view/abc"), undefined, "the ATS's shared board is not a tenant");
  assert.equal(atsTenantKey("https://jobs.dayforcehcm.com/en-US/x/CANDIDATEPORTAL/jobs/1"), undefined);
  assert.equal(atsTenantKey("not a url"), undefined);
});

check("--pull: rebrand/sibling-brand aliases are ALIAS? warnings, verdict stays NEW, exit 0", () => {
  const r = guard(["--json", "--pull", PULL]);
  assert.equal(r.code, 0, `alias warnings must never block: ${r.stdout}${r.stderr}`);
  assert.deepEqual(r.json.pulls, [PULL]);
  const alias = (domain: string) => verdictOf(r, domain).warnings.filter((w: string) => w.startsWith("ALIAS?"));

  // (a) applytojob tenant-subdomain: a rebrand posting through the old brand's ATS tenant
  const nb = verdictOf(r, "newbrand.invalid");
  assert.equal(nb.verdict, "NEW");
  assert.equal(alias("newbrand.invalid").length, 1, nb.warnings.join(" | "));
  assert.equal(
    alias("newbrand.invalid")[0],
    'ALIAS? newbrand.invalid shares ATS tenant "oldbrand.applytojob.com" with oldbrand.invalid (status active) — rebrand/sibling-brand class; never a separate account',
  );

  // (b) greenhouse path-tenant
  assert.equal(verdictOf(r, "gh-child.invalid").verdict, "NEW");
  assert.deepEqual(alias("gh-child.invalid"), [
    'ALIAS? gh-child.invalid shares ATS tenant "job-boards.greenhouse.io/ghparent" with gh-parent.invalid (status routed) — rebrand/sibling-brand class; never a separate account',
  ]);

  // (c) LinkedIn slug, store side sourced from account.yaml linkedin_url
  assert.equal(verdictOf(r, "li-child.invalid").verdict, "NEW");
  assert.deepEqual(alias("li-child.invalid"), [
    'ALIAS? li-child.invalid shares linkedin slug "li-parent-co" with li-parent.invalid (status enrolled-paused) — rebrand/sibling-brand class; never a separate account',
  ]);

  // (d) aggregator hosts carry no identity — same linkedin/indeed/glassdoor job URLs must NOT match
  assert.equal(verdictOf(r, "agg-child.invalid").verdict, "NEW");
  assert.deepEqual(alias("agg-child.invalid"), []);

  // (e) a tenant seen in raw/ for a domain that has no accounts/ dir is not store identity
  assert.deepEqual(alias("ghost-child.invalid"), []);

  // (f) a clean new domain: NEW, no ALIAS? at all
  const clean = verdictOf(r, "clean-new.invalid");
  assert.equal(clean.verdict, "NEW");
  assert.deepEqual(clean.warnings, []);

  // (g) a known domain in a pull is EXISTS as ever (exit 1), and never aliased to itself
  const k = guard(["--json", "--pull", PULL_KNOWN]);
  assert.equal(k.code, 1);
  const known = verdictOf(k, "oldbrand.invalid");
  assert.equal(known.verdict, "EXISTS");
  assert.deepEqual(known.warnings.filter((w: string) => w.startsWith("ALIAS?")), []);

  // Human output carries the ALIAS? line verbatim under the domain, and still says OK for the new ones.
  const human = guard(["--pull", PULL]);
  assert.match(human.stdout, /alias keys from 1 pull file\(s\)/);
  assert.match(human.stdout, /WARN ALIAS\? newbrand\.invalid shares ATS tenant "oldbrand\.applytojob\.com" with oldbrand\.invalid/);
});

check("--pull adds to explicit domains rather than replacing them; --pull without a file exits 2", () => {
  const r = guard(["--json", "--pull", PULL, "brand-new.invalid"]);
  assert.equal(r.json.checked, 7, "6 pull rows + 1 explicit domain");
  const two = guard(["--json", "--pull", PULL, "--pull", PULL_KNOWN]);
  assert.equal(two.json.checked, 7, "--pull may be given more than once");
  assert.equal(two.json.exists, 1);
  assert.equal(verdictOf(r, "brand-new.invalid").verdict, "NEW");
  assert.equal(guard(["--json", "--pull"]).code, 2);
  assert.equal(guard(["--json", "--pull", join(root, "nope.json")]).code, 2);
});

check("the store is never written", () => {
  assert.deepEqual(fingerprint(root), before, "$PIPELINE_DATA must be read-only for the guard");
});

rmSync(root, { recursive: true, force: true });
rmSync(cfg, { recursive: true, force: true });

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("pull-guard test passed");
