// Run-start guardrail: find file-sync conflict copies (*.sync-conflict*) anywhere in the
// store and route them to queue/. Two hosts editing the same account.yaml is silent data
// loss unless someone looks, so every module runs this BEFORE writing to the store.
// Exit 0 = clean, exit 2 = conflicts found (modules must stop).
import { existsSync } from "node:fs";
import { PIPELINE_DATA } from "./env.ts";
import { scanSyncConflicts, appendQueue, todayStamp } from "./store.ts";

if (!existsSync(PIPELINE_DATA)) {
  console.log(`no store at ${PIPELINE_DATA} — nothing to scan`);
  process.exit(0);
}
const hits = scanSyncConflicts();
if (!hits.length) {
  console.log("no sync conflicts");
  process.exit(0);
}
appendQueue(
  `sync-conflicts-${todayStamp()}.md`,
  `## ${new Date().toISOString()}\n${hits.map((h) => `- ${h}`).join("\n")}\n`,
);
console.error(`${hits.length} sync-conflict file(s) — resolve before any module writes:`);
hits.forEach((h) => console.error(`  ${h}`));
process.exit(2);
