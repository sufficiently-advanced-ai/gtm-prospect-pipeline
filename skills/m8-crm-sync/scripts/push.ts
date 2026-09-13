// M8 push mode — mirror account.yaml state to Twenty. Idempotent via syncHash.
// Usage:
//   node push.ts <domain> [<domain>...]     push specific accounts
//   node push.ts --all                      push every account in the store
//   node push.ts --all --dry-run            show what would change, write nothing
//   node push.ts <domain> --note "text"     also append a note to the company
// Mirroring module: reads accounts/, writes Twenty, fetches nothing, interprets nothing.
import { upsertCompany, upsertPerson, addNote } from "../../../lib/twenty.ts";
import { listAccounts, readAccount, writeAccount, syncHash, appendProgress, scanSyncConflicts, appendQueue, todayStamp } from "../../../lib/store.ts";
import { OUTREACH_STATUS } from "../../../lib/status-map.ts";
import { isCrmHeldOut } from "../../../lib/signal-policy.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const noteIdx = args.indexOf("--note");
const noteText = noteIdx >= 0 ? args[noteIdx + 1] : null;
const all = args.includes("--all");
const domains = all
  ? listAccounts()
  : args.filter((a) => !a.startsWith("--") && a !== noteText).map((d) => d.trim().toLowerCase());

if (domains.length === 0) {
  console.error("usage: push.ts <domain>... | --all  [--dry-run] [--note \"text\"]");
  process.exit(1);
}
if (all && noteText) {
  console.error("refusing --all with --note: that would append the same note to every company (notes are append-only). Name the domains explicitly.");
  process.exit(1);
}

// Run-start ritual (store guardrails)
const conflicts = scanSyncConflicts();
if (conflicts.length) {
  appendQueue(
    `sync-conflicts-${todayStamp()}.md`,
    `## ${new Date().toISOString()} — found by m8 push\n${conflicts.map((c) => `- ${c}`).join("\n")}\n`,
  );
  console.error(`ABORT: ${conflicts.length} sync-conflict file(s) — routed to queue/, resolve before pushing:`);
  conflicts.forEach((c) => console.error(`  ${c}`));
  process.exit(2);
}

function companyPayload(a: any): Record<string, unknown> {
  const p: Record<string, unknown> = {
    name: a.company ?? a.domain,
    // always sent, null included — a re-triaged account must CLEAR an outdated
    // LIVE/etc. value in the mirror, not silently keep it (dropped accounts never
    // reach this function — excluded from selection below)
    outreachStatus: OUTREACH_STATUS[a.status] ?? null,
  };
  if (a.route) p.route = a.route;
  if (a.batch) p.batchLabel = a.batch;
  if (a.verification) p.verificationMethod = a.verification;
  if (a.evidence_note) p.evidenceNote = a.evidence_note;
  if (a.signal_source) p.signalSource = a.signal_source;
  if (a.apollo_account_id) p.apolloAccountId = a.apollo_account_id;
  const e = a.enrichment ?? {};
  if (e.industry) p.industry = e.industry;
  if (e.employee_count != null) p.employeeCount = e.employee_count; // workspace custom field (there is no `employees` field here)
  if (e.revenue_usd != null) p.revenueUsd = e.revenue_usd;
  if (e.description) p.companyDescription = e.description;
  if (e.phone) p.phone = e.phone;
  if (e.founded_year != null) p.foundedYear = e.founded_year;
  if (e.linkedin_url) p.linkedinLink = { primaryLinkUrl: e.linkedin_url };
  if (e.last_enriched_at) p.lastEnrichedAt = e.last_enriched_at;
  if (a.tech_stack) p.techStack = a.tech_stack;
  if (a.hiring_signals) p.hiringSignals = a.hiring_signals;
  return p;
}

