// Architecture diagram generator — emits .excalidraw scene files next to this script.
//
//   node docs/diagrams/generate.ts
//
// Plain TypeScript, erasable syntax, node 24+ (CLAUDE.md Runtime). Writes NOTHING under
// $PIPELINE_DATA and reads no store state: every fact drawn here comes from ARCHITECTURE.md,
// commands/pipeline-batch.md, config/*.yaml, lib/*.ts and evals/DESIGN.md.
//
// The scenes are hand-layouted below; `assertLayout()` catches box overlaps so a content
// edit that outgrows its box is a build error, not a diagram someone opens and squints at.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Excalidraw element construction
// ---------------------------------------------------------------------------

type El = Record<string, any>;
type Box = { id: string; x: number; y: number; w: number; h: number; name: string; container?: boolean };

const FONT = 2;             // 1 = hand-drawn, 2 = Helvetica/Nunito (denser text reads better)
const CHAR_W = 0.54;        // avg glyph width as a fraction of fontSize, for wrapping/sizing
const LINE_H = 1.25;

const COLORS = {
  ext: { bg: "#ffec99", stroke: "#e8590c" },      // external system / integration
  mod: { bg: "#a5d8ff", stroke: "#1971c2" },      // pipeline module (agent skill)
  store: { bg: "#b2f2bb", stroke: "#2f9e44" },    // local store ($PIPELINE_DATA)
  cfg: { bg: "#d0bfff", stroke: "#6741d9" },      // config / resolver / code
  gate: { bg: "#ffc9c9", stroke: "#e03131" },     // gate, guard, policy stop
  human: { bg: "#ffd8a8", stroke: "#f08c00" },    // human action
  state: { bg: "#f1f3f5", stroke: "#868e96" },    // state / status annotation
  plain: { bg: "transparent", stroke: "#adb5bd" },
};

let counter = 0;
const nid = (prefix: string): string => `${prefix}-${++counter}`;
const nonce = (): number => (counter * 104729 + 12345) % 2147483647;

function base(type: string, x: number, y: number, w: number, h: number, id: string): El {
  return {
    id,
    type,
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: nonce(),
    version: 1,
    versionNonce: nonce(),
    isDeleted: false,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
  };
}

