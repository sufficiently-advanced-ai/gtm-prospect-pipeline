// M1 pre-write dedupe guard — the FIRST line of defense against a blind stub write.
// READ-ONLY: this file never writes anything under $PIPELINE_DATA. It answers one question
// for a whole pull at once, BEFORE any stub write happens: "which of these domains does the
// store already know about?"
//
// Why it exists. `createAccountStub()` in lib/store.ts refuses to overwrite an existing
// account — that is the LAST line of defense, and it only fires one domain at a time, after
// the decision to write has already been made. A source's dedupe can return already-active
// domains despite the full store being passed as exclusions; a stub write that trusts the
// pull then clobbers mid-sequence accounts, and raw provenance is not recoverable from the
// CRM mirror. A pull calling a domain "new" is NOT evidence. Ask the filesystem first, for
// every domain, in one pass.
//
// Rebrand / sibling-brand aliases (`--pull`). A source will sometimes return a company the
// store already knows under a NEW domain and a NEW company id (a rebrand, a sister brand, a
// holding company). Neither dedupe leg can see that — the domain is genuinely absent from
// accounts/ — and typically only a human notices that the apply URL still points at the old
// ATS tenant, or that the LinkedIn company page is the same one. So when the raw pull file is
// handed over with `--pull`, the guard builds identity keys that survive a rebrand:
//   (a) the LinkedIn company slug from `linkedin_url` (/company/<slug>);
//   (b) the ATS tenant from every job URL — the hostname for tenant-subdomain ATSs
//       (x.applytojob.com, x.wd5.myworkdayjobs.com, x.icims.com, ...), hostname + first path
//       segment for path-tenant boards (job-boards.greenhouse.io/<t>, jobs.lever.co/<t>, ...);
//       aggregator/board hosts (linkedin, indeed, glassdoor, ...) carry no identity and are
//       skipped, as is any host the table does not recognise (a shared recruiting host used
//       by every customer of that vendor carries no tenant — a hostname key there is noise).
// The same keys are built for the STORE side from every other raw pull under
// raw/theirstack/*.json (rows whose domain has an accounts/ dir) and from an optional
// `linkedin_url` in account.yaml. A pulled domain whose key maps to a DIFFERENT store domain
// gets an `ALIAS?` warning. Advisory only, like every other warning here: the verdict stays
// what the filesystem says, a human rules on the alias. Still read-only.
//
// CLI:
//   node lib/pull-guard.ts <domain> [<domain>...]
//   printf '%s\n' acme.com foo.com | node lib/pull-guard.ts
//   node lib/pull-guard.ts --json <domain>...
//   node lib/pull-guard.ts --pull raw/theirstack/<date>-<signal-key>-pull-1.json [--pull ...]
//       (every domain in the pull file(s) is checked; explicit domains/stdin are added to it)
// Exit 0 = every domain is genuinely new (near-miss / ALIAS? warnings may still be printed).
// Exit 1 = at least one domain overlaps the store / the known-bug list / is malformed — STOP.
// Exit 2 = cannot run (no store to check against; refusing to answer "all new" from nothing).
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { dataPath, listAccounts } from "./store.ts";
import { PIPELINE_DATA, configPath } from "./env.ts";

export type Verdict = "NEW" | "EXISTS" | "EXCLUSION_BUG" | "INVALID";

export type Check = {
  input: string;          // exactly what the caller passed
  domain: string;         // normalized (lowercased, scheme/path/port stripped)
  verdict: Verdict;
  status?: string;        // EXISTS: status from account.yaml (or why it could not be read)
  match?: string;         // EXISTS: the accounts/ directory it matched
  reason?: string;        // EXCLUSION_BUG / INVALID: why
  warnings: string[];     // advisory near-misses — never change the verdict
};