function personPayload(c: any, companyId: string): Record<string, unknown> {
  const p: Record<string, unknown> = { companyId };
  if (c.name) {
    const parts = String(c.name).trim().split(/\s+/);
    p.name = { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
  }
  if (c.title) p.jobTitle = c.title;
  if (c.email) p.emails = { primaryEmail: c.email };
  if (c.apollo_contact_id) p.apolloContactId = c.apollo_contact_id;
  if (c.apollo_sequence_id) p.apolloSequenceId = c.apollo_sequence_id;
  if (c.sequence_status) p.sequenceStatus = c.sequence_status;
  if (c.sequence_step != null) p.sequenceStep = String(c.sequence_step);
  if (c.enrolled_at) p.enrolledAt = c.enrolled_at;
  if (c.sender_email) p.senderEmail = c.sender_email;
  if (c.apollo_email_status) p.apolloEmailStatus = c.apollo_email_status;
  return p;
}

let pushed = 0, skipped = 0, droppedExcluded = 0, heldOut = 0, failed = 0;
const failedDomains: Array<{ domain: string; error: string }> = [];
for (const domain of domains) {
  const a = readAccount(domain);
  if (!a) { console.error(`no account.yaml: ${domain}`); failed++; continue; }

  // fit-triage drops are STORE-ONLY — never mirrored, and the exclusion is
  // UNCONDITIONAL: a leftover crm pointer must not resurrect a dropped company in
  // Twenty after remove-dropped.ts deleted it there.
  // SKIP is different — verified suppression decisions stay mirrored.
  if (a.status === "dropped" || a.route === "DROPPED") {
    droppedExcluded++;
    continue;
  }

  // per-signal CRM holdout: holdout-signal accounts (config policy.push_to_crm_after:
  // enrolled) enter Twenty only once they're in a sequence — pre-enroll states are
  // store-only, unconditionally. skipped still mirrors.
  if (isCrmHeldOut(a)) {
    heldOut++;
    continue;
  }

  // pulled/triaged accounts don't belong in the CRM yet (lib/status-map.ts) —
  // only mirror them once routed (or already known to the CRM)
  if ((a.status === "pulled" || a.status === "triaged") && !a.crm?.twenty_company_id) {
    skipped++;
    continue;
  }

  const coPayload = companyPayload(a);
  const contacts = a.contacts ?? [];
  const hash = syncHash({ coPayload, contacts: contacts.map((c: any) => personPayload(c, "x")) });
  if (a.crm?.sync_hash === hash && !noteText) { skipped++; continue; }

  if (dryRun) {
    console.log(`[dry-run] would push ${domain} (${contacts.length} contacts)`);
    pushed++;
    continue;
  }

  try {
    const companyId = await upsertCompany(domain, coPayload, a.crm?.twenty_company_id);
    const personIds: Record<string, string> = { ...(a.crm?.twenty_person_ids ?? {}) };
    for (const c of contacts) {
      const key = c.apollo_contact_id ?? c.email ?? c.name;
      const id = await upsertPerson(personPayload(c, companyId), c.apollo_contact_id, personIds[key], c.email);
      personIds[key] = id;
    }
    if (noteText) await addNote(`Pipeline update — ${a.batch ?? todayStamp()}`, noteText, [{ targetCompanyId: companyId }]);
    a.crm = {
      ...(a.crm ?? {}),
      twenty_company_id: companyId,
      twenty_person_ids: personIds,
      last_synced_at: new Date().toISOString(),
      sync_hash: hash,
    };
    writeAccount(domain, a);
    pushed++;
    console.log(`pushed ${domain} (company ${companyId}, ${contacts.length} contacts)`);
  } catch (e: any) {
    failed++;
    failedDomains.push({ domain, error: String(e.message).slice(0, 200) });
    console.error(`FAIL ${domain}: ${e.message}`);
  }
}

const summary = `m8 push: ${pushed} pushed, ${skipped} unchanged, ${droppedExcluded} dropped-excluded, ${heldOut} crm-holdout, ${failed} failed (${domains.length} requested)`;
console.log(summary);
if (!dryRun) appendProgress(`- ${new Date().toISOString()} ${summary}`);
if (failedDomains.length) {
  appendQueue(
    `crm-push-failures-${todayStamp()}.md`,
    `## ${new Date().toISOString()} — push failures (transport retries exhausted; re-run: node skills/m8-crm-sync/scripts/push.ts ${failedDomains.map((f) => f.domain).join(" ")})\n${failedDomains.map((f) => `- ${f.domain}: ${f.error}`).join("\n")}\n`,
  );
  console.error(`failed domains queued -> queue/crm-push-failures-${todayStamp()}.md`);
}
if (failed) process.exit(1);
