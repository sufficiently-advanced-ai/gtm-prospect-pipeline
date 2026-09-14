// Fixture backlog — the mechanical link in the eval flywheel.
//
// A ruling recorded in the decision ledger (dashboard button or `decisions.ts resolve`) is a
// lesson the pipeline paid for. It is only PROTECTED once it is an eval fixture, because only
// fixtures gate future edits to the skill text and the ICP. This script lists every resolved
// judgment ruling that names an account and has no fixture yet — in cases/ or staging/ — and
// prints the exact draft command for each. Run by M7 at the end of every batch and by the
// orchestrator's run-start ritual; the dashboard shows the count.
//
//   node evals/fixture-backlog.ts [--json] [--count] [--all-kinds] [--fixtures <dir>]
//
// Read-only. Exit 0 always — a backlog is work, not a failure. Coverage is by ledger id
// (fixture provenance.decision_id) or, for fixtures drafted before that field existed, by
// domain (provenance.domain).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { dataPath } from "../lib/store.ts";

// Ledger kinds that encode a JUDGMENT about an account — the ones evals can protect.
// go-live / ops / sequence-lifecycle / deferred-enrollment / relabel are process, not judgment.
export const JUDGMENT_KINDS = new Set(["re-triage", "policy-ruling", "data-bug"]);

export type Candidate = {
  id: string;
  kind: string;
  domain: string;
  date: string;
  verdict?: string;
  ruling: string;
  task: "fit-triage" | "route";
  command: string;
};

export type Backlog = {
  candidates: Candidate[];
  covered: number;          // resolved judgment rulings that already have a fixture
  skipped: number;          // resolved rulings with no account named (nothing to draft from)
};

function readJsonl(path: string): any[] {
  if (!existsSync(path)) return [];
  const out: any[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a broken line is not a reason to crash */ }
  }
  return out;
}

const bare = (d: unknown) => String(d ?? "").trim().toLowerCase().replace(/^www\./, "");

// Every fixture.yaml under <root>/cases/<task>/<id>/ and <root>/staging/<id>/.
function fixtureProvenance(root: string): { domains: Set<string>; decisionIds: Set<string> } {
  const domains = new Set<string>();
  const decisionIds = new Set<string>();
  const visit = (dir: string, depth: number) => {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (depth > 0) visit(p, depth - 1); continue; }
      if (e.name !== "fixture.yaml") continue;
      let doc: any;
      try { doc = YAML.parse(readFileSync(p, "utf8")); } catch { continue; }
      const prov = doc?.provenance ?? {};
      if (typeof prov.domain === "string") domains.add(bare(prov.domain));
      if (typeof prov.decision_id === "string") decisionIds.add(prov.decision_id.trim());
    }
  };
  visit(join(root, "cases"), 2);
  visit(join(root, "staging"), 1);
  return { domains, decisionIds };
}

export function fixtureBacklog(opts: { ledgerPath?: string; fixturesRoot?: string; allKinds?: boolean } = {}): Backlog {
  const ledger = opts.ledgerPath ?? dataPath("queue", "decisions.jsonl");
  const root = opts.fixturesRoot ?? fileURLToPath(new URL("./fixtures/", import.meta.url));
  const { domains, decisionIds } = fixtureProvenance(root);

  const candidates: Candidate[] = [];
  let covered = 0, skipped = 0;
  for (const e of readJsonl(ledger)) {
    if (e?.status !== "resolved") continue;
    if (!opts.allKinds && !JUDGMENT_KINDS.has(String(e.kind))) continue;
    const ruling = String(e?.resolution?.ruling ?? "").trim();
    if (!ruling) continue;
    const named = [
      ...(Array.isArray(e.accounts) ? e.accounts : []),
      ...(Array.isArray(e.subject) ? e.subject : []),
    ].map(bare).filter(Boolean);
    if (!named.length) { skipped++; continue; }
    if (decisionIds.has(String(e.id))) { covered++; continue; }
    const verdict = typeof e?.resolution?.verdict === "string" ? e.resolution.verdict : undefined;
    const task: Candidate["task"] = verdict === "drop" || e.kind === "data-bug" ? "fit-triage" : "route";
    for (const domain of [...new Set(named)]) {
      if (domains.has(domain)) { covered++; continue; }
      candidates.push({
        id: String(e.id), kind: String(e.kind), domain,
        date: String(e?.resolution?.date ?? ""), verdict, ruling, task,
        command: `node evals/draft-fixture.ts ${domain} --task ${task} --decision ${e.id}`,
      });
    }
  }
  candidates.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { candidates, covered, skipped };
}

function main(argv: string[]): number {
  const args = argv.slice(2);
  const flag = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const b = fixtureBacklog({
    fixturesRoot: flag("--fixtures") ? resolve(String(flag("--fixtures"))) : undefined,
    ledgerPath: flag("--ledger") ? resolve(String(flag("--ledger"))) : undefined,
    allKinds: args.includes("--all-kinds"),
  });
  if (args.includes("--count")) { console.log(String(b.candidates.length)); return 0; }
  if (args.includes("--json")) { console.log(JSON.stringify(b, null, 2)); return 0; }
  if (!b.candidates.length) {
    console.log(`fixture backlog: 0 — every resolved judgment ruling that names an account has a fixture (${b.covered} covered).`);
    return 0;
  }
  console.log(`fixture backlog: ${b.candidates.length} ruling(s) without a fixture (${b.covered} covered). Draft each, confirm the gold, name the trap:`);
  for (const c of b.candidates) {
    const r = c.ruling.length > 90 ? c.ruling.slice(0, 87) + "…" : c.ruling;
    console.log(`\n  ${c.id}  [${c.kind}${c.verdict ? ` · ${c.verdict}` : ""}]  ${c.date}`);
    console.log(`    ${c.domain}: "${r}"`);
    console.log(`    ${c.command}`);
  }
  console.log(`\nThen: move the staged dir into evals/fixtures/cases/<task>/, run the suite live once, rewrite the baseline.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv));
