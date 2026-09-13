// M7 · decision ledger — pending decisions as first-class store records.
//
// Before this, decisions lived as append-only prose across queue/*.md files and run-record
// notes: no machine-readable open/resolved state, no owner, no age, and the files drifted
// out of date. This ledger is canonical; markdown is a view. Rulings recorded here feed
// the eval-fixture loop — a ruling is how an operator's judgment becomes standing law.
//
//   node skills/m7-recorder-sync/scripts/decisions.ts add --kind <k> --title "…" [--body "…"]
//        [--accounts a.com,b.com] [--subject x.com,y.com] [--unblocks "…"] [--run-id <id>]
//        [--by <who>] [--id <slug>] [--blocked]
//                             (or: add --file <path> | add < entry.json — same keys)
//   node skills/m7-recorder-sync/scripts/decisions.ts list [--all] [--json] [--kind <k>]
//   node skills/m7-recorder-sync/scripts/decisions.ts resolve <id> --ruling "…" [--verdict <v>] [--by <who>]
//   node skills/m7-recorder-sync/scripts/decisions.ts verdicts [--all] [--json]
//   node skills/m7-recorder-sync/scripts/decisions.ts ack <id> [--by <who>] [--note "…"]
//   node skills/m7-recorder-sync/scripts/decisions.ts report
//
// `accounts` = the accounts a decision touches (gating, dashboard links). `subject` (optional)
// = the domains a VERDICT is about, when that differs from `accounts` — e.g. a ruling about a
// lead with no account file that merely mentions a live neighbour account. `verdicts` targets
// `subject` when present, else `accounts`, so the neighbour is never nagged (a drop ruling on
// a rebrand once nagged the live sibling account for weeks). Only the NEWEST resolution per
// target domain is ever pending; older
// rulings on the same domain are reported as superseded, never re-applied (flip-flop guard).
// `ack` records that a run saw a verdict and executed it — or correctly did nothing — so it
// stops resurfacing; it never mutates the store.
//
// File: $PIPELINE_DATA/queue/decisions.jsonl
//
// FILE-SYNC CAVEAT: `add` is append-only (O_APPEND) and safe from any session; `resolve`
// and `ack` REWRITE the file and follow queue/'s soft single-writer convention — rewrite
// from one session at a time. The rewrite is atomic (temp + rename), so concurrent rewrites
// surface as a *.sync-conflict* file via lib/conflict-scan.ts, never as silent loss.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { dataPath, readAccount, todayStamp } from "../../../lib/store.ts";

const LEDGER = dataPath("queue", "decisions.jsonl");
// relabel = an account's signal label changed on new evidence (M2 records one entry per relabel)
const KINDS = ["policy-ruling", "go-live", "sequence-lifecycle", "re-triage", "deferred-enrollment", "data-bug", "ops", "relabel"];
const STATUSES = ["open", "blocked", "resolved"];
// Optional machine-readable verdict on a resolution: dashboard buttons record rulings,
// MODULES execute them — a verdict never mutates the store here. The
// `verdicts` subcommand lists resolutions whose accounts' store state does not yet reflect
// the verdict, and the batch run-start ritual applies them (ruling = the authority).
const VERDICTS = ["skip", "qualified", "drop", "enroll", "hold", "acknowledge"];
// Store statuses that count as "verdict executed" per verdict.
const VERDICT_DONE: Record<string, (status: string) => boolean> = {
  skip: (s) => s === "skipped",
  drop: (s) => s === "dropped",
  hold: (s) => s === "held",
  qualified: (s) => ["routed", "enriched", "enrolled-paused", "active", "replied", "finished"].includes(s),
  enroll: (s) => ["enrolled-paused", "active", "replied", "finished"].includes(s),
  acknowledge: () => true,
};
const ENTRY_KEYS = ["id", "kind", "status", "title", "body", "opened", "accounts", "subject", "unblocks", "resolution"];
// resolution.executed = {date, by, note?} is stamped by `ack`; resolution.superseded_by = <id>
// is an explicit, hand-recorded override of the recency rule (rare — recency covers the norm).
const RESOLUTION_KEYS = ["date", "ruling", "by", "verdict", "executed", "superseded_by"];