function wrap(text: string, width: number, fontSize: number): string[] {
  const max = Math.max(8, Math.floor((width - 18) / (fontSize * CHAR_W)));
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para.trim() === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/)) {
      const cand = line ? `${line} ${word}` : word;
      if (cand.length <= max) line = cand;
      else {
        if (line) out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

const textW = (lines: string[], fontSize: number): number =>
  Math.max(...lines.map((l) => l.length)) * fontSize * CHAR_W;
const textH = (lines: string[], fontSize: number): number => lines.length * fontSize * LINE_H;

type TextOpts = {
  align?: "left" | "center";
  size?: number;
  color?: string;
  groupIds?: string[];
  width?: number;
};

function text(scene: Scene, x: number, y: number, body: string, opts: TextOpts = {}): El {
  const size = opts.size ?? 13;
  const width = opts.width ?? 400;
  const lines = wrap(body, width + 18, size);
  const el = base("text", x, y, opts.width ? width : textW(lines, size), textH(lines, size), nid("t"));
  el.strokeColor = opts.color ?? "#1e1e1e";
  el.groupIds = opts.groupIds ?? [];
  el.fontSize = size;
  el.fontFamily = FONT;
  el.text = lines.join("\n");
  el.originalText = body;
  el.textAlign = opts.align ?? "left";
  el.verticalAlign = "top";
  el.containerId = null;
  el.lineHeight = LINE_H;
  el.autoResize = true;
  scene.elements.push(el);
  return el;
}

type BoxOpts = {
  title?: string;
  body?: string;
  color?: { bg: string; stroke: string };
  titleSize?: number;
  bodySize?: number;
  dashed?: boolean;
  container?: boolean;
  align?: "left" | "center";
  vcenter?: boolean;          // center the content block vertically (slide chips)
  ellipse?: boolean;
};

class Scene {
  elements: El[] = [];
  boxes: Box[] = [];
  frameId: string | null = null;

  // A frame gives the slide a 16:9 boundary Excalidraw can export or present on its own.
  // Everything created afterwards becomes a child of it (assigned at write time).
  frame(name: string, x: number, y: number, w: number, h: number): void {
    const f = base("frame", x, y, w, h, nid("f"));
    f.name = name;
    f.strokeColor = "#bbbbbb";
    f.backgroundColor = "transparent";
    f.roughness = 0;
    f.strokeWidth = 1;
    this.elements.push(f);
    this.frameId = f.id;
  }

  box(name: string, x: number, y: number, w: number, h: number, opts: BoxOpts = {}): Box {
    const color = opts.color ?? COLORS.plain;
    const titleSize = opts.titleSize ?? 16;
    const bodySize = opts.bodySize ?? 12;
    const group = nid("g");
    const pad = 10;

    const titleLines = opts.title ? wrap(opts.title, w, titleSize) : [];
    const bodyLines = opts.body ? wrap(opts.body, w, bodySize) : [];
    const needed =
      pad * 2 +
      (titleLines.length ? textH(titleLines, titleSize) : 0) +
      (titleLines.length && bodyLines.length ? 6 : 0) +
      (bodyLines.length ? textH(bodyLines, bodySize) : 0);
    const height = Math.max(h, Math.ceil(needed));

    const rect = base(opts.ellipse ? "ellipse" : "rectangle", x, y, w, height, nid("r"));
    rect.backgroundColor = color.bg;
    rect.strokeColor = color.stroke;
    rect.roundness = { type: 3 };
    rect.groupIds = [group];
    if (opts.dashed) rect.strokeStyle = "dashed";
    if (opts.container) {
      rect.fillStyle = "hachure";
      rect.strokeWidth = 1;
    }
    this.elements.push(rect);

    let cursor = y + pad;
    if (opts.vcenter) cursor = y + (height - (needed - pad * 2)) / 2;
    if (titleLines.length) {
      const t = text(this, x + pad, cursor, opts.title as string, {
        size: titleSize,
        align: opts.container ? "left" : (opts.align ?? "center"),
        width: w - pad * 2,
        groupIds: [group],
      });
      cursor += t.height + 6;
    }
    if (bodyLines.length) {
      text(this, x + pad, cursor, opts.body as string, {
        size: bodySize,
        align: opts.align ?? (opts.container ? "left" : "left"),
        width: w - pad * 2,
        groupIds: [group],
        color: "#343a40",
      });
    }

    const b: Box = { id: rect.id, x, y, w, h: height, name, container: opts.container };
    this.boxes.push(b);
    return b;
  }

  note(x: number, y: number, w: number, body: string, size = 12, color = "#495057"): El {
    return text(this, x, y, body, { size, width: w, color, align: "left" });
  }

  link(
    from: Box,
    fromSide: Side,
    to: Box,
    toSide: Side,
    opts: {
      label?: string;
      labelSize?: number;
      dashed?: boolean;
      color?: string;
      elbow?: "h" | "v";
      route?: number[][];
      fromT?: number;
      toT?: number;
      both?: boolean;
    } = {},
  ): El {
    const gap = 8;
    const s = shift(anchor(from, fromSide, opts.fromT ?? 0.5), fromSide, gap);
    const e = shift(anchor(to, toSide, opts.toT ?? 0.5), toSide, gap);
    const dx = e.x - s.x;
    const dy = e.y - s.y;
    let points: number[][];
    if (opts.route) points = [[0, 0], ...opts.route.map(([x, y]) => [x - s.x, y - s.y]), [dx, dy]];
    else if (opts.elbow === "h") points = [[0, 0], [dx / 2, 0], [dx / 2, dy], [dx, dy]];
    else if (opts.elbow === "v") points = [[0, 0], [0, dy / 2], [dx, dy / 2], [dx, dy]];
    else points = [[0, 0], [dx, dy]];

    const el = base("arrow", s.x, s.y, Math.abs(dx), Math.abs(dy), nid("a"));
    el.points = points;
    el.strokeColor = opts.color ?? "#343a40";
    el.strokeWidth = 2;
    if (opts.dashed) el.strokeStyle = "dashed";
    el.roundness = { type: 2 };
    el.startArrowhead = opts.both ? "arrow" : null;
    el.endArrowhead = "arrow";
    el.startBinding = { elementId: from.id, focus: 0, gap: gap };
    el.endBinding = { elementId: to.id, focus: 0, gap: gap };
    el.elbowed = false;
    this.elements.push(el);
    bind(this, from.id, el.id, "arrow");
    bind(this, to.id, el.id, "arrow");

    if (opts.label) {
      const size = opts.labelSize ?? 11;
      const lines = wrap(opts.label, 260, size);
      const lw = textW(lines, size);
      const lh = textH(lines, size);
      const mid = midpoint(s, points);
      const lbl = base("text", mid.x - lw / 2, mid.y - lh / 2, lw, lh, nid("t"));
      lbl.strokeColor = opts.color ?? "#343a40";
      lbl.fontSize = size;
      lbl.fontFamily = FONT;
      lbl.text = lines.join("\n");
      lbl.originalText = opts.label;
      lbl.textAlign = "center";
      lbl.verticalAlign = "middle";
      lbl.containerId = el.id;
      lbl.lineHeight = LINE_H;
      lbl.autoResize = true;
      this.elements.push(lbl);
      bind(this, el.id, lbl.id, "text");
    }
    return el;
  }

  write(file: string, name: string): void {
    assertLayout(name, this.boxes);
    if (this.frameId) {
      for (const el of this.elements) if (el.id !== this.frameId) el.frameId = this.frameId;
    }
    const scene = {
      type: "excalidraw",
      version: 2,
      source: "prospect-pipeline/docs/diagrams/generate.ts",
      elements: this.elements,
      appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
      files: {},
    };
    const path = resolve(OUT_DIR, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(scene, null, 2) + "\n");
    console.log(`wrote ${path} (${this.elements.length} elements, ${this.boxes.length} boxes)`);
  }
}

type Side = "t" | "b" | "l" | "r";
type Pt = { x: number; y: number };

function anchor(b: Box, side: Side, t: number): Pt {
  if (side === "t") return { x: b.x + b.w * t, y: b.y };
  if (side === "b") return { x: b.x + b.w * t, y: b.y + b.h };
  if (side === "l") return { x: b.x, y: b.y + b.h * t };
  return { x: b.x + b.w, y: b.y + b.h * t };
}

function shift(p: Pt, side: Side, gap: number): Pt {
  if (side === "t") return { x: p.x, y: p.y - gap };
  if (side === "b") return { x: p.x, y: p.y + gap };
  if (side === "l") return { x: p.x - gap, y: p.y };
  return { x: p.x + gap, y: p.y };
}

function midpoint(start: Pt, points: number[][]): Pt {
  const i = Math.floor((points.length - 1) / 2);
  const a = points[i];
  const b = points[i + 1];
  return { x: start.x + (a[0] + b[0]) / 2, y: start.y + (a[1] + b[1]) / 2 };
}

function bind(scene: Scene, elementId: string, boundId: string, type: string): void {
  const el = scene.elements.find((e) => e.id === elementId);
  if (!el) return;
  el.boundElements = [...(el.boundElements ?? []), { id: boundId, type }];
}

// Overlapping boxes are a layout bug: content grew past the space budgeted for it.
// Containers are exempt (they are drawn around their children on purpose).
function assertLayout(name: string, boxes: Box[]): void {
  const problems: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.container || b.container) continue;
      const overlap =
        a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      if (overlap) problems.push(`${a.name} ✕ ${b.name}`);
    }
  }
  if (problems.length) {
    console.error(`LAYOUT (${name}): ${problems.length} overlap(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
  }
}

function legend(s: Scene, x: number, y: number, entries: Array<[keyof typeof COLORS, string]>, title = "Legend"): void {
  text(s, x, y, title, { size: 14 });
  let cy = y + 26;
  for (const [key, label] of entries) {
    const sw = base("rectangle", x, cy, 22, 14, nid("r"));
    sw.backgroundColor = COLORS[key].bg;
    sw.strokeColor = COLORS[key].stroke;
    sw.roundness = { type: 3 };
    s.elements.push(sw);
    text(s, x + 32, cy - 1, label, { size: 12, color: "#495057" });
    cy += 24;
  }
}

// ===========================================================================
// Diagram 1 — system overview
// ===========================================================================

function overview(): void {
  const s = new Scene();
  const COL = [300, 560, 820, 1080, 1340, 1600];
  const CW = 230;

  text(s, 40, 40, "gtm-prospect-pipeline — system overview", { size: 28, width: 1200, align: "left" });
  s.note(
    40,
    82,
    1800,
    "Signal-driven outbound engine run by Claude Code. identify → qualify → enroll-paused → mirror. " +
      "Autonomous end to end; M4 go-live is the sole human gate.",
    14,
  );

  // --- external systems -----------------------------------------------------
  const theirstack = s.box("theirstack", COL[0], 170, CW, 110, {
    title: "TheirStack",
    body: "job-posting signal API · billed per company · server-side company-list dedupe",
    color: COLORS.ext,
  });
  const firecrawl = s.box("firecrawl", COL[1], 170, CW, 110, {
    title: "Firecrawl",
    body: "leadership / about / careers scrapes · posting re-hunt",
    color: COLORS.ext,
  });
  const salesnav = s.box("salesnav", COL[2], 170, CW, 110, {
    title: "LinkedIn Sales Navigator",
    body: "via Claude-in-Chrome, logged-in session. VIEW / SEARCH ONLY — no outreach action, ever",
    color: COLORS.ext,
  });
  const apollo = s.box("apollo", COL[3], 170, CW, 110, {
    title: "Apollo",
    body: "org + people enrichment, sequences, mailbox. THE SEND LAYER — never the record",
    color: COLORS.ext,
  });
  const twenty = s.box("twenty", COL[4], 170, CW, 110, {
    title: "Twenty CRM",
    body: "self-hosted, behind lib/twenty.ts · operational mirror + query UI · never triggers sends",
    color: COLORS.ext,
  });
  const dashboard = s.box("dashboard", COL[5], 170, CW, 110, {
    title: "Dashboard",
    body: "generated from accounts/, run records and the decision ledger · replies first, throughput second",
    color: COLORS.ext,
  });

  // --- orchestration + guards ----------------------------------------------
  const orch = s.box("orchestrator", 40, 170, 230, 110, {
    title: "/pipeline-batch",
    body: "thin orchestrator — caps and rules live IN the modules. scheduled host: headless-batch.sh under cron. laptop: interactive.",
    color: COLORS.cfg,
  });
  const ritual = s.box("ritual", 40, 360, 230, 130, {
    title: "Run-start ritual",
    body: "lib/conflict-scan.ts → sync conflicts to queue/ (exit 2 = STOP)\nlib/store-lint.ts → structural integrity\ndecisions.ts verdicts → execute rulings",
    color: COLORS.gate,
  });

  // --- modules --------------------------------------------------------------
  const m1 = s.box("m1", COL[0], 360, CW, 160, {
    title: "M1 signal-pull",
    body: "GATHERING. Multi-signal loop over signal.yaml. Writes raw/ + a stub only. lib/pull-guard.ts before any write.",
    color: COLORS.mod,
  });
  const m2 = s.box("m2", COL[1], 360, CW, 160, {
    title: "M2 triage-route",
    body: "PROCESSING. Fit triage + 3-source verification. route = QUALIFIED | SKIP | FLAGGED | DROPPED. Reads raw/, never fetches beyond 4 named sources.",
    color: COLORS.mod,
  });
  const sn = s.box("snpass", COL[2], 360, CW, 160, {
    title: "Sales Nav pass",
    body: "Every batch, agent-driven, view/search only. Capped lookups/run. Confirms the ABSENCE claims enrichment APIs are unreliable on. HEADLESS_3SOURCE → SALES_NAV.",
    color: COLORS.mod,
  });
  const m3 = s.box("m3", COL[3], 360, CW, 160, {
    title: "M3 enrich-enroll",
    body: "Apollo enrichment + ENROLL PAUSED. Suppression gate before every enrollment. Caps from config/sequences.yaml, never restated.",
    color: COLORS.mod,
  });
  const m8 = s.box("m8", COL[4], 360, CW, 160, {
    title: "M8 crm-sync (push)",
    body: "MIRRORING. Reads accounts/, writes Twenty, fetches nothing, interprets nothing. syncHash = cheap no-op. Excludes dropped.",
    color: COLORS.mod,
  });
  const m7 = s.box("m7", COL[5], 360, CW, 160, {
    title: "M7 recorder-sync",
    body: "Records for HUMANS: registry entry, batch digest, progress.md, structured run record, decision ledger, dashboard.",
    color: COLORS.mod,
  });

  // --- config ---------------------------------------------------------------
  const signalCfg = s.box("signal.yaml", COL[0], 570, CW, 130, {
    title: "config/signal.yaml",
    body: "the LABEL CATALOG: one block per signal (query optional), aliases, per-signal policy gates, dedupe + limits",
    color: COLORS.cfg,
  });
  const seqCfg = s.box("sequences.yaml", COL[1], 570, CW, 130, {
    title: "config/sequences.yaml",
    body: "the ONLY place Apollo sequence ids live: binds {signals, routes}, lifecycle draft|active|retired, supersedes, caps, suppression, merge fields",
    color: COLORS.cfg,
  });
  const resolver = s.box("resolver", COL[2], 570, CW, 130, {
    title: "lib/sequence-resolver.ts",
    body: "signals label accounts · sequences subscribe · lifecycle gates enrollment. Emits ENROLL <id> | HOLD. --validate after ANY config edit.",
    color: COLORS.cfg,
  });
  const statusMap = s.box("status-map", COL[3], 570, CW, 130, {
    title: "lib/status-map.ts",
    body: "store status ⇄ Twenty SELECT vocabulary; ROUTES; verification methods. The shared enum spine (evals mirror it).",
    color: COLORS.cfg,
  });

  // --- store ----------------------------------------------------------------
  const storeBox = s.box("store", 280, 750, 1570, 250, {
    title: "$PIPELINE_DATA — ~/Data/gtm-prospect-pipeline (file-synced between hosts · no git, no secrets)",
    color: COLORS.store,
    container: true,
    titleSize: 14,
  });
  const raw = s.box("raw", 300, 800, 370, 180, {
    title: "raw/",
    body: "CAPTURE TRUTH — immutable, append-only, timestamped, machine-suffixed:\ntheirstack/ · postings/ · apollo/ · firecrawl/ · salesnav/ · twenty/",
    color: COLORS.store,
  });
  const accounts = s.box("accounts", 690, 800, 370, 180, {
    title: "accounts/<domain>/",
    body: "DERIVED, always rebuildable from raw/ — AUTHORITATIVE ON CONFLICT.\naccount.yaml: status · route · verification · contacts[] · raw_pointers · crm ids\nevidence.md: one citation per fact",
    color: COLORS.store,
  });
  const queue = s.box("queue", 1080, 800, 370, 180, {
    title: "queue/",
    body: "the things a human or the next run must resolve: flags.md · salesnav-pending.md · decisions.jsonl · CRM drift · sync conflicts",
    color: COLORS.store,
  });
  const logs = s.box("logs", 1470, 800, 370, 180, {
    title: "registry.md · progress.md",
    body: "human logbook + per-run record (funnel, credit spend, flip rate). A run that produces no progress.md record alerts as a NO-OP.",
    color: COLORS.store,
  });

  const sor = s.box("sor", 40, 750, 230, 250, {
    title: "System of record",
    body: "1 · raw/ — capture truth\n2 · accounts/ — canonical derived state, wins every conflict\n3 · CRM — mirror + activity log\n4 · Apollo — send layer, never the record",
    color: COLORS.state,
  });

  // --- out-of-band modules + gate ------------------------------------------
  const m5 = s.box("m5", COL[0], 1050, CW, 150, {
    title: "M5 evidence-collector",
    body: "per-account deep evidence → evidence.md (one citation per fact). Runs out-of-band, batchable, each followed by an M8 push.",
    color: COLORS.mod,
  });
  const m8r = s.box("m8-reconcile", COL[1], 1050, CW * 2 + 30, 150, {
    title: "M8 reconcile (daily while sequences are active) · audit + pull-back (weekly)",
    body: "Apollo contact statuses → raw/ → account.yaml → Twenty, with a note per change. Reply → Opportunity(NEW) + task. Opt-out → Apollo stop + DNC (the only authorized Apollo write) + store + Twenty. Audit: full Twenty export → raw/twenty/, three-way count reconcile, UI-side drift → queue/.",
    color: COLORS.mod,
  });
  const m4 = s.box("m4", COL[3], 1050, CW * 2 + 30, 150, {
    title: "M4 go-live — THE ONLY HUMAN GATE",
    body: "Human-only, never headless, never inferred from context. A human names the batch → M4 unpauses exactly those contacts in Apollo → confirms counts back → immediate M8 push (LIVE + go-live note). Everything upstream is autonomous; every enrollment sits paused until this.",
    color: COLORS.human,
  });

  const evals = s.box("evals", 40, 1050, 230, 150, {
    title: "evals/ + check-evals.sh",
    body: "regression suite over the LLM-judgment surfaces. $0 offline gate blocks any edit to skills/*/SKILL.md and config/*.yaml that regresses a paid-for lesson.",
    color: COLORS.gate,
  });

  const rules = s.box("rules", 40, 1250, 1810, 90, {
    title: "Hard rules that survive any refactor",
    body: "never send without a human “go” · everything enrolls PAUSED · mailbox cap from config · suppression check before EVERY enrollment · any disqualifier → SKIP (binary, account-level) · " +
      "no automated LinkedIn OUTREACH, ever · capture-first: every response to raw/ verbatim BEFORE interpretation · check-then-write on every account create · " +
      "store outranks the CRM · the CRM never sends · connector flake = one ~60s retry then BLOCKED, never a looser source",
    color: COLORS.gate,
    align: "left",
  });

  // --- wiring ---------------------------------------------------------------
  s.link(orch, "r", m1, "l", { label: "M1→M2→M3→M8→M7" });
  s.link(orch, "b", ritual, "t");
  s.link(theirstack, "b", m1, "t");
  s.link(firecrawl, "b", m2, "t");
  s.link(salesnav, "b", sn, "t");
  s.link(apollo, "b", m3, "t");
  s.link(apollo, "b", m2, "t", {
    dashed: true,
    fromT: 0.15,
    toT: 0.85,
    route: [[COL[3] + 34, 322], [COL[1] + CW * 0.85, 322]],
    label: "org sweep (0 credits)",
  });
  s.link(m8, "t", twenty, "b", { both: true, label: "push · reconcile · audit" });
  s.link(m7, "t", dashboard, "b");
  s.link(m3, "t", apollo, "b", { fromT: 0.8, toT: 0.8, label: "enroll PAUSED" });

  s.link(m1, "r", m2, "l");
  s.link(m2, "r", sn, "l");
  s.link(sn, "r", m3, "l");
  s.link(m3, "r", m8, "l");
  s.link(m8, "r", m7, "l");

  s.link(signalCfg, "t", m1, "b", { color: "#6741d9", label: "enabled signal blocks" });
  s.link(signalCfg, "t", m2, "b", { color: "#6741d9", dashed: true, fromT: 0.85, toT: 0.15 });
  s.link(seqCfg, "r", resolver, "l", { color: "#6741d9" });
  s.link(resolver, "t", m3, "b", { color: "#6741d9", fromT: 0.85, toT: 0.2, label: "ENROLL | HOLD" });
  s.link(statusMap, "t", m8, "b", { color: "#6741d9", fromT: 0.85, toT: 0.2, dashed: true });

  // One arrow each way, drawn in the clear margins: every module writes raw/ before it
  // interprets anything, and reads its inputs back out of the store.
  s.link(m1, "l", storeBox, "l", {
    color: "#2f9e44",
    fromT: 0.85,
    toT: 0.1,
    route: [[285, 490], [285, 770]],
    label: "writes",
  });
  s.link(storeBox, "r", m7, "r", {
    color: "#2f9e44",
    fromT: 0.1,
    toT: 0.85,
    route: [[1880, 775], [1880, 496]],
    label: "reads",
  });
  s.link(logs, "t", m7, "b", { color: "#2f9e44", both: true, toT: 0.8, fromT: 0.7 });

  s.link(m4, "l", m8r, "r", { dashed: true });
  s.link(evals, "l", signalCfg, "l", {
    color: "#e03131",
    dashed: true,
    route: [[20, 1125], [20, 700], [292, 700]],
    label: "gates edits to skills + config",
  });
  s.link(m5, "t", accounts, "b", { color: "#2f9e44", dashed: true, toT: 0.15 });

  legend(s, 1600, 1050, [
    ["ext", "external system / integration"],
    ["mod", "pipeline module (agent skill)"],
    ["cfg", "config + resolution code"],
    ["store", "local store — $PIPELINE_DATA"],
    ["gate", "guard / gate / hard rule"],
    ["human", "human action"],
  ]);

  s.write("00-overview.excalidraw", "overview");
}

// ===========================================================================
// Diagram 2 — data flow & integrations
// ===========================================================================

function dataflow(): void {
  const s = new Scene();
  const CW = 300;
  const GAP = 40;
  const X = (i: number): number => 220 + i * (CW + GAP);
  const Y_EXT = 200;
  const Y_MOD = 400;
  const Y_STORE = 720;
  const Y_STATE = 980;
  const Y_GATE = 1080;

  text(s, 40, 40, "gtm-prospect-pipeline — data flow & integrations", { size: 28, width: 1200, align: "left" });
  s.note(
    40,
    82,
    2400,
    "One batch, left to right. Every external response lands in raw/ verbatim BEFORE anything interprets it; account.yaml is the derived state, " +
      "and its `status` is the only thing that decides what the next module may do.",
    14,
  );

  const bandExt = s.box("band-ext", 40, Y_EXT, 160, 110, {
    title: "EXTERNAL",
    body: "API / browser call",
    color: COLORS.ext,
    titleSize: 14,
  });
  const bandMod = s.box("band-mod", 40, Y_MOD, 160, 110, {
    title: "MODULE",
    body: "skills/m*/SKILL.md",
    color: COLORS.mod,
    titleSize: 14,
  });
  const bandStore = s.box("band-store", 40, Y_STORE, 160, 110, {
    title: "STORE",
    body: "capture-first write",
    color: COLORS.store,
    titleSize: 14,
  });
  const bandState = s.box("band-state", 40, Y_STATE, 160, 70, {
    title: "STATE",
    body: "account.yaml",
    color: COLORS.state,
    titleSize: 14,
  });

  type Stage = {
    key: string;
    ext: [string, string];
    mod: [string, string];
    store: [string, string];
    state: string;
    gate?: [string, string];
    human?: boolean;
  };

  const stages: Stage[] = [
    {
      key: "m1",
      ext: [
        "TheirStack",
        "search_companies / search_jobs per enabled signal block. Credit guard from config. Dedupe: company_list_id_not + the ranked company_domain_not leg (lib/dedupe-leg.ts). Explicit limit on every call. Optional 0-credit preflight count first.",
      ],
      mod: [
        "M1 · signal-pull",
        "GATHERING — writes raw/ + minimal flags, interprets nothing. Loops every signal.yaml block with enabled: true (each a self-contained filter set; block name = signal_source). Feeds every returned id back to the dedupe list.\n\nlib/pull-guard.ts checks EVERY domain against the store before a single write — a source calling a domain “new” is not evidence (a blind stub write once destroyed live accounts). createAccountStub() then refuses to overwrite.",
      ],
      store: [
        "raw/theirstack/<date>-pull-<n>.json",
        "raw/postings/<domain>/<date>-<slug>.md — JD FULL TEXT at pull time (the richest artifact)\naccounts/<domain>/account.yaml — stub only",
      ],
      state: "status: pulled",
    },
    {
      key: "m2",
      ext: [
        "Apollo · Firecrawl",
        "(a) Apollo full-org people sweep — broad seniority, not just the obvious titles (0 credits)\n(b) Firecrawl leadership / about page\n(c) job-posting evidence from raw/postings/",
      ],
      mod: [
        "M2 · triage-route",
        "PROCESSING — reads raw/, writes accounts/, fetches nothing beyond those named sources (each captured first).\n\nFit triage drops: the drop classes in config/icp.md (vendors in your own category, staffing, investors, job boards, out-of-band size, domain mismaps).\nRoute (classification only, account-level, binary): QUALIFIED | SKIP (any disqualifier, reason in skip_reason) | FLAGGED (conflicting/thin — never guess) | DROPPED (drop_class from icp.md).",
      ],
      store: [
        "raw/apollo/<domain>/ · raw/firecrawl/<domain>/",
        "account.yaml: route, skip_reason / drop_class, evidence_note, signal_source, raw_pointers, verification: HEADLESS_3SOURCE (provisional)",
      ],
      state: "status: triaged\ndrops → status: dropped (STORE-ONLY, never mirrored)",
      gate: [
        "POLICY GATE",
        "signal.yaml policy.require_salesnav_before_route: true — the account stops here. Enrichment APIs are hit-or-miss on recent hires, so an ABSENCE claim is not yet a fact.",
      ],
    },
    {
      key: "salesnav",
      ext: [
        "LinkedIn Sales Navigator",
        "driven through Claude-in-Chrome against a logged-in session (a headless host qualifies). VIEW / SEARCH ONLY — connection requests, messages, InMail, follows and reactions are absolutely banned.",
      ],
      mod: [
        "Sales Nav verification pass",
        "Standing practice on EVERY batch; agent-driven, interactive only when no browser is reachable.\n\nqueue/salesnav-pending.md backlog first, then this run's survivors, ≤ limits.salesnav_lookups_per_run with human-like pacing. Overflow stays queued for the next run.\n\nIt keeps catching disqualifiers the APIs missed — this is why headless routing is provisional.",
      ],
      store: [
        "raw/salesnav/<domain>/<date>-notes[-<host>].md",
        "written AT observation time, never reconstructed later.\naccount.yaml: verification: SALES_NAV — or route flipped to SKIP / FLAGGED",
      ],
      state: "status: routed",
      gate: [
        "DEGRADE PATH",
        "browser/extension unreachable or an auth wall = connector flake: one ~60s retry, then degrade to the browserless profile — survivors queued, no enrollment, run reports DEGRADED. Never a failed batch, never a looser verification source.",
      ],
    },
    {
      key: "m3",
      ext: [
        "Apollo",
        "people match/enrich (1 credit each) · sequence enrollment with status:\"paused\" · Do Not Contact — Unsubscribed list read",
      ],
      mod: [
        "M3 · enrich-enroll",
        "node lib/sequence-resolver.ts <domain> → ENROLL <id> (+ required merge fields) or HOLD. A match on a non-active sequence HOLDs — never a fallback to some other sequence — and becomes enrollable the moment a successor flips to active.\n\nHARD GATE before ANY enrollment: Apollo DNC list + Twenty outreachStatus/sequenceStatus OPTED_OUT + store opted-out/skipped/never_enroll.\n\nMulti-thread (operator + tech owner); 2nd same-company contact needs sequence_same_company_in_same_campaign. Never fabricate an address — HOLD instead. Caps: config/sequences.yaml caps:, read at run time.",
      ],
      store: [
        "raw/apollo/<domain>/<date>-{people,contacts}.json",
        "account.yaml: contacts[] with apollo ids, sequence id, step, enrolledAt, merge fields (e.g. hiring_signal — unset = step 1 renders a raw variable)",
      ],
      state: "status: enrolled-paused\n(no email / ambiguous identity → held)",
    },
    {
      key: "m8push",
      ext: [
        "Twenty CRM (REST)",
        "/rest/companies · /rest/people · /rest/notes + noteTargets (two calls to link). Batch ≤60/call, throttle ~10 req/s. Bearer key from ~/.config/gtm-prospect-pipeline/env, never the repo.",
      ],
      mod: [
        "M8 · crm-sync (push)",
        "MIRRORING — reads accounts/, writes Twenty, fetches nothing, interprets nothing.\n\nUpsert company by domainName.primaryLinkUrl + people by apolloContactId (fallback email). Owned-field set per lib/status-map.ts. ONE note per account per batch; notes/tasks/opportunities dedupe on title+companyId so a re-run never duplicates.\n\nDropped accounts are excluded unconditionally, even with a stale crm pointer.",
      ],
      store: [
        "account.yaml crm: {twentyCompanyId, twentyPersonIds, lastSyncedAt, syncHash}",
        "syncHash over the owned fields makes an unchanged push a no-op.",
      ],
      state: "Twenty outreachStatus: ENROLLED_PAUSED\nperson sequenceStatus: PAUSED",
      gate: [
        "POLICY GATE",
        "signal.yaml policy.push_to_crm_after: enrolled — a holdout signal's accounts have NO CRM presence before enrollment (skipped still mirrors: a verified suppression decision is worth keeping). Audit flags an early push as a stray.",
      ],
    },
    {
      key: "m7",
      ext: ["Dashboard", "dashboard.ts regenerates $PIPELINE_DATA/dashboard/index.html from accounts/, run records, the decision ledger and the resolver — last step, after the run record is appended"],
      mod: [
        "M7 · recorder-sync",
        "Records for HUMANS; M8 mirrors machine state to the CRM. Both read the same account.yaml diffs; neither writes the other's targets.\n\nregistry entry · batch digest (funnel, credit spend, “reply go” line) · progress.md · structured run record carrying the FLIP RATE (headless route vs. post-Sales-Nav final) — the production error rate the eval suite predicts.",
      ],
      store: ["registry.md · progress.md · logs/ · queue/", "logs/run-records.jsonl (run-record.ts) · queue/decisions.jsonl (decisions.ts) — append-only, machine-readable, trendable"],
      state: "batch closed\n(no progress.md record = NO-OP alert)",
    },
    {
      key: "m4",
      ext: ["Apollo", "unpause exactly the named contacts. This is the only moment anything is authorized to send."],
      mod: [
        "M4 · go-live",
        "HUMAN ONLY. Never headless, never inferred from context, never “implied” by a passing batch. A human names the batch; M4 unpauses precisely that batch and confirms counts back.\n\nEverything upstream of here is autonomous — which is exactly why this stays a hand on the switch.",
      ],
      store: ["account.yaml: status: active", "M4 triggers an immediate M8 push (company LIVE, people ACTIVE, go-live note with date/sequence/contact count)"],
      state: "status: active → Twenty LIVE",
      human: true,
    },
    {
      key: "reconcile",
      ext: [
        "Apollo → Twenty",
        "apollo_contacts_search paged over all enrolled contacts (captured verbatim first). Opt-out writes back: campaigns remove_or_stop mode:\"stop\" + DNC list add.",
      ],
      mod: [
        "M8 · reconcile (daily while any sequence is active)",
        "The gatherer half: capture → diff contact_campaign_statuses against account.yaml → update the store → push to Twenty with a note per change.\n\nInterest reply → company REPLIED + Opportunity (NEW → SCREENING → MEETING → PROPOSAL → CUSTOMER) + respond-task + the reply pasted into a note.\n\nUnsubscribe/negative reply → the pre-authorized opt-out procedure, executed instantly across all three systems.",
      ],
      store: [
        "raw/apollo/<date>-… → account.yaml → Twenty",
        "raw/twenty/<date>-export-{companies,people,notes}.jsonl (backup-independent audit trail)",
      ],
      state: "status: replied | finished | opted-out",
      gate: [
        "AUDIT / PULL-BACK (weekly)",
        "full Twenty export → raw/twenty/<date>-export-*.jsonl · three-way count reconcile (store vs Twenty vs Apollo) · UI-side edits to M8-owned fields → queue/ for human review, never silently absorbed or clobbered. Dropped accounts are expected ABSENT; one found present is a stray.",
      ],
    },
  ];

  const mods: Box[] = [];
  const firsts: Record<string, Box> = {};
  stages.forEach((st, i) => {
    const x = X(i);
    const ext = s.box(`${st.key}-ext`, x, Y_EXT, CW, 150, {
      title: st.ext[0],
      body: st.ext[1],
      color: COLORS.ext,
      titleSize: 15,
    });
    const mod = s.box(`${st.key}-mod`, x, Y_MOD, CW, 260, {
      title: st.mod[0],
      body: st.mod[1],
      color: st.human ? COLORS.human : COLORS.mod,
      titleSize: 16,
    });
    const store = s.box(`${st.key}-store`, x, Y_STORE, CW, 200, {
      title: st.store[0],
      body: st.store[1],
      color: COLORS.store,
      titleSize: 13,
    });
    const state = s.box(`${st.key}-state`, x, Y_STATE, CW, 60, {
      title: st.state,
      color: COLORS.state,
      titleSize: 13,
    });
    s.link(ext, "b", mod, "t", { color: "#e8590c", label: i === 0 ? "capture verbatim" : undefined });
    s.link(mod, "b", store, "t", { color: "#2f9e44" });
    s.link(store, "b", state, "t", { color: "#868e96" });
    if (st.gate) {
      s.box(`${st.key}-gate`, x, Y_GATE, CW, 130, {
        title: st.gate[0],
        body: st.gate[1],
        color: COLORS.gate,
        titleSize: 13,
      });
    }
    mods.push(mod);
    if (i === 0) {
      firsts.ext = ext;
      firsts.mod = mod;
      firsts.store = store;
      firsts.state = state;
    }
  });

  for (let i = 0; i < mods.length - 1; i++) {
    s.link(mods[i], "r", mods[i + 1], "l", {
      color: "#1971c2",
      label: i === 6 ? "separate daily schedule — not part of the batch chain" : undefined,
    });
  }

  s.link(bandExt, "r", firsts.ext, "l", { color: "#adb5bd", dashed: true });
  s.link(bandMod, "r", firsts.mod, "l", { color: "#adb5bd", dashed: true });
  s.link(bandStore, "r", firsts.store, "l", { color: "#adb5bd", dashed: true });
  s.link(bandState, "r", firsts.state, "l", { color: "#adb5bd", dashed: true });

  const sync = s.box("sync", 220, 1260, X(7) + CW - 220, 110, {
    title: "$PIPELINE_DATA is file-synced between hosts — no git on data, no secrets in either tree",
    body: "raw/ filenames are timestamped and machine-unique → append-only and conflict-free. account.yaml is THE conflict surface: lib/conflict-scan.ts scans for *.sync-conflict* at every run start and routes hits to queue/ — never ignored, never auto-merged. " +
      "Soft single-writer convention: scheduled/headless writes on one host, interactive sessions on the other. Secrets stay per-host in ~/.config/gtm-prospect-pipeline/env (chmod 600).",
    color: COLORS.store,
    align: "left",
  });

  s.box("sor2", 40, 1260, 160, 110, {
    title: "HOSTS",
    body: "scheduled: headless + CRM + browser\nlaptop: interactive + go-live",
    color: COLORS.state,
    titleSize: 14,
  });

  legend(s, 220, 1420, [
    ["ext", "external system"],
    ["mod", "module"],
    ["store", "store write (capture-first)"],
    ["state", "resulting state"],
    ["gate", "policy gate / degrade path"],
    ["human", "human-only step"],
  ]);

  s.note(
    600,
    1420,
    1400,
    "Read the STORE band as the contract: a module may only act on what a previous module durably wrote. " +
      "That is what makes every module idempotent and separately re-invocable — a mid-run failure is fixed by re-running the one module, not the batch.",
    13,
  );

  s.write("01-data-flow.excalidraw", "data-flow");
}

// ===========================================================================
// Diagram 3 — eval system
// ===========================================================================

function evals(): void {
  const s = new Scene();

  text(s, 40, 40, "gtm-prospect-pipeline — the eval system", { size: 28, width: 1200, align: "left" });
  s.note(
    40,
    82,
    2000,
    "Regression evals for the pipeline's LLM-judgment surfaces. Every judgment failure to date was caught live and encoded as SKILL.md prose — nothing detected when an edit silently un-learned one. This does.",
    14,
  );

  const gate = s.box("check-evals", 420, 140, 1340, 120, {
    title: "scripts/check-evals.sh — the $0 pre-edit gate (no model calls, no credits, no network)",
    body: "harness self-tests → fixture immutability + completeness vs the committed baseline → full --offline replay run.\nRun it before landing ANY edit to skills/*/SKILL.md, config/icp.md, config/signal.yaml or config/sequences.yaml. Exit 1 blocks the edit until reconciled.",
    color: COLORS.gate,
    align: "left",
  });

  // --- inputs ---------------------------------------------------------------
  const fixtures = s.box("fixtures", 40, 320, 320, 210, {
    title: "evals/fixtures/cases/<task>/<id>/",
    body: "fixture.yaml — one frozen decision: gold = the POST-CORRECTION outcome (after human review, after the Sales Nav pass, after the incident writeup), plus `forbidden` traps naming the specific wrong answer that actually happened.\ninputs/ — excerpted raw captures (≤50KB/file), no secrets, no gold leakage.",
    color: COLORS.store,
    titleSize: 14,
  });
  const loader = s.box("loader", 40, 560, 320, 170, {
    title: "harness/loader.ts",
    body: "loads + validates: required input roles per task, enum vocabularies scoped per task, drop_class validated against config/icp.md, traps must name a field the task actually carries.\nsha = fixture.yaml + raw input bytes.",
    color: COLORS.cfg,
    titleSize: 14,
  });
  const sources = s.box("sources", 40, 760, 320, 170, {
    title: "PROMPT SOURCES — the live production text",
    body: "skills/m1-signal-pull/SKILL.md · skills/m2-triage-route/SKILL.md · skills/m5-evidence-collector/SKILL.md · config/icp.md · config/signal.yaml · config/sequences.yaml",
    color: COLORS.ext,
    titleSize: 14,
  });
  const prompt = s.box("prompt", 40, 960, 320, 190, {
    title: "harness/prompt.ts",
    body: "extractSection() pulls the sections the production module would actually follow — quoted, never paraphrased — and appends the reason-first output protocol (prose reasoning, then exactly one strict JSON verdict).\nprompt_sha (template only, inputs excluded) is recorded per run and in the baseline: a skill edit shows up as a sha change and its effect is MEASURED.",
    color: COLORS.cfg,
    titleSize: 14,
  });

  // --- chain ----------------------------------------------------------------
  const runners = s.box("runners", 420, 470, 320, 420, {
    title: "harness/runners/<task>.ts",
    body: "Context is assembled ONLY from fixture inputs + live skill text — never from the live store (evals are read-only against $PIPELINE_DATA).\n\nfit-triage — keep/drop + reason class\nroute — QUALIFIED | SKIP | FLAGGED | DROPPED\nsalesnav-verdict — confirm | flip_to_skip | flag from captured roster text\nevidence-synthesis — produce evidence.md from a full raw set",
    color: COLORS.mod,
    titleSize: 15,
  });

  const model = s.box("model", 800, 470, 320, 300, {
    title: "harness/model.ts — ModelClient",
    body: "LIVE: shells out to `claude -p --output-format json --model <EVAL_MODEL>` — works on any host, no API key in the repo. Records a replay for every call.\n\nOFFLINE: replays/<task>/<id>.json, committed and keyed to the fixture sha — deterministic, $0, and the corpus check-evals.sh runs. A stale replay is a skip, and skips are reported loudly.",
    color: COLORS.mod,
    titleSize: 15,
  });

  const parse = s.box("parse", 800, 820, 320, 260, {
    title: "verdict parsing",
    body: "Follows the stated protocol: the object the reply ENDS with is the verdict, and it must carry the primary field as a string.\n\nNo fallback to an earlier object — the retracted one is frequently the forbidden value, which would report a paid-for lesson as regressed on a reply that answered correctly.\n\nParse failure = WRONG (scored 0, raw response in details) — never a skip.",
    color: COLORS.mod,
    titleSize: 15,
  });

  const scoring = s.box("scoring", 1180, 470, 320, 330, {
    title: "harness/scoring.ts",
    body: "Exact match on the task's primary field → accuracy (the gated metric).\nSecondary fields (classification, name recall) scored and reported, never gated.\nforbidden_hits counted per fixture.\nevidence-synthesis instead: a deterministic citation check (every claim line ends with [<path> · fact|inference|hypothesis] resolving to a real input) + an LLM judge on the must/should rubric → must_pass_rate.",
    color: COLORS.mod,
    titleSize: 15,
  });

  const report = s.box("report", 1180, 840, 320, 260, {
    title: "harness/report.ts",
    body: "results/<ts>_<git_sha>.json per run (gitignored)\nresults/history.jsonl — the trend, live runs only\nbaselines/baseline.json — committed: gated metrics + prompt_shas + fixture_shas\n\ngit_sha takes a -dirty suffix when skills/ or config/ are dirty: “the prompts in this run are not reproducible from this commit”.",
    color: COLORS.cfg,
    titleSize: 15,
  });

  const gates = s.box("gates", 1560, 470, 380, 630, {
    title: "THE GATES — exit 1 on any of these",
    body: "· forbidden_hits > 0 — a specific historical failure regressed. Absolute; no tolerance applies.\n\n· gated metric below baseline − tolerance (default 0.02).\n\n· fixture sha ≠ baseline (immutability) — changing a fixture means bumping `version`, saying why, and rewriting the baseline in the same change.\n\n· a fixture id in the baseline no longer loads (completeness) — deleting an inconvenient fixture used to pass every gate in silence.\n\n· coverage shrank: fewer fixtures scored than the baseline scored. Accuracy is a rate, and the fixture that skipped is the one whose sha moved.\n\n· a task loaded fixtures and scored NONE of them → gated metric forced to 0.0, offline too. That is exactly the post-SKILL.md-edit state check-evals.sh exists to catch.\n\n· a runner that will not import — no graceful absence, no silent drop from the report.\n\n· --baseline refuses to record from a broken run (forced-zero task, n:0, or fewer tasks than TASKS).",
    color: COLORS.gate,
    titleSize: 15,
    align: "left",
  });

  const verdict = s.box("verdict", 1180, 1140, 320, 90, {
    title: "exit 0 = land the edit · exit 1 = reconcile first",
    color: COLORS.state,
    titleSize: 14,
  });

  // --- flywheel -------------------------------------------------------------
  const fw1 = s.box("fw-store", 40, 1320, 320, 180, {
    title: "$PIPELINE_DATA (read-only)",
    body: "The unfair advantage: capture-first means every historical decision's complete input is already frozen in raw/, and the corrected outcome is recorded in account.yaml + progress.md + the registry. Fixtures are ASSEMBLED, not invented.",
    color: COLORS.store,
    titleSize: 14,
  });
  const fw2 = s.box("fw-draft", 420, 1320, 320, 180, {
    title: "evals/draft-fixture.ts <domain>",
    body: "scaffolds a fixture into staging/ from the account's raw_pointers + corrected account.yaml, gold pre-filled from the corrected state.",
    color: COLORS.cfg,
    titleSize: 14,
  });
  const fw3 = s.box("fw-staging", 800, 1320, 320, 180, {
    title: "staging/ — never loaded",
    body: "No immutability, no scoring, no influence on any gate. Unreviewed gold never leaves this directory.",
    color: COLORS.state,
    titleSize: 14,
  });
  const fw4 = s.box("fw-human", 1180, 1320, 320, 180, {
    title: "human review",
    body: "confirms the gold label and writes the `forbidden` trap encoding the failure that actually happened. No automated gold relabeling, ever — gold changes are human decisions with provenance.",
    color: COLORS.human,
    titleSize: 14,
  });
  const fw5 = s.box("fw-commit", 1560, 1320, 380, 180, {
    title: "cases/<task>/ + `--task all --baseline`",
    body: "a full live run records the replays and rewrites the baseline. Adding a fixture is a deliberate baseline change — as is retiring one (move to retired/<id>/ with a RETIRED.md).",
    color: COLORS.store,
    titleSize: 14,
  });

  const flip = s.box("flip", 800, 1620, 700, 140, {
    title: "The live metric this suite predicts: FLIP RATE",
    body: "headless provisional route vs. post-Sales-Nav final, tracked per batch in M7's structured run record — the production error rate. " +
      "Offline suite green while flip rate climbs = a failure mode the fixtures don't cover yet. Turn the flips into fixtures.",
    color: COLORS.gate,
    titleSize: 15,
  });

  // --- wiring ---------------------------------------------------------------
  s.link(fixtures, "b", loader, "t");
  s.link(sources, "b", prompt, "t");
  s.link(loader, "r", runners, "l", { toT: 0.25, label: "fixtures + shas" });
  s.link(prompt, "r", runners, "l", { toT: 0.8, label: "template + prompt_sha" });
  s.link(runners, "r", model, "l", { toT: 0.5, label: "one request per fixture" });
  s.link(model, "b", parse, "t", { color: "#1971c2" });
  s.link(parse, "r", scoring, "l", { toT: 0.85 });
  s.link(scoring, "b", report, "t", { color: "#1971c2" });
  s.link(report, "r", gates, "l", { toT: 0.85 });
  s.link(gates, "b", verdict, "r", { color: "#e03131" });
  s.link(gate, "l", sources, "l", {
    color: "#e03131",
    dashed: true,
    route: [[20, 200], [20, 845]],
    label: "exit 1 blocks the edit",
  });
  s.link(gate, "b", model, "t", { color: "#e03131", dashed: true, fromT: 0.6, label: "--offline" });
  s.link(gate, "b", fixtures, "t", { color: "#e03131", dashed: true, fromT: 0.05, elbow: "v", label: "immutability + completeness" });

  s.link(fw1, "r", fw2, "l");
  s.link(fw2, "r", fw3, "l");
  s.link(fw3, "r", fw4, "l");
  s.link(fw4, "r", fw5, "l");
  s.link(fw5, "r", fixtures, "t", {
    color: "#2f9e44",
    route: [[1990, 1410], [1990, 295], [200, 295]],
    label: "committed, hashed, gated",
  });
  s.link(flip, "l", fw2, "b", { dashed: true, color: "#e03131", label: "new failure mode → new fixture" });

  legend(s, 40, 1620, [
    ["ext", "live production text (the thing under test)"],
    ["cfg", "harness code"],
    ["mod", "run stage"],
    ["store", "frozen artifacts"],
    ["gate", "gate / failure signal"],
    ["human", "human judgment"],
  ]);

  s.write("02-eval-system.excalidraw", "eval-system");
}

// ===========================================================================
// Slide versions — 16:9, one idea per box, readable from the back of a room.
// Same three subjects as above, cut to what survives a projector.
// ===========================================================================

const SLIDE_W = 1600;
const SLIDE_H = 900;

function slideHeader(s: Scene, title: string, sub: string): void {
  s.frame(title, 0, 0, SLIDE_W, SLIDE_H);
  text(s, 60, 48, title, { size: 40, width: 1480, align: "left" });
  text(s, 60, 104, sub, { size: 19, width: 1480, align: "left", color: "#495057" });
}

function slideFooter(s: Scene, line: string): void {
  text(s, 60, 820, line, { size: 18, width: 1480, align: "left", color: "#495057" });
}

function slideOverview(): void {
  const s = new Scene();
  slideHeader(
    s,
    "gtm-prospect-pipeline",
    "Outbound as a pipeline of small, separately-runnable modules: identify → qualify → enroll paused → mirror.",
  );

  s.box("integrations", 60, 170, 1480, 76, {
    title: "Integrations:   TheirStack   ·   Firecrawl   ·   LinkedIn Sales Navigator   ·   Apollo   ·   Twenty CRM",
    color: COLORS.ext,
    titleSize: 21,
    align: "left",
    vcenter: true,
  });

  const chipY = 292;
  const chipW = 272;
  const chipH = 150;
  const chipX = (i: number): number => 60 + i * (chipW + 24);
  const chips: Array<[string, string]> = [
    ["M1 · Signal", "find companies whose own job posts show the buying signal"],
    ["M2 · Triage", "is this the ICP, and does a disqualifier apply?"],
    ["Sales Nav", "confirm what the data sources can't prove: no disqualifier"],
    ["M3 · Enroll", "enrich, pick the sequence from config, enroll PAUSED"],
    ["M8 + M7 · Mirror", "CRM mirror, registry, digest, run record, dashboard"],
  ];
  const chipBoxes = chips.map(([t, b], i) =>
    s.box(`chip${i}`, chipX(i), chipY, chipW, chipH, { title: t, body: b, color: COLORS.mod, titleSize: 22, bodySize: 15, align: "center", vcenter: true }),
  );
  for (let i = 0; i < chipBoxes.length - 1; i++) s.link(chipBoxes[i], "r", chipBoxes[i + 1], "l", { color: "#1971c2" });

  const store = s.box("store", 60, 500, 1480, 110, {
    title: "One local store — raw/ (every response, verbatim)  →  accounts/ (the canonical state)",
    body: "Modules never talk to each other. They read the store, write the store, and are individually re-runnable.",
    color: COLORS.store,
    titleSize: 22,
    bodySize: 16,
    align: "left",
    vcenter: true,
  });
  s.link(chipBoxes[2], "b", store, "t", { color: "#2f9e44" });

  const human = s.box("m4", 60, 660, 470, 130, {
    title: "M4 · Go-live — the only human gate",
    body: "Everything upstream runs unattended. Nothing sends until a human names a batch.",
    color: COLORS.human,
    titleSize: 22,
    bodySize: 16,
    vcenter: true,
  });
  s.box("rules", 554, 660, 986, 130, {
    title: "The rules that never bend",
    align: "left",
    body: "Every enrollment lands paused  ·  suppression checked before every send  ·  a disqualifier is an instant skip  ·  no automated LinkedIn outreach, ever  ·  nothing is interpreted before it is captured",
    color: COLORS.gate,
    titleSize: 22,
    bodySize: 16,
    vcenter: true,
  });
  s.link(human, "t", store, "b", { color: "#f08c00", toT: 0.2 });

  slideFooter(s, "Autonomous end to end — with one hand deliberately left on the switch.");
  s.write("10-slide-overview.excalidraw", "slide-overview");
}

function slideDataFlow(): void {
  const s = new Scene();
  slideHeader(s, "How one batch moves", "Each stage calls one kind of source, writes what it saw, and leaves the account in a state the next stage can trust.");

  const cw = 228;
  const gap = 24;
  const x = (i: number): number => 60 + i * (cw + gap);
  const stages: Array<[string, string, string]> = [
    ["Pull", "TheirStack", "pulled"],
    ["Triage", "Apollo · Firecrawl", "triaged"],
    ["Verify", "Sales Navigator", "routed"],
    ["Enroll", "Apollo (paused)", "enrolled-paused"],
    ["Mirror", "Twenty CRM", "in the CRM"],
    ["Go live", "human", "active"],
  ];
  const boxes = stages.map(([t, src, st], i) =>
    s.box(`s${i}`, x(i), 200, cw, 150, {
      title: t,
      body: src,
      color: i === 5 ? COLORS.human : COLORS.mod,
      titleSize: 24,
      bodySize: 16,
      align: "center",
      vcenter: true,
    }),
  );
  stages.forEach(([, , st], i) => {
    const pill = s.box(`st${i}`, x(i), 400, cw, 56, { title: st, color: COLORS.state, titleSize: 17, vcenter: true });
    s.link(boxes[i], "b", pill, "t", { color: "#868e96" });
  });
  for (let i = 0; i < boxes.length - 1; i++) s.link(boxes[i], "r", boxes[i + 1], "l", { color: "#1971c2" });

  s.box("capture", 60, 520, 480, 170, {
    title: "Capture first, interpret second",
    body: "Every API response and browser session is written to raw/ verbatim before anything reads meaning into it. Any conclusion can be traced back to the bytes it came from — and the whole derived layer can be rebuilt.",
    color: COLORS.store,
    titleSize: 21,
    bodySize: 16,
    vcenter: true,
  });
  s.box("gates", 560, 520, 480, 170, {
    title: "The state is the permission",
    body: "A stage may only act on what the previous stage durably wrote. Verification that didn't happen leaves the account parked — no enrollment gets to assume it.",
    color: COLORS.gate,
    titleSize: 21,
    bodySize: 16,
    vcenter: true,
  });
  s.box("degrade", 1060, 520, 480, 170, {
    title: "Degrade, never guess",
    body: "Browser down, API flaking, evidence thin? One retry, then queue it and report the run as degraded. The pipeline never substitutes a weaker source for a missing one.",
    color: COLORS.gate,
    titleSize: 21,
    bodySize: 16,
    vcenter: true,
  });

  slideFooter(s, "The daily reconcile runs the same loop backwards: read Apollo, update the store, mirror to the CRM — replies open opportunities, opt-outs are honored instantly.");
  s.write("11-slide-data-flow.excalidraw", "slide-data-flow");
}

function slideEvals(): void {
  const s = new Scene();
  slideHeader(s, "Evals — so a prompt edit can't un-learn a lesson", "Every judgment failure was caught live, once, and written into the rules. The suite is what notices when an edit quietly undoes one.");

  const fixtures = s.box("fixtures", 60, 210, 380, 165, {
    title: "Frozen fixtures",
    body: "Real past decisions: the exact evidence the module saw, and the answer we now know was right — plus the wrong answer that actually happened.",
    color: COLORS.store,
    titleSize: 22,
    bodySize: 16,
    vcenter: true,
  });
  const prompts = s.box("prompts", 60, 400, 380, 165, {
    title: "The live rulebook",
    body: "Prompts are read out of the production SKILL.md and config at run time — never a paraphrase. Edit the rules and the suite is testing the new rules.",
    color: COLORS.ext,
    titleSize: 22,
    bodySize: 16,
    vcenter: true,
  });

  const run = s.box("run", 500, 270, 330, 240, {
    title: "Run the judgment",
    body: "Four tasks: fit · route · Sales Nav verdict · evidence synthesis.\n\nLive against the model, or replayed from committed responses for $0.",
    color: COLORS.mod,
    titleSize: 22,
    bodySize: 16,
    vcenter: true,
  });
  const score = s.box("score", 890, 270, 330, 240, {
    title: "Score against the baseline",
    body: "Accuracy per task, compared to the committed baseline.\n\nA wrong answer that matches a recorded past failure fails the run outright — no tolerance.",
    color: COLORS.mod,
    titleSize: 22,
    bodySize: 16,
    vcenter: true,
  });

  const pass = s.box("pass", 1280, 270, 260, 105, {
    title: "PASS — land the edit",
    color: COLORS.store,
    titleSize: 20,
    vcenter: true,
  });
  const block = s.box("block", 1280, 405, 260, 105, {
    title: "BLOCK — reconcile first",
    color: COLORS.gate,
    titleSize: 20,
    vcenter: true,
  });

  s.link(fixtures, "r", run, "l", { toT: 0.25, color: "#2f9e44" });
  s.link(prompts, "r", run, "l", { toT: 0.8, color: "#e8590c" });
  s.link(run, "r", score, "l", { color: "#1971c2" });
  s.link(score, "r", pass, "l", { color: "#2f9e44" });
  s.link(score, "r", block, "l", { color: "#e03131" });

  s.box("free", 60, 610, 480, 150, {
    title: "Free, and therefore actually run",
    body: "The pre-edit gate replays committed model responses: no credits, no network, seconds. It runs before every change to the rulebook.",
    color: COLORS.gate,
    titleSize: 21,
    bodySize: 16,
    vcenter: true,
  });
  s.box("flywheel", 560, 610, 480, 150, {
    title: "Mistakes become fixtures",
    body: "Capture-first means the inputs to every past decision are already frozen. A new failure is scaffolded into a fixture, labeled by hand, and guarded from then on.",
    color: COLORS.store,
    titleSize: 21,
    bodySize: 16,
    vcenter: true,
  });
  s.box("live", 1060, 610, 480, 150, {
    title: "Checked against reality",
    body: "The production error rate is the flip rate: how often the human-verified pass overturns the automated call. Suite green while flips climb = a gap the fixtures don't cover yet.",
    color: COLORS.human,
    titleSize: 21,
    bodySize: 16,
    vcenter: true,
  });

  slideFooter(s, "Nothing here grades itself: gold labels are human decisions, and the suite only ever asks whether today's rules still reach yesterday's hard-won answers.");
  s.write("12-slide-evals.excalidraw", "slide-evals");
}

overview();
dataflow();
evals();
slideOverview();
slideDataFlow();
slideEvals();
