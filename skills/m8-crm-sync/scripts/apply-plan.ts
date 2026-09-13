// M8 reconcile, apply half — executes a reconcile plan produced by the M8 skill
// (the gather half pages Apollo via MCP, captures to raw/apollo/, diffs against
// accounts/, and emits this plan).
//
// Usage: node apply-plan.ts <plan.json>
//
// Plan shape (all sections optional):
// {
//   "accountUpdates":  [{ "domain", "status", "contactUpdates": [{ "apollo_contact_id", "sequence_status", "sequence_step", "apollo_sequence_id", "enrolled_at" }] }],
//     — apollo_sequence_id/enrolled_at are set when a contact was re-enrolled in a
//       different sequence Apollo-side (human action in the Apollo UI); the store's
//       single-enrollment contact model tracks the CURRENT enrollment, and the prior
//       one stays recoverable from raw/apollo/_exports/.
//   "notes":           [{ "domain", "title", "markdown", "alsoPerson": "<apollo_contact_id>" }],
//   "tasks":           [{ "domain", "title", "markdown", "dueAt" }],
//   "opportunities":   [{ "domain", "name", "stage": "NEW" }]
// }
// Store is updated FIRST (canonical), then mirrored via push.ts logic per account.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readAccount, writeAccount, appendProgress, scanSyncConflicts, appendQueue, todayStamp } from "../../../lib/store.ts";
import { addNote, addTask, api, pageAll } from "../../../lib/twenty.ts";

const planPath = process.argv[2];
if (!planPath) { console.error("usage: apply-plan.ts <plan.json>"); process.exit(1); }
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const here = dirname(fileURLToPath(import.meta.url));

// Run-start ritual — the canonical store is about to be mutated
const conflicts = scanSyncConflicts();
if (conflicts.length) {
  appendQueue(
    `sync-conflicts-${todayStamp()}.md`,
    `## ${new Date().toISOString()} — found by m8 apply-plan\n${conflicts.map((c) => `- ${c}`).join("\n")}\n`,
  );
  console.error(`ABORT: ${conflicts.length} sync-conflict file(s) — routed to queue/, resolve first.`);
  process.exit(2);
}

const touched = new Set<string>();

// 1. store updates (canonical first)
for (const u of plan.accountUpdates ?? []) {
  const a = readAccount(u.domain);
  if (!a) { console.error(`no account.yaml: ${u.domain}`); continue; }
  if (u.status) a.status = u.status;
  for (const cu of u.contactUpdates ?? []) {
    const c = (a.contacts ?? []).find((x: any) => x.apollo_contact_id === cu.apollo_contact_id);
    if (!c) { console.error(`${u.domain}: contact ${cu.apollo_contact_id} not in account.yaml`); continue; }
    if (cu.sequence_status) c.sequence_status = cu.sequence_status;
    if (cu.sequence_step != null) c.sequence_step = cu.sequence_step;
    if (cu.apollo_sequence_id) c.apollo_sequence_id = cu.apollo_sequence_id;
    if (cu.enrolled_at) c.enrolled_at = cu.enrolled_at;
  }
  writeAccount(u.domain, a);
  touched.add(u.domain);
}
console.log(`store updated: ${touched.size} accounts`);

// 2. mirror to Twenty — a push failure must not abort notes/tasks/opportunities for
// the accounts that DID mirror (store is already updated; rerunning the plan is safe
// because steps 1-2 are idempotent and step 3 dedupes)
let pushFailed = false;
if (touched.size) {
  try {
    execFileSync(process.execPath, [join(here, "push.ts"), ...touched], { stdio: "inherit" });
  } catch {
    pushFailed = true;
    console.error("push reported failures — continuing with notes/tasks/opportunities; re-run this plan after fixing (idempotent)");
  }
}

