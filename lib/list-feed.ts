// TheirStack list feeder — the 0-CREDIT half of list maintenance.
// READ-ONLY: never writes under $PIPELINE_DATA and never calls TheirStack. It harvests the
// company ids TheirStack has already returned to this workspace (every raw capture under
// raw/theirstack/ carries them verbatim — capture-first pays off here) and emits the ids a
// list is still missing, so M1 or a human can feed the list with ONE `add_companies_to_list`
// call at 0 credits.
//
// Why: `add_companies_to_list` only accepts TheirStack's own company id, and the only other
// way to get one is a billed search. Accounts that entered the store from another connector
// or by hand have no id anywhere in raw/ — those stay on the domain leg (lib/dedupe-leg.ts)
// until the vendor accepts a domain.
//
// Two lists, two purposes:
//   --list seen      dedupe.company_list_id ("companies seen") — EVERY store account belongs
//                    in it; standard-mode pulls exclude it via company_list_id_not (no cap).
//                    Accounts that were never fed (migration, manual sourcing) get in here
//                    without a re-buy.
//   --list terminal  dedupe.terminal_list_id — TERMINAL accounts only (dropped/skipped/
//                    opted-out/active/enrolled-paused). Merge-mode signals run WITHOUT the
//                    seen-list leg by design, so this list is their capless exclusion;
//                    accounts that can still become work items must never be in it. Create
//                    it once with `create_company_list`, put the id in config, snapshot it
//                    like the seen-list (same dir, <date>-<id>.json).
// The newest snapshot of the target list decides what is "already in"; no snapshot = feed
// everything with an id (idempotent — the vendor ignores repeats).
//
// CLI:
//   node lib/list-feed.ts --list seen|terminal        # JSON: {list, list_id, add_ids, ...}
//   node lib/list-feed.ts --list seen --ids           # one id per line (paste into the MCP call)
//   node lib/list-feed.ts --census                    # counts only: ids held / missing, per status
// Exit 0 when it can read the store; exit 2 when the store is empty or the list id is unset.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { configPath } from "./env.ts";
import { dataPath, listAccounts } from "./store.ts";
import { normalizeDomain } from "./pull-guard.ts";
import { configuredListId, newestListSnapshot, TERMINAL_STATUSES } from "./dedupe-leg.ts";

export type IdMap = Map<string, string>; // normalized domain → TheirStack company id

// TheirStack company ids are encrypted slugs (base64-looking strings); job ids are integers.
// Only string ids are companies. Blurred rows (preflight captures) are skipped: their ids are
// real but their domains are not guaranteed to be.
const looksLikeCompanyId = (v: unknown): v is string => typeof v === "string" && v.length >= 8 && !/^\d+$/.test(v);

function harvestRow(row: any, into: IdMap): void {
  if (!row || typeof row !== "object") return;
  if (row.has_blurred_data === true) return;
  const candidates = [row, row.company_object, row.company, row._company_object];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const d = normalizeDomain(c.domain);
    if (d && looksLikeCompanyId(c.id) && !into.has(d)) into.set(d, c.id);
  }
}

export function harvestIdsFromDoc(doc: any, into: IdMap): void {
  if (!doc || typeof doc !== "object") return;
  if (doc._company_object) harvestRow({ _company_object: doc._company_object }, into);
  const rows: any[] = Array.isArray(doc) ? doc
    : Array.isArray(doc.data) ? doc.data
    : Array.isArray(doc.result) ? doc.result
    : Array.isArray(doc.companies) ? doc.companies : [];
  for (const r of rows) harvestRow(r, into);
}

// Every JSON capture under raw/theirstack/ (recursively — pulls, per-domain jobs files,
// list snapshots, sweeps). Malformed files are skipped, never fatal.
export function harvestIdsFromRaw(dir = dataPath("raw", "theirstack")): { ids: IdMap; files: number } {
  const ids: IdMap = new Map();
  let files = 0;
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!name.endsWith(".json")) continue;
      let doc: any;
      try { doc = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
      files++;
      harvestIdsFromDoc(doc, ids);
    }
  };
  walk(dir);
  return { ids, files };
}

export type StoreRow = { domain: string; status: string };

export function scanStoreStatuses(): StoreRow[] {
  const rows: StoreRow[] = [];
  for (const dir of listAccounts()) {
    const domain = normalizeDomain(dir);
    if (!domain) continue;
    const p = dataPath("accounts", dir, "account.yaml");
    let status = "";
    if (existsSync(p)) {
      try { const doc: any = YAML.parse(readFileSync(p, "utf8")); if (typeof doc?.status === "string") status = doc.status; } catch { /* unreadable = "" */ }
    }
    rows.push({ domain, status });
  }
  return rows;
}