// A pull can hand us "https://WWW.Acme.com/careers?x=1"; the store's directories are bare
// lowercase domains. Normalize both sides before comparing — the mixed-case class of miss
// (same account, different casing) is caught here, mechanically.
export function normalizeDomain(raw: string): string {
  let d = String(raw).trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.\-]*:\/\//, "");   // scheme
  d = d.replace(/^[^/@]*@/, "");                    // userinfo
  d = d.split(/[/?#]/)[0];                          // path/query/fragment
  d = d.replace(/:\d+$/, "");                       // port
  d = d.replace(/\.+$/, "");                        // trailing root dot
  return d;
}

// www.acme.com and acme.com are the same account. Only this equivalence is mechanical —
// acme.info vs acme.com is NOT (different registrable domains that happen to be the same
// company), which is why that class is a warning below, never a verdict.
export const bareForm = (d: string): string => d.replace(/^www\./, "");

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function exclusionBugDomains(): Set<string> {
  const doc: any = YAML.parse(readFileSync(configPath("signal.yaml"), "utf8"));
  const list: unknown = doc?.dedupe?.exclusion_bug_domains;
  const out = new Set<string>();
  if (Array.isArray(list)) for (const d of list) if (typeof d === "string" && d.trim()) out.add(bareForm(normalizeDomain(d)));
  return out;
}

// bare-form key -> actual accounts/ directory name. Both the literal directory name and its
// www-stripped form are indexed, so the match works whichever side carries the prefix.
function buildStoreIndex(): Map<string, string> {
  const index = new Map<string, string>();
  for (const dir of listAccounts()) {
    const norm = normalizeDomain(dir);
    if (!index.has(norm)) index.set(norm, dir);
    const bare = bareForm(norm);
    if (!index.has(bare)) index.set(bare, dir);
  }
  return index;
}

function statusOf(dir: string): string {
  const p = dataPath("accounts", dir, "account.yaml");
  if (!existsSync(p)) return "unknown — directory exists, no account.yaml";
  try {
    const a: any = YAML.parse(readFileSync(p, "utf8"));
    return typeof a?.status === "string" && a.status ? a.status : "unknown — account.yaml has no status";
  } catch (e: any) {
    return `unreadable account.yaml (${e.message})`;
  }
}

// Advisory only. These are the shapes a human should eyeball before calling a domain new;
// none of them is safe to decide mechanically, so none of them changes the exit code.
const MAX_NEAR_MISSES = 5;
function nearMisses(domain: string, storeDirs: string[]): string[] {
  const bare = bareForm(domain);
  const base = bare.split(".")[0];
  const out: string[] = [];
  for (const dir of storeDirs) {
    const other = bareForm(normalizeDomain(dir));
    if (other === bare) continue;
    if (bare.endsWith(`.${other}`) || other.endsWith(`.${bare}`))
      out.push(`near-miss: store has ${dir} — one is a subdomain of the other (sub.acme.com vs acme.com class); confirm they are different companies`);
    else if (base.length >= 4 && other.split(".")[0] === base)
      out.push(`near-miss: store has ${dir} — same base label, different TLD (acme.info vs acme.com class); verify by hand, this is NOT decidable mechanically`);
    if (out.length >= MAX_NEAR_MISSES) { out.push("… further near-misses suppressed"); break; }
  }
  return out;
}

// ---- Rebrand / sibling-brand alias keys ---------------------------------------
// Identity that survives a domain change: the LinkedIn company page and the ATS tenant the
// company posts through. See the header. Everything below is pure string work over
// already-captured raw files — no network, no writes.

export type AliasKind = "linkedin slug" | "ATS tenant";
export type AliasKey = { kind: AliasKind; key: string };

// Hosts that publish everyone's jobs — an "identity" there is the aggregator's, not the
// company's. Matched on the host's registrable tail so glassdoor.co.uk / adzuna.* fall in.
const AGGREGATOR_HOSTS = [
  "linkedin.com", "indeed.com", "glassdoor.", "ziprecruiter.com", "hitmarker.net", "builtin.com",
  "wellfound.com", "jobgether.com", "simplyhired.com", "monster.com", "dice.com", "lensa.com",
  "talent.com", "adzuna.", "jooble.", "careerbuilder.com", "google.com", "welcometothejungle.com",
];
// Tenant-subdomain ATSs: <tenant>.<ats-suffix> — the hostname IS the tenant key.
const SUBDOMAIN_ATS_SUFFIXES = [
  ".applytojob.com", ".myworkdayjobs.com", ".icims.com", ".rec.pro.ukg.net", ".breezy.hr",
  ".bamboohr.com", ".recruitee.com", ".workable.com", ".dayforcehcm.com", ".careers.hibob.com",
];
// Path-tenant boards: <board-host>/<tenant>/... — hostname + first path segment.
const PATH_TENANT_HOSTS = new Set([
  "job-boards.greenhouse.io", "boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com",
  "jobs.smartrecruiters.com", "apply.workable.com", "ats.rippling.com", "jobs.jobvite.com",
  "recruiting.ultipro.com", "recruiting2.ultipro.com",   // tenant codes here often carry the OLD brand name
]);
// ADP WorkforceNow carries its tenant in the `cid` query param (one shared host for everyone).
const ADP_HOST = "workforcenow.adp.com";
// First segments on path-tenant hosts that are the board's own routing, not a tenant
// (apply.workable.com/j/<id>, boards.greenhouse.io/embed/...), and leading host labels on a
// tenant-subdomain ATS that are its shared board, not a tenant (jobs.workable.com,
// jobs.dayforcehcm.com — keying on those once aliased two accounts to nine unrelated others).
const NOT_A_TENANT = new Set(["j", "jobs", "job", "apply", "embed", "careers", "postings", "api", "www", "app", "recruiting", "boards"]);

function parseUrl(raw: unknown): URL | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try { return new URL(raw.trim()); } catch { return undefined; }
}

