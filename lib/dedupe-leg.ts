// M1 `company_domain_not` leg builder — the CLIENT-SIDE half of TheirStack dedupe.
// READ-ONLY: never writes under $PIPELINE_DATA. It ranks the store into the slots the API
// tolerates (dedupe.company_domain_not_cap) so the leg covers exactly what the server-side
// list does NOT.
//
// Why it exists. A naive leg of "the N most recently modified store domains" re-buys known
// accounts: the TheirStack company list only knows companies the API has returned to THIS
// workspace, so accounts that entered the store another way are invisible server-side; and a
// mid-sequence account nobody has touched for weeks is not "recently modified", so a recency
// leg misses it too. An account in neither leg is bought again, at full credit cost, every
// time it re-enters the source's window — and a re-bought mid-sequence account is the exact
// shape the blind-stub-write guard exists for.
//
// Standard mode (every signal without dedupe_mode: merge) — tiers, highest priority first:
//   1. config dedupe.exclusion_bug_domains (drop-on-sight class; cheap, always in)
//   2. store domains ABSENT from the newest list snapshot — live statuses first
//      (active/enrolled-paused/routed/held/triaged/flagged/pulled), then the rest, by mtime
//   3. remaining store domains, most recently modified first (fill)
// Merge mode (a signal block with dedupe_mode: merge — signals that RE-VISIT known accounts
// to check whether something changed, so the list leg would defeat the purpose; NO list leg):
//   1. exclusion_bug_domains
//   2. EVERY account already seen in a pull of this signal (raw pointer into this signal's
//      pulls) — terminal ones (dropped/skipped/opted-out/active/enrolled-paused) can never
//      become work items, and the rest are already work items a re-pull cannot improve until
//      the window rolls. Terminal first so they survive the cap when it binds.
//   3. accounts whose `dedupe.merge_verified_field` (default `verified_at`) date is inside
//      dedupe.merge_verified_window_days — re-checking them buys nothing new
//   4. remaining terminal accounts, most recently modified first (fill)
// Everything is capped at dedupe.company_domain_not_cap. If a tier overflows the cap the
// script says so on stderr — the upgrade path is a dedicated TheirStack list excluded via
// company_list_id_not (no cap), which must be created in the app.
//
// List snapshot: `get_companies_in_list` (0 credits) saved to
// <dedupe.list_snapshot_dir>/<date>-<company_list_id>.json. Both the raw MCP shape
// ({result:[{company_object:{domain,id},added_at}]}) and the compact shape
// ({companies:[{domain,id,added_at}]}) parse. An aged snapshot is SAFE — a domain fed to the
// list since the snapshot still lands in tier 2 and merely spends a slot.
//
// CLI:
//   node lib/dedupe-leg.ts                              # standard mode, newline-separated
//   node lib/dedupe-leg.ts --mode merge --signal-key <signal-key>
//   node lib/dedupe-leg.ts --json                       # {mode, cap, count, tiers, domains, ...}
//   node lib/dedupe-leg.ts --list-snapshot <path>       # override snapshot discovery
//   node lib/dedupe-leg.ts --list-id <n>                # override dedupe.company_list_id
//   node lib/dedupe-leg.ts --cap 200
// Exit 0 always when it can read the store; exit 2 when there is no store to rank or the
// list id is not configured (standard mode).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { configPath } from "./env.ts";
import { dataPath, listAccounts } from "./store.ts";
import { exclusionBugDomains, normalizeDomain } from "./pull-guard.ts";

export type Mode = "standard" | "merge";

export type AccountRow = {
  domain: string;              // normalized lowercase
  status: string;              // "" when unreadable
  mtimeMs: number;             // account.yaml mtime (0 when unreadable)
  verifiedAt?: string;         // the merge_verified_field value (yyyy-mm-dd) when present
  rawPointers: string[];
};

export type LegInput = {
  mode: Mode;
  cap: number;
  accounts: AccountRow[];
  listDomains: Set<string>;    // normalized domains known to the TheirStack list (standard mode)
  bugDomains: Iterable<string>;
  signalKey?: string;          // merge mode: which signal's raw pulls mark "seen in window"
  today?: Date;
  verifiedWindowDays?: number;
};

export type LegResult = {
  mode: Mode;
  cap: number;
  count: number;
  tiers: Record<string, number>;   // domains contributed per tier, after capping
  overflow: Record<string, number>; // domains a tier could NOT fit (0 = fully covered)
  domains: string[];
};

const LIVE = new Set(["active", "enrolled-paused", "routed", "held", "triaged", "flagged", "pulled"]);
const TERMINAL = new Set(["dropped", "skipped", "opted-out", "active", "enrolled-paused"]);
const DEFAULT_VERIFIED_WINDOW_DAYS = 30;
const DEFAULT_VERIFIED_FIELD = "verified_at";
const DEFAULT_CAP = 350;

const byMtimeDesc = (a: AccountRow, b: AccountRow) => b.mtimeMs - a.mtimeMs;

