// `discovered_at_max_age_days` for a discovery signal's next pull — the "ask only for what
// the source found since my last run" leg. READ-ONLY over raw/theirstack/ and config/. It
// decides the window; M1 puts it in the payload.
//
// Why: a description-pattern filter cannot use an index — it regex-scans the description of
// every posting in the posted_at window on EVERY call, and that scan is what times a search
// out (not the length of the domain-exclusion leg). A daily discovery run already dedupes
// against the seen-list, so re-scanning the whole window every morning re-derives an answer
// it has; asking only for what was discovered since the last run cut an identical query
// several-fold with the same results.
//
// Why it is a script and not a rule in prose: the leg is only safe when N covers the gap
// since the last BILLED pull of THIS signal. A posting that ages out of the discovered_at
// window before it is fetched never re-enters it — it is lost for good. Two gotchas, both
// enforced here and in the M1 procedure:
//   1. `discovered_at_*` alone is rejected by the API ("Missing mandatory filter") —
//      `posted_at_max_age_days` STAYS in the payload; the scan is bounded by the smaller
//      window, which is the whole point.
//   2. If the previous pull returned exactly `limit` rows the pool was not drained (older
//      discoveries were never fetched), so the leg is dropped for this run — as it is on
//      the weekly sweep (--sweep) — and the full posted_at window is scanned.
// Not for merge-mode / posting-age signals (a "still open after N days" signal asks how OLD
// a posting is; that is a posted_at question by definition). Signals opt in with
// `discovered_at_lookback: auto` in config/signal.yaml; a block without it, or with
// `dedupe_mode: merge`, always plans the full window so M1 can call this uniformly.
//
// CLI:
//   node lib/discovered-window.ts --signal-key <key>           # JSON plan
//   node lib/discovered-window.ts --signal-key <key> --sweep   # forces null (full window)
//   --pad <days>   safety margin added to the gap (default 2)
//   --today <yyyy-mm-dd>  for tests
// Exit 0 whenever the signal key exists in config; `discovered_at_max_age_days: null` means
// "omit the leg this run". Exit 2 when the key is not a block in config/signal.yaml.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { configPath } from "./env.ts";
import { dataPath } from "./store.ts";

export type PullRecord = { date: string; n: number; returned: number; limit: number | null; file: string };

export type WindowPlan = {
  signal_key: string;
  last_pull: PullRecord | null;
  days_since_last_pull: number | null;
  drained: boolean | null;                 // false = previous pull hit `limit` (pool not drained)
  discovered_at_max_age_days: number | null;
  reason: string;
};

const PAD_DEFAULT = 2;

// The config gate: a reason to plan the full window without looking at raw/, or null when
// the block opts in. Pure, so tests can drive it with a literal block.
export function optOutReason(block: unknown): string | null {
  if (!block || typeof block !== "object") return "signal block is not a mapping — full posted_at window";
  const b = block as Record<string, unknown>;
  if (b.dedupe_mode === "merge") return "merge-mode signal asks how OLD a posting is (a posted_at question) — no discovered_at leg";
  if (b.discovered_at_lookback !== "auto") return "signal does not opt in (discovered_at_lookback is not `auto`) — full posted_at window";
  return null;
}

// Newest billed pull of this signal = highest -pull-<n> on the newest date.
export function findLastPull(signalKey: string, files: string[], readDoc: (f: string) => any): PullRecord | null {
  const re = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})-${signalKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-pull-(\\d+)\\.json$`);
  let best: { date: string; n: number; file: string } | null = null;
  for (const f of files) {
    const m = re.exec(f);
    if (!m) continue;
    const cand = { date: m[1], n: Number(m[2]), file: f };
    if (!best || cand.date > best.date || (cand.date === best.date && cand.n > best.n)) best = cand;
  }
  if (!best) return null;
  const doc = readDoc(best.file);
  const rows = Array.isArray(doc?.data) ? doc.data : Array.isArray(doc?.result) ? doc.result : [];
  const limit = Number.isInteger(doc?._request?.limit) ? Number(doc._request.limit) : null;
  return { ...best, returned: rows.length, limit };
}

// Pure planner.
export function planWindow(input: { signalKey: string; last: PullRecord | null; today: Date; pad?: number; sweep?: boolean; optOut?: string | null }): WindowPlan {
  const pad = input.pad ?? PAD_DEFAULT;
  const base = { signal_key: input.signalKey, last_pull: input.last };
  if (input.optOut) return { ...base, days_since_last_pull: null, drained: null, discovered_at_max_age_days: null, reason: input.optOut };
  if (input.sweep) return { ...base, days_since_last_pull: null, drained: null, discovered_at_max_age_days: null, reason: "sweep run — full posted_at window" };
  if (!input.last) return { ...base, days_since_last_pull: null, drained: null, discovered_at_max_age_days: null, reason: "no previous billed pull of this signal — full posted_at window" };
  const t = Date.parse(`${input.last.date}T00:00:00Z`);
  const days = Math.max(0, Math.floor((input.today.getTime() - t) / 86_400_000));
  if (input.last.limit === null) return { ...base, days_since_last_pull: days, drained: null, discovered_at_max_age_days: null, reason: "previous pull did not record _request.limit — cannot prove the pool was drained; full window" };
  const drained = input.last.returned < input.last.limit;
  if (!drained) return { ...base, days_since_last_pull: days, drained, discovered_at_max_age_days: null, reason: `previous pull returned ${input.last.returned} = limit ${input.last.limit} — pool not drained; full window` };
  return { ...base, days_since_last_pull: days, drained, discovered_at_max_age_days: days + pad, reason: `gap ${days}d + pad ${pad}d; posted_at_max_age_days stays in the payload` };
}

function parseArgs(argv: string[]) {
  const o: { signalKey?: string; sweep: boolean; pad?: number; today?: Date } = { sweep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--signal-key") o.signalKey = argv[++i];
    else if (a === "--sweep") o.sweep = true;
    else if (a === "--pad") { o.pad = Number(argv[++i]); if (!Number.isInteger(o.pad) || o.pad < 0) throw new Error("--pad must be a non-negative integer"); }
    else if (a === "--today") { o.today = new Date(`${argv[++i]}T00:00:00Z`); if (Number.isNaN(o.today.getTime())) throw new Error("--today must be yyyy-mm-dd"); }
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.signalKey) throw new Error("need --signal-key <key>");
  return o;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const key = args.signalKey as string;
  const cfgFile = configPath("signal.yaml");
  const cfg: any = YAML.parse(readFileSync(cfgFile, "utf8"));
  if (!cfg || typeof cfg !== "object" || !(key in cfg) || ["dedupe", "limits"].includes(key)) {
    console.error(`discovered-window: no signal block "${key}" in ${cfgFile}`);
    process.exit(2);
  }
  const optOut = optOutReason(cfg[key]);
  const dir = dataPath("raw", "theirstack");
  const files = optOut ? [] : existsSync(dir) ? readdirSync(dir) : [];
  const last = optOut ? null : findLastPull(key, files, (f) => { try { return JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { return null; } });
  const plan = planWindow({ signalKey: key, last, today: args.today ?? new Date(), pad: args.pad, sweep: args.sweep, optOut });
  console.log(JSON.stringify(plan, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
