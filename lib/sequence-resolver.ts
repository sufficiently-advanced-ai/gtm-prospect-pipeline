// Sequence resolution — the ONLY place route/signal becomes a sequence.
// Signals label accounts (config/signal.yaml = label catalog, block key = canonical identity);
// sequences subscribe to labels via `binds: {signals, routes?}` in config/sequences.yaml,
// criteria ANDed, `binds: {}` matches nothing. Lifecycle (draft|active|retired) gates
// ENROLLMENT only — Apollo send state is M4's, never inferred here. An account that matches
// only non-active sequences HOLDs at status:routed and becomes enrollable automatically when
// a successor activates: no re-triage, no fallback to a looser sequence.
//
// CLI: node lib/sequence-resolver.ts --validate     (exit 1 on config errors)
//      node lib/sequence-resolver.ts <domain>       (resolve one store account)
//      node lib/sequence-resolver.ts --all          (read-only sweep of routed|triaged)
//      node lib/sequence-resolver.ts --audit-enrolled  (merge-field audit of enrolled contacts)
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { configPath } from "./env.ts";
import { ROUTES } from "./status-map.ts";

export type MergeFieldSpec = {
  key: string;
  apollo_field_id: string;
  value: string;
  signals: string[];
  /** True when sequence copy renders {{key}}. Unset value then hard-fails the send in Apollo
   *  (`snippets_missing`); a reply/call-prep-only field can never do that. */
  rendersInCopy: boolean;
};

export type Resolution =
  | { decision: "ENROLL"; key: string; id: string; name: string; mergeFields: MergeFieldSpec[] }
  | { decision: "HOLD"; reason: string };

const SEQUENCE_STATUSES_LIFECYCLE = ["draft", "active", "retired"];
// Routes that may qualify a bind. The rest of ROUTES are terminal classifications:
// SKIP/FLAGGED/DROPPED accounts never reach enrollment.
const NON_TARGETABLE_ROUTES = new Set(["SKIP", "FLAGGED", "DROPPED"]);
const BINDABLE_ROUTES: string[] = ROUTES.filter((r) => !NON_TARGETABLE_ROUTES.has(r));

// Apollo ids (sequences, contact custom fields) are 24 hex chars. Anything else — a
// `REPLACE-WITH-…` / `PENDING-CREATE-IN-APOLLO` placeholder, an empty string — is a
// staging value that must never reach an ACTIVE sequence.
const APOLLO_ID_RE = /^[a-f0-9]{24}$/;

const parseConfig = (file: string): any => YAML.parse(readFileSync(configPath(file), "utf8"));

const signalsDoc: any = parseConfig("signal.yaml");
const sequencesDoc: any = parseConfig("sequences.yaml");

// A signal block is any top-level mapping with a `name` — `dedupe`/`limits` are not signals.
type SignalIndex = {
  keys: string[];
  nameByKey: Map<string, string>;
  keyByLabel: Map<string, string>;
};

function buildSignalIndex(doc: any): SignalIndex {
  const keys: string[] = [];
  const nameByKey = new Map<string, string>();
  const keyByLabel = new Map<string, string>();
  const claim = (label: unknown, key: string) => {
    const l = typeof label === "string" ? label.trim() : "";
    if (l && !keyByLabel.has(l)) keyByLabel.set(l, key);
  };
  for (const [key, block] of Object.entries(doc ?? {})) {
    const b: any = block;
    if (!b || typeof b !== "object" || Array.isArray(b) || typeof b.name !== "string") continue;
    keys.push(key);
    nameByKey.set(key, b.name);
    claim(key, key);
    claim(b.name, key);
    for (const a of Array.isArray(b.aliases) ? b.aliases : []) claim(a, key);
  }
  return { keys, nameByKey, keyByLabel };
}

const signalIndex = buildSignalIndex(signalsDoc);

// A stored `signal_source` (canonical name, block key, or legacy alias) -> signal block key.
export function canonicalSignalKey(raw?: string, index: SignalIndex = signalIndex): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  return index.keyByLabel.get(s);
}

export function signalNameForKey(key: string): string | undefined {
  return signalIndex.nameByKey.get(key);
}