export function linkedinSlug(raw: unknown): string | undefined {
  const u = parseUrl(raw);
  if (!u || !/(^|\.)linkedin\.com$/.test(u.hostname.toLowerCase())) return undefined;
  const m = u.pathname.toLowerCase().match(/^\/(?:company|school|showcase)\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]).replace(/\/+$/, "") : undefined;
}

export function atsTenantKey(raw: unknown): string | undefined {
  const u = parseUrl(raw);
  if (!u) return undefined;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const isAggregator = (a: string) =>
    a.endsWith(".") ? host.startsWith(a) || host.includes(`.${a}`) : host === a || host.endsWith(`.${a}`);
  if (AGGREGATOR_HOSTS.some(isAggregator)) return undefined;
  // Path-tenant boards first: apply.workable.com is a shared board, not a <tenant>.workable.com.
  if (PATH_TENANT_HOSTS.has(host)) {
    const seg = u.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
    return seg && !NOT_A_TENANT.has(seg) ? `${host}/${seg}` : undefined;
  }
  if (SUBDOMAIN_ATS_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length))
    return NOT_A_TENANT.has(host.split(".")[0]) ? undefined : host;
  if (host === ADP_HOST) {
    const cid = u.searchParams.get("cid")?.trim().toLowerCase();
    if (cid) return `${host}/cid=${cid}`;
  }
  return undefined;
}

const aliasId = (k: AliasKey) => `${k.kind}:${k.key}`;

// One raw row -> its keys. Tolerates both TheirStack shapes: search_companies rows carry
// `domain` + `jobs_found[]`; search_jobs rows are one job each with `company_domain`.
export function aliasKeysForRow(row: any): AliasKey[] {
  const seen = new Set<string>();
  const out: AliasKey[] = [];
  const add = (k: AliasKey | undefined) => { if (k && !seen.has(aliasId(k))) { seen.add(aliasId(k)); out.push(k); } };
  const slug = linkedinSlug(row?.linkedin_url);
  if (slug) add({ kind: "linkedin slug", key: slug });
  const jobs: any[] = Array.isArray(row?.jobs_found) ? row.jobs_found : [row];
  for (const j of jobs)
    for (const field of ["url", "source_url", "final_url"]) {
      const t = atsTenantKey(j?.[field]);
      if (t) add({ kind: "ATS tenant", key: t });
    }
  return out;
}

