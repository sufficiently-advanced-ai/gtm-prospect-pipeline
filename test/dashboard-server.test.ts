// Offline test for the dashboard action server — GET /api/decisions enrichment and the
// rulings-only POST /api/resolve write path (which shells out to decisions.ts).
// Child processes + temp PIPELINE_DATA, ephemeral port.
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const SERVER = join(REPO, "skills", "m7-recorder-sync", "scripts", "dashboard-server.ts");
const CLI = join(REPO, "skills", "m7-recorder-sync", "scripts", "decisions.ts");
const PORT = 8600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;

const store = mkdtempSync(join(tmpdir(), "dashsrv-store-"));
mkdirSync(join(store, "accounts", "acme-example.com"), { recursive: true });
writeFileSync(join(store, "accounts", "acme-example.com", "account.yaml"),
  `domain: acme-example.com\ncompany: Acme Example Co\nstatus: flagged\nroute: FLAGGED\nevidence_note: two sources disagree\ncrm:\n  twenty_company_id: 11111111-2222-3333-4444-555555555555\n`);
const env = { ...process.env, PIPELINE_DATA: store, PORT: String(PORT) };
spawnSync("node", [CLI, "add", "--kind", "re-triage", "--id", "flag-acme-example-com", "--title", "acme flagged", "--accounts", "acme-example.com"], { env, encoding: "utf8" });

// Launch via execPath with a node-less PATH — regression guard for the service-manager
// PATH bug: the server must not depend on finding "node" on PATH to spawn the CLI.
const server = spawn(process.execPath, [SERVER],
  { env: { ...env, PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
let failures = 0;
const check = (name: string, fn: () => void | Promise<void>) => Promise.resolve().then(fn).then(
  () => console.log(`ok   ${name}`),
  (e) => { failures++; console.error(`FAIL ${name}: ${e.message}`); });

const until = async (fn: () => Promise<boolean>, ms = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await fn()) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("server did not come up");
};

try {
  await until(async () => (await fetch(`${BASE}/api/decisions`)).ok);

  await check("GET /api/decisions enriches accounts with context for links", async () => {
    const j = await (await fetch(`${BASE}/api/decisions`)).json();
    assert.equal(j.decisions.length, 1);
    const d = j.decisions[0];
    assert.equal(d.id, "flag-acme-example-com");
    assert.deepEqual(d.account_context[0], {
      domain: "acme-example.com", company: "Acme Example Co", status: "flagged", route: "FLAGGED",
      evidence_note: "two sources disagree", twenty_company_id: "11111111-2222-3333-4444-555555555555",
    });
  });

  await check("POST /api/resolve records ruling + verdict through the CLI write path", async () => {
    const r = await fetch(`${BASE}/api/resolve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "flag-acme-example-com", ruling: "Skip it — self-described scope.", verdict: "skip" }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.resolved.status, "resolved");
    assert.equal(j.resolved.resolution.verdict, "skip");
    assert.equal(j.resolved.resolution.by, "operator-via-dashboard");
    const line = JSON.parse(readFileSync(join(store, "queue", "decisions.jsonl"), "utf8").trim());
    assert.equal(line.resolution.ruling, "Skip it — self-described scope.");
  });

  await check("re-resolve is refused with the CLI's error; bad bodies 400", async () => {
    const again = await fetch(`${BASE}/api/resolve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "flag-acme-example-com", ruling: "changed my mind" }),
    });
    assert.equal(again.status, 409);
    assert.match((await again.json()).error, /already resolved/);
    assert.equal((await fetch(`${BASE}/api/resolve`, { method: "POST", body: "nope" })).status, 400);
    assert.equal((await fetch(`${BASE}/api/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "x" }) })).status, 400);
  });

  await check("verdicts subcommand reports the unexecuted skip (account still flagged)", () => {
    const r = spawnSync("node", [CLI, "verdicts"], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /SKIP\s+flag-acme-example-com/);
    assert.match(r.stdout, /acme-example\.com\s+currently status:flagged/);
    assert.match(r.stdout, /1 verdict\(s\) awaiting execution/);
  });

  await check("executed verdict disappears from the pending list", () => {
    writeFileSync(join(store, "accounts", "acme-example.com", "account.yaml"),
      `domain: acme-example.com\ncompany: Acme Example Co\nstatus: skipped\nroute: SKIP\nskip_reason: disqualifier in place\n`);
    const r = spawnSync("node", [CLI, "verdicts"], { env, encoding: "utf8" });
    assert.match(r.stdout, /no verdicts awaiting execution/);
  });
} finally {
  server.kill();
  rmSync(store, { recursive: true, force: true });
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("dashboard-server test passed");
