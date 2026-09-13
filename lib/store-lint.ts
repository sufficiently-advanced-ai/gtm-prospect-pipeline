// Deterministic store linter — structural integrity of $PIPELINE_DATA/accounts/*/account.yaml.
// READ-ONLY: this file never writes anything under $PIPELINE_DATA (no queue append, no repair).
// Exit 0 = no errors, 1 = errors, 2 = cannot run (no store / unknown --domain).
//
// Every check here is a paid-for incident, not a style preference:
//   - unparseable YAML     (an agent-written evidence_note with an unescaped ": " turns the
//                           plain scalar into a mapping and breaks the whole file)
//   - bad enum value       (`route: FLAG` written instead of FLAGGED)
//   - dropped required key (an M2 edit pass silently lost signal_source from several files)
//   - dangling raw pointer (capture-first is worthless if the pointer doesn't resolve)
//   - dangling citation    (M5 evidence.md must cite raw/ paths that actually exist)
//   - silent M3 deferral   (an account sat for days routed + SALES_NAV + resolver ENROLL, but
//                           M3 wrote no `m3_note` and no ledger entry named it, so no
//                           human-readable view ever showed it — WARN `silent-deferral`)
// Legacy tolerance lives in WARN, never in ERROR — accounts written before a convention
// existed must not make the linter's error count meaningless. See test/store-lint.test.ts
// for the incident fixtures.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { dataPath, listAccounts } from "./store.ts";
import { PIPELINE_DATA } from "./env.ts";
import { STORE_STATUSES, ROUTES, SEQUENCE_STATUSES, VERIFICATION_METHODS } from "./status-map.ts";
import { resolveSequence } from "./sequence-resolver.ts";

export type Severity = "error" | "warn";
export type Finding = { domain: string; severity: Severity; check: string; message: string };

// Statuses that mean M2 has classified the account — route must be recorded by then.
const ROUTE_REQUIRED = new Set([
  "routed", "enriched", "enrolled-paused", "active", "replied", "finished", "skipped", "dropped",
]);

const list = (vals: readonly string[]) => vals.join("|");

// Citations look like `[raw/a.md · fact]`, `[accounts/x/evidence.md]`, sometimes several paths
// in one bracket group. Pull bracket groups first (they cannot nest), then any store-relative
// path token inside — annotations (· fact|inference|hypothesis|sensitive) fall out for free.
const BRACKET = /\[([^[\]]*)\]/g;
const CITED_PATH = /(?:raw|accounts)\/[^\s,;|)\]]+/g;

export function extractCitations(markdown: string): string[] {
  const out: string[] = [];
  for (const group of markdown.matchAll(BRACKET))
    for (const p of group[1].matchAll(CITED_PATH)) out.push(p[0].replace(/[.,;:·]+$/, ""));
  return out;
}

// Resolve a store-relative pointer without ever touching the filesystem outside the store.
// dataPath() throws on traversal — an account.yaml carrying "../../x" is a finding, not a crash.
function resolveInStore(rel: string): { path: string } | { error: string } {
  const cleaned = String(rel).trim().replace(/^\.\//, "");
  if (!cleaned) return { error: "empty path" };
  try {
    return { path: dataPath(cleaned) };
  } catch (e: any) {
    return { error: e.message };
  }
}

// Domains named by an OPEN (status open|blocked) entry in queue/decisions.jsonl — via
// `accounts` (the ledger's field) or `subject` where present. Read once per process, tolerating
// a missing file and unparseable lines: a broken ledger line is not a reason to crash the lint,
// and a domain it would have named simply stays eligible for the silent-deferral warning.
const bareDomain = (d: string) => d.trim().toLowerCase().replace(/^www\./, "");
let openLedgerDomains: Set<string> | undefined;
export function ledgerOpenDomains(): Set<string> {
  if (openLedgerDomains) return openLedgerDomains;
  const out = new Set<string>();
  const p = dataPath("queue", "decisions.jsonl");
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e: any;
      try { e = JSON.parse(line); } catch { continue; }
      if (e?.status !== "open" && e?.status !== "blocked") continue;
      const named = [
        ...(Array.isArray(e.accounts) ? e.accounts : []),
        ...(Array.isArray(e.subject) ? e.subject : e.subject !== undefined ? [e.subject] : []),
      ];
      for (const d of named) if (typeof d === "string" && d.trim()) out.add(bareDomain(d));
    }
  }
  openLedgerDomains = out;
  return out;
}