const bindsOf = (seq: any): { signals: string[]; routes: string[] } => ({
  signals: Array.isArray(seq?.binds?.signals) ? seq.binds.signals.map(String) : [],
  routes: Array.isArray(seq?.binds?.routes) ? seq.binds.routes.map(String) : [],
});

function matchesBinds(seq: any, signalKey: string | undefined, route: string | undefined): boolean {
  if (!signalKey) return false;
  const { signals, routes } = bindsOf(seq);
  if (!signals.includes(signalKey)) return false;
  if (routes.length === 0) return true; // no routes qualifier -> any route (or none) enrolls
  return route !== undefined && routes.includes(route);
}

// Required merge fields = merge_fields.*.signals ∩ (NAMES of the sequence's bound signals).
function mergeFieldsFor(seq: any, doc: any = sequencesDoc, index: SignalIndex = signalIndex): MergeFieldSpec[] {
  const boundNames = new Set(
    bindsOf(seq).signals.map((k) => index.nameByKey.get(k)).filter((n): n is string => !!n),
  );
  const out: MergeFieldSpec[] = [];
  for (const [key, spec] of Object.entries(doc?.merge_fields ?? {})) {
    const s: any = spec;
    const signals: string[] = Array.isArray(s?.signals) ? s.signals.map(String) : [];
    if (!signals.some((n) => boundNames.has(n))) continue;
    out.push({
      key, apollo_field_id: String(s?.apollo_field_id ?? ""), value: String(s?.value ?? ""), signals,
      rendersInCopy: s?.renders_in_copy === true,
    });
  }
  return out;
}

// `seqDoc`/`signalDoc` default to the shipped config; tests pass fixture documents.
export function resolveSequence(
  a: { signal_source?: string; route?: string },
  seqDoc: any = sequencesDoc,
  signalDoc?: any,
): Resolution {
  const index = signalDoc === undefined ? signalIndex : buildSignalIndex(signalDoc);
  const rawSignal = typeof a?.signal_source === "string" ? a.signal_source.trim() : "";
  const signalKey = canonicalSignalKey(rawSignal, index);
  const route = typeof a?.route === "string" && a.route.trim() ? a.route.trim() : undefined;

  const matched: Array<[string, any]> = Object.entries(seqDoc?.sequences ?? {})
    .filter(([, seq]) => matchesBinds(seq, signalKey, route));
  const active = matched.filter(([, seq]: [string, any]) => seq?.status === "active");

  if (active.length === 1) {
    const [key, seq] = active[0] as [string, any];
    return {
      decision: "ENROLL",
      key,
      id: String(seq.id),
      name: String(seq.name ?? key),
      mergeFields: mergeFieldsFor(seq, seqDoc, index),
    };
  }
  if (active.length > 1) {
    // Validator forbids this; if config drifted, refuse rather than guess a target.
    return {
      decision: "HOLD",
      reason: `ambiguous — ${active.length} active sequences match (${active.map(([k]) => k).join(", ")}); run: node lib/sequence-resolver.ts --validate`,
    };
  }
  if (matched.length) {
    return {
      decision: "HOLD",
      reason: matched
        .map(([k, seq]: [string, any]) => `${k} is ${seq?.status ?? "unknown-status"} — awaiting successor`)
        .join("; "),
    };
  }
  const signalLabel = signalKey ?? (rawSignal ? `unknown "${rawSignal}"` : "—");
  return { decision: "HOLD", reason: `no sequence bound for signal=${signalLabel} route=${route ?? "—"}` };
}

