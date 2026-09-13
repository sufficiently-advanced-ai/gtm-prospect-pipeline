// Local store access — $PIPELINE_DATA (default ~/Data/gtm-prospect-pipeline; may be replicated
// between hosts by a file-sync tool, never by git).
// raw/ is append-only capture; accounts/<domain>/account.yaml is canonical derived state.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { hostname } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { PIPELINE_DATA } from "./env.ts";

// All store access resolves through here; reject any path that escapes the store root.
// Domains and slugs originate in EXTERNAL data (Twenty/Apollo/scrapes) — a value like
// "../../x" must never become a filesystem write outside $PIPELINE_DATA.
export function dataPath(...parts: string[]): string {
  const root = resolve(PIPELINE_DATA);
  const p = resolve(root, ...parts);
  if (p !== root && !p.startsWith(root + sep)) throw new Error(`path escapes store root: ${join(...parts)}`);
  return p;
}

export function listAccounts(): string[] {
  const dir = dataPath("accounts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function readAccount(domain: string): any | null {
  const p = dataPath("accounts", domain, "account.yaml");
  if (!existsSync(p)) return null;
  return YAML.parse(readFileSync(p, "utf8"));
}

// Atomic write (temp + rename) so a file-sync tool never replicates a half-written file.
// Temp name is machine+pid-unique so two hosts writing the same account never collide
// on the temp file itself.
export function writeAccount(domain: string, account: any): void {
  const p = dataPath("accounts", domain, "account.yaml");
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${hostname().split(".")[0]}.${process.pid}.tmp`;
  writeFileSync(tmp, YAML.stringify(account, { lineWidth: 100 }));
  renameSync(tmp, p);
}

// Stub creation is CHECK-THEN-WRITE — M1 must never clobber an account that already exists.
// A source's dedupe CAN let an already-active domain back through a pull even when the full
// store is passed as exclusions, and a blind stub write then destroys a mid-sequence account
// (contacts, sequence state, raw pointers). Outreach state is recoverable from the CRM
// mirror; raw provenance is not. Never assume the pull's novelty claim — ask the filesystem.
// Returns false when the domain is already known; the caller counts that as a repeat
// (ignoring the false return is the bug).
export function createAccountStub(domain: string, stub: any): boolean {
  if (existsSync(dataPath("accounts", domain, "account.yaml"))) return false;
  writeAccount(domain, stub);
  return true;
}

// Capture-first: raw payloads are written verbatim, timestamped, before interpretation.
// "wx" = exclusive create: a concurrent duplicate capture fails instead of overwriting.
export function captureRaw(subpath: string, content: string): string {
  const p = dataPath("raw", subpath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, { flag: "wx" });
  return p;
}

export function appendQueue(name: string, markdown: string): string {
  const p = dataPath("queue", name);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, markdown); // O_APPEND — safe under concurrent module runs
  return p;
}

export function appendProgress(line: string): void {
  mkdirSync(PIPELINE_DATA, { recursive: true });
  appendFileSync(dataPath("progress.md"), line.trimEnd() + "\n");
}

export function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

// Status transition with a timestamp — `status_since` powers aging ("stuck N days at
// routed") in the dashboard and reports. Accounts written before this convention lack it;
// readers must degrade to triaged_at/enrolled_at or report age as unknown, never guess.
export function setStatus(account: any, status: string): any {
  if (account.status !== status) {
    account.status = status;
    account.status_since = todayStamp();
  }
  return account;
}

// Stable hash of the CRM-owned field set — makes M8 push a no-op when nothing changed.
export function syncHash(obj: unknown): string {
  const canon = (v: any): any => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
    return v;
  };
  return createHash("sha256").update(JSON.stringify(canon(obj))).digest("hex").slice(0, 16);
}

// File-sync conflict guardrail — run at the start of EVERY module run.
// queue/ is skipped: the conflict REPORT files live there (their names contain
// "sync-conflict"), and scanning them would deadlock the guardrail against itself.
export function scanSyncConflicts(): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (dir === PIPELINE_DATA && e.name === "queue") continue;
      if (e.name.includes("sync-conflict")) hits.push(p);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(PIPELINE_DATA);
  return hits;
}
