// M8 · decision mirror — open ledger decisions surface as Twenty tasks; resolutions
// complete them. Store is canonical (queue/decisions.jsonl); Twenty is a mirror; this
// script never writes the ledger and never triggers anything.
//
//   node skills/m8-crm-sync/scripts/mirror-decisions.ts [--dry-run]
//
// Mirroring contract:
// - open|blocked decision + ≥1 account with crm.twenty_company_id → ONE task, title
//   "Decision: <id>" (id-in-title = the deterministic dedupe key; ids are unique and titles
//   never change), targeted at every account that has a CRM id.
// - resolved decision whose task is still TODO → completeTask (status DONE) + nothing else;
//   the ruling itself lives in the store and the M7 records, not in task edits.
// - decisions with NO CRM-visible account (policy rulings, ops, dropped/holdout accounts)
//   are NOT mirrored — tasks need a target; they surface in the dashboard instead.
// - Twenty unreachable after the client's built-in retries → BLOCKED queue entry, exit 1,
//   never blocks a batch (M8 standing rule). Idempotent: re-run any time.
import { readFileSync, existsSync } from "node:fs";
import { appendQueue, dataPath, readAccount, todayStamp } from "../../../lib/store.ts";
import { addTask, completeTask, pageAll } from "../../../lib/twenty.ts";

const dryRun = process.argv.includes("--dry-run");

const LEDGER = dataPath("queue", "decisions.jsonl");
const decisions: any[] = existsSync(LEDGER)
  ? readFileSync(LEDGER, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
  : [];
if (decisions.length === 0) { console.log("no decisions in ledger — nothing to mirror"); process.exit(0); }

const title = (d: any): string => `Decision: ${d.id}`;

function body(d: any): string {
  const lines = [
    `**${d.title}**`, "",
    `kind: ${d.kind} · opened ${d.opened?.date} by ${d.opened?.by}${d.opened?.run_id ? ` (run ${d.opened.run_id})` : ""}`,
  ];
  if (d.accounts?.length) lines.push(`accounts: ${d.accounts.join(", ")}`);
  if (d.unblocks) lines.push(`unblocks: ${d.unblocks}`);
  if (d.body) lines.push("", d.body);
  lines.push("", `resolve: \`node skills/m7-recorder-sync/scripts/decisions.ts resolve ${d.id} --ruling "…"\``);
  return lines.join("\n");
}

// CRM targets for a decision: every listed account that has a mirrored company.
function targetsFor(d: any): string[] {
  const ids: string[] = [];
  for (const domain of d.accounts ?? []) {
    const id = readAccount(domain)?.crm?.twenty_company_id;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

let allTasks: any[], allTaskTargets: any[];
try {
  [allTasks, allTaskTargets] = [await pageAll("tasks"), await pageAll("taskTargets")];
} catch (e: any) {
  appendQueue(`crm-push-failures-${todayStamp()}.md`,
    `## ${new Date().toISOString()} mirror-decisions BLOCKED: ${String(e.message).slice(0, 200)}\nRe-run: node skills/m8-crm-sync/scripts/mirror-decisions.ts\n`);
  console.error(`BLOCKED: Twenty unreachable (${e.message}) — mirror queued for re-run, batch continues.`);
  process.exit(1);
}
// Dedupe on the task TITLE alone: "Decision: <id>" is unique by construction (ledger ids
// are unique), which sidesteps the create-vs-read target-field asymmetry entirely.
const taskByTitle: Record<string, any> = Object.fromEntries(allTasks.map((t: any) => [t.title, t]));

let created = 0, completed = 0, skippedNoTarget = 0, unchanged = 0;
for (const d of decisions) {
  const existing = taskByTitle[title(d)];
  if (d.status === "resolved") {
    if (existing && existing.status !== "DONE") {
      if (!dryRun) await completeTask(existing.id);
      completed++;
      console.log(`${dryRun ? "[dry] " : ""}DONE  ${title(d)}  (${d.resolution?.date})`);
    } else unchanged++;
    continue;
  }
  if (existing) { unchanged++; continue; }
  const companyIds = targetsFor(d);
  if (companyIds.length === 0) { skippedNoTarget++; continue; }
  if (!dryRun) await addTask(title(d), body(d), null, companyIds.map((id) => ({ targetCompanyId: id })));
  created++;
  console.log(`${dryRun ? "[dry] " : ""}TODO  ${title(d)}  -> ${d.accounts.join(", ")} (${companyIds.length} CRM target(s))`);
}

console.log("");
console.log(`mirror-decisions: ${created} created, ${completed} completed, ${unchanged} unchanged, ${skippedNoTarget} not mirrored (no CRM-visible account — dashboard-only)${dryRun ? "  [dry-run: nothing written]" : ""}`);