const isStr = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
const isIsoDate = (v: unknown): boolean =>
  typeof v === "string"
  && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.test(v)
  && !Number.isNaN(Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v));

const die = (msg: string): never => { console.error(msg); process.exit(1); throw new Error(msg); };

function readLedger(): any[] {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, "utf8").split("\n").filter((l) => l.trim() !== "").map((l, i) => {
    try { return JSON.parse(l); }
    catch { throw new Error(`${LEDGER}:${i + 1} is not valid JSON — repair the line before touching the ledger`); }
  });
}

function writeLedger(entries: any[]): void {
  mkdirSync(dirname(LEDGER), { recursive: true });
  const tmp = `${LEDGER}.${hostname().split(".")[0]}.${process.pid}.tmp`;
  writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
  renameSync(tmp, LEDGER);
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}

const defaultBy = (): string => `${process.env.USER ?? "agent"}@${hostname().split(".")[0]}`;

function validate(entry: any): string[] {
  const errors: string[] = [];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return ["entry must be a JSON object"];
  for (const k of Object.keys(entry)) if (!ENTRY_KEYS.includes(k)) errors.push(`unknown key "${k}"`);
  if (!isStr(entry.id)) errors.push("id: required non-empty slug");
  else if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) errors.push(`id: "${entry.id}" — lowercase slug chars only ([a-z0-9-])`);
  if (!KINDS.includes(entry.kind)) errors.push(`kind: required, one of ${KINDS.join("|")}`);
  if (!STATUSES.includes(entry.status)) errors.push(`status: required, one of ${STATUSES.join("|")}`);
  if (!isStr(entry.title)) errors.push("title: required, one line naming the decision");
  if (entry.body !== undefined && typeof entry.body !== "string") errors.push("body: must be a string");
  const o = entry.opened;
  if (!o || typeof o !== "object" || Array.isArray(o)) errors.push("opened: required object {date, run_id?, by}");
  else {
    for (const k of Object.keys(o)) if (!["date", "run_id", "by"].includes(k)) errors.push(`opened: unknown key "${k}"`);
    if (!isIsoDate(o.date)) errors.push("opened.date: required ISO date");
    if (o.run_id !== undefined && !isStr(o.run_id)) errors.push("opened.run_id: must be a non-empty string");
    if (!isStr(o.by)) errors.push("opened.by: required (who/what opened it)");
  }
  if (!Array.isArray(entry.accounts)) errors.push("accounts: required array of domains (may be empty)");
  else for (const a of entry.accounts)
    if (!isStr(a) || /\s/.test(a)) errors.push(`accounts: "${a}" — each entry must be a domain (non-empty, no spaces)`);
  if (entry.subject !== undefined) {
    if (!Array.isArray(entry.subject) || entry.subject.length === 0) errors.push("subject: when present, a non-empty array of domains the verdict is about");
    else for (const a of entry.subject)
      if (!isStr(a) || /\s/.test(a)) errors.push(`subject: "${a}" — each entry must be a domain (non-empty, no spaces)`);
  }
  if (entry.unblocks !== undefined && !isStr(entry.unblocks)) errors.push("unblocks: must be a non-empty string");
  const r = entry.resolution;
  if (entry.status === "resolved") {
    if (!r || typeof r !== "object" || Array.isArray(r)) errors.push("resolution: required object {date, ruling, by, verdict?} when status is resolved");
    else {
      for (const k of Object.keys(r)) if (!RESOLUTION_KEYS.includes(k)) errors.push(`resolution: unknown key "${k}"`);
      if (!isIsoDate(r.date)) errors.push("resolution.date: required ISO date");
      if (!isStr(r.ruling)) errors.push("resolution.ruling: required — the ruling verbatim, it feeds the eval-fixture loop");
      if (!isStr(r.by)) errors.push("resolution.by: required (who ruled)");
      if (r.verdict !== undefined && !VERDICTS.includes(r.verdict)) errors.push(`resolution.verdict: one of ${VERDICTS.join("|")} when present`);
      if (r.superseded_by !== undefined && !isStr(r.superseded_by)) errors.push("resolution.superseded_by: must be the id of the newer ruling when present");
      const x = r.executed;
      if (x !== undefined) {
        if (!x || typeof x !== "object" || Array.isArray(x)) errors.push("resolution.executed: must be an object {date, by, note?} when present");
        else {
          for (const k of Object.keys(x)) if (!["date", "by", "note"].includes(k)) errors.push(`resolution.executed: unknown key "${k}"`);
          if (!isIsoDate(x.date)) errors.push("resolution.executed.date: required ISO date");
          if (!isStr(x.by)) errors.push("resolution.executed.by: required (who/what executed it)");
          if (x.note !== undefined && typeof x.note !== "string") errors.push("resolution.executed.note: must be a string");
        }
      }
    }
  } else if (r !== undefined && r !== null) {
    errors.push(`resolution: must be null/absent unless status is resolved (got status "${entry.status}")`);
  }
  return errors;
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) die(`${flag} needs a value`);
  return v;
}

