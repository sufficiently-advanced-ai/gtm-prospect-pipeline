// M8 audit/pull-back, gather half — full Twenty export to raw/twenty/ as JSONL.
// Also serves as migration step 0a and a backup-independent audit trail.
import { hostname } from "node:os";
import { pageAll } from "../../../lib/twenty.ts";
import { captureRaw, todayStamp } from "../../../lib/store.ts";

// timestamped + machine-unique (capture-first rule): same-day reruns and two-host
// runs never collide in the append-only raw/ layer
const now = new Date();
const hhmmss = now.toISOString().slice(11, 19).replace(/:/g, "");
const stamp = `${todayStamp()}-${hhmmss}-${hostname().split(".")[0].toLowerCase()}`;
const objects = ["companies", "people", "notes", "noteTargets", "opportunities", "tasks"];

for (const plural of objects) {
  const records = await pageAll(plural);
  const path = captureRaw(
    `twenty/${stamp}-export-${plural}.jsonl`,
    records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""),
  );
  console.log(`${plural}: ${records.length} -> ${path}`);
}
