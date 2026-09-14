// M7 · pipeline dashboard — the state/velocity view generated from canonical sources.
//
//   node skills/m7-recorder-sync/scripts/dashboard.ts          terminal summary
//   node skills/m7-recorder-sync/scripts/dashboard.ts --html   + writes $PIPELINE_DATA/dashboard/index.html
//
// Reads ONLY derived/canonical state: accounts/*.yaml, logs/run-records.jsonl,
// queue/decisions.jsonl, and config via lib/sequence-resolver.ts. Writes ONLY
// $PIPELINE_DATA/dashboard/index.html (--html). Runs LAST in M7 so the current run's
// run-record is included. Serve the file with dashboard-server.ts (127.0.0.1 only — put
// your own reverse proxy in front) or open it directly.
//
// Layout order is deliberate: OUTCOME first — replies are the load-bearing metric;
// throughput without outcomes is vanity. Then gates, funnel, velocity, run health.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { fixtureBacklog } from "../../../evals/fixture-backlog.ts";
import { dataPath, listAccounts, readAccount, todayStamp } from "../../../lib/store.ts";
import { TWENTY_BASE_URL, configPath } from "../../../lib/env.ts";
import { canonicalSignalKey, resolveSequence, signalNameForKey } from "../../../lib/sequence-resolver.ts";

const SEQ_CONFIG = YAML.parse(readFileSync(configPath("sequences.yaml"), "utf8"));

// ---------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------
type SeqInfo = { key: string; name: string; status: string };
const seqById: Record<string, SeqInfo> = {};
for (const [key, s] of Object.entries<any>(SEQ_CONFIG.sequences ?? {}))
  if (s?.id) seqById[s.id] = { key, name: s.name ?? key, status: s.status ?? "unknown" };

const CONTACT_STATES = ["PAUSED", "ACTIVE", "FINISHED", "REPLIED", "REMOVED", "BOUNCED", "OPTED_OUT", "NOT_ENROLLED"];

function collect() {
  const statusTally: Record<string, number> = {};
  const bySequence: Record<string, Record<string, number>> = {};
  const bySignal: Record<string, Record<string, number>> = {};
  const holds: Record<string, { count: number; sample: string[] }> = {};
  const enrollReady: string[] = [];
  let pausedActive = 0, pausedFrozen = 0, contactsTotal = 0, replied = 0;
  const aging: Array<{ domain: string; status: string; since: string | null }> = [];

  for (const domain of listAccounts()) {
    const a = readAccount(domain);
    if (!a) continue;
    const st = String(a.status ?? "unknown");
    statusTally[st] = (statusTally[st] ?? 0) + 1;

    const sigKey = canonicalSignalKey(a.signal_source) ?? "unknown-signal";
    for (const c of a.contacts ?? []) {
      contactsTotal++;
      const cs = String(c.sequence_status ?? "NOT_ENROLLED");
      const seq = seqById[c.apollo_sequence_id]?.key ?? "unknown-sequence";
      (bySequence[seq] ??= {})[cs] = (bySequence[seq]?.[cs] ?? 0) + 1;
      (bySignal[sigKey] ??= {})[cs] = (bySignal[sigKey]?.[cs] ?? 0) + 1;
      if (cs === "REPLIED") replied++;
      if (cs === "PAUSED") {
        if (seqById[c.apollo_sequence_id]?.status === "active") pausedActive++;
        else pausedFrozen++;
      }
    }

    if (st === "routed" || st === "triaged") {
      const r = resolveSequence({ signal_source: a.signal_source, route: a.route });
      if (r.decision === "ENROLL") enrollReady.push(domain);
      else {
        const reason = (r as any).reason ?? "unmatched";
        const h = (holds[reason] ??= { count: 0, sample: [] });
        h.count++;
        if (h.sample.length < 3) h.sample.push(domain);
      }
      aging.push({ domain, status: st, since: a.status_since ?? a.triaged_at ?? null });
    }
  }
  return { statusTally, bySequence, bySignal, holds, enrollReady, pausedActive, pausedFrozen, contactsTotal, replied, aging };
}

