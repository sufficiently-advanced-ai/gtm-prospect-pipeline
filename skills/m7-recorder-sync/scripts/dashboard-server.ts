// M7 · dashboard action server — serves the generated dashboard AND a live decision inbox
// with a rulings-only write path.
//
//   node skills/m7-recorder-sync/scripts/dashboard-server.ts    # 127.0.0.1:8654 (PORT overrides)
//
// Binds 127.0.0.1 ONLY; there is no auth. Put your own reverse proxy (with its own access
// control) in front if you want it reachable from anywhere else.
//
// Write surface, deliberately minimal: POST /api/resolve SHELLS OUT to decisions.ts —
// one write path, CLI validation, atomic rewrite, audit attribution. This server never
// touches account.yaml, Apollo, or Twenty; verdicts are recorded here and EXECUTED by the
// batch run-start ritual (`decisions.ts verdicts`). A misclick can mis-rule a decision,
// never mutate pipeline state directly.
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataPath, readAccount } from "../../../lib/store.ts";

const PORT = Number(process.env.PORT ?? 8654);
const DECISIONS_CLI = join(import.meta.dirname, "decisions.ts");

function ledger(): any[] {
  const p = dataPath("queue", "decisions.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// Per-account context the inbox needs for scan-and-decide: name for search links, status
// for context, CRM id for the record link. Nothing secret — whatever sits in front of the
// loopback bind is the access control, and this serves less than the dashboard HTML shows.
function accountContext(domain: string): any {
  const a = readAccount(domain);
  if (!a) return { domain };
  return {
    domain,
    company: a.company ?? null,
    status: a.status ?? null,
    route: a.route ?? null,
    evidence_note: a.evidence_note ?? null,
    twenty_company_id: a.crm?.twenty_company_id ?? null,
  };
}

const json = (res: any, code: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(s);
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const p = dataPath("dashboard", "index.html");
    if (!existsSync(p)) return json(res, 404, { error: "dashboard not generated yet — run dashboard.ts --html" });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(readFileSync(p));
  }

  if (req.method === "GET" && url.pathname === "/api/decisions") {
    const all = ledger().map((d) => ({ ...d, account_context: (d.accounts ?? []).map(accountContext) }));
    // Unresolved first, oldest first within each group — the scan order.
    all.sort((a, b) =>
      (a.status === "resolved" ? 1 : 0) - (b.status === "resolved" ? 1 : 0)
      || String(a.opened?.date ?? "").localeCompare(String(b.opened?.date ?? "")));
    return json(res, 200, { decisions: all });
  }

  if (req.method === "POST" && url.pathname === "/api/resolve") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 64_000) req.destroy(); });
    req.on("end", () => {
      let p: any;
      try { p = JSON.parse(body); } catch { return json(res, 400, { error: "invalid JSON body" }); }
      if (typeof p?.id !== "string" || typeof p?.ruling !== "string" || p.ruling.trim() === "")
        return json(res, 400, { error: "need {id, ruling, verdict?}" });
      const args = ["resolve", p.id, "--ruling", p.ruling, "--by", "operator-via-dashboard"];
      if (typeof p.verdict === "string" && p.verdict) args.push("--verdict", p.verdict);
      // One write path: the CLI validates, rewrites atomically, refuses re-resolution.
      // process.execPath, NOT "node": a service manager's PATH may not include node at all
      // (found live — every resolve 409'd with an empty error).
      const r = spawnSync(process.execPath, [DECISIONS_CLI, ...args], { encoding: "utf8" });
      if (r.status !== 0) {
        const detail = String(r.stderr ?? "").trim() || r.error?.message || `spawn exited ${r.status}`;
        return json(res, 409, { error: detail.slice(0, 500) });
      }
      return json(res, 200, { resolved: JSON.parse(String(r.stdout).trim()) });
    });
    return;
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`dashboard-server on http://127.0.0.1:${PORT} (loopback only — put your own reverse proxy in front)`);
});