// Pure ranking — no filesystem, so tests can drive it directly.
export function buildLeg(input: LegInput): LegResult {
  const tiers: Array<[string, string[]]> = [];
  const bug = [...input.bugDomains].map(normalizeDomain).filter(Boolean);
  tiers.push(["exclusion_bug", bug]);

  if (input.mode === "standard") {
    const missing = input.accounts.filter((a) => !input.listDomains.has(a.domain));
    const live = missing.filter((a) => LIVE.has(a.status)).sort(byMtimeDesc);
    const other = missing.filter((a) => !LIVE.has(a.status)).sort(byMtimeDesc);
    tiers.push(["not_in_list", [...live, ...other].map((a) => a.domain)]);
    tiers.push(["recent_fill", [...input.accounts].sort(byMtimeDesc).map((a) => a.domain)]);
  } else {
    if (!input.signalKey) throw new Error("merge mode needs --signal-key (which signal's pulls mark window membership)");
    const key = input.signalKey;
    const seen = (a: AccountRow) => a.rawPointers.some((p) => p.includes("raw/theirstack/") && p.includes(key));
    const terminal = input.accounts.filter((a) => TERMINAL.has(a.status));
    // ANY account already seen in this signal's window is excluded, not only terminal ones:
    // a fresh stub at status:pulled/triaged carries no verified date yet and would otherwise
    // be re-billed on every pull for zero new information. A seen account is already a work
    // item; a re-pull adds nothing until the window rolls. Terminal first so they survive
    // the cap when it binds.
    const seenAll = input.accounts.filter(seen);
    tiers.push(["seen_in_window", [
      ...seenAll.filter((a) => TERMINAL.has(a.status)).sort(byMtimeDesc),
      ...seenAll.filter((a) => !TERMINAL.has(a.status)).sort(byMtimeDesc),
    ].map((a) => a.domain)]);
    const today = input.today ?? new Date();
    const windowMs = (input.verifiedWindowDays ?? DEFAULT_VERIFIED_WINDOW_DAYS) * 86_400_000;
    const recentlyVerified = input.accounts.filter((a) => {
      if (!a.verifiedAt) return false;
      const t = Date.parse(a.verifiedAt);
      return Number.isFinite(t) && today.getTime() - t <= windowMs && today.getTime() - t >= 0;
    });
    tiers.push(["recently_verified", recentlyVerified.sort(byMtimeDesc).map((a) => a.domain)]);
    tiers.push(["terminal_fill", terminal.sort(byMtimeDesc).map((a) => a.domain)]);
  }

  const out: string[] = [];
  const taken = new Set<string>();
  const contributed: Record<string, number> = {};
  const overflow: Record<string, number> = {};
  for (const [name, domains] of tiers) {
    contributed[name] = 0;
    overflow[name] = 0;
    for (const d of domains) {
      if (!d || taken.has(d)) continue;
      if (out.length >= input.cap) { overflow[name]++; continue; }
      taken.add(d);
      out.push(d);
      contributed[name]++;
    }
  }
  return { mode: input.mode, cap: input.cap, count: out.length, tiers: contributed, overflow, domains: out };
}

// --- store + config readers ---------------------------------------------------------------

function readSignalConfig(): any {
  return YAML.parse(readFileSync(configPath("signal.yaml"), "utf8"));
}

// `verifiedField` names the account.yaml date field merge mode keys on (config
// dedupe.merge_verified_field). A signal that re-verifies accounts stamps it when it does.
export function scanStore(verifiedField: string = DEFAULT_VERIFIED_FIELD): AccountRow[] {
  const rows: AccountRow[] = [];
  for (const dir of listAccounts()) {
    const domain = normalizeDomain(dir);
    if (!domain) continue;
    const p = dataPath("accounts", dir, "account.yaml");
    if (!existsSync(p)) { rows.push({ domain, status: "", mtimeMs: 0, rawPointers: [] }); continue; }
    let doc: any = null;
    try { doc = YAML.parse(readFileSync(p, "utf8")); } catch { doc = null; }
    const v = doc?.[verifiedField];
    rows.push({
      domain,
      status: typeof doc?.status === "string" ? doc.status : "",
      mtimeMs: statSync(p).mtimeMs,
      verifiedAt: v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "string" ? v : undefined,
      rawPointers: Array.isArray(doc?.raw_pointers) ? doc.raw_pointers.filter((x: unknown) => typeof x === "string") : [],
    });
  }
  return rows;
}

// Accepts the raw MCP result or the compact form; returns normalized domains.
export function parseListSnapshot(text: string): Set<string> {
  const doc = JSON.parse(text);
  const rows: any[] = Array.isArray(doc?.result) ? doc.result
    : Array.isArray(doc?.companies) ? doc.companies
    : Array.isArray(doc) ? doc : [];
  const out = new Set<string>();
  for (const r of rows) {
    const d = r?.domain ?? r?.company_object?.domain;
    if (typeof d === "string") { const n = normalizeDomain(d); if (n) out.add(n); }
  }
  return out;
}