// ---- validation -------------------------------------------------------------
// validateSequencesDoc takes plain objects so failure modes are testable with fixtures
// (never by editing the real config). validateSequencesConfig() checks the shipped files.
export function validateSequencesDoc(seqDoc: any, signalDoc: any = signalsDoc): string[] {
  const errors: string[] = [];
  const index = buildSignalIndex(signalDoc);
  const knownSignals = new Set(index.keys);

  // signal.yaml: aliases unique, and never colliding with a name or another block's key.
  const claimedBy = new Map<string, string>();
  for (const [key, block] of Object.entries(signalDoc ?? {})) {
    const b: any = block;
    if (!b || typeof b !== "object" || Array.isArray(b) || typeof b.name !== "string") continue;
    claimedBy.set(key, key);
    const nameOwner = claimedBy.get(b.name);
    if (nameOwner && nameOwner !== key) errors.push(`signal ${key}: name "${b.name}" collides with signal ${nameOwner}`);
    claimedBy.set(b.name, key);
  }
  for (const [key, block] of Object.entries(signalDoc ?? {})) {
    const b: any = block;
    if (!b || typeof b !== "object" || Array.isArray(b) || typeof b.name !== "string") continue;
    if (b.aliases !== undefined && !Array.isArray(b.aliases)) {
      errors.push(`signal ${key}: aliases must be a list`);
      continue;
    }
    for (const alias of b.aliases ?? []) {
      const a = String(alias).trim();
      if (!a) { errors.push(`signal ${key}: empty alias`); continue; }
      const owner = claimedBy.get(a);
      if (owner && owner !== key) errors.push(`signal ${key}: alias "${a}" collides with signal ${owner}`);
      claimedBy.set(a, key);
    }
  }

  const sequences: Record<string, any> = seqDoc?.sequences ?? {};
  if (!seqDoc?.sequences || typeof seqDoc.sequences !== "object") {
    errors.push("sequences: missing or not a mapping");
    return errors;
  }

  const idOwners = new Map<string, string>();
  for (const [key, seq] of Object.entries(sequences)) {
    const s: any = seq;
    if (!s || typeof s !== "object") { errors.push(`sequence ${key}: not a mapping`); continue; }

    if (!SEQUENCE_STATUSES_LIFECYCLE.includes(s.status))
      errors.push(`sequence ${key}: status "${s.status}" not in ${SEQUENCE_STATUSES_LIFECYCLE.join("|")}`);

    const id = s.id === undefined || s.id === null ? "" : String(s.id).trim();
    if (!id) errors.push(`sequence ${key}: missing id`);
    else if (idOwners.has(id)) errors.push(`sequence ${key}: id ${id} duplicates sequence ${idOwners.get(id)}`);
    else idOwners.set(id, key);
    // A draft (or retired) sequence may carry a `REPLACE-WITH-…` placeholder — that is how a
    // sequence is staged before it exists in Apollo. An ACTIVE one may not: M3 would enroll
    // contacts into a sequence id Apollo has never heard of.
    if (s.status === "active" && id && !APOLLO_ID_RE.test(id))
      errors.push(`sequence ${key} is active but its id "${id}" is not a real Apollo sequence id (24 hex) — record the id from the sequence URL BEFORE activating`);

    if (s.binds === undefined || s.binds === null || typeof s.binds !== "object" || Array.isArray(s.binds)) {
      errors.push(`sequence ${key}: missing binds (use \`binds: {}\` for an unbound sequence)`);
    } else {
      if (s.binds.signals !== undefined && !Array.isArray(s.binds.signals))
        errors.push(`sequence ${key}: binds.signals must be a list`);
      if (s.binds.routes !== undefined && !Array.isArray(s.binds.routes))
        errors.push(`sequence ${key}: binds.routes must be a list`);
      for (const sig of Array.isArray(s.binds.signals) ? s.binds.signals : [])
        if (!knownSignals.has(String(sig)))
          errors.push(`sequence ${key}: binds.signals "${sig}" is not a signal.yaml block key`);
      for (const r of Array.isArray(s.binds.routes) ? s.binds.routes : [])
        if (!BINDABLE_ROUTES.includes(String(r)))
          errors.push(`sequence ${key}: binds.routes "${r}" not in ${BINDABLE_ROUTES.join("|")}`);
    }

    if (s.supersedes !== undefined) {
      if (!Array.isArray(s.supersedes)) {
        errors.push(`sequence ${key}: supersedes must be a list`);
      } else {
        for (const t of s.supersedes) {
          const target: any = sequences[String(t)];
          if (!target) { errors.push(`sequence ${key}: supersedes unknown sequence "${t}"`); continue; }
          if (s.status === "active" && target.status !== "retired")
            errors.push(`sequence ${key} is active but supersedes ${t} which is ${target.status} — an activation must retire its targets in the same edit`);
        }
      }
    }
  }

  // No two ACTIVE sequences may match the same account: same signal, and route sets that
  // overlap or are unqualified on either side.
  const actives = Object.entries(sequences).filter(([, s]: [string, any]) => s?.status === "active");
  for (let i = 0; i < actives.length; i++) {
    for (let j = i + 1; j < actives.length; j++) {
      const [ka, sa] = actives[i] as [string, any];
      const [kb, sb] = actives[j] as [string, any];
      const a = bindsOf(sa), b = bindsOf(sb);
      const shared = a.signals.filter((s) => b.signals.includes(s));
      if (!shared.length) continue;
      const routesOverlap =
        a.routes.length === 0 || b.routes.length === 0 || a.routes.some((r) => b.routes.includes(r));
      if (routesOverlap)
        errors.push(`sequences ${ka} and ${kb} are both active and match the same accounts (signal ${shared.join(",")})`);
    }
  }

  for (const [key, spec] of Object.entries(seqDoc?.merge_fields ?? {})) {
    const s: any = spec;
    const signals = Array.isArray(s?.signals) ? s.signals : [];
    if (!signals.length) { errors.push(`merge_fields ${key}: no signals listed`); continue; }
    for (const n of signals)
      if (!index.keyByLabel.has(String(n).trim()))
        errors.push(`merge_fields ${key}: signal "${n}" is not a known signal name/alias`);
    if (typeof s?.renders_in_copy !== "boolean")
      errors.push(
        `merge_fields ${key}: missing renders_in_copy (true if sequence copy renders {{${key}}}, ` +
        `false if it is reply/call-prep only) — it decides whether an unset value blocks a send`);
  }

  // An ACTIVE sequence may not require a merge field whose Apollo field does not exist yet.
  // Apollo resolves {{variables}} at SEND time, so a placeholder id means every enrollment on
  // that sequence hard-fails with `snippets_missing` (this once stranded most of a sequence's
  // enrolled contacts for days before anyone noticed). A placeholder on a DRAFT sequence is
  // legitimate (that is how a sequence is staged before its fields are created in the Apollo
  // UI); the two states just may never coexist. Enforced as a pairing at activation, like the
  // supersedes rule above.
  for (const [key, seq] of Object.entries(seqDoc?.sequences ?? {})) {
    if ((seq as any)?.status !== "active") continue;
    for (const m of mergeFieldsFor(seq, seqDoc, index)) {
      if (!APOLLO_ID_RE.test(m.apollo_field_id))
        errors.push(
          `sequence ${key} is active but requires merge field ${m.key} whose apollo_field_id ` +
          `"${m.apollo_field_id || "(empty)"}" is not a real Apollo field id (24 hex). Create the ` +
          `field in Apollo and record its id BEFORE activating` +
          (m.rendersInCopy
            ? ` — renders_in_copy:true, so activating now hard-fails every enrollment with \`snippets_missing\``
            : ``));
    }
  }

  return errors;
}