export type PulledRow = { domain: string; keys: AliasKey[] };

export function rowsOfPull(doc: any): PulledRow[] {
  const rows: any[] = Array.isArray(doc?.data) ? doc.data : [];
  const byDomain = new Map<string, PulledRow>();
  for (const row of rows) {
    const rawDomain = row?.domain ?? row?.company_domain ?? row?.company_object?.domain;
    if (typeof rawDomain !== "string" || !rawDomain.trim()) continue;
    const domain = normalizeDomain(rawDomain);
    const entry = byDomain.get(domain) ?? { domain, keys: [] };
    const have = new Set(entry.keys.map(aliasId));
    for (const k of aliasKeysForRow(row)) if (!have.has(aliasId(k))) { have.add(aliasId(k)); entry.keys.push(k); }
    byDomain.set(domain, entry);
  }
  return [...byDomain.values()];
}

function readJsonQuietly(path: string): any | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

// Store-side identity: alias id -> accounts/ dirs that carry it. Sources: every raw pull under
// raw/theirstack/*.json EXCEPT the file(s) being checked (a pull must never vouch for itself),
// restricted to rows whose domain has an accounts/ dir; plus `linkedin_url` in account.yaml.
export function buildStoreAliasIndex(index: Map<string, string>, excludeFiles: string[] = []): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const claim = (k: AliasKey, dir: string) => {
    const id = aliasId(k);
    if (!out.has(id)) out.set(id, new Set());
    out.get(id)!.add(dir);
  };
  const dirFor = (domain: string) => index.get(domain) ?? index.get(bareForm(domain));
  const excluded = new Set(excludeFiles.map((f) => { try { return realpathSync(f); } catch { return f; } }));

  // Each raw file is parsed exactly once; anything that is not JSON, or not a pull shape,
  // contributes nothing and says nothing (lists/ snapshots carry only domains, for instance).
  const rawDir = dataPath("raw", "theirstack");
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".json")) continue;
      let real = p;
      try { real = realpathSync(p); } catch { /* fall through with the literal path */ }
      if (excluded.has(real)) continue;
      const doc = readJsonQuietly(p);
      if (!doc) continue;
      for (const row of rowsOfPull(doc)) {
        const dir = dirFor(row.domain);
        if (dir) for (const k of row.keys) claim(k, dir);
      }
    }
  };
  if (existsSync(rawDir)) walk(rawDir);

  for (const dir of new Set(index.values())) {
    const p = dataPath("accounts", dir, "account.yaml");
    if (!existsSync(p)) continue;
    let a: any;
    try { a = YAML.parse(readFileSync(p, "utf8")); } catch { continue; }
    const slug = linkedinSlug(a?.linkedin_url);
    if (slug) claim({ kind: "linkedin slug", key: slug }, dir);
  }
  return out;
}

export type AliasContext = {
  pulled: Map<string, AliasKey[]>;      // normalized pulled domain -> its keys
  store: Map<string, Set<string>>;      // alias id -> accounts/ dirs
};

export function loadAliasContext(pullPaths: string[]): AliasContext & { domains: string[] } {
  const pulled = new Map<string, AliasKey[]>();
  for (const p of pullPaths) {
    const doc = readJsonQuietly(p);
    if (!doc) continue;
    for (const row of rowsOfPull(doc)) {
      const keys = pulled.get(row.domain) ?? [];
      const have = new Set(keys.map(aliasId));
      for (const k of row.keys) if (!have.has(aliasId(k))) { have.add(aliasId(k)); keys.push(k); }
      pulled.set(row.domain, keys);
    }
  }
  return { pulled, store: buildStoreAliasIndex(buildStoreIndex(), pullPaths), domains: [...pulled.keys()] };
}

