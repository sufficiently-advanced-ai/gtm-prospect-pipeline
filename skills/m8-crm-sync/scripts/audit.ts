// M8 audit mode — three-way reconcile report: store vs Twenty (Apollo drift is the
// reconcile skill's job; this checks the mirror). Flags UI-side edits to M8-owned
// fields into queue/ rather than silently absorbing or clobbering them.
// Usage: node audit.ts [--counts-only]
import { pageAll } from "../../../lib/twenty.ts";
import { listAccounts, readAccount, appendQueue, todayStamp } from "../../../lib/store.ts";
import { OUTREACH_STATUS } from "../../../lib/status-map.ts";
import { isCrmHeldOut } from "../../../lib/signal-policy.ts";

const countsOnly = process.argv.includes("--counts-only");

const companies = await pageAll("companies");
const people = await pageAll("people");
const domains = listAccounts();

const byDomain: Record<string, any> = {};
const duplicateDomains: string[] = [];
for (const c of companies) {
  const d = c.domainName?.primaryLinkUrl?.replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase();
  if (!d) continue;
  if (byDomain[d]) duplicateDomains.push(`${d}: ${byDomain[d].id} AND ${c.id}`);
  byDomain[d] = c;
}
const personById: Record<string, any> = Object.fromEntries(people.map((p: any) => [p.id, p]));

console.log(`Twenty: ${companies.length} companies, ${people.length} people`);
console.log(`Store:  ${domains.length} accounts`);

if (countsOnly) process.exit(0);

const drift: string[] = [];
const missingInTwenty: string[] = [];
const missingInStore: string[] = [];
const strayDropped: string[] = [];
const strayHoldout: string[] = [];

const storeSet = new Set(domains.map((d) => d.toLowerCase()));
for (const d of Object.keys(byDomain)) if (!storeSet.has(d)) missingInStore.push(d);

for (const domain of domains) {
  const a = readAccount(domain);
  if (!a) continue;
  const co = byDomain[domain.toLowerCase()];
  // dropped accounts are store-only: absent from Twenty is the CORRECT state — never
  // "missing". Present in Twenty = a stray to remove, not drift.
  if (a.status === "dropped" || a.route === "DROPPED") {
    if (co) strayDropped.push(`${domain}: ${co.id}`);
    continue;
  }
  // holdout-signal accounts pre-enrollment are store-only (config policy.push_to_crm_after):
  // absent from Twenty is CORRECT; present = pushed too early, flag as a stray.
  if (isCrmHeldOut(a)) {
    if (co) strayHoldout.push(`${domain}: ${co.id} (status ${a.status})`);
    continue;
  }
  if (!co) { missingInTwenty.push(domain); continue; }
  const expectedStatus = OUTREACH_STATUS[a.status] ?? null;
  if ((co.outreachStatus ?? null) !== expectedStatus)
    drift.push(`${domain}: outreachStatus store=${expectedStatus} twenty=${co.outreachStatus ?? null}`);
  if (a.route && co.route !== a.route)
    drift.push(`${domain}: route store=${a.route} twenty=${co.route}`);
  if (a.crm?.twenty_company_id && a.crm.twenty_company_id !== co.id)
    drift.push(`${domain}: twenty_company_id mismatch store=${a.crm.twenty_company_id} twenty=${co.id}`);
  // person-level drift — sequenceStatus/sequenceStep are the E3 gate's inputs
  for (const c of a.contacts ?? []) {
    const key = c.apollo_contact_id ?? c.email ?? c.name;
    const pid = key ? a.crm?.twenty_person_ids?.[key] : undefined;
    const tp = pid ? personById[pid] : undefined;
    if (!tp) { if (pid) drift.push(`${domain} / ${c.name}: twenty person ${pid} missing`); continue; }
    if (c.sequence_status && tp.sequenceStatus !== c.sequence_status)
      drift.push(`${domain} / ${c.name}: sequenceStatus store=${c.sequence_status} twenty=${tp.sequenceStatus}`);
    if (c.sequence_step != null && (tp.sequenceStep ?? null) !== String(c.sequence_step))
      drift.push(`${domain} / ${c.name}: sequenceStep store=${c.sequence_step} twenty=${tp.sequenceStep ?? null}`);
  }
}

console.log(`\nmirror drift: ${drift.length}`);
drift.slice(0, 30).forEach((d) => console.log(`  ${d}`));
console.log(`duplicate domains in Twenty: ${duplicateDomains.length}${duplicateDomains.length ? " — " + duplicateDomains.join("; ") : ""}`);
console.log(`in store, not Twenty: ${missingInTwenty.length}${missingInTwenty.length ? " — " + missingInTwenty.slice(0, 10).join(", ") : ""}`);
console.log(`in Twenty, not store: ${missingInStore.length}${missingInStore.length ? " — " + missingInStore.slice(0, 10).join(", ") : ""}`);
console.log(`dropped in store but still in Twenty: ${strayDropped.length}${strayDropped.length ? " — " + strayDropped.slice(0, 10).join(", ") : ""}`);
console.log(`holdout-signal accounts in Twenty pre-enrollment: ${strayHoldout.length}${strayHoldout.length ? " — " + strayHoldout.slice(0, 10).join(", ") : ""}`);

if (drift.length || missingInTwenty.length || missingInStore.length || duplicateDomains.length || strayDropped.length || strayHoldout.length) {
  appendQueue(
    `crm-audit-${todayStamp()}.md`,
    [
      `## CRM audit ${new Date().toISOString()}`,
      `Twenty ${companies.length} companies / ${people.length} people; store ${domains.length} accounts.`,
      ...(drift.length ? ["", "### Drift (store value wins unless a human says otherwise)", ...drift.map((d) => `- ${d}`)] : []),
      ...(duplicateDomains.length ? ["", "### Duplicate companies in Twenty (same domain, two records — merge manually)", ...duplicateDomains.map((d) => `- ${d}`)] : []),
      ...(missingInTwenty.length ? ["", "### In store, missing from Twenty (push them)", ...missingInTwenty.map((d) => `- ${d}`)] : []),
      ...(missingInStore.length ? ["", "### In Twenty, missing from store (import or archive)", ...missingInStore.map((d) => `- ${d}`)] : []),
      ...(strayDropped.length ? ["", "### Dropped in store but still in Twenty (DROPPED is store-only — remove: node skills/m8-crm-sync/scripts/remove-dropped.ts)", ...strayDropped.map((d) => `- ${d}`)] : []),
      ...(strayHoldout.length ? ["", "### Holdout-signal accounts in Twenty before enrollment (pushed too early; investigate how)", ...strayHoldout.map((d) => `- ${d}`)] : []),
      "",
    ].join("\n"),
  );
  console.log(`\nreport appended to queue/crm-audit-${todayStamp()}.md`);
}