function readJsonl(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const daysSince = (iso: string | null): number | null =>
  iso && /^\d{4}-\d{2}-\d{2}/.test(iso)
    ? Math.max(0, Math.floor((Date.now() - Date.parse(`${iso.slice(0, 10)}T00:00:00Z`)) / 86_400_000))
    : null;

function collectDecisions() {
  const all = readJsonl(dataPath("queue", "decisions.jsonl"));
  const open = all.filter((d) => d.status !== "resolved");
  const byKind: Record<string, { count: number; oldest: number }> = {};
  for (const d of open) {
    const age = daysSince(d.opened?.date) ?? 0;
    const k = (byKind[d.kind] ??= { count: 0, oldest: 0 });
    k.count++;
    if (age > k.oldest) k.oldest = age;
  }
  const oldestOpen = [...open].sort((x, y) => (daysSince(y.opened?.date) ?? 0) - (daysSince(x.opened?.date) ?? 0)).slice(0, 8);
  const gatedAccounts = new Set(open.flatMap((d) => d.accounts ?? [])).size;
  return { total: all.length, open, byKind, oldestOpen, gatedAccounts };
}

function collectRuns() {
  const runs = readJsonl(dataPath("logs", "run-records.jsonl"));
  const recent = runs.slice(-10);
  let streak = 0;
  for (let i = runs.length - 1; i >= 0 && runs[i].degraded; i--) streak++;
  const last = runs[runs.length - 1] ?? null;
  return { runs, recent, streak, last, lastAgeDays: last ? daysSince(String(last.run_date)) : null };
}

// ---------------------------------------------------------------------------
// Terminal view
// ---------------------------------------------------------------------------
const sum = (o: Record<string, number> = {}): number => Object.values(o).reduce((a, b) => a + b, 0);
const fmtStates = (o: Record<string, number> = {}): string =>
  CONTACT_STATES.filter((s) => o[s]).map((s) => `${s.toLowerCase()}:${o[s]}`).join(" ") || "—";

function terminal(): string {
  const s = collect(), d = collectDecisions(), r = collectRuns(), fb = fixtureBacklog();
  const L: string[] = [];
  L.push(`gtm-prospect-pipeline dashboard — ${todayStamp()}`);
  L.push("");
  L.push("OUTCOME (contact sequence states — replies are the metric that matters)");
  L.push(`  lifetime replies: ${s.replied} of ${s.contactsTotal} contacts (open-tracking is off; replies are the only engagement signal)`);
  for (const [seq, tally] of Object.entries(s.bySequence).sort()) {
    const info = Object.values(seqById).find((x) => x.key === seq);
    L.push(`  ${seq.padEnd(20)} [${(info?.status ?? "?").padEnd(7)}] ${fmtStates(tally)}`);
  }
  L.push("  by signal:");
  for (const [sig, tally] of Object.entries(s.bySignal).sort())
    L.push(`    ${(signalNameForKey(sig) ?? sig).padEnd(30)} ${fmtStates(tally)}`);
  L.push("");
  L.push("GATES");
  L.push(`  awaiting M4 go: ${s.pausedActive} paused contacts in ACTIVE sequences (${s.pausedFrozen} more are frozen retired-sequence history)`);
  L.push(`  open decisions: ${d.open.length} (${d.gatedAccounts} accounts gated) — node skills/m7-recorder-sync/scripts/decisions.ts list`);
  L.push(`  eval fixture backlog: ${fb.candidates.length} ruling(s) not yet protected by a fixture (${fb.covered} covered) — node evals/fixture-backlog.ts`);
  for (const [k, v] of Object.entries(d.byKind).sort((a, b) => b[1].count - a[1].count))
    L.push(`    ${k.padEnd(19)} ${String(v.count).padStart(3)} open  oldest ${v.oldest}d`);
  L.push("");
  L.push("FUNNEL");
  const order = ["pulled", "triaged", "routed", "enriched", "enrolled-paused", "active", "replied", "finished", "held", "flagged", "skipped", "opted-out", "dropped"];
  L.push("  " + order.filter((k) => s.statusTally[k]).map((k) => `${k}:${s.statusTally[k]}`).join("  "));
  L.push(`  enroll-ready per resolver: ${s.enrollReady.length}${s.enrollReady.length ? ` (${s.enrollReady.slice(0, 6).join(", ")}${s.enrollReady.length > 6 ? ", …" : ""})` : ""}`);
  L.push("  HOLD pile (what activating a successor releases):");
  for (const [reason, h] of Object.entries(s.holds).sort((a, b) => b[1].count - a[1].count))
    L.push(`    ${String(h.count).padStart(3)}  ${reason}  (e.g. ${h.sample.join(", ")})`);
  const unknownAge = s.aging.filter((a) => !a.since).length;
  const oldest = s.aging.filter((a) => a.since).sort((x, y) => (daysSince(y.since) ?? 0) - (daysSince(x.since) ?? 0))[0];
  L.push(`  aging at routed/triaged: oldest ${oldest ? `${daysSince(oldest.since)}d (${oldest.domain})` : "n/a"}; ${unknownAge} with unknown age (pre-status_since accounts)`);
  L.push("");
  L.push("VELOCITY (last runs)");
  L.push("  date        mode         pulled/new  routed  enrolled  credits(ts/ap/wf)  state");
  for (const run of r.recent) {
    const pulled = (run.signals ?? []).reduce((a: number, x: any) => a + (x.pulled ?? 0), 0);
    const fresh = (run.signals ?? []).reduce((a: number, x: any) => a + (x.new ?? 0), 0);
    const cr = run.credits ?? {};
    L.push(`  ${String(run.run_date).slice(0, 10)}  ${String(run.mode).padEnd(11)}  ${String(pulled).padStart(3)}/${String(fresh).padEnd(4)}   ${String(run.funnel?.routed ?? 0).padStart(4)}   ${String(run.enrollment?.contacts ?? "—").padStart(6)}   ${String(cr.theirstack ?? 0).padStart(4)}/${String(cr.apollo ?? 0).padEnd(3)}/${String(cr.apollo_waterfall ?? 0).padEnd(3)}   ${run.degraded ? "DEGRADED" : "ok"}`);
  }
  L.push("");
  L.push("RUN HEALTH");
  L.push(`  last run: ${r.last ? `${String(r.last.run_date).slice(0, 10)} (${r.lastAgeDays}d ago, ${r.last.mode}${r.last.degraded ? ", DEGRADED" : ""})` : "no run records"}`);
  L.push(`  consecutive-DEGRADED streak: ${r.streak}${r.lastAgeDays !== null && r.lastAgeDays > 1 ? `  ⚠ no run record for ${r.lastAgeDays} days — a headless batch may have run without recording` : ""}`);
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// HTML view
// ---------------------------------------------------------------------------
const esc = (s: unknown): string => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function html(): string {
  const s = collect(), d = collectDecisions(), r = collectRuns(), fb = fixtureBacklog();
  const tile = (label: string, value: string, note = "", tone = "") =>
    `<div class="tile ${tone}"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div>${note ? `<div class="n">${esc(note)}</div>` : ""}</div>`;
  const stateCells = (t: Record<string, number> = {}) => CONTACT_STATES.map((cs) => `<td class="num">${t[cs] ?? ""}</td>`).join("");

  const seqRows = Object.entries(s.bySequence).sort().map(([seq, t]) => {
    const info = Object.values(seqById).find((x) => x.key === seq);
    return `<tr><td>${esc(seq)}</td><td>${esc(info?.status ?? "?")}</td>${stateCells(t)}<td class="num">${sum(t)}</td></tr>`;
  }).join("");
  const sigRows = Object.entries(s.bySignal).sort().map(([sig, t]) =>
    `<tr><td>${esc(signalNameForKey(sig) ?? sig)}</td><td></td>${stateCells(t)}<td class="num">${sum(t)}</td></tr>`).join("");
  const holdRows = Object.entries(s.holds).sort((a, b) => b[1].count - a[1].count).map(([reason, h]) =>
    `<tr><td class="num">${h.count}</td><td>${esc(reason)}</td><td class="muted">${esc(h.sample.join(", "))}</td></tr>`).join("");
  const decRows = d.oldestOpen.map((x) =>
    `<tr><td class="num">${daysSince(x.opened?.date) ?? "?"}d</td><td>${esc(x.kind)}</td><td>${esc(x.id)}</td><td>${esc(x.title)}</td></tr>`).join("");
  const runRows = r.recent.map((run) => {
    const pulled = (run.signals ?? []).reduce((a: number, x: any) => a + (x.pulled ?? 0), 0);
    const fresh = (run.signals ?? []).reduce((a: number, x: any) => a + (x.new ?? 0), 0);
    const cr = run.credits ?? {};
    return `<tr><td>${esc(String(run.run_date).slice(0, 10))}</td><td>${esc(run.mode)}</td><td class="num">${pulled}/${fresh}</td><td class="num">${run.funnel?.routed ?? 0}</td><td class="num">${run.enrollment?.contacts ?? "—"}</td><td class="num">${cr.theirstack ?? 0} / ${cr.apollo ?? 0}${cr.apollo_waterfall ? ` / wf ${cr.apollo_waterfall}` : ""}</td><td>${run.degraded ? `<span class="bad">▲ DEGRADED</span>` : `<span class="ok">● ok</span>`}</td></tr>`;
  }).join("");
  const funnelOrder = ["pulled", "triaged", "routed", "enriched", "enrolled-paused", "active", "replied", "finished", "held", "flagged", "skipped", "opted-out", "dropped"];
  const funnelRow = funnelOrder.filter((k) => s.statusTally[k]).map((k) =>
    `<tr><td>${esc(k)}</td><td class="num">${s.statusTally[k]}</td></tr>`).join("");
  const noRecentRun = r.lastAgeDays !== null && r.lastAgeDays > 1;

  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>gtm-prospect-pipeline — ${esc(todayStamp())}</title>
<style>
:root { --bg:#fafafa; --card:#fff; --ink:#1a1a1a; --ink2:#555; --ink3:#8a8a8a; --line:#e4e4e4;
        --accent:#3555c8; --good:#1a7f37; --bad:#b42318; --warn:#9a6700; }
@media (prefers-color-scheme: dark) { :root { --bg:#121417; --card:#1b1e23; --ink:#e8e8e8;
        --ink2:#a8a8a8; --ink3:#767676; --line:#2c3036; --accent:#7d97f2; --good:#4cc38a; --bad:#f0776b; --warn:#d9a514; } }
* { box-sizing:border-box }
body { margin:0; padding:24px; background:var(--bg); color:var(--ink);
       font:14px/1.45 ui-sans-serif, system-ui, sans-serif; }
h1 { font-size:18px; margin:0 0 4px } h2 { font-size:13px; text-transform:uppercase;
     letter-spacing:.06em; color:var(--ink2); margin:28px 0 8px }
.sub { color:var(--ink3); margin-bottom:20px }
.tiles { display:flex; flex-wrap:wrap; gap:12px }
.tile { background:var(--card); border:1px solid var(--line); border-radius:8px;
        padding:14px 18px; min-width:150px; flex:1 1 150px }
.tile .v { font-size:32px; font-weight:600; font-variant-numeric:tabular-nums }
.tile .l { color:var(--ink2); margin-top:2px } .tile .n { color:var(--ink3); font-size:12px; margin-top:4px }
.tile.alert .v { color:var(--bad) } .tile.warn .v { color:var(--warn) } .tile.accent .v { color:var(--accent) }
.tablewrap { overflow-x:auto; background:var(--card); border:1px solid var(--line); border-radius:8px }
table { border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums }
th, td { text-align:left; padding:7px 12px; border-top:1px solid var(--line); white-space:nowrap }
td.muted { color:var(--ink3); white-space:normal } thead th { border-top:0; color:var(--ink2);
     font-size:12px; text-transform:uppercase; letter-spacing:.04em }
.num { text-align:right } .ok { color:var(--good) } .bad { color:var(--bad); font-weight:600 }
.note { color:var(--ink3); font-size:12px; margin-top:6px }
</style>
<h1>gtm-prospect-pipeline</h1>
<div class="sub">generated ${esc(new Date().toISOString().slice(0, 16).replace("T", " "))}Z · store: ${esc(sum(s.statusTally))} accounts · canonical sources only (accounts/, run-records, decision ledger, resolver)</div>

<div class="tiles">
${tile("lifetime replies", String(s.replied), `${s.contactsTotal} contacts; open-tracking off — replies are the only engagement signal`, s.replied === 0 ? "alert" : "accent")}
${tile("awaiting M4 go", String(s.pausedActive), `paused in ACTIVE sequences (+${s.pausedFrozen} frozen retired history)`, "accent")}
${tile("open decisions", String(d.open.length), `${d.gatedAccounts} accounts gated · oldest ${Math.max(0, ...Object.values(d.byKind).map((k) => k.oldest))}d`, d.open.length ? "warn" : "")}
${tile("eval fixture backlog", String(fb.candidates.length), `${fb.covered} rulings protected · node evals/fixture-backlog.ts`, fb.candidates.length ? "warn" : "")}
${tile("HOLD pile", String(sum(Object.fromEntries(Object.entries(s.holds).map(([k, v]) => [k, v.count])))), "releases on successor activation", "warn")}
${tile("enroll-ready", String(s.enrollReady.length), "resolver ENROLL, awaiting next M3", "")}
${tile("last run", r.last ? `${r.lastAgeDays}d ago` : "—", r.last ? `${String(r.last.run_date).slice(0, 10)} ${r.last.mode}${r.last.degraded ? " · DEGRADED" : ""} · streak ${r.streak}` : "no run records", noRecentRun || r.streak > 0 ? "alert" : "")}
</div>

<h2>Outcome — contacts by sequence</h2>
<div class="tablewrap"><table><thead><tr><th>sequence</th><th>lifecycle</th>${CONTACT_STATES.map((c) => `<th class="num">${c.toLowerCase()}</th>`).join("")}<th class="num">total</th></tr></thead>
<tbody>${seqRows}</tbody></table></div>
<h2>Outcome — contacts by signal</h2>
<div class="tablewrap"><table><thead><tr><th>signal</th><th></th>${CONTACT_STATES.map((c) => `<th class="num">${c.toLowerCase()}</th>`).join("")}<th class="num">total</th></tr></thead>
<tbody>${sigRows}</tbody></table></div>
<div class="note">Delivered/open counts live Apollo-side and are not mirrored per-contact; sequence_status is the store's truth. Replies land here via M8 reconcile.</div>

<h2>Decision inbox</h2>
<div id="inbox">
<div class="tablewrap"><table><thead><tr><th>age</th><th>kind</th><th>id</th><th>title</th></tr></thead><tbody>${decRows || `<tr><td colspan="4" class="muted">none open</td></tr>`}</tbody></table></div>
<div class="note">Static snapshot (opened as a file, or the action server is down). The live inbox with resolve buttons is served by dashboard-server.ts; CLI: <code>node skills/m7-recorder-sync/scripts/decisions.ts resolve &lt;id&gt; --ruling "…"</code></div>
</div>
<script>
(function () {
  var TWENTY = ${JSON.stringify(TWENTY_BASE_URL)};
  var VERDICTS = [
    ["", "no verdict — ruling only (nothing moves; for policy/ops answers)"],
    ["drop", "drop — never our buyer; store-only, deleted from CRM"],
    ["skip", "skip — never contact, keep the CRM suppression record"],
    ["qualified", "qualified — fit; back into Sales Nav → resolver flow"],
    ["enroll", "enroll — fit AND sequence them; next run does the M3 pass"],
    ["hold", "hold — park it; not now, don't work it, don't suppress it"],
    ["acknowledge", "acknowledge — seen; the ruling text is the action"],
  ];
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function age(dateStr) { var d = Date.parse(String(dateStr).slice(0, 10) + "T00:00:00Z"); return isNaN(d) ? "?" : Math.max(0, Math.floor((Date.now() - d) / 864e5)) + "d"; }
  function links(ctx) {
    var wrap = el("span", "links");
    function a(href, label) { var x = el("a", null, label); x.href = href; x.target = "_blank"; x.rel = "noreferrer"; wrap.appendChild(x); }
    if (ctx.domain) a("https://" + ctx.domain, ctx.domain);
    var q = encodeURIComponent(ctx.company || ctx.domain || "");
    if (q) {
      a("https://www.linkedin.com/search/results/companies/?keywords=" + q, "LinkedIn");
      a("https://www.linkedin.com/sales/search/company?query=(keywords%3A" + q + ")", "SalesNav");
    }
    if (ctx.twenty_company_id) a(TWENTY + "/object/company/" + ctx.twenty_company_id, "Twenty");
    return wrap;
  }
  function card(d) {
    var c = el("div", "card" + (d.status === "resolved" ? " resolved" : ""));
    var head = el("div", "cardhead");
    head.appendChild(el("span", "chip", d.kind));
    head.appendChild(el("span", "chip age", d.status === "resolved" ? "resolved " + ((d.resolution || {}).date || "") : age((d.opened || {}).date) + " open"));
    head.appendChild(el("strong", null, " " + d.title));
    c.appendChild(head);
    (d.account_context || []).forEach(function (ctx) {
      var row = el("div", "acct");
      row.appendChild(el("span", "chip", (ctx.status || "?") + (ctx.route ? " · " + ctx.route : "")));
      row.appendChild(links(ctx));
      if (ctx.evidence_note) row.appendChild(el("div", "ev", ctx.evidence_note));
      c.appendChild(row);
    });
    if (d.body && !(d.account_context || []).some(function (x) { return x.evidence_note; })) c.appendChild(el("div", "ev", d.body));
    if (d.status !== "resolved") {
      var form = el("div", "resolveform");
      var sel = document.createElement("select");
      VERDICTS.forEach(function (pair) { var o = el("option", null, pair[1]); o.value = pair[0]; sel.appendChild(o); });
      var ta = document.createElement("textarea"); ta.placeholder = "ruling (required — recorded verbatim, feeds the eval loop)";
      var btn = el("button", null, "Resolve");
      var msg = el("span", "note");
      btn.onclick = function () {
        if (!ta.value.trim()) { msg.textContent = "ruling required"; return; }
        btn.disabled = true; msg.textContent = "…";
        fetch("/api/resolve", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: d.id, ruling: ta.value.trim(), verdict: sel.value || undefined }) })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (x) {
            if (x.ok) { c.classList.add("resolved"); form.replaceWith(el("div", "ev", "resolved ✓ " + (sel.value ? "verdict " + sel.value + " — executed by the next batch run" : ""))); }
            else { btn.disabled = false; msg.textContent = x.j.error || "failed"; }
          }).catch(function () { btn.disabled = false; msg.textContent = "network error"; });
      };
      form.appendChild(sel); form.appendChild(ta); form.appendChild(btn); form.appendChild(msg);
      c.appendChild(form);
    }
    return c;
  }
  fetch("/api/decisions").then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (j) {
    var box = document.getElementById("inbox"); box.textContent = "";
    var open = j.decisions.filter(function (d) { return d.status !== "resolved"; });
    box.appendChild(el("div", "note", open.length + " open — live inbox; a resolve here records the ruling, the next batch run executes any verdict"));
    var legend = el("details", "legend");
    legend.appendChild(el("summary", null, "what the verdicts do"));
    var lg = el("div", "ev",
      "A verdict tells the NEXT batch what to do with the account; the ruling text is recorded verbatim and can become standing triage law. " +
      "drop = never our buyer (store-only, CRM record deleted). " +
      "skip = never contact, but keep the CRM suppression record (classic case: a disqualifier named in config/icp.md is in place). " +
      "qualified = fit — account returns to the machine flow (Sales Nav confirm → sequence resolver; accounts whose sequence is draft/retired HOLD until a successor activates). " +
      "enroll = fit AND sequence them — next run performs a full M3 pass (contact + waterfall + merge fields + suppression, enrolls PAUSED; M4 still gates sends). " +
      "hold = park deliberately. acknowledge / none = ruling recorded, no account state moves (policy, ops, data-bugs).");
    legend.appendChild(lg);
    box.appendChild(legend);
    j.decisions.forEach(function (d) { box.appendChild(card(d)); });
  }).catch(function () { /* file:// or server down — static table stays */ });
})();
</script>
<style>
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin:10px 0 }
.card.resolved { opacity:.55 }
.cardhead { margin-bottom:6px } .cardhead strong { font-weight:600 }
.chip { display:inline-block; background:var(--bg); border:1px solid var(--line); border-radius:99px; padding:1px 9px; font-size:12px; color:var(--ink2); margin-right:6px }
.acct { margin:6px 0 } .links a { margin-right:10px; color:var(--accent) }
.ev { color:var(--ink2); font-size:13px; margin-top:4px; white-space:normal }
.resolveform { display:flex; gap:8px; margin-top:8px; align-items:flex-start; flex-wrap:wrap }
.resolveform select, .resolveform textarea, .resolveform button {
  font:inherit; color:var(--ink); background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:6px 8px }