function aliasWarnings(domain: string, ctx: AliasContext | undefined): string[] {
  if (!ctx) return [];
  const keys = ctx.pulled.get(domain) ?? ctx.pulled.get(bareForm(domain)) ?? [];
  const self = bareForm(domain);
  const out: string[] = [];
  const said = new Set<string>();
  for (const k of keys)
    for (const dir of ctx.store.get(aliasId(k)) ?? []) {
      if (bareForm(normalizeDomain(dir)) === self) continue; // same account, not an alias
      const line = `ALIAS? ${domain} shares ${k.kind} "${k.key}" with ${dir} (status ${statusOf(dir)}) — rebrand/sibling-brand class; never a separate account`;
      if (!said.has(line)) { said.add(line); out.push(line); }
    }
  return out;
}

export function checkDomains(inputs: string[], alias?: AliasContext): Check[] {
  const index = buildStoreIndex();
  const storeDirs = [...new Set(index.values())];
  const bugs = exclusionBugDomains();

  const checks = inputs.map((input) => {
    const domain = normalizeDomain(input);
    const warnings: string[] = [];
    if (domain !== String(input).trim().toLowerCase())
      warnings.push(`normalized "${String(input).trim()}" -> "${domain}"`);
    else if (String(input).trim() !== domain)
      warnings.push(`case-normalized "${String(input).trim()}" -> "${domain}"`);

    if (!DOMAIN_RE.test(domain))
      return { input, domain, verdict: "INVALID" as Verdict, reason: "not a bare domain — a malformed pull list is not evidence of anything", warnings };

    const bare = bareForm(domain);
    const dir = index.get(domain) ?? index.get(bare);
    if (dir) {
      if (dir !== domain) warnings.push(`matched accounts/${dir} — www/bare or case variant of "${domain}"`);
      const check: Check = { input, domain, verdict: "EXISTS", status: statusOf(dir), match: dir, warnings };
      if (bugs.has(bare)) check.warnings.push("also listed in config/signal.yaml dedupe.exclusion_bug_domains");
      return check;
    }

    if (bugs.has(bare))
      return {
        input, domain, verdict: "EXCLUSION_BUG" as Verdict,
        reason: "config/signal.yaml dedupe.exclusion_bug_domains — slips domain_not despite exclusion; drop on sight, count as a repeat",
        warnings,
      };

    warnings.push(...nearMisses(domain, storeDirs));
    return { input, domain, verdict: "NEW" as Verdict, warnings };
  });

  // ALIAS? is appended whatever the verdict (an EXISTS domain can still share a tenant with a
  // second store account — that is a merge question for a human), never changing it.
  for (const c of checks) if (c.verdict !== "INVALID") c.warnings.push(...aliasWarnings(c.domain, alias));
  return checks;
}

