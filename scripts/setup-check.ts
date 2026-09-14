// Setup doctor — deterministic, read-only, $0. The /setup skill runs this between steps and
// at the end; an operator can run it any time to see what is still missing.
//
//   node scripts/setup-check.ts [--json]
//
// Exit 0 = ready to run a batch (sequences may still be draft — that is a HOLD, not a fault).
// Exit 1 = something an operator must fix; each finding names the file and the fix.
//
// Checks: node version · env file present + chmod 600 · PIPELINE_DATA layout · config parses ·
// resolver validation · placeholders left in config · icp.md still a template · CRM reachable
// when configured. It never calls a paid connector and never writes.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { PIPELINE_DATA, TWENTY_BASE_URL, configPath } from "../lib/env.ts";
import { validateSequencesConfig } from "../lib/sequence-resolver.ts";

type Level = "ok" | "todo" | "fail";
type Finding = { level: Level; area: string; message: string; fix?: string };
const findings: Finding[] = [];
const add = (level: Level, area: string, message: string, fix?: string) =>
  findings.push({ level, area, message, fix });

const ENV_PATH = join(homedir(), ".config", "gtm-prospect-pipeline", "env");
const PLACEHOLDER = /REPLACE-WITH-|PENDING-CREATE-IN-APOLLO/;

// 1. runtime
const major = Number(process.versions.node.split(".")[0]);
if (major >= 24) add("ok", "node", `node ${process.versions.node}`);
else add("fail", "node", `node ${process.versions.node} is too old`, "install node 24 or newer");

// 2. env file
if (!existsSync(ENV_PATH)) {
  add("todo", "env", `${ENV_PATH} does not exist`,
    `mkdir -p ~/.config/gtm-prospect-pipeline && printf 'PIPELINE_DATA=%s\\n' "$HOME/Data/gtm-prospect-pipeline" > ${ENV_PATH} && chmod 600 ${ENV_PATH}`);
} else {
  const mode = statSync(ENV_PATH).mode & 0o777;
  if (mode & 0o077) add("fail", "env", `${ENV_PATH} is group/world readable (${mode.toString(8)})`, `chmod 600 ${ENV_PATH}`);
  else add("ok", "env", `${ENV_PATH} present, mode 600`);
  const text = readFileSync(ENV_PATH, "utf8");
  if (/API_KEY=\S/.test(text)) add("ok", "env", "a CRM key is set (value not shown)");
  else add("ok", "env", "no CRM key set — M8 runs as a no-op until one is added");
}

// 3. data layout
const required = ["raw", "accounts", "queue", "logs"];
if (!existsSync(PIPELINE_DATA)) {
  add("todo", "data", `PIPELINE_DATA ${PIPELINE_DATA} does not exist`,
    `mkdir -p ${required.map((d) => `${PIPELINE_DATA}/${d}`).join(" ")}`);
} else {
  const missing = required.filter((d) => !existsSync(join(PIPELINE_DATA, d)));
  if (missing.length) add("todo", "data", `missing ${missing.join(", ")} under ${PIPELINE_DATA}`,
    `mkdir -p ${missing.map((d) => `${PIPELINE_DATA}/${d}`).join(" ")}`);
  else add("ok", "data", `${PIPELINE_DATA} has raw/ accounts/ queue/ logs/`);
}

// 4. config parses + validates
let signals: any = {}, sequences: any = {};
try {
  signals = YAML.parse(readFileSync(configPath("signal.yaml"), "utf8")) ?? {};
  sequences = YAML.parse(readFileSync(configPath("sequences.yaml"), "utf8")) ?? {};
  add("ok", "config", "signal.yaml and sequences.yaml parse");
} catch (e: any) {
  add("fail", "config", `config does not parse: ${e.message}`, "fix the YAML and re-run");
}
const errors = validateSequencesConfig();
if (errors.length) for (const e of errors) add("fail", "resolver", e, "node lib/sequence-resolver.ts --validate");
else add("ok", "resolver", "config validates");