.resolveform textarea { flex:1 1 260px; min-height:38px } .resolveform button { cursor:pointer }
</style>

<h2>Funnel</h2>
<div class="tablewrap"><table><thead><tr><th>status</th><th class="num">accounts</th></tr></thead><tbody>${funnelRow}</tbody></table></div>

<h2>HOLD pile — what a successor activation releases</h2>
<div class="tablewrap"><table><thead><tr><th class="num">accounts</th><th>hold reason</th><th>sample</th></tr></thead><tbody>${holdRows || `<tr><td colspan="3" class="muted">no holds</td></tr>`}</tbody></table></div>

<h2>Velocity — recent runs</h2>
<div class="tablewrap"><table><thead><tr><th>date</th><th>mode</th><th class="num">pulled/new</th><th class="num">routed</th><th class="num">enrolled</th><th class="num">credits ts/ap</th><th>state</th></tr></thead><tbody>${runRows || `<tr><td colspan="7" class="muted">no run records yet</td></tr>`}</tbody></table></div>
${noRecentRun ? `<div class="note"><span class="bad">▲</span> No run record for ${r.lastAgeDays} days — a headless batch may have run without recording, or not run at all.</div>` : ""}
`;
}

// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
console.log(terminal());
if (argv.includes("--html")) {
  const dir = dataPath("dashboard");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html());
  console.error(`\nhtml written: ${join(dir, "index.html")}`);
}