// ---- CLI --------------------------------------------------------------------
// Import-safe: test/pull-guard.test.ts imports the helpers, so the CLI only runs when this
// file IS the entrypoint.
const isEntrypoint = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try { return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (isEntrypoint) {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const pullPaths: string[] = [];
  let inputs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json" || argv[i] === "-") continue;
    if (argv[i] === "--pull") {
      const p = argv[++i];
      if (!p || p.startsWith("--")) { console.error("--pull requires a path to a raw TheirStack pull JSON"); process.exit(2); }
      if (!existsSync(p)) { console.error(`--pull: no such file: ${p}`); process.exit(2); }
      pullPaths.push(p);
      continue;
    }
    inputs.push(argv[i]);
  }

  // No domains on the argv? Take them from stdin (one per line) — that is how M1 pipes a
  // whole pull in. Never block on an interactive terminal.
  if (inputs.length === 0 && !process.stdin.isTTY) {
    let piped = "";
    try { piped = readFileSync(0, "utf8"); } catch { piped = ""; }
    inputs = piped.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  }

  // --pull: every domain in the raw file(s) is checked, and their LinkedIn/ATS identity keys
  // are compared against the store's for ALIAS? warnings. Explicit domains are added, not
  // replaced. The alias index is only built when a pull is given — it parses every raw file.
  let alias: AliasContext | undefined;
  if (pullPaths.length) {
    const ctx = loadAliasContext(pullPaths);
    alias = ctx;
    const have = new Set(inputs.map((d) => normalizeDomain(d)));
    for (const d of ctx.domains) if (!have.has(d)) { have.add(d); inputs.push(d); }
  }

  const storeRoot = dataPath("accounts");
  const storeReadable = existsSync(storeRoot) && statSync(storeRoot).isDirectory();
  if (!storeReadable) {
    // "All new" from an unreadable store is exactly the false reassurance this guard exists
    // to prevent. Refuse to answer.
    const msg = `cannot check: no accounts/ directory under PIPELINE_DATA (${PIPELINE_DATA}) — refusing to call anything new`;
    if (asJson) console.log(JSON.stringify({ pipeline_data: PIPELINE_DATA, error: msg }, null, 2));
    else console.error(msg);
    process.exit(2);
  }

  const accountsIndexed = listAccounts().length;
  const checks = checkDomains(inputs, alias);
  const counts = {
    checked: checks.length,
    new: checks.filter((c) => c.verdict === "NEW").length,
    exists: checks.filter((c) => c.verdict === "EXISTS").length,
    exclusion_bug: checks.filter((c) => c.verdict === "EXCLUSION_BUG").length,
    invalid: checks.filter((c) => c.verdict === "INVALID").length,
    warnings: checks.reduce((n, c) => n + c.warnings.length, 0),
  };
  const blocked = counts.exists + counts.exclusion_bug + counts.invalid;

  if (asJson) {
    console.log(JSON.stringify({ pipeline_data: PIPELINE_DATA, accounts_indexed: accountsIndexed, pulls: pullPaths, ...counts, blocked, checks }, null, 2));
  } else {
    console.log(`pull-guard — ${checks.length} domain(s) against ${storeRoot} (${accountsIndexed} accounts) [READ-ONLY]` +
      (pullPaths.length ? ` — alias keys from ${pullPaths.length} pull file(s)` : ""));
    if (!checks.length) console.log("  no domains given — nothing to check");
    for (const c of checks) {
      const label = c.verdict.padEnd(13);
      if (c.verdict === "EXISTS") console.log(`${label} ${c.domain} -> accounts/${c.match} (status: ${c.status})`);
      else if (c.verdict === "NEW") console.log(`${label} ${c.domain}`);
      else console.log(`${label} ${c.domain} — ${c.reason}`);
      for (const w of c.warnings) console.log(`              WARN ${w}`);
    }
    console.log("");
    if (blocked) {
      console.log("================================================================================");
      console.log(
        `STOP — ${blocked} of ${checks.length} domain(s) are NOT new ` +
        `(${counts.exists} already in accounts/, ${counts.exclusion_bug} known exclusion-bug, ${counts.invalid} malformed).`,
      );
      console.log(
        "Reconcile BEFORE any stub write. The pull calling a domain \"new\" is not evidence: a\n" +
        "source's dedupe can return already-active domains despite full store exclusions, and a\n" +
        "blind stub write destroys mid-sequence accounts — raw provenance is not recoverable from\n" +
        "the CRM mirror. EXISTS/EXCLUSION_BUG domains are REPEATS: count them as repeats, never\n" +
        "stub-write them, and make the pulled = new + repeats arithmetic close.",
      );
      console.log("================================================================================");
    } else if (checks.length) {
      console.log(
        `OK — all ${checks.length} domain(s) are new to the store. Stub-write them through ` +
        "createAccountStub()\n(which still refuses to overwrite — guard first, stub-refusal last)." +
        (counts.warnings ? `\n${counts.warnings} advisory warning(s) above — read them before writing.` : ""),
      );
    }
  }
  process.exit(blocked ? 1 : 0);
}