export function validateSequencesConfig(): string[] {
  return validateSequencesDoc(sequencesDoc, signalsDoc);
}

// ---- Enrolled-contact merge-field audit ------------------------------------
// WHY THIS EXISTS: Apollo resolves a sequence template's {{variables}} at SEND time against
// the contact's CURRENT field values, and a template edit applies retroactively to everyone
// already enrolled. So adding a merge variable to live copy silently invalidates every prior
// enrollment — Apollo hard-fails those contacts with `failure_reason: snippets_missing`
// instead of sending, and nothing in the UI shouts about it.
//
// resolveSequence() only declares required merge fields for a NEW enrollment; nothing re-checked
// the back catalogue. This audit closes that gap: it re-derives each enrolled contact's required
// fields from config and reports any that were never recorded.
//
// AUTHORITY IS THE STORE, deliberately. This tool has no Apollo API access, so it checks what
// M3 recorded on the contact — which the M3 contract already requires ("record the value in
// account.yaml per contact"). A value set in Apollo but missing from the store is itself a
// defect, so flagging it is correct, not a false positive. Confirm against Apollo before
// backfilling.

export type MergeFieldFinding = {
  domain: string;
  contact: string;
  contactId: string;
  sequenceKey: string;
  sequenceId: string;
  sequenceStatus: string;
  /** every required-but-unrecorded field */
  missing: string[];
  /** subset of `missing` that sequence copy renders — the send-blocking ones */
  rendered: string[];
  /** subset of `missing` kept only for reply/call prep — a record gap, never a send failure */
  prepOnly: string[];
  severity: "error" | "warn";
};