// ---------------------------------------------------------------------------
function cmdAdd(argv: string[]): void {
  const file = flagValue(argv, "--file");
  let entry: any;
  if (file || !process.stdin.isTTY) {
    // JSON mode — same keys as the record itself; defaults still applied below.
    let text = "";
    try { text = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8"); } catch (err: any) { die(`cannot read input: ${err.message}`); }
    if (text.trim() === "" && !file) {
      entry = null; // empty stdin (e.g. spawned with no input) → fall through to flag mode
    } else {
      try { entry = JSON.parse(text); } catch (err: any) { die(`input is not valid JSON: ${err.message}`); }
    }
  }
  if (!entry) {
    const title = flagValue(argv, "--title");
    if (!title) die("no input: pass --title (with --kind etc.), or --file <path>, or pipe entry JSON on stdin");
    entry = {
      id: flagValue(argv, "--id"),
      kind: flagValue(argv, "--kind"),
      status: argv.includes("--blocked") ? "blocked" : undefined,
      title,
      body: flagValue(argv, "--body"),
      accounts: flagValue(argv, "--accounts")?.split(",").map((s) => s.trim()).filter(Boolean),
      subject: flagValue(argv, "--subject")?.split(",").map((s) => s.trim()).filter(Boolean),
      unblocks: flagValue(argv, "--unblocks"),
      opened: { date: undefined, run_id: flagValue(argv, "--run-id"), by: flagValue(argv, "--by") },
    };
  }

  // Defaults — applied in both modes, then validated strictly.
  entry.id ??= `d-${todayStamp()}-${slugify(entry.title ?? "")}`;
  entry.status ??= "open";
  entry.accounts ??= [];
  entry.body ??= "";
  entry.opened = { date: todayStamp(), by: defaultBy(), ...(entry.opened ?? {}) };
  if (entry.opened.date === undefined) entry.opened.date = todayStamp();
  if (entry.opened.by === undefined) entry.opened.by = defaultBy();
  if (entry.opened.run_id === undefined) delete entry.opened.run_id;
  if (entry.unblocks === undefined) delete entry.unblocks;
  if (entry.subject === undefined) delete entry.subject; // absent unless given — old-shape entries stay old-shape
  entry.resolution ??= null; // canonical shape: resolution is explicitly null while pending

  const errors = validate(entry);
  const existing = readLedger();
  if (existing.some((e) => e.id === entry.id))
    errors.push(`id: "${entry.id}" already exists — pass a distinct --id (or resolve/edit the existing entry)`);
  if (errors.length) {
    console.error(`REJECTED — ${errors.length} error(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
    return;
  }

  mkdirSync(dirname(LEDGER), { recursive: true });
  appendFileSync(LEDGER, JSON.stringify(entry) + "\n"); // O_APPEND — safe from any session
  console.log(JSON.stringify(entry));
  console.error(`opened ${entry.id} (${entry.kind}) in ${LEDGER}`);
}

// ---------------------------------------------------------------------------
const daysOpen = (e: any): number =>
  Math.max(0, Math.floor((Date.now() - Date.parse(`${String(e.opened.date).slice(0, 10)}T00:00:00Z`)) / 86_400_000));

function cmdList(argv: string[]): void {
  const all = argv.includes("--all");
  const kindFilter = flagValue(argv, "--kind");
  if (kindFilter && !KINDS.includes(kindFilter)) die(`--kind: "${kindFilter}" — one of ${KINDS.join("|")}`);
  let entries = readLedger();
  if (kindFilter) entries = entries.filter((e) => e.kind === kindFilter);
  const unresolved = entries.filter((e) => e.status !== "resolved");
  const shown = all ? entries : unresolved;

  if (argv.includes("--json")) {
    for (const e of shown) console.log(JSON.stringify(e));
    return;
  }
  if (shown.length === 0) {
    console.log(all ? `ledger empty (${LEDGER})` : "decisions: 0 open — nothing awaiting a ruling");
    return;
  }
  // Oldest first — age is the point of this view.
  const byAge = [...shown].sort((a, b) => String(a.opened.date).localeCompare(String(b.opened.date)));
  for (const e of byAge) {
    const state = e.status === "resolved"
      ? `resolved ${String(e.resolution?.date ?? "").slice(0, 10)}`
      : `${e.status.toUpperCase().padEnd(7)} ${String(daysOpen(e)).padStart(3)}d`;
    const acct = e.accounts.length ? `  [${e.accounts.length} acct]` : "";
    console.log(`${state}  ${e.kind.padEnd(19)}  ${e.id}${acct}  ${e.title}`);
  }
  console.log("");
  console.log(`open+blocked: ${unresolved.length}  |  resolved: ${entries.length - unresolved.length}  |  ${LEDGER}`);
}

// ---------------------------------------------------------------------------
function cmdResolve(argv: string[]): void {
  const id = argv[0];
  if (!id || id.startsWith("--")) die("resolve needs the decision id first: resolve <id> --ruling \"…\"");
  const ruling = flagValue(argv, "--ruling");
  if (!isStr(ruling)) die("--ruling is required — record the ruling verbatim (it feeds the eval-fixture loop)");

  const entries = readLedger();
  const e = entries.find((x) => x.id === id);
  if (!e) die(`no decision "${id}" in ${LEDGER} — \`list\` shows ids`);
  if (e.status === "resolved") die(`"${id}" is already resolved (${e.resolution?.date}) — rulings are append-only history, open a new decision to revisit`);

  const verdict = flagValue(argv, "--verdict");
  if (verdict !== undefined && !VERDICTS.includes(verdict)) die(`--verdict: "${verdict}" — one of ${VERDICTS.join("|")}`);
  e.status = "resolved";
  e.resolution = { date: todayStamp(), ruling, by: flagValue(argv, "--by") ?? defaultBy(), ...(verdict ? { verdict } : {}) };
  const errors = validate(e);
  if (errors.length) die(`internal: resolved entry failed validation: ${errors.join("; ")}`);
  writeLedger(entries);
  console.log(JSON.stringify(e));
  console.error(`resolved ${id} — ${e.resolution.ruling.slice(0, 80)}${e.resolution.ruling.length > 80 ? "…" : ""}`);
}

// ---------------------------------------------------------------------------
function cmdReport(): void {
  const entries = readLedger();
  if (entries.length === 0) { console.log("no decisions recorded yet"); return; }
  const open = entries.filter((e) => e.status !== "resolved");
  console.log(`decisions: ${entries.length} total | ${open.length} open+blocked | ${entries.length - open.length} resolved`);
  console.log("");
  for (const k of KINDS) {
    const ofKind = open.filter((e) => e.kind === k);
    if (ofKind.length === 0) continue;
    const oldest = Math.max(...ofKind.map(daysOpen));
    console.log(`  ${k.padEnd(19)}  ${String(ofKind.length).padStart(2)} open  (oldest ${oldest}d)`);
  }
  const accounts = new Set(open.flatMap((e) => e.accounts));
  if (accounts.size) {
    console.log("");
    console.log(`accounts gated on an open decision: ${accounts.size}`);
  }
  const aged = open.filter((e) => daysOpen(e) >= 7);
  if (aged.length) {
    console.log("");
    console.log(`open ≥7 days (${aged.length}):`);
    for (const e of aged.sort((a, b) => daysOpen(b) - daysOpen(a)))
      console.log(`  ${String(daysOpen(e)).padStart(3)}d  ${e.id}  ${e.title}`);
  }
}

// ---------------------------------------------------------------------------
// Rulings awaiting execution: resolved-with-verdict entries whose TARGET domains' store state
// does not yet reflect the verdict. The batch run-start ritual reads this and applies the
// flips (setStatus + M8 push), quoting resolution.ruling as the authority, then `ack`s. Read-only here.
//
// Targets are `subject` when present, else `accounts`. Three guards, each paid for by runs
// that looped on the same entries night after night:
//   recency    — per target domain only the newest resolution (resolution.date, then file
//                position) can be pending; older ones are "superseded by <id>", never re-applied
//   subject    — a target with no account.yaml is informational ("not executable"), never a
//                nag against a bystander listed in `accounts`
//   executed   — an entry `ack`ed (resolution.executed) is never pending again
const resolvedAt = (e: any): number => {
  const d = String(e.resolution?.date ?? "");
  return Date.parse(d.length === 10 ? `${d}T00:00:00Z` : d) || 0;
};
const verdictTargets = (e: any): string[] => (Array.isArray(e.subject) && e.subject.length ? e.subject : (e.accounts ?? []));

function cmdVerdicts(argv: string[]): void {
  const ruled = readLedger()
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.status === "resolved" && e.resolution?.verdict);

  // Newest ruling per target domain — the only one eligible to be pending for that domain.
  // (An entry explicitly marked superseded_by yields to the ruling it names, whatever the dates.)
  const newest = new Map<string, { e: any; i: number }>();
  for (const r of ruled) for (const d of verdictTargets(r.e)) {
    if (r.e.resolution.superseded_by) continue;
    const cur = newest.get(d);
    if (!cur || resolvedAt(r.e) > resolvedAt(cur.e) || (resolvedAt(r.e) === resolvedAt(cur.e) && r.i > cur.i)) newest.set(d, r);
  }

  const pending: any[] = [], superseded: any[] = [], no_account: any[] = [], executed: any[] = [];
  for (const { e } of ruled) {
    const v = e.resolution.verdict;
    const base = { id: e.id, verdict: v, ruling: e.resolution.ruling, resolved: e.resolution.date };
    const targets = verdictTargets(e);
    if (e.resolution.executed) { executed.push({ ...base, executed: e.resolution.executed, domains: targets }); continue; }
    if (e.resolution.superseded_by) { superseded.push({ ...base, superseded_by: e.resolution.superseded_by, domains: targets, explicit: true }); continue; }
    const done = VERDICT_DONE[v] ?? (() => true);
    const unexecuted: any[] = [], older: Record<string, string[]> = {}, missing: string[] = [];
    for (const d of targets) {
      const winner = newest.get(d);
      if (winner && winner.e !== e) { (older[winner.e.id] ??= []).push(d); continue; }
      const a = readAccount(d);
      if (!a) { missing.push(d); continue; }
      if (!done(String(a.status))) unexecuted.push({ domain: d, status: a.status });
    }
    if (unexecuted.length) pending.push({ ...base, accounts: unexecuted, ...(e.subject ? { subject: true } : {}) });
    for (const [by, domains] of Object.entries(older)) superseded.push({ ...base, superseded_by: by, domains });
    if (missing.length) no_account.push({ ...base, domains: missing });
  }

  if (argv.includes("--json")) { console.log(JSON.stringify({ pending, superseded, no_account, executed })); return; }
  const all = argv.includes("--all");
  if (pending.length === 0) console.log("no verdicts awaiting execution — store reflects every ruling");
  for (const p of pending) {
    console.log(`${p.verdict.toUpperCase().padEnd(11)} ${p.id}  (ruled ${p.resolved}${p.subject ? ", subject-targeted" : ""})`);
    for (const a of p.accounts) console.log(`    ${a.domain}  currently status:${a.status}`);
    console.log(`    ruling: ${String(p.ruling).slice(0, 120)}`);
  }
  if (no_account.length) {
    console.log("");
    console.log(`no account file — not executable (${no_account.length}, informational):`);
    for (const n of no_account) console.log(`    ${n.verdict.toUpperCase().padEnd(11)} ${n.id}  ${n.domains.join(", ")}  (ruled ${n.resolved})`);
  }
  if (superseded.length) {
    console.log("");
    if (all) {
      console.log(`superseded — not pending (${superseded.length}):`);
      for (const s of superseded) console.log(`    ${s.verdict.toUpperCase().padEnd(11)} ${s.id}  superseded by ${s.superseded_by}${s.explicit ? " (explicit)" : ""}  [${s.domains.join(", ")}]  (ruled ${s.resolved})`);
    } else console.log(`superseded by a newer ruling on the same domain — not pending: ${superseded.length}  (--all to list)`);
  }
  if (all && executed.length) {
    console.log("");
    console.log(`executed / acknowledged (${executed.length}):`);
    for (const x of executed) console.log(`    ${x.verdict.toUpperCase().padEnd(11)} ${x.id}  ack ${String(x.executed.date).slice(0, 10)} by ${x.executed.by}${x.executed.note ? ` — ${x.executed.note}` : ""}`);
  }
  if (pending.length) {
    console.log("");
    console.log(`${pending.length} verdict(s) awaiting execution — apply via the module (setStatus + M8 push), then \`ack <id>\`; never hand-edit the ledger`);
  }
}

// ---------------------------------------------------------------------------
// Acknowledge a ruling as executed — including "saw it, correctly did nothing" — so it
// stops resurfacing in `verdicts`. Stamps resolution.executed; never touches the store.
function cmdAck(argv: string[]): void {
  const id = argv[0];
  if (!id || id.startsWith("--")) die("ack needs the decision id first: ack <id> [--by <who>] [--note \"…\"]");
  const entries = readLedger();
  const e = entries.find((x) => x.id === id);
  if (!e) die(`no decision "${id}" in ${LEDGER} — \`list\` shows ids`);
  if (e.status !== "resolved") die(`"${id}" is ${e.status}, not resolved — ack records execution of a ruling; resolve it first`);
  if (!e.resolution?.verdict) die(`"${id}" has no verdict — nothing to execute or acknowledge`);
  if (e.resolution.executed) die(`"${id}" already acknowledged (${e.resolution.executed.date} by ${e.resolution.executed.by})`);
  const note = flagValue(argv, "--note");
  e.resolution.executed = { date: todayStamp(), by: flagValue(argv, "--by") ?? defaultBy(), ...(note ? { note } : {}) };
  const errors = validate(e);
  if (errors.length) die(`internal: acknowledged entry failed validation: ${errors.join("; ")}`);
  writeLedger(entries);
  console.log(JSON.stringify(e));
  console.error(`acknowledged ${id} (${e.resolution.verdict}) — executed ${e.resolution.executed.date} by ${e.resolution.executed.by}`);
}

// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const cmd = argv[0];
if (!cmd || cmd === "--help" || cmd === "-h") {
  console.log("usage: decisions.ts add --kind <k> --title \"…\" [--body …] [--accounts a.com,b.com]");
  console.log("                        [--subject x.com,y.com] [--unblocks …] [--run-id …] [--by …] [--id …] [--blocked]");
  console.log("                        (or: add --file <path> | add < entry.json)");
  console.log("       decisions.ts list [--all] [--json] [--kind <k>]");
  console.log("       decisions.ts resolve <id> --ruling \"…\" [--verdict <v>] [--by <who>]");
  console.log("       decisions.ts verdicts [--all] [--json]   # rulings not yet reflected in the store (newest per domain)");
  console.log("       decisions.ts ack <id> [--by <who>] [--note \"…\"]   # mark a ruling executed / seen-and-nothing-to-do");
  console.log("       decisions.ts report");
  console.log(`kinds: ${KINDS.join(" | ")}   verdicts: ${VERDICTS.join(" | ")}`);
} else if (cmd === "add") cmdAdd(argv.slice(1));
else if (cmd === "list") cmdList(argv.slice(1));
else if (cmd === "resolve") cmdResolve(argv.slice(1));
else if (cmd === "verdicts") cmdVerdicts(argv.slice(1));
else if (cmd === "ack") cmdAck(argv.slice(1));
else if (cmd === "report") cmdReport();
else die(`unknown subcommand "${cmd}" — expected add | list | resolve | verdicts | ack | report`);