const hasNote = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== "";

export function lintAccount(domain: string): Finding[] {
  const findings: Finding[] = [];
  const err = (check: string, message: string) => findings.push({ domain, severity: "error", check, message });
  const warn = (check: string, message: string) => findings.push({ domain, severity: "warn", check, message });

  const yamlPath = dataPath("accounts", domain, "account.yaml");
  if (!existsSync(yamlPath)) {
    err("account-yaml-missing", "accounts/ directory has no account.yaml");
    return findings;
  }

  let account: any;
  try {
    account = YAML.parse(readFileSync(yamlPath, "utf8"));
  } catch (e: any) {
    // One-line the parser's multi-line pointer output so the report stays one finding per line.
    err("yaml-parse", `account.yaml does not parse: ${String(e.message).split("\n")[0].replace(/:$/, "")}`);
    return findings;
  }
  if (!account || typeof account !== "object" || Array.isArray(account)) {
    err("yaml-parse", "account.yaml is not a YAML mapping");
    return findings;
  }

  // ---- required fields ------------------------------------------------------
  if (account.domain === undefined || account.domain === "") err("required-field", "missing `domain`");
  else if (account.domain !== domain) err("domain-mismatch", `domain "${account.domain}" != directory name "${domain}"`);
  if (account.company === undefined || account.company === "") err("required-field", "missing `company`");
  if (account.status === undefined || account.status === "") err("required-field", "missing `status`");
  if (account.signal_source === undefined || account.signal_source === "")
    err("required-field", "missing `signal_source` (provenance of the pull)");

  // ---- enums ----------------------------------------------------------------
  const status = account.status;
  if (status !== undefined && status !== "" && !STORE_STATUSES.includes(status))
    err("enum-status", `status "${status}" not in STORE_STATUSES (${list(STORE_STATUSES)})`);
  if (account.route !== undefined && account.route !== "" && !ROUTES.includes(account.route))
    err("enum-route", `route "${account.route}" not in ROUTES (${list(ROUTES)})`);
  if (account.verification !== undefined && account.verification !== "" && !VERIFICATION_METHODS.includes(account.verification))
    err("enum-verification", `verification "${account.verification}" not in VERIFICATION_METHODS (${list(VERIFICATION_METHODS)})`);

  // ---- status-conditional fields --------------------------------------------
  if (ROUTE_REQUIRED.has(status) && (account.route === undefined || account.route === ""))
    err("required-field", `status "${status}" requires a \`route\``);
  // WARN, not ERROR: legacy accounts may predate the triaged_at convention.
  if (status !== undefined && status !== "" && status !== "pulled" && !account.triaged_at)
    warn("required-field", `status "${status}" is past \`pulled\` but has no \`triaged_at\``);

  // ---- silent M3 deferral ---------------------------------------------------
  // Enrollable on every axis M3 reads (routed, Sales-Nav verified, resolver ENROLL) yet M3 left
  // no trace: no `m3_note`, no open ledger entry naming the domain. Such an account is invisible
  // to every human-readable view. WARN, never ERROR: the store is not wrong, the record is
  // missing.
  if (status === "routed" && account.verification === "SALES_NAV" && !hasNote(account.m3_note)) {
    const r = resolveSequence(account);
    if (r.decision === "ENROLL" && !ledgerOpenDomains().has(bareDomain(domain)))
      warn("silent-deferral", "silent-deferral — resolver says ENROLL, no m3_note and no open ledger entry (M3 must record every deferral)");
  }

  // ---- raw pointers ---------------------------------------------------------
  const pointers = account.raw_pointers;
  if (pointers !== undefined && pointers !== null && pointers !== "") {
    if (!Array.isArray(pointers)) err("raw-pointer", "`raw_pointers` must be a list");
    else
      for (const p of pointers) {
        if (typeof p !== "string") { err("raw-pointer", `raw_pointer is not a string: ${JSON.stringify(p)}`); continue; }
        const r = resolveInStore(p);
        if ("error" in r) err("raw-pointer", `raw_pointer ${p} — ${r.error}`);
        else if (!existsSync(r.path)) err("raw-pointer", `raw_pointer does not exist: ${p}`);
      }
  }

  // ---- contacts -------------------------------------------------------------
  const contacts = account.contacts;
  if (contacts !== undefined && contacts !== null && contacts !== "") {
    if (!Array.isArray(contacts)) err("contacts", "`contacts` must be a list");
    else
      contacts.forEach((c: any, i: number) => {
        if (!c || typeof c !== "object") { err("contacts", `contacts[${i}] is not a mapping`); return; }
        const who = c.name || c.email || `contacts[${i}]`;
        if (c.sequence_status !== undefined && c.sequence_status !== "" && !SEQUENCE_STATUSES.includes(c.sequence_status))
          err("enum-sequence-status", `${who}: sequence_status "${c.sequence_status}" not in SEQUENCE_STATUSES (${list(SEQUENCE_STATUSES)})`);
        // WARN only: alternate internal domains (brand vs corporate) are legitimate and common.
        if (typeof c.email === "string" && c.email.includes("@")) {
          const emailDomain = c.email.slice(c.email.lastIndexOf("@") + 1).trim().toLowerCase();
          if (emailDomain && emailDomain !== domain.toLowerCase())
            warn("contact-email-domain", `${who}: email domain "${emailDomain}" differs from account domain`);
        }
      });
  }

  // ---- evidence.md citations -------------------------------------------------
  const evidencePath = dataPath("accounts", domain, "evidence.md");
  if (existsSync(evidencePath)) {
    const seen = new Set<string>();
    for (const cite of extractCitations(readFileSync(evidencePath, "utf8"))) {
      if (seen.has(cite)) continue;
      seen.add(cite);
      const r = resolveInStore(cite);
      if ("error" in r) err("evidence-citation", `evidence.md cites ${cite} — ${r.error}`);
      else if (!existsSync(r.path)) err("evidence-citation", `evidence.md cites a path that does not exist: ${cite}`);
    }
  }

  return findings;
}

