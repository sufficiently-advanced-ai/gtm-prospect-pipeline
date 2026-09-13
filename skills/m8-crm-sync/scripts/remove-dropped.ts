// M8 maintenance — remove fit-triage drops from Twenty (DROPPED is store-only; SKIP stays
// mirrored). The standing tool for any stray (e.g. a mirrored account re-triaged to drop —
// audit.ts flags those here).
//
// Usage: node skills/m8-crm-sync/scripts/remove-dropped.ts [--dry-run]
//
// Order of operations (capture-first, store outranks Twenty):
//   1. audit log of every planned removal -> raw/twenty-maintenance/<date>-dropped-removal.json
//   2. per company: verify domain matches, verify NO attached people/opportunities
//      (drops were never enriched — anything attached = human review, skip + flag)
//   3. DELETE, then re-GET to confirm 404
//   4. account.yaml: drop the leftover crm pointer block, stamp crm_removed: <date>
import { api, isNotFound, normalizeDomain } from "../../../lib/twenty.ts";
import { listAccounts, readAccount, writeAccount, captureRaw, appendProgress, appendQueue, scanSyncConflicts, todayStamp } from "../../../lib/store.ts";

const dryRun = process.argv.includes("--dry-run");

// Run-start ritual (store guardrails) — this run writes the store
const conflicts = scanSyncConflicts();
if (conflicts.length) {
  appendQueue(
    `sync-conflicts-${todayStamp()}.md`,
    `## ${new Date().toISOString()} — found by m8 remove-dropped\n${conflicts.map((c) => `- ${c}`).join("\n")}\n`,
  );
  console.error(`ABORT: ${conflicts.length} sync-conflict file(s) — routed to queue/, resolve first.`);
  process.exit(2);
}

type Target = { domain: string; company: string | null; twenty_company_id: string };
const targets: Target[] = [];
for (const domain of listAccounts()) {
  const a = readAccount(domain);
  if (!a) continue;
  if (a.status !== "dropped" && a.route !== "DROPPED") continue;
  if (!a.crm?.twenty_company_id) continue;
  targets.push({ domain, company: a.company ?? null, twenty_company_id: a.crm.twenty_company_id });
}

console.log(`${targets.length} dropped account(s) with a Twenty pointer${dryRun ? " [dry-run]" : ""}`);
if (!targets.length) process.exit(0);

// 1. audit log BEFORE any deletion (append-only raw capture; unique name on same-day re-run)
if (!dryRun) {
  const log = JSON.stringify(
    { written_at: new Date().toISOString(), reason: "DROPPED is store-only — removing fit-triage drops from Twenty", removals: targets },
    null, 2,
  );
  let logPath: string;
  try {
    logPath = captureRaw(`twenty-maintenance/${todayStamp()}-dropped-removal.json`, log);
  } catch {
    logPath = captureRaw(`twenty-maintenance/${todayStamp()}-dropped-removal-${Date.now()}.json`, log);
  }
  console.log(`audit log: ${logPath}`);
}

let deleted = 0, alreadyAbsent = 0, skipped = 0, failed = 0;
const flags: string[] = [];

for (const t of targets) {
  const id = t.twenty_company_id;
  if (dryRun) { console.log(`[dry-run] would delete ${t.domain} (${id})`); continue; }
  try {
    // 2a. fetch — already gone in Twenty just means the store pointer is outdated
    let co: any = null;
    try {
      co = (await api("GET", `/rest/companies/${id}`))?.data?.company ?? null;
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    if (co) {
      // 2b. identity guard — never delete a record whose domain doesn't match the account
      const twentyDomain = normalizeDomain(co.domainName?.primaryLinkUrl ?? "");
      if (twentyDomain && twentyDomain !== normalizeDomain(t.domain)) {
        skipped++;
        flags.push(`${t.domain}: Twenty ${id} has domain "${twentyDomain}" — mismatch, NOT deleted`);
        continue;
      }
      // 2c. attachment guard — drops were never enriched; attached records = human call
      const [people, opps] = [
        (await api("GET", `/rest/people?filter=companyId[eq]:${id}&limit=10`))?.data?.people ?? [],
        (await api("GET", `/rest/opportunities?filter=companyId[eq]:${id}&limit=10`))?.data?.opportunities ?? [],
      ];
      if (people.length || opps.length) {
        skipped++;
        flags.push(`${t.domain}: Twenty ${id} has ${people.length} people / ${opps.length} opportunities attached — NOT deleted`);
        continue;
      }
      // 3. delete + verify
      await api("DELETE", `/rest/companies/${id}`);
      let verified = false;
      try {
        await api("GET", `/rest/companies/${id}`);
      } catch (e) {
        if (isNotFound(e)) verified = true; else throw e;
      }
      if (!verified) { failed++; flags.push(`${t.domain}: DELETE returned ok but ${id} still fetches — investigate`); continue; }
      deleted++;
      console.log(`deleted ${t.domain} (${id})`);
    } else {
      alreadyAbsent++;
      console.log(`already absent ${t.domain} (${id}) — clearing leftover pointer`);
    }
    // 4. store cleanup — pointer is outdated either way; the account dir stays (store is the record)
    const a = readAccount(t.domain);
    if (a) {
      delete a.crm;
      a.crm_removed = todayStamp();
      writeAccount(t.domain, a);
    }
  } catch (e: any) {
    failed++;
    flags.push(`${t.domain}: ${String(e.message).slice(0, 200)}`);
    console.error(`FAIL ${t.domain}: ${e.message}`);
  }
}

const summary = `m8 remove-dropped: ${deleted} deleted, ${alreadyAbsent} already absent, ${skipped} skipped, ${failed} failed (${targets.length} targeted)`;
console.log(summary);
if (!dryRun) appendProgress(`- ${new Date().toISOString()} ${summary}`);
if (flags.length && !dryRun) {
  appendQueue(
    `crm-remove-dropped-${todayStamp()}.md`,
    `## ${new Date().toISOString()} — remove-dropped flags (human review)\n${flags.map((f) => `- ${f}`).join("\n")}\n`,
  );
  console.error(`flags queued -> queue/crm-remove-dropped-${todayStamp()}.md`);
}
if (failed) process.exit(1);