export function newestListSnapshot(listId: number, dir = "raw/theirstack/lists"): string | null {
  const full = dataPath(dir);
  if (!existsSync(full)) return null;
  const suffix = `-${listId}.json`;
  const files = readdirSync(full).filter((f) => f.endsWith(suffix)).sort();
  return files.length ? dataPath(dir, files[files.length - 1]) : null;
}

// config `dedupe.company_list_id` is a TheirStack list id (a positive integer). The template
// ships a `REPLACE-WITH-…` placeholder; that is "not configured", never NaN.
export function configuredListId(raw: unknown): number | undefined {
  const s = raw === undefined || raw === null ? "" : String(raw).trim();
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  return n > 0 ? n : undefined;
}

// --- CLI ---------------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const o: { mode: Mode; json: boolean; cap?: number; signalKey?: string; snapshot?: string; listId?: number } = { mode: "standard", json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--mode") { const v = argv[++i]; if (v !== "standard" && v !== "merge") throw new Error(`--mode must be standard|merge, got ${v}`); o.mode = v; }
    else if (a === "--cap") { o.cap = Number(argv[++i]); if (!Number.isInteger(o.cap) || o.cap < 1) throw new Error("--cap must be a positive integer"); }
    else if (a === "--signal-key") o.signalKey = argv[++i];
    else if (a === "--list-snapshot") o.snapshot = argv[++i];
    else if (a === "--list-id") { o.listId = configuredListId(argv[++i]); if (o.listId === undefined) throw new Error("--list-id must be a positive integer (the TheirStack company-list id)"); }
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = readSignalConfig();
  const dedupe = cfg?.dedupe ?? {};
  const cap = args.cap ?? Number(dedupe.company_domain_not_cap ?? DEFAULT_CAP);
  const listId = args.listId ?? configuredListId(dedupe.company_list_id);
  const snapshotDir = typeof dedupe.list_snapshot_dir === "string" ? dedupe.list_snapshot_dir : "raw/theirstack/lists";
  const verifiedWindowDays = Number(dedupe.merge_verified_window_days ?? DEFAULT_VERIFIED_WINDOW_DAYS);
  const verifiedField = typeof dedupe.merge_verified_field === "string" && dedupe.merge_verified_field.trim()
    ? dedupe.merge_verified_field.trim() : DEFAULT_VERIFIED_FIELD;

  const accounts = scanStore(verifiedField);
  if (accounts.length === 0) {
    console.error(`dedupe-leg: no accounts under ${dataPath("accounts")} — refusing to build a leg from nothing`);
    process.exit(2);
  }

  let listDomains = new Set<string>();
  let snapshotPath: string | null = null;
  let snapshotAgeDays: number | null = null;
  if (args.mode === "standard") {
    if (listId === undefined && !args.snapshot) {
      console.error(
        `dedupe-leg: dedupe.company_list_id is not configured (config/signal.yaml has "${String(dedupe.company_list_id ?? "")}") — ` +
        "set it to your TheirStack \"companies seen\" list id, or pass --list-id <n> / --list-snapshot <path>",
      );
      process.exit(2);
    }
    snapshotPath = args.snapshot ?? newestListSnapshot(listId as number, snapshotDir);
    if (snapshotPath && existsSync(snapshotPath)) {
      listDomains = parseListSnapshot(readFileSync(snapshotPath, "utf8"));
      snapshotAgeDays = Math.floor((Date.now() - statSync(snapshotPath).mtimeMs) / 86_400_000);
      if (snapshotAgeDays > 7) console.error(`dedupe-leg: list snapshot is ${snapshotAgeDays}d old (${snapshotPath}) — refresh with get_companies_in_list (0 credits)`);
    } else {
      console.error(`dedupe-leg: no list-${listId} snapshot under ${snapshotDir} — treating the whole store as not-in-list (safe, but refresh the snapshot)`);
    }
  }

  const result = buildLeg({
    mode: args.mode, cap, accounts, listDomains, bugDomains: exclusionBugDomains(),
    signalKey: args.signalKey, verifiedWindowDays,
  });
  for (const [tier, n] of Object.entries(result.overflow)) {
    if (n > 0) console.error(`dedupe-leg: tier ${tier} overflowed the cap by ${n} domain(s) — consider a dedicated TheirStack list (company_list_id_not has no cap)`);
  }
  if (args.json) {
    console.log(JSON.stringify({ ...result, list_id: listId ?? null, list_snapshot: snapshotPath, list_snapshot_age_days: snapshotAgeDays, list_domains: listDomains.size, store_accounts: accounts.length, verified_field: verifiedField }, null, 2));
  } else {
    console.error(`dedupe-leg: mode=${result.mode} cap=${result.cap} count=${result.count} tiers=${JSON.stringify(result.tiers)}`);
    for (const d of result.domains) console.log(d);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