export type AuditableAccount = { domain: string; account: any };

/** A merge field counts as set only if a non-empty string was recorded for it. */
function recordedMergeValue(contact: any, key: string): string {
  const v = contact?.merge_fields?.[key] ?? contact?.[key];
  return typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v).trim();
}

export function auditEnrolledDoc(
  accounts: AuditableAccount[],
  seqDoc: any = sequencesDoc,
  index: SignalIndex = signalIndex,
): MergeFieldFinding[] {
  // Sequences are addressed by Apollo id on the contact, not by config key.
  const byApolloId = new Map<string, [string, any]>();
  for (const [key, seq] of Object.entries(seqDoc?.sequences ?? {})) {
    const id = String((seq as any)?.id ?? "").trim();
    if (id) byApolloId.set(id, [key, seq]);
  }

  const findings: MergeFieldFinding[] = [];
  for (const { domain, account } of accounts) {
    for (const contact of account?.contacts ?? []) {
      const seqId = String(contact?.apollo_sequence_id ?? "").trim();
      if (!seqId) continue;
      const name = String(contact?.name ?? "?");
      const contactId = String(contact?.apollo_contact_id ?? "");
      const hit = byApolloId.get(seqId);

      // Enrolled in a sequence config has never heard of — config drift, or a hand-enrollment
      // outside the pipeline. Either way nothing can vouch for its merge fields.
      if (!hit) {
        findings.push({
          domain, contact: name, contactId, sequenceKey: "<unknown>", sequenceId: seqId,
          sequenceStatus: "<unknown>",
          missing: ["<sequence not in config/sequences.yaml>"],
          rendered: ["<sequence not in config/sequences.yaml>"], prepOnly: [],
          severity: "error",
        });
        continue;
      }

      const [seqKey, seq] = hit;
      const unset = mergeFieldsFor(seq, seqDoc, index).filter((m) => !recordedMergeValue(contact, m.key));
      if (!unset.length) continue;

      // Severity turns on TWO things, and both matter:
      //  - does the copy actually render it? A reply/call-prep-only field (renders_in_copy:false)
      //    can never cause `snippets_missing`, so it is a record gap, not a send risk.
      //  - can this sequence send today? draft/retired cannot, but would strand the same
      //    contacts the moment it is activated.
      const status = String(seq?.status ?? "<none>");
      const rendered = unset.filter((m) => m.rendersInCopy).map((m) => m.key);
      const prepOnly = unset.filter((m) => !m.rendersInCopy).map((m) => m.key);
      const blocking = status === "active" && rendered.length > 0;
      findings.push({
        domain, contact: name, contactId, sequenceKey: seqKey, sequenceId: seqId,
        sequenceStatus: status,
        missing: unset.map((m) => m.key),
        rendered, prepOnly,
        severity: blocking ? "error" : "warn",
      });
    }
  }
  return findings;
}