// 5. placeholders
const signalText = readFileSync(configPath("signal.yaml"), "utf8");
const seqText = readFileSync(configPath("sequences.yaml"), "utf8");
const stripComments = (s: string) => s.split("\n").map((l) => l.replace(/\s+#.*$/, "")).filter((l) => !/^\s*#/.test(l)).join("\n");
const sigPh = stripComments(signalText).match(PLACEHOLDER) ? true : false;
const seqPh = stripComments(seqText).match(PLACEHOLDER) ? true : false;
if (sigPh) add("todo", "signal.yaml", "placeholder values remain", "fill dedupe.company_list_id and every REPLACE-WITH-… value");
else add("ok", "signal.yaml", "no placeholders");
if (seqPh) add("todo", "sequences.yaml", "placeholder values remain (legal while a sequence is draft)",
  "set each sequence id, enrollment.sender, and merge_fields.*.apollo_field_id before flipping to active");
else add("ok", "sequences.yaml", "no placeholders");

const enabled = Object.entries(signals).filter(([k, v]: [string, any]) => v && typeof v === "object" && v.name && v.enabled === true).map(([k]) => k);
if (!enabled.length) add("todo", "signal.yaml", "no signal block is enabled", "set enabled: true on at least one block");
else add("ok", "signal.yaml", `enabled signals: ${enabled.join(", ")}`);
const templRegex = stripComments(signalText).includes("REPLACE WITH THE PHRASE");
if (templRegex) add("todo", "signal.yaml", "the template job_description_pattern_or is still in place", "write the regex for the phrase your signal keys on");

const active = Object.entries(sequences?.sequences ?? {}).filter(([, s]: [string, any]) => s?.status === "active").map(([k]) => k);
if (!active.length) add("ok", "sequences.yaml", "no active sequence yet — batches will qualify and stage, then HOLD at routed (expected before your copy is approved)");
else add("ok", "sequences.yaml", `active sequences: ${active.join(", ")}`);

// 6. icp.md
const icp = readFileSync(configPath("icp.md"), "utf8");
if (/REPLACE|<your |\[your /i.test(icp)) add("todo", "icp.md", "still contains template placeholders", "run /setup, or fill each section in your own words");
else add("ok", "icp.md", "no placeholders");
if (!/## Drop classes/.test(icp)) add("fail", "icp.md", "missing the `## Drop classes` section the eval loader reads", "restore the section: one `- slug — description` bullet per class");

// 7. CRM reachability (only if configured; unauthenticated GET, no writes)
const crmConfigured = existsSync(ENV_PATH) && /TWENTY_BASE_URL=\S/.test(readFileSync(ENV_PATH, "utf8"));
if (crmConfigured) {
  try {
    const res = await fetch(`${TWENTY_BASE_URL}/healthz`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) add("ok", "crm", `${TWENTY_BASE_URL} reachable`);
    else add("todo", "crm", `${TWENTY_BASE_URL} answered ${res.status}`, "check TWENTY_BASE_URL; M8 will queue pushes until it is reachable");
  } catch (e: any) {
    add("todo", "crm", `${TWENTY_BASE_URL} unreachable (${e.name})`, "check TWENTY_BASE_URL; M8 will queue pushes until it is reachable");
  }
} else add("ok", "crm", "not configured — skipping (optional)");

// report
const json = process.argv.includes("--json");
if (json) {
  console.log(JSON.stringify({ findings, ready: !findings.some((f) => f.level === "fail") }, null, 2));
} else {
  const icon: Record<Level, string> = { ok: "ok  ", todo: "todo", fail: "FAIL" };
  for (const f of findings) {
    console.log(`${icon[f.level]}  ${f.area.padEnd(14)} ${f.message}`);
    if (f.fix && f.level !== "ok") console.log(`${"".padEnd(20)}→ ${f.fix}`);
  }
  const fails = findings.filter((f) => f.level === "fail").length;
  const todos = findings.filter((f) => f.level === "todo").length;
  console.log();
  if (fails) console.log(`${fails} blocking issue(s), ${todos} todo(s). Fix the FAIL lines first.`);
  else if (todos) console.log(`No blockers. ${todos} todo(s) before the first real batch — /setup walks through them.`);
  else console.log("Ready. Run /pipeline-batch in Claude Code.");
}
process.exit(findings.some((f) => f.level === "fail") ? 1 : 0);