// step-3 dedupe sets keyed by title+companyId: a re-run of the same plan must not
// re-create notes/tasks/opportunities (same title on a DIFFERENT company is legitimate)
let allNotes: any[], allNoteTargets: any[], allTasks: any[], allTaskTargets: any[], allOpps: any[];
try {
  [allNotes, allNoteTargets, allTasks, allTaskTargets, allOpps] = [
    await pageAll("notes"), await pageAll("noteTargets"), await pageAll("tasks"), await pageAll("taskTargets"), await pageAll("opportunities"),
  ];
} catch (e: any) {
  // Twenty unreachable after the client's built-in retry: BLOCKED. The plan file is the
  // retry vehicle — store updates (step 1) are done and idempotent, step 3 dedupes.
  appendQueue(`crm-apply-plan-blocked-${todayStamp()}.md`,
    `## ${new Date().toISOString()} BLOCKED mid-plan ${planPath}: ${String(e.message).slice(0, 200)}\nRe-run: node skills/m8-crm-sync/scripts/apply-plan.ts ${planPath}\n`);
  console.error(`BLOCKED: Twenty unreachable (${e.message}). Plan queued for re-run — notes/tasks/opportunities not yet applied.`);
  process.exit(1);
}
const noteTitleById: Record<string, string> = Object.fromEntries(allNotes.map((n: any) => [n.id, n.title]));
const taskTitleById: Record<string, string> = Object.fromEntries(allTasks.map((t: any) => [t.id, t.title]));
const existingNotes = new Set(allNoteTargets.filter((t: any) => t.companyId).map((t: any) => `${noteTitleById[t.noteId]}::${t.companyId}`));
const existingTasks = new Set(allTaskTargets.filter((t: any) => t.companyId).map((t: any) => `${taskTitleById[t.taskId]}::${t.companyId}`));
const existingOpps = new Set(allOpps.map((o: any) => `${o.name}::${o.companyId}`));

// 3. notes / tasks / opportunities (need crm ids from the store)
function crmIds(domain: string): { companyId?: string; personIdFor: (apolloId?: string) => string | undefined } {
  const a = readAccount(domain);
  return {
    companyId: a?.crm?.twenty_company_id,
    personIdFor: (apolloId?: string) => (apolloId ? a?.crm?.twenty_person_ids?.[apolloId] : undefined),
  };
}

for (const n of plan.notes ?? []) {
  const { companyId, personIdFor } = crmIds(n.domain);
  if (!companyId) { console.error(`note skipped, no crm id: ${n.domain}`); continue; }
  if (existingNotes.has(`${n.title}::${companyId}`)) { console.log(`note "${n.title}" already on ${n.domain} — skipped`); continue; }
  const targets: any[] = [{ targetCompanyId: companyId }];
  const pid = personIdFor(n.alsoPerson);
  if (pid) targets.push({ targetPersonId: pid });
  await addNote(n.title, n.markdown, targets);
  console.log(`note "${n.title}" -> ${n.domain}`);
}

for (const t of plan.tasks ?? []) {
  const { companyId } = crmIds(t.domain);
  if (!companyId) { console.error(`task skipped, no crm id: ${t.domain}`); continue; }
  if (existingTasks.has(`${t.title}::${companyId}`)) { console.log(`task "${t.title}" already on ${t.domain} — skipped`); continue; }
  await addTask(t.title, t.markdown, t.dueAt ?? null, [{ targetCompanyId: companyId }]);
  console.log(`task "${t.title}" -> ${t.domain}`);
}

for (const o of plan.opportunities ?? []) {
  const { companyId } = crmIds(o.domain);
  if (!companyId) { console.error(`opportunity skipped, no crm id: ${o.domain}`); continue; }
  if (existingOpps.has(`${o.name}::${companyId}`)) { console.log(`opportunity "${o.name}" already on ${o.domain} — skipped`); continue; }
  await api("POST", "/rest/opportunities", { name: o.name, stage: o.stage ?? "NEW", companyId });
  console.log(`opportunity "${o.name}" (${o.stage ?? "NEW"}) -> ${o.domain}`);
}

appendProgress(`- ${new Date().toISOString()} m8 apply-plan ${planPath}: ${touched.size} accounts, ${(plan.notes ?? []).length} notes, ${(plan.tasks ?? []).length} tasks, ${(plan.opportunities ?? []).length} opportunities${pushFailed ? " — PUSH FAILURES, re-run plan" : ""}`);
console.log(pushFailed ? "apply-plan complete WITH push failures — re-run this plan after fixing" : "apply-plan complete");
if (pushFailed) process.exit(1);