export function lintStore(domains?: string[]): Finding[] {
  const out: Finding[] = [];
  for (const domain of domains ?? listAccounts()) out.push(...lintAccount(domain));
  return out;
}

// ---- CLI --------------------------------------------------------------------
// Import-safe: lintStore/lintAccount are importable; the CLI only runs as entrypoint.
const isEntrypoint = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try { return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (isEntrypoint) {
  const args = process.argv.slice(2);
  const fail = (msg: string): never => { console.error(msg); process.exit(2); };
  const usage = "usage: node lib/store-lint.ts [--domain <d>] [--strict] [--json]";

  let strict = false, asJson = false, domainArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--strict") strict = true;
    else if (args[i] === "--json") asJson = true;
    else if (args[i] === "--domain") {
      domainArg = args[++i];
      if (!domainArg || domainArg.startsWith("--")) fail(`--domain requires a value — ${usage}`);
    } else fail(`unknown argument "${args[i]}" — ${usage}`);
  }

  if (!existsSync(PIPELINE_DATA)) fail(`PIPELINE_DATA does not exist: ${PIPELINE_DATA}`);
  if (!existsSync(dataPath("accounts"))) fail(`no accounts/ directory under PIPELINE_DATA: ${PIPELINE_DATA}`);

  let domains = listAccounts();
  if (domainArg !== undefined) {
    let dir = "";
    try { dir = dataPath("accounts", domainArg); } catch (e: any) { fail(e.message); }
    if (!existsSync(dir)) fail(`no such account: ${domainArg}`);
    domains = [domainArg];
  }

  const findings = lintStore(domains).map((f) => (strict && f.severity === "warn" ? { ...f, severity: "error" as Severity } : f));
  const errors = findings.filter((f) => f.severity === "error").length;
  const warns = findings.length - errors;

  if (asJson) {
    console.log(JSON.stringify({
      pipeline_data: PIPELINE_DATA, strict, accounts: domains.length,
      errors, warnings: warns, findings,
    }, null, 2));
  } else {
    for (const f of findings) console.log(`${f.severity === "error" ? "ERROR" : "WARN "} ${f.domain}: ${f.message}`);
    console.log(
      `${domains.length} account(s) linted — ${errors} error(s), ${warns} warn(s)` +
      (strict ? " [--strict: warns counted as errors]" : ""),
    );
  }
  process.exit(errors ? 1 : 0);
}