export type FeedPlan = {
  list: "seen" | "terminal";
  list_id: number | null;
  eligible: number;          // store accounts that belong in this list
  with_id: number;           // ...of which we hold a TheirStack id
  already_in_list: number;   // ...of which the newest snapshot already carries
  add_ids: string[];         // ids to pass to add_companies_to_list
  add_domains: string[];     // same rows, by domain (for the run record)
  without_id: string[];      // eligible accounts no raw capture has an id for (domain leg carries them)
};

// Pure planner — tests drive it directly.
export function planFeed(input: {
  list: "seen" | "terminal";
  listId: number | null;
  accounts: StoreRow[];
  ids: IdMap;
  inList: Set<string>;       // normalized domains already in the target list (newest snapshot)
}): FeedPlan {
  const eligible = input.list === "seen"
    ? input.accounts
    : input.accounts.filter((a) => TERMINAL_STATUSES.has(a.status));
  const addIds: string[] = [];
  const addDomains: string[] = [];
  const withoutId: string[] = [];
  let withId = 0;
  let already = 0;
  for (const a of eligible) {
    const id = input.ids.get(a.domain);
    if (!id) { withoutId.push(a.domain); continue; }
    withId++;
    if (input.inList.has(a.domain)) { already++; continue; }
    addIds.push(id);
    addDomains.push(a.domain);
  }
  return {
    list: input.list, list_id: input.listId, eligible: eligible.length, with_id: withId,
    already_in_list: already, add_ids: addIds, add_domains: addDomains, without_id: withoutId.sort(),
  };
}

// --- CLI ---------------------------------------------------------------------------------

function readSignalConfig(): any {
  return YAML.parse(readFileSync(configPath("signal.yaml"), "utf8"));
}

function parseArgs(argv: string[]) {
  const o: { list?: "seen" | "terminal"; ids: boolean; census: boolean; snapshot?: string } = { ids: false, census: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") { const v = argv[++i]; if (v !== "seen" && v !== "terminal") throw new Error(`--list must be seen|terminal, got ${v}`); o.list = v; }
    else if (a === "--ids") o.ids = true;
    else if (a === "--census") o.census = true;
    else if (a === "--list-snapshot") o.snapshot = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.list && !o.census) throw new Error("need --list seen|terminal or --census");
  return o;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dedupe = readSignalConfig()?.dedupe ?? {};
  const snapshotDir = typeof dedupe.list_snapshot_dir === "string" ? dedupe.list_snapshot_dir : "raw/theirstack/lists";
  const accounts = scanStoreStatuses();
  if (accounts.length === 0) { console.error(`list-feed: no accounts under ${dataPath("accounts")}`); process.exit(2); }
  const { ids, files } = harvestIdsFromRaw();

  if (args.census) {
    const byStatus: Record<string, { total: number; with_id: number }> = {};
    for (const a of accounts) {
      const k = a.status || "(unreadable)";
      byStatus[k] ??= { total: 0, with_id: 0 };
      byStatus[k].total++;
      if (ids.has(a.domain)) byStatus[k].with_id++;
    }
    const withId = accounts.filter((a) => ids.has(a.domain)).length;
    console.log(JSON.stringify({ store_accounts: accounts.length, with_id: withId, without_id: accounts.length - withId, raw_files_scanned: files, ids_harvested: ids.size, by_status: byStatus }, null, 2));
    return;
  }

  const list = args.list as "seen" | "terminal";
  const listId = configuredListId(list === "seen" ? dedupe.company_list_id : dedupe.terminal_list_id) ?? null;
  if (listId === null && !args.snapshot) {
    console.error(`list-feed: dedupe.${list === "seen" ? "company_list_id" : "terminal_list_id"} is not set in config/signal.yaml` +
      (list === "terminal" ? " — create the list once with create_company_list, then set the id" : ""));
    process.exit(2);
  }
  const inList = new Set<string>();
  const snapshot = args.snapshot ?? (listId === null ? null : newestListSnapshot(listId, snapshotDir));
  if (snapshot && existsSync(snapshot)) {
    let doc: any = null;
    try { doc = JSON.parse(readFileSync(snapshot, "utf8")); } catch { console.error(`list-feed: snapshot ${snapshot} is not JSON — planning as if the list were empty`); }
    const rows: any[] = Array.isArray(doc?.result) ? doc.result : Array.isArray(doc?.companies) ? doc.companies : Array.isArray(doc) ? doc : [];
    for (const r of rows) { const d = normalizeDomain(r?.domain ?? r?.company_object?.domain); if (d) inList.add(d); }
  } else {
    console.error(`list-feed: no snapshot for list ${listId} under ${snapshotDir} — planning as if the list were empty (repeats are harmless)`);
  }
  const plan = planFeed({ list, listId, accounts, ids, inList });
  if (args.ids) { for (const id of plan.add_ids) console.log(id); return; }
  console.log(JSON.stringify({ ...plan, snapshot: snapshot ?? null, raw_files_scanned: files }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
