// Offline tests for evals/draft-fixture.ts — the failure→fixture scaffolder.
// No network, no model calls, no real store: a synthetic account + raw tree is built in a
// temp dir and the CLI is invoked in a child process with PIPELINE_DATA pointed at it
// (lib/env.ts resolves PIPELINE_DATA once at import, so an in-process override would be
// read too late). The drop-class vocabulary comes from a test ICP via EVAL_ICP_FILE, so the
// assertions never depend on the operator's config/icp.md.
// Run: npm test (or node test/draft-fixture.test.ts)
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

const REPO = join(import.meta.dirname, "..");
const SCRIPT = join(REPO, "evals", "draft-fixture.ts");
// Tests stage into a throwaway temp dir via EVAL_STAGING_DIR — never the live
// evals/fixtures/staging/ tree a promotion `git mv` reads from (a crash between create and
// cleanup would otherwise strand invalid drafts in live staging).
const STAGING = mkdtempSync(join(tmpdir(), "draft-fixture-staging-"));

// Test drafts are namespaced so they can never collide with (or delete) real staged work.
const TEST_ID_RE = /^(?:[a-z_]+_)?zz[a-z]+_invalid$/;
const cleanupStaging = () => {
  if (!existsSync(STAGING)) return;
  for (const d of readdirSync(STAGING)) if (TEST_ID_RE.test(d)) rmSync(join(STAGING, d), { recursive: true, force: true });
};

let failures = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e: any) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
};