// ---- CLI --------------------------------------------------------------------
// Import-safe: the module is imported by lib/signal-policy.ts and test/smoke.ts, so the
// CLI only runs when this file IS the entrypoint.
const isEntrypoint = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try { return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (isEntrypoint) {
  const args = process.argv.slice(2);
  const line = (domain: string, r: Resolution): string =>
    r.decision === "ENROLL"
      ? `ENROLL  ${domain} -> ${r.key} (${r.id})${r.mergeFields.length ? `  merge: ${r.mergeFields.map((m) => m.key).join(",")}` : ""}`
      : `HOLD    ${domain} — ${r.reason}`;

  if (args[0] === "--validate" || args.length === 0) {
    const errors = validateSequencesConfig();
    if (errors.length) {
      console.error(`config/sequences.yaml + config/signal.yaml — ${errors.length} error(s):`);
      errors.forEach((e) => console.error(`  ${e}`));
      process.exit(1);
    }
    console.log(
      `config valid — ${Object.keys(sequencesDoc.sequences).length} sequences ` +
      `(${Object.entries(sequencesDoc.sequences).filter(([, s]: [string, any]) => s.status === "active").length} active), ` +
      `${signalIndex.keys.length} signals, ${signalIndex.keyByLabel.size} labels`,
    );
  } else if (args[0] === "--audit-enrolled") {
    // Gate: re-check every ALREADY-ENROLLED contact against its sequence's currently-required
    // merge fields. Run after ANY edit to sequence copy or config `merge_fields`, and on the
    // M8 reconcile schedule. Exit 1 on an active-sequence miss — those contacts will hard-fail
    // in Apollo (`snippets_missing`) instead of sending.
    const { listAccounts, readAccount } = await import("./store.ts");
    const accounts: AuditableAccount[] = [];
    for (const domain of listAccounts()) {
      const account = readAccount(domain);
      if (account) accounts.push({ domain, account });
    }
    const findings = auditEnrolledDoc(accounts);
    const errors = findings.filter((f) => f.severity === "error");
    const warns = findings.filter((f) => f.severity === "warn");
    for (const f of [...errors, ...warns]) {
      const tag = f.severity === "error" ? "BLOCKING" : "record  ";
      const what = f.severity === "error"
        ? `copy renders ${f.rendered.join(", ")}`
        : `${f.missing.join(", ")} unrecorded`;
      console.log(`${tag} ${f.domain} — ${f.contact} (${f.contactId}) in ${f.sequenceKey} [${f.sequenceStatus}]: ${what}`);
    }
    const enrolled = accounts.reduce(
      (n, a) => n + (a.account?.contacts ?? []).filter((c: any) => c?.apollo_sequence_id).length, 0);
    console.log(`\n${enrolled} enrolled contact(s) audited — ${errors.length} blocking, ${warns.length} record gap(s)`);
    console.log(
      "\nSCOPE: the STORE is the only witness here — this tool has no Apollo API access.\n" +
      "A finding means account.yaml cannot vouch that the field was set, which is itself a defect\n" +
      "(the M3 contract requires recording it). It is NOT proof the value is missing in Apollo:\n" +
      "verify with apollo_contacts_search before backfilling, or you may overwrite a good value.");
    if (errors.length) {
      console.error(
        "\nBLOCKING: an enrolled contact on an ACTIVE sequence has no recorded value for a field that\n" +
        "sequence copy renders. Apollo resolves {{variables}} at send time against the contact's\n" +
        "current values, so if it is genuinely unset the contact hard-fails (`snippets_missing`)\n" +
        "instead of sending. Fix: confirm in Apollo, set the value, record it in account.yaml, then\n" +
        "re-add the contact PAUSED — Apollo does not revive a failed contact when the field appears.");
      process.exit(1);
    }
  } else if (args[0] === "--all") {
    const { listAccounts, readAccount } = await import("./store.ts");
    let enroll = 0, hold = 0;
    const unknownSignals = new Map<string, number>();
    for (const domain of listAccounts()) {
      const a = readAccount(domain);
      if (!a || (a.status !== "routed" && a.status !== "triaged")) continue;
      const r = resolveSequence(a);
      if (r.decision === "ENROLL") enroll++; else hold++;
      if (a.signal_source && !canonicalSignalKey(a.signal_source))
        unknownSignals.set(a.signal_source, (unknownSignals.get(a.signal_source) ?? 0) + 1);
      console.log(`${line(domain, r)}  [status:${a.status} route:${a.route ?? "—"} signal:${a.signal_source ?? "—"}]`);
    }
    console.log(`\n${enroll + hold} account(s) at status routed|triaged: ${enroll} ENROLL, ${hold} HOLD`);
    console.log(
      `unknown signal_source: ${unknownSignals.size}` +
      (unknownSignals.size ? ` — ${[...unknownSignals].map(([s, n]) => `"${s}" x${n}`).join("; ")}` : ""),
    );
  } else {
    const domain = args[0];
    const { readAccount } = await import("./store.ts");
    const a = readAccount(domain);
    if (!a) { console.error(`no account: ${domain}`); process.exit(1); }
    const r = resolveSequence(a);
    console.log(line(domain, r));
    if (r.decision === "ENROLL") {
      console.log(`  sequence: ${r.name}`);
      for (const m of r.mergeFields)
        console.log(`  merge field ${m.key} (apollo_field_id ${m.apollo_field_id}): ${m.value}`);
      if (!r.mergeFields.length) console.log("  merge fields: none required");
    }
  }
}