// ---------------------------------------------------------------------------
// Synthetic store: one rich account (every task applies) + one oversize account.
// ---------------------------------------------------------------------------
const STORE = mkdtempSync(join(tmpdir(), "draft-fixture-store-"));
const w = (rel: string, body: string) => {
  const p = join(STORE, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
};

// The test's own ICP: three classes the guesser can match against evidence notes.
const ICP = join(STORE, "icp.md");
writeFileSync(ICP, `# ICP

## Drop classes

- vendor_of_the_capability — the company sells, builds, or resells the thing we provide
- staffing_or_agency — staffing, recruiting, outsourcing, or a services agency
- out_of_band_size — headcount or revenue outside the size band
`);

const D = "zzselftest.invalid";
const BIG = "zzbig.invalid";

w(`accounts/${D}/account.yaml`, YAML.stringify({
  domain: D,
  company: "ZZ Selftest Co",
  status: "enrolled-paused",
  route: "QUALIFIED",
  signal_source: "Hiring Signal",
  verification: "SALES_NAV",
  triaged_at: "2026-01-02",
  routed_at: "2026-01-03",
  evidence_note: "Absence confirmed (corrected 2026-01-04 after review). Operating company.",
  contacts: [{ name: "Ann Example", title: "CEO", email: "ann@zzselftest.invalid", apollo_contact_id: "aaaaaaaaaaaaaaaaaaaaaaaa" }],
  raw_pointers: [
    "raw/theirstack/2026-01-01-pull-1.json",
    `raw/postings/${D}/2026-01-01-planner.md`,
    `raw/firecrawl/${D}/2026-01-01-homepage.md`,
    `raw/firecrawl/${D}/2026-01-01-team.md`,
    `raw/apollo/${D}/2026-01-01-people.json`,
    `raw/salesnav/${D}/2026-01-01-notes.md`,
    "raw/postings/zzselftest.invalid/2026-01-01-does-not-exist.md",
  ],
}));
w(`accounts/${D}/evidence.md`, "# Evidence — ZZ Selftest Co\n\nAnn Example is CEO [firecrawl-team.md · fact]\n");

// TheirStack: two companies + a padded one. Only OUR company block may be staged.
w("raw/theirstack/2026-01-01-pull-1.json", JSON.stringify({
  metadata: { total_results: 3 },
  data: [
    { domain: "other-company.invalid", name: "Other Co", apollo_id: "bbbbbbbbbbbbbbbbbbbbbbbb", long_description: "X".repeat(80_000), jobs_found: [] },
    {
      domain: D, name: "ZZ Selftest Co", employee_count: 42, industry: "Widget Manufacturing",
      apollo_id: "cccccccccccccccccccccccc",
      jobs_found: [{
        id: 1, job_title: "Planner", date_posted: "2026-01-01",
        matching_phrases: ["- Actively use automation tools for planning analysis"],
      }],
    },
    { domain: "third-company.invalid", name: "Third Co", jobs_found: [] },
  ],
}));

w(`raw/postings/${D}/2026-01-01-planner.md`, `# Source: WebFetch capture
# Captured: 2026-01-01 (M2, hiring-signal batch)

**Location:** Nowhere, XX

## Requirements

> "Actively use automation tools for planning analysis"

Contact the hiring manager at jobs@zzselftest.invalid or (555) 867-5309.

## Assessment

Structurally close to the known false-positive pattern. Provisional route QUALIFIED.
`);

w(`raw/firecrawl/${D}/2026-01-01-homepage.md`, `# ZZ Selftest Co

We manufacture widgets. Reach us at hello@zzselftest.invalid or +15558675309.
Asset: https://cdn.example.invalid/dddddddddddddddddddddddd/logo.png
`);
w(`raw/firecrawl/${D}/2026-01-01-team.md`, "# Team\n\nAnn Example — CEO\nBob Example — Director of Engineering\n");

const person = (title: string) => ({
  id: "eeeeeeeeeeeeeeeeeeeeeeee", first_name: "Bob", last_name: "Example", title,
  seniority: "director", last_refreshed_at: "2026-01-01T00:00:00Z",
  email: "bob@zzselftest.invalid", sanitized_phone: "+15558675309",
  employment_history: [{ organization_name: "Old Co" }],
  organization: { id: "ffffffffffffffffffffffff", name: "ZZ Selftest Co", domain: D, phone: "555-867-5309" },
});
w(`raw/apollo/${D}/2026-01-01-people.json`, JSON.stringify({
  _query: { tool: "apollo_mixed_people_api_search", captured_at: "2026-01-01" },
  _note: "One director, nothing above — verify.",
  tech_titles_found: ["Director of Engineering (Bob Example)"],
  total_entries: 1, people: [person("Director of Engineering")],
}));

w(`raw/salesnav/${D}/2026-01-01-notes.md`, `# Sales Navigator pass — ${D} — 2026-01-01

## Findings
- **Ann Example** — CEO, 10y tenure.
- **Bob Example** — Director of Engineering, 3y tenure.
- No CTO, no CIO, no titled owner of the function in the 20-profile sweep.

## Absence claims
- No titled owner: CONFIRMED genuine zero — tech leadership tops out at Director.

## Verdict
Absence confirmed; route: QUALIFIED.
`);

w("queue/salesnav-pending.md", `# Sales Navigator pending

## 2026-01-01 batch
- ${D} (ZZ Selftest Co, 42 emp) — sweep returned 1 director. Absence claims to confirm: no
  titled owner of the function, no CTO/CIO.
- other-company.invalid (Other Co) — nothing to confirm.
`);

// Oversize account: a homepage no mechanical trim can shrink under the 50KB cap. Dropped,
// with the drop reason only in prose — the guesser has to match it to a class.
w(`accounts/${BIG}/account.yaml`, YAML.stringify({
  domain: BIG, company: "ZZ Big Co", status: "dropped",
  evidence_note: "Dropped: IT staffing agency, not an operating company.",
  raw_pointers: ["raw/theirstack/2026-01-01-big.json", `raw/firecrawl/${BIG}/2026-01-01-homepage.md`],
}));
w("raw/theirstack/2026-01-01-big.json", JSON.stringify({ metadata: {}, data: [{ domain: BIG, name: "ZZ Big Co", employee_count: 900 }] }));
w(`raw/firecrawl/${BIG}/2026-01-01-homepage.md`, "# ZZ Big Co\n\n" + "We staff IT contractors. ".repeat(2600));

// ---------------------------------------------------------------------------
// CLI driver
// ---------------------------------------------------------------------------
type Run = { status: number; stdout: string; stderr: string };
const run = (...args: string[]): Run => {
  try {
    const stdout = execFileSync("node", [SCRIPT, ...args], {
      env: { ...process.env, PIPELINE_DATA: STORE, EVAL_STAGING_DIR: STAGING, EVAL_ICP_FILE: ICP }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e: any) {
    return { status: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
};

const stagedDir = (id: string) => join(STAGING, id);
const fixtureOf = (id: string) => YAML.parse(readFileSync(join(stagedDir(id), "fixture.yaml"), "utf8"));
const sidecarOf = (id: string) => readFileSync(join(stagedDir(id), ".review.md"), "utf8");
const inputText = (id: string, file: string) => readFileSync(join(stagedDir(id), "inputs", file), "utf8");
const allStagedBytes = (id: string) => {
  const dir = join(stagedDir(id), "inputs");
  return readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
};

// Fingerprint the synthetic store so we can prove the scaffolder never wrote to it.
const fingerprint = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${p.slice(STORE.length)}:${statSync(p).size}:${statSync(p).mtimeMs}`);
    }
  };
  walk(dir);
  return out.sort();
};

cleanupStaging();
const before = fingerprint(STORE);
const main = run(D);
const big = run(BIG);

// ---------------------------------------------------------------------------
check("scaffolds every task the captures support, one staging dir each", () => {
  assert.equal(main.status, 0, main.stderr);
  assert.match(main.stdout, /tasks: salesnav-verdict, route, fit-triage, evidence-synthesis/);
  for (const t of ["salesnav_verdict", "route", "fit_triage", "evidence_synthesis"])
    assert.ok(existsSync(stagedDir(`${t}_zzselftest_invalid`)), `missing staging dir for ${t}`);
  // A raw_pointer whose capture is gone is reported, never silently dropped.
  assert.match(main.stdout, /missing capture, skipped: raw\/postings\/zzselftest\.invalid\/2026-01-01-does-not-exist\.md/);
});

check("fixture.yaml is schema-correct and parses", () => {
  for (const d of readdirSync(STAGING).filter((x) => TEST_ID_RE.test(x))) {
    const f = fixtureOf(d);
    assert.equal(f.id, d, `${d}: id must equal dir name`);
    assert.match(f.id, /^[a-z0-9_]+$/, `${d}: id charset`);
    assert.equal(f.version, 1);
    assert.ok(f.description.startsWith("TODO"), `${d}: description must be a TODO`);
    assert.ok(f.provenance.domain, `${d}: provenance.domain`);
    assert.match(f.provenance.source, /^TODO/, `${d}: provenance.source must be a TODO`);
    assert.ok(Array.isArray(f.inputs) && f.inputs.every((i: any) => i.path.startsWith("inputs/") && i.role));
    assert.deepEqual(f.forbidden, [], `${d}: forbidden must be an empty list for the human to fill`);
    assert.ok(f.notes && f.notes.length > 0, `${d}: notes must explain every prefill`);
    assert.ok(f.gold || f.rubric, `${d}: needs gold or (evidence-synthesis) rubric`);
    for (const i of f.inputs) assert.ok(existsSync(join(stagedDir(d), i.path)), `${d}: ${i.path} listed but not written`);
  }
});

check("gold is pre-filled from the corrected account.yaml, judgment left to the reviewer", () => {
  assert.deepEqual(fixtureOf("route_zzselftest_invalid").gold, { route: "QUALIFIED", evidence_names: [] });
  assert.deepEqual(fixtureOf("salesnav_verdict_zzselftest_invalid").gold, { verdict: "confirm", evidence_names: [] });
  // a keep carries no drop_class
  assert.deepEqual(fixtureOf("fit_triage_zzselftest_invalid").gold, { decision: "keep" });
  // evidence-synthesis is rubric-scored: rubric replaces gold.
  const ev = fixtureOf("evidence_synthesis_zzselftest_invalid");
  assert.equal(ev.gold, undefined);
  assert.ok(ev.rubric.must.length && ev.rubric.should.length);
  // the incident date is lifted from the correction recorded in evidence_note, not routed_at
  assert.equal(String(fixtureOf("route_zzselftest_invalid").provenance.incident_date), "2026-01-04");
});

check("fit-triage on a dropped account guesses the drop class from icp.md and says it guessed", () => {
  const f = fixtureOf("fit_triage_zzbig_invalid");
  assert.equal(big.status, 0, big.stderr);
  assert.equal(f.gold.decision, "drop");
  assert.equal(f.gold.drop_class, "staffing_or_agency", "the class whose slug words match the note");
  assert.match(f.notes, /GUESSED/);
});

check("a recorded account.drop_class is used as-is, and a SKIP route infers flip_to_skip", () => {
  const REC = "zzrecorded.invalid";
  w(`accounts/${REC}/account.yaml`, YAML.stringify({
    domain: REC, company: "ZZ Recorded Co", status: "dropped", route: "DROPPED", drop_class: "out_of_band_size",
    evidence_note: "Dropped: staffing shop.", // would guess staffing — the recorded class must win
    raw_pointers: ["raw/theirstack/2026-01-01-rec.json", `raw/firecrawl/${REC}/2026-01-01-homepage.md`],
  }));
  w("raw/theirstack/2026-01-01-rec.json", JSON.stringify({ metadata: {}, data: [{ domain: REC, name: "ZZ Recorded Co", employee_count: 9000 }] }));
  w(`raw/firecrawl/${REC}/2026-01-01-homepage.md`, "# ZZ Recorded Co\n\nWe are large.\n");
  const r = run(REC, "--task", "fit-triage");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fixtureOf("fit_triage_zzrecorded_invalid").gold.drop_class, "out_of_band_size");
  assert.match(fixtureOf("fit_triage_zzrecorded_invalid").notes, /account\.drop_class/);

  const SK = "zzskipped.invalid";
  w(`accounts/${SK}/account.yaml`, YAML.stringify({
    domain: SK, company: "ZZ Skipped Co", status: "skipped", route: "SKIP", skip_reason: "titled owner in seat",
    raw_pointers: [`raw/salesnav/${SK}/2026-01-01-notes.md`],
  }));
  w(`raw/salesnav/${SK}/2026-01-01-notes.md`, "# Sales Navigator pass\n\n## Findings\n- **Cara Example** — VP of Automation, 2y.\n");
  const s = run(SK, "--task", "salesnav-verdict");
  assert.equal(s.status, 0, s.stderr);
  assert.equal(fixtureOf("salesnav_verdict_zzskipped_invalid").gold.verdict, "flip_to_skip");
});

check("no email, phone, or 24-hex id survives anywhere in staged inputs", () => {
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const HEX24 = /\b[0-9a-f]{24}\b/;
  const PHONE = /\+\d{10,15}\b|\(?\b\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}\b/;
  for (const d of readdirSync(STAGING).filter((x) => TEST_ID_RE.test(x))) {
    const text = allStagedBytes(d);
    assert.ok(!EMAIL.test(text), `${d}: email survived: ${text.match(EMAIL)?.[0]}`);
    assert.ok(!HEX24.test(text), `${d}: 24-hex id survived: ${text.match(HEX24)?.[0]}`);
    assert.ok(!PHONE.test(text), `${d}: phone survived: ${text.match(PHONE)?.[0]}`);
    assert.ok(text.trim().length > 0, `${d}: staged nothing at all`);
  }
});

check("Apollo JSON keeps name/title/seniority/last_refreshed + org names, drops the rest", () => {
  const sweep = JSON.parse(inputText("route_zzselftest_invalid", "apollo-sweep.json"));
  const p = sweep.people[0];
  assert.deepEqual(Object.keys(p).sort(), ["first_name", "last_name", "last_refreshed_at", "organization", "seniority", "title"]);
  assert.deepEqual(Object.keys(p.organization).sort(), ["domain", "name"]);
  assert.equal(p.title, "Director of Engineering");
  assert.equal(sweep.total_entries, 1);
  assert.ok(sweep._query, "capture provenance (_query) is kept");
  assert.equal(sweep._note, undefined, "analyst annotation must be dropped");
  assert.deepEqual(sweep.tech_titles_found, ["Director of Engineering (Bob Example)"], "names+titles are evidence, not annotation");
  assert.match(sidecarOf("route_zzselftest_invalid"), /dropped JSON keys:.*_note/);
});

check("TheirStack payload is cut to this domain's company block only", () => {
  const ts = JSON.parse(inputText("fit_triage_zzselftest_invalid", "theirstack-company.json"));
  assert.equal(ts.data.length, 1);
  assert.equal(ts.data[0].domain, "zzselftest.invalid");
  assert.equal(ts.data[0].apollo_id, undefined);
  const raw = inputText("fit_triage_zzselftest_invalid", "theirstack-company.json");
  assert.ok(!raw.includes("other-company.invalid") && !raw.includes("third-company.invalid"), "other companies must not be copied");
  assert.ok(raw.length < 4096, `whole-pull padding leaked (${raw.length} B)`);
});

check("conclusions are stripped from analyst markdown; findings stay", () => {
  const sn = inputText("salesnav_verdict_zzselftest_invalid", "salesnav-notes.md");
  assert.ok(!/## Verdict/.test(sn), "## Verdict section must be gone");
  assert.ok(!/route: QUALIFIED/.test(sn), "route verdict must be gone");
  assert.match(sn, /No CTO, no CIO, no titled owner/, "findings must survive");
  assert.match(sn, /\*\*Ann Example\*\* — CEO/, "named execs must survive");

  const jd = inputText("fit_triage_zzselftest_invalid", "posting.md");
  assert.ok(!/## Assessment/.test(jd) && !/Provisional route/.test(jd), "posting Assessment section must be gone");
  assert.match(jd, /Actively use automation tools/, "the matching phrase must survive");
  assert.match(jd, /# Captured: 2026-01-01 \(M2, hiring-signal batch\)/, "the capture header must survive");

  // every deletion is listed for the reviewer, and survivors that hint at the answer are flagged
  const side = sidecarOf("salesnav_verdict_zzselftest_invalid");
  assert.match(side, /section: ## Verdict/);
  assert.match(side, /REVIEW \(survived stripping\).*genuine zero/);
});

check("checklist role is extracted as the per-domain bullet only", () => {
  const cl = inputText("salesnav_verdict_zzselftest_invalid", "checklist.md");
  assert.match(cl, /Absence claims to confirm/);
  assert.ok(!cl.includes("other-company.invalid"), "other domains' bullets must not be copied");
});

check("oversize input is excluded, never truncated, and raised as a manual TODO", () => {
  const f = fixtureOf("fit_triage_zzbig_invalid");
  assert.ok(!f.inputs.some((i: any) => i.role === "homepage"), "oversize homepage must not be listed as an input");
  assert.ok(!existsSync(join(stagedDir("fit_triage_zzbig_invalid"), "inputs", "homepage.md")), "oversize file must not be written");
  assert.match(sidecarOf("fit_triage_zzbig_invalid"), /Manual-trim TODOs[\s\S]*homepage/);
  assert.match(big.stdout, /manual-trim TODO/);
  for (const d of readdirSync(STAGING).filter((x) => TEST_ID_RE.test(x))) {
    let total = 0;
    for (const i of fixtureOf(d).inputs) {
      const n = statSync(join(stagedDir(d), i.path)).size;
      assert.ok(n <= 50 * 1024, `${d}/${i.path} is ${n} B (cap 50KB)`);
      total += n;
    }
    assert.ok(total <= 200 * 1024, `${d} totals ${total} B (cap 200KB)`);
  }
});

check("missing required roles are BLOCKERs, not silent gaps", () => {
  // zzbig has no Apollo sweep capture, so route cannot be scaffolded from it.
  const r = run(BIG, "--task", "route", "--id", "route_zzbig_invalid");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /BLOCKER/);
  assert.match(r.stdout, /apollo_sweep/);
  assert.match(fixtureOf("route_zzbig_invalid").notes, /BLOCKERS:/);
});

check("refuses to overwrite an existing staging dir without --force", () => {
  const marker = join(stagedDir("route_zzselftest_invalid"), "inputs", "HUMAN-EDIT.md");
  writeFileSync(marker, "hand-written gold calibration\n");
  const again = run(D, "--task", "route");
  assert.equal(again.status, 1, "must exit 1");
  assert.match(again.stderr + again.stdout, /already exists/);
  assert.ok(existsSync(marker), "human work must be untouched");

  const forced = run(D, "--task", "route", "--force");
  assert.equal(forced.status, 0, forced.stderr);
  assert.ok(!existsSync(marker), "--force replaces the dir");
});

check("refuses ids that would escape staging, and ambiguous --id", () => {
  const bad = run(D, "--task", "route", "--id", "../../evil");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr + bad.stdout, /id must match/);
  assert.ok(!existsSync(join(REPO, "evals", "fixtures", "evil")), "nothing may be written outside staging/");

  const ambiguous = run(D, "--id", "some_id");
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /ambiguous/);
});

check("rejects unknown tasks and unknown domains", () => {
  assert.equal(run(D, "--task", "not-a-task").status, 1);
  assert.match(run("nope.invalid").stderr, /no account\.yaml/);
});

check("the store is never written", () => {
  // The two accounts added mid-test are the only difference from the initial fingerprint.
  const after = fingerprint(STORE).filter((l) => !/zzrecorded|zzskipped|-rec\.json/.test(l));
  assert.deepEqual(after, before, "$PIPELINE_DATA must be read-only for evals/");
});

check("evidence-synthesis stages the raw set and parks the historical output outside inputs/", () => {
  const dir = stagedDir("evidence_synthesis_zzselftest_invalid");
  const roles = fixtureOf("evidence_synthesis_zzselftest_invalid").inputs.map((i: any) => i.role);
  assert.ok(roles.includes("posting") && roles.includes("salesnav") && roles.some((r: string) => r.startsWith("firecrawl_")));
  assert.ok(!existsSync(join(dir, "inputs", "REFERENCE-evidence.md")), "the expected OUTPUT is not an input");
  assert.match(readFileSync(join(dir, "REFERENCE-evidence.md"), "utf8"), /HISTORICAL OUTPUT, not a fixture input/);
  assert.match(sidecarOf("evidence_synthesis_zzselftest_invalid"), /delete it\*\* before moving/);
});

// ---------------------------------------------------------------------------
// Regressions — bugs the scaffolder has hit on real captures, each reproduced in the
// shape it occurred.
// ---------------------------------------------------------------------------
const ESC = "zzescape.invalid";     // JSON escape eaten by the email redactor
const SCR = "zzscraped.invalid";    // scraped capture leaking the verdict + _capture_note
const CLA = "zzclause.invalid";     // finding + verdict in ONE sentence
const JOB = "zzjobs.invalid";       // TheirStack capture keyed `jobs`, not `data`

w(`accounts/${ESC}/account.yaml`, YAML.stringify({
  domain: ESC, company: "ZZ Escape Co", status: "triaged",
  evidence_note: "Operating company.",
  raw_pointers: ["raw/theirstack/2026-01-01-escapes.json"],
}));
// An escaped newline immediately followed by an email. JSON.stringify turns the real newline
// below into the `\n` escape on disk.
w("raw/theirstack/2026-01-01-escapes.json", JSON.stringify({
  metadata: {},
  data: [{
    domain: ESC, name: "ZZ Escape Co", employee_count: 30,
    long_description: "Get in contact with a ZZ Escape professional:\ncontact@zzescape.invalid to schedule a tour.",
  }],
}));

w(`accounts/${SCR}/account.yaml`, YAML.stringify({
  domain: SCR, company: "ZZ Scraped Co", status: "triaged",
  evidence_note: "Operating company.",
  raw_pointers: ["raw/theirstack/2026-01-01-scraped.json", `raw/firecrawl/${SCR}/2026-01-01-homepage.md`],
}));
w("raw/theirstack/2026-01-01-scraped.json", JSON.stringify({
  _capture_note: "BOTH matches name the vendor as a CLIENT, not adoption — false positive class.",
  metadata: {},
  data: [{ domain: SCR, name: "ZZ Scraped Co", employee_count: 55, _note: "same JD, second location" }],
}));
// A summarized homepage: not analyst-authored, and yet it answers the triage taxonomy, ends
// on a verdict, and states a conclusion entangled with named evidence.
w(`raw/firecrawl/${SCR}/2026-01-01-homepage.md`, `# Source: WebFetch capture, https://${SCR}
# Captured: 2026-01-01 (M2 fit-triage)

**What they do:**
ZZ Scraped Co manufactures conveyor belts and sells them to food processors.

**Not any of the other categories:**
They are not a vendor, IT consulting firm, VC/PE firm, or job board.

CONCLUSION: Their **Dana Rivera** is VP of Engineering and that tech leadership is real, so this is a KEEP.

Note: co-located with a university lab, but sells commercially. Keep (operating company).
`);

w(`accounts/${CLA}/account.yaml`, YAML.stringify({
  domain: CLA, company: "ZZ Clause Co", status: "skipped", route: "SKIP",
  evidence_note: "Titled owner confirmed.",
  raw_pointers: [`raw/salesnav/${CLA}/2026-01-01-notes.md`],
}));
// The only statement of each decisive finding also carries the verdict — deleting the
// sentence would delete the named person and make the gold underivable.
w(`raw/salesnav/${CLA}/2026-01-01-notes.md`, `# Sales Navigator pass — ${CLA} — 2026-01-01

## Findings
- **Dana Rivera** — VP of Automation, 4y tenure — DISQUALIFIES: titled owner, route SKIP.
- **Sam Okafor** is Head of Data Science and this DISQUALIFIES the account (SKIP).
- Nobody else above manager level.
`);

w(`accounts/${JOB}/account.yaml`, YAML.stringify({
  domain: JOB, company: "ZZ Jobs Co", status: "triaged",
  evidence_note: "Operating company.",
  raw_pointers: ["raw/theirstack/2026-01-01-jobs-keyed.json"],
}));
// Hand-transcribed per-domain pull: rows live under `jobs`, carry no domain field at all,
// and the domain is stated only in the capture's own provenance note.
w("raw/theirstack/2026-01-01-jobs-keyed.json", JSON.stringify({
  _capture_note: `search_jobs ${JOB} + signal regex, limit 2, 2026-01-01. matching_phrases verbatim.`,
  jobs: [
    { id: 1, job_title: "Data Analyst", date_posted: "2026-01-01", matching_phrases: ["Most of our reporting is built with automation agents"] },
    { id: 2, job_title: "Planner", date_posted: "2026-01-01", matching_phrases: ["Access to automation tooling"] },
  ],
}));

const esc = run(ESC, "--task", "fit-triage");
const scr = run(SCR, "--task", "fit-triage");
const cla = run(CLA, "--task", "salesnav-verdict");
const job = run(JOB, "--task", "fit-triage");

check("redaction never eats a JSON escape — the staged capture still parses", () => {
  assert.equal(esc.status, 0, esc.stderr);
  const raw = inputText("fit_triage_zzescape_invalid", "theirstack-company.json");
  const parsed = JSON.parse(raw); // a broken redactor produces `professional:\<redacted>` here
  const desc = parsed.data[0].long_description;
  assert.match(desc, /professional:\n<redacted> to schedule a tour\./, "the escape must survive, the email must not");
  assert.ok(!/@/.test(raw), `email survived: ${raw.match(/\S*@\S*/)?.[0]}`);
  assert.match(raw, /professional:\\n<redacted>/, "on disk the escape is still `\\n`, not a dangling backslash");
});

check("scraped captures are conclusion-stripped too; _capture_note never reaches an input", () => {
  assert.equal(scr.status, 0, scr.stderr);
  const hp = inputText("fit_triage_zzscraped_invalid", "homepage.md");
  const side = sidecarOf("fit_triage_zzscraped_invalid");

  // trailing verdict line + taxonomy answer: deleted, and both listed for the reviewer
  assert.ok(!/Keep \(operating company\)/.test(hp), "trailing verdict line must be deleted from a SCRAPED capture");
  assert.ok(!/not a vendor, IT consulting firm/.test(hp), "taxonomy-answering line must be deleted");
  assert.match(hp, /co-located with a university lab/, "the evidence in the same paragraph must survive");
  assert.match(hp, /manufactures conveyor belts/, "substantive scraped content must survive");
  assert.match(side, /sentence: .*Keep \(operating company\)/);
  assert.match(side, /sentence: .*not any of the other categories/i);

  // entangled conclusion: NOT deleted (it names a person + title) — raised as a BLOCKER
  assert.match(hp, /Dana Rivera/, "an entangled conclusion must be kept, never silently deleted");
  assert.match(side, /## BLOCKERS[\s\S]*OVER-STRIP GUARD[\s\S]*Dana Rivera/);
  assert.match(scr.stdout, /BLOCKER/);

  // analyst annotation keys are dropped from JSON inputs entirely, and listed
  const ts = inputText("fit_triage_zzscraped_invalid", "theirstack-company.json");
  assert.equal(JSON.parse(ts)._capture_note, undefined, "_capture_note narrates the conclusion — never an input");
  assert.ok(!/false positive class/.test(ts), "no annotation text may survive anywhere in the JSON");
  assert.equal(JSON.parse(ts).data[0]._note, undefined, "row-level _note is annotation too");
  assert.match(side, /dropped JSON keys:.*_capture_note/);
});

check("a finding+verdict sentence keeps its named person — clause cut or BLOCKER, never deletion", () => {
  assert.equal(cla.status, 0, cla.stderr);
  const sn = inputText("salesnav_verdict_zzclause_invalid", "salesnav-notes.md");
  const side = sidecarOf("salesnav_verdict_zzclause_invalid");

  // (a) cleanly separable trailing clause → only the verdict goes, the evidence stays
  assert.match(sn, /\*\*Dana Rivera\*\* — VP of Automation, 4y tenure\s*$/m);
  assert.ok(!/DISQUALIFIES: titled owner/.test(sn), "the severable verdict clause must be gone");
  assert.ok(!/route SKIP/.test(sn), "…including the route it named");
  assert.match(side, /clause \(name\+title kept, verdict clause only\): .*SKIP/);

  // (b) not separable → the sentence stays intact and the human is told, loudly
  assert.match(sn, /\*\*Sam Okafor\*\* is Head of Data Science/, "the only statement of this finding must survive");
  assert.match(side, /## BLOCKERS[\s\S]*OVER-STRIP GUARD[\s\S]*Sam Okafor/);
  assert.match(fixtureOf("salesnav_verdict_zzclause_invalid").notes, /BLOCKERS:[\s\S]*OVER-STRIP GUARD/);
  // and the gold inference reads the SKIP route as a flip
  assert.equal(fixtureOf("salesnav_verdict_zzclause_invalid").gold.verdict, "flip_to_skip");
});

check("a `jobs`-keyed TheirStack capture scaffolds instead of blocking", () => {
  assert.equal(job.status, 0, job.stderr);
  assert.ok(!/no TheirStack capture in raw_pointers/.test(job.stdout), `theirstack_company blocked: ${job.stdout}`);
  const f = fixtureOf("fit_triage_zzjobs_invalid");
  assert.ok(f.inputs.some((i: any) => i.role === "theirstack_company"), "the company block must be staged");
  const ts = JSON.parse(inputText("fit_triage_zzjobs_invalid", "theirstack-company.json"));
  assert.equal(ts.data.length, 2, "both `jobs` rows belong to this single-company capture");
  assert.match(ts.data[0].matching_phrases[0], /automation agents/, "the evidence phrases must be carried over");
  assert.match(ts._excerpt, /single-company capture/);
  assert.equal(ts._capture_note, undefined);
});

cleanupStaging();
rmSync(STORE, { recursive: true, force: true });

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("draft-fixture test passed");
