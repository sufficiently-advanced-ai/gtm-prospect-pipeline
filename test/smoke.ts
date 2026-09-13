// Offline smoke test — store round-trip, path-traversal guard, status maps, sync hash,
// sequence resolution + config validation against fixture documents.
// No network, no CRM key required. Run: npm test (or node test/smoke.ts)
import { strict as assert } from "node:assert";
import { rmSync, existsSync } from "node:fs";
import { dataPath, readAccount, writeAccount, createAccountStub, syncHash, scanSyncConflicts } from "../lib/store.ts";
import { OUTREACH_STATUS, STORE_STATUS_FROM_OUTREACH, STORE_STATUSES, ROUTES } from "../lib/status-map.ts";
import {
  canonicalSignalKey, resolveSequence, validateSequencesConfig, validateSequencesDoc,
  auditEnrolledDoc,
} from "../lib/sequence-resolver.ts";
import { isCrmHeldOut } from "../lib/signal-policy.ts";

let failures = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e: any) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
};

// Apollo ids are 24 hex chars; fixtures build them at runtime so no id literal sits in git.
const hex24 = (n: number): string => n.toString(16).padStart(24, "0");
const PLACEHOLDER = "REPLACE-WITH-APOLLO-SEQUENCE-ID";

check("dataPath rejects traversal", () => {
  assert.throws(() => dataPath("accounts", "../../etc", "passwd"));
  assert.throws(() => dataPath("..", "outside"));
  assert.ok(dataPath("accounts", "acme-example.com", "account.yaml").includes("accounts"));
});

check("account round-trip preserves types", () => {
  const domain = "smoke-test.invalid";
  const account = {
    domain,
    company: "Smoke: Test & Co — \"quotes\" 'n stuff",
    status: "routed",
    enrichment: { employee_count: 42, revenue_usd: 1234567.89, last_enriched_at: "2026-01-15T12:00:00.000Z" },
    contacts: [{ name: "Ann Example", sequence_step: "2/5 (auto_email)", email: "ann@smoke-test.invalid" }],
  };
  writeAccount(domain, account);
  const back = readAccount(domain);
  assert.deepEqual(back, account);
  rmSync(dataPath("accounts", domain), { recursive: true });
  assert.ok(!existsSync(dataPath("accounts", domain)));
});

// Regression for the blind stub-write class: a pull that wrongly reports an existing domain
// as "new" must not be able to destroy its live state.
check("createAccountStub refuses to overwrite an existing account", () => {
  const domain = "smoke-stub.invalid";
  const live = {
    domain,
    status: "active",
    contacts: [{ name: "Ann Example", sequence_status: "ACTIVE", sequence_step: "2/5 (auto_email)" }],
    raw_pointers: ["raw/postings/smoke-stub.invalid/2026-01-15-a-role.md"],
  };
  writeAccount(domain, live);

  const created = createAccountStub(domain, { domain, status: "pulled", signal_source: "hiring-signal" });
  assert.equal(created, false, "must report the domain as already known");
  assert.deepEqual(readAccount(domain), live, "existing account must be untouched");

  rmSync(dataPath("accounts", domain), { recursive: true });
  assert.equal(createAccountStub(domain, { domain, status: "pulled" }), true, "genuinely new domain writes");
  assert.equal(readAccount(domain).status, "pulled");
  rmSync(dataPath("accounts", domain), { recursive: true });
});

check("syncHash is order-insensitive and value-sensitive", () => {
  assert.equal(syncHash({ a: 1, b: 2 }), syncHash({ b: 2, a: 1 }));
  assert.notEqual(syncHash({ a: 1 }), syncHash({ a: 2 }));
});

check("ROUTES is the four-value classification enum", () => {
  assert.deepEqual([...ROUTES], ["QUALIFIED", "SKIP", "FLAGGED", "DROPPED"]);
});

check("every store status has an outreach mapping entry except store-only `dropped`", () => {
  // `dropped` is store-only and deliberately absent from the map — M8 excludes it before
  // mapping, so an entry here would be a mirroring bug.
  for (const s of STORE_STATUSES) {
    if (s === "dropped") { assert.ok(!(s in OUTREACH_STATUS), "`dropped` must stay unmapped"); continue; }
    assert.ok(s in OUTREACH_STATUS, `missing OUTREACH_STATUS[${s}]`);
  }
});

check("outreach inverse round-trips onto itself", () => {
  for (const [outreach, store] of Object.entries(STORE_STATUS_FROM_OUTREACH))
    assert.equal(OUTREACH_STATUS[store], outreach, `${outreach} -> ${store} -> ${OUTREACH_STATUS[store]}`);
});

check("scanSyncConflicts runs and ignores queue/", () => {
  const hits = scanSyncConflicts();
  assert.ok(Array.isArray(hits));
  assert.ok(hits.every((h) => !h.includes("/queue/")));
});

check("shipped sequence + signal config validates (a draft sequence with placeholder ids is legal)", () => {
  const errors = validateSequencesConfig();
  assert.deepEqual(errors, [], errors.join(" | "));
});

check("signal_source spellings canonicalize to the shipped template's signal key", () => {
  assert.equal(canonicalSignalKey("hiring-signal"), "hiring-signal", "block key");
  assert.equal(canonicalSignalKey("Hiring Signal"), "hiring-signal", "canonical name");
  assert.equal(canonicalSignalKey("  Hiring Signal  "), "hiring-signal", "whitespace-tolerant");
  assert.equal(canonicalSignalKey("no-such-signal"), undefined);
  assert.equal(canonicalSignalKey(""), undefined);
  assert.equal(canonicalSignalKey(undefined), undefined);
});

// --- resolution against fixture documents -------------------------------------------------
// The shipped template is a single draft sequence, so every lifecycle shape is exercised on
// fixtures instead (validateSequencesDoc / resolveSequence both accept documents).
const SIGNALS = {
  "hiring-signal": { enabled: true, name: "Hiring Signal", aliases: ["legacy-hiring-spelling"] },
  "title-signal": { enabled: false, name: "Title Signal", aliases: [] },
  referral: { enabled: false, name: "Referral", aliases: [] },
  dedupe: { company_list_id: "REPLACE-WITH-THEIRSTACK-LIST-ID" },
  limits: { salesnav_lookups_per_run: 25 },
};
const SEQUENCES = {
  sequences: {
    "hiring-v2": { id: hex24(2), name: "Hiring v2", status: "active", binds: { signals: ["hiring-signal"] }, supersedes: ["hiring-v1"] },
    "hiring-v1": { id: hex24(1), name: "Hiring v1", status: "retired", binds: { signals: ["hiring-signal"] } },
    "title-qualified": { id: hex24(3), status: "active", binds: { signals: ["title-signal"], routes: ["QUALIFIED"] } },
    "referral-draft": { id: PLACEHOLDER, status: "draft", binds: { signals: ["referral"] } },
  },
  merge_fields: {
    hiring_signal: { apollo_field_id: hex24(10), value: "posting title", signals: ["Hiring Signal"], renders_in_copy: true },
    prep_note: { apollo_field_id: hex24(11), value: "reply prep", signals: ["Hiring Signal"], renders_in_copy: false },
  },
};

check("fixture config validates", () => {
  const errors = validateSequencesDoc(SEQUENCES, SIGNALS);
  assert.deepEqual(errors, [], errors.join(" | "));
});

check("resolveSequence maps signal+route onto the lifecycle", () => {
  const byName = resolveSequence({ signal_source: "Hiring Signal", route: "QUALIFIED" }, SEQUENCES, SIGNALS);
  assert.equal(byName.decision, "ENROLL");
  if (byName.decision !== "ENROLL") return;
  assert.equal(byName.key, "hiring-v2");
  assert.equal(byName.id, hex24(2));
  // merge-field order follows the config's merge_fields order
  assert.deepEqual(byName.mergeFields.map((m) => m.key), ["hiring_signal", "prep_note"]);
  assert.deepEqual(byName.mergeFields.map((m) => m.rendersInCopy), [true, false]);

  // a legacy alias resolves to the same block; no routes qualifier -> any route (or none) enrolls
  const byAlias = resolveSequence({ signal_source: "legacy-hiring-spelling" }, SEQUENCES, SIGNALS);
  assert.equal(byAlias.decision, "ENROLL");
  if (byAlias.decision !== "ENROLL") return;
  assert.equal(byAlias.key, "hiring-v2");

  // routes qualifier: only the named route enrolls; other/no route HOLDs
  assert.equal(resolveSequence({ signal_source: "title-signal", route: "QUALIFIED" }, SEQUENCES, SIGNALS).decision, "ENROLL");
  const wrongRoute = resolveSequence({ signal_source: "title-signal", route: "FLAGGED" }, SEQUENCES, SIGNALS);
  assert.equal(wrongRoute.decision, "HOLD");
  if (wrongRoute.decision !== "HOLD") return;
  assert.match(wrongRoute.reason, /no sequence bound for signal=title-signal route=FLAGGED/);
  const noRoute = resolveSequence({ signal_source: "Title Signal" }, SEQUENCES, SIGNALS);
  assert.equal(noRoute.decision, "HOLD");
  if (noRoute.decision !== "HOLD") return;
  assert.match(noRoute.reason, /route=—/);

  // draft-only match -> HOLD by name, awaiting activation
  const draft = resolveSequence({ signal_source: "Referral" }, SEQUENCES, SIGNALS);
  assert.equal(draft.decision, "HOLD");
  if (draft.decision !== "HOLD") return;
  assert.match(draft.reason, /referral-draft is draft — awaiting successor/);

  // retired-only match -> HOLD by name (no fallback to a looser sequence)
  const retiredOnly = { sequences: { "hiring-v1": SEQUENCES.sequences["hiring-v1"] } };
  const retired = resolveSequence({ signal_source: "Hiring Signal" }, retiredOnly, SIGNALS);
  assert.equal(retired.decision, "HOLD");
  if (retired.decision !== "HOLD") return;
  assert.match(retired.reason, /hiring-v1 is retired/);

  // two active matches (config drift) -> refuse rather than guess
  const drifted = { sequences: {
    a: { id: hex24(4), status: "active", binds: { signals: ["hiring-signal"] } },
    b: { id: hex24(5), status: "active", binds: { signals: ["hiring-signal"] } },
  } };
  const ambiguous = resolveSequence({ signal_source: "Hiring Signal" }, drifted, SIGNALS);
  assert.equal(ambiguous.decision, "HOLD");
  if (ambiguous.decision !== "HOLD") return;
  assert.match(ambiguous.reason, /ambiguous — 2 active sequences match \(a, b\)/);

  // no signal at all, and an unrecognized one, both HOLD and say so
  assert.equal(resolveSequence({}, SEQUENCES, SIGNALS).decision, "HOLD");
  const unknown = resolveSequence({ signal_source: "mystery-source", route: "QUALIFIED" }, SEQUENCES, SIGNALS);
  assert.equal(unknown.decision, "HOLD");
  if (unknown.decision !== "HOLD") return;
  assert.match(unknown.reason, /unknown "mystery-source"/);
});

// --- enrolled-contact merge-field audit ---------------------------------------------------
// Regression cover for the retroactive-merge-field class: a {{variable}} added to live copy
// hard-fails every contact enrolled before the field existed (`snippets_missing`) instead of
// sending. Nothing re-checked already-enrolled contacts; this audit does.
const AUDIT_DOC = {
  sequences: {
    live:    { id: hex24(20), status: "active", binds: { signals: ["hiring-signal"] } },
    shelved: { id: hex24(21), status: "draft",  binds: { signals: ["hiring-signal"] } },
  },
  merge_fields: {
    hiring_signal: { apollo_field_id: hex24(22), signals: ["Hiring Signal"], renders_in_copy: true },
    prep_note:     { apollo_field_id: hex24(23), signals: ["Hiring Signal"], renders_in_copy: false },
  },
};
const acct = (contacts: any[]) => [{ domain: "acme-example.com", account: { contacts } }];

check("audit blocks an active-sequence contact missing a field the copy renders", () => {
  const f = auditEnrolledDoc(
    acct([{ name: "A", apollo_contact_id: "c1", apollo_sequence_id: hex24(20),
            merge_fields: { prep_note: "some quote" } }]), AUDIT_DOC);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "error");
  assert.deepEqual(f[0].rendered, ["hiring_signal"]);
  assert.deepEqual(f[0].prepOnly, []);
});

check("audit does not block on a reply-prep-only field — it cannot fail a send", () => {
  const f = auditEnrolledDoc(
    acct([{ name: "A", apollo_contact_id: "c1", apollo_sequence_id: hex24(20),
            merge_fields: { hiring_signal: "Data Analyst" } }]), AUDIT_DOC);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "warn");
  assert.deepEqual(f[0].prepOnly, ["prep_note"]);
});

check("audit stays quiet when every required field is recorded", () => {
  const f = auditEnrolledDoc(
    acct([{ name: "A", apollo_contact_id: "c1", apollo_sequence_id: hex24(20),
            merge_fields: { hiring_signal: "Data Analyst", prep_note: "quote" } }]), AUDIT_DOC);
  assert.deepEqual(f, []);
  // blank/whitespace is not a value — that is the shape the incident actually produced
  const blank = auditEnrolledDoc(
    acct([{ name: "A", apollo_contact_id: "c1", apollo_sequence_id: hex24(20),
            merge_fields: { hiring_signal: "   ", prep_note: "quote" } }]), AUDIT_DOC);
  assert.equal(blank[0].severity, "error");
});

check("audit warns (never blocks) on a non-active sequence, and errors on an unknown one", () => {
  const draft = auditEnrolledDoc(
    acct([{ name: "A", apollo_contact_id: "c1", apollo_sequence_id: hex24(21) }]), AUDIT_DOC);
  assert.equal(draft[0].severity, "warn", "a draft sequence cannot send today");

  const unknown = auditEnrolledDoc(
    acct([{ name: "A", apollo_contact_id: "c1", apollo_sequence_id: hex24(99) }]), AUDIT_DOC);
  assert.equal(unknown[0].severity, "error");
  assert.match(unknown[0].missing[0], /not in config/);

  // a contact that was never enrolled is not the audit's business
  assert.deepEqual(auditEnrolledDoc(acct([{ name: "A", apollo_contact_id: "c1" }]), AUDIT_DOC), []);
});

// --- validator ------------------------------------------------------------------------------
check("validator demands renders_in_copy on every merge field", () => {
  const errors = validateSequencesDoc({
    sequences: { a: { id: PLACEHOLDER, status: "draft", binds: {} } },
    merge_fields: { hiring_signal: { signals: ["Hiring Signal"] } },
  }, SIGNALS);
  assert.ok(errors.some((e) => /missing renders_in_copy/.test(e)), errors.join(" | "));
});

check("validator rejects two active sequences matching one account", () => {
  const errors = validateSequencesDoc({
    sequences: {
      a: { id: hex24(1), status: "active", binds: { signals: ["hiring-signal"], routes: ["QUALIFIED"] } },
      b: { id: hex24(2), status: "active", binds: { signals: ["hiring-signal"] } },   // unqualified -> overlaps a
    },
  }, SIGNALS);
  assert.ok(errors.some((e) => /both active and match the same accounts/.test(e)), errors.join(" | "));
});

check("validator rejects an active superseder whose target is not retired", () => {
  const errors = validateSequencesDoc({
    sequences: {
      old: { id: hex24(1), status: "active", binds: {} },
      next: { id: hex24(2), status: "active", binds: { signals: ["hiring-signal"] }, supersedes: ["old"] },
    },
  }, SIGNALS);
  assert.ok(errors.some((e) => /supersedes old which is active/.test(e)), errors.join(" | "));
});

check("validator: a placeholder sequence id is legal on draft/retired, rejected on active", () => {
  const doc = (status: string) => ({
    sequences: { s: { id: PLACEHOLDER, status, binds: { signals: ["hiring-signal"] } } },
  });
  const active = validateSequencesDoc(doc("active"), SIGNALS);
  assert.ok(active.some((e) => /sequence s is active but its id "REPLACE-WITH-APOLLO-SEQUENCE-ID" is not a real Apollo sequence id/.test(e)), active.join(" | "));
  assert.deepEqual(validateSequencesDoc(doc("draft"), SIGNALS), []);
  assert.deepEqual(validateSequencesDoc(doc("retired"), SIGNALS), []);
  // a real id passes
  assert.deepEqual(validateSequencesDoc({ sequences: { s: { id: hex24(7), status: "active", binds: { signals: ["hiring-signal"] } } } }, SIGNALS), []);
});

check("validator rejects an active sequence whose merge field has a placeholder apollo_field_id", () => {
  // Apollo resolves {{variables}} at SEND time, so activating a sequence whose merge field does
  // not exist in Apollo hard-fails every enrollment with `snippets_missing`.
  const doc = (status: string) => ({
    sequences: { s: { id: hex24(1), status, binds: { signals: ["hiring-signal"] } } },
    merge_fields: {
      not_yet: {
        apollo_field_id: "PENDING-CREATE-IN-APOLLO",
        signals: ["Hiring Signal"],
        renders_in_copy: true,
      },
    },
  });
  const active = validateSequencesDoc(doc("active"), SIGNALS);
  assert.ok(
    active.some((e) => /requires merge field not_yet .* is not a real Apollo field id/.test(e)),
    active.join(" | "),
  );
  // …and says WHY it is urgent when the field reaches a template.
  assert.ok(active.some((e) => /snippets_missing/.test(e)), active.join(" | "));
  // A placeholder on a DRAFT sequence is how a sequence is legitimately staged — must NOT error.
  assert.deepEqual(validateSequencesDoc(doc("draft"), SIGNALS), [], "draft sequences may carry a placeholder field id");
});

check("validator accepts a real 24-hex apollo_field_id on an active sequence", () => {
  const errors = validateSequencesDoc({
    sequences: { s: { id: hex24(1), status: "active", binds: { signals: ["hiring-signal"] } } },
    merge_fields: {
      real: { apollo_field_id: hex24(12), signals: ["Hiring Signal"], renders_in_copy: true },
    },
  }, SIGNALS);
  assert.deepEqual(errors, [], errors.join(" | "));
});

check("validator rejects bad status, duplicate id, unknown signal, and non-targetable routes", () => {
  const errors = validateSequencesDoc({
    sequences: {
      a: { id: hex24(1), status: "inactive", binds: { signals: ["hiring-signal"], routes: ["QUALIFIED"] } },
      b: { id: hex24(1), status: "draft", binds: { signals: ["not-a-signal"], routes: ["DROPPED"] } },
      c: { id: hex24(3), status: "draft" },                       // missing binds
      d: { id: hex24(4), status: "draft", binds: { signals: ["hiring-signal"], routes: ["SKIP"] } },
    },
    merge_fields: { mf: { signals: ["Nope"] } },
  }, SIGNALS);
  for (const pattern of [
    /status "inactive" not in/, /duplicates sequence a/, /not a signal.yaml block key/,
    /binds.routes "DROPPED" not in/, /binds.routes "SKIP" not in/, /missing binds/, /not a known signal name/,
  ]) assert.ok(errors.some((e) => pattern.test(e)), `${pattern} — got: ${errors.join(" | ")}`);
});

check("validator rejects alias collisions across signal blocks", () => {
  const errors = validateSequencesDoc({ sequences: {} }, {
    a: { name: "A", aliases: ["shared"] },
    b: { name: "B", aliases: ["shared"] },
    c: { name: "A", aliases: [] },
  });
  assert.ok(errors.some((e) => /alias "shared" collides with signal a/.test(e)), errors.join(" | "));
  assert.ok(errors.some((e) => /name "A" collides with signal a/.test(e)), errors.join(" | "));
});

check("CRM holdout honors signal aliases and the per-signal policy", () => {
  // The shipped template pushes at `routed` — nothing is held out.
  assert.equal(isCrmHeldOut({ signal_source: "Hiring Signal", status: "routed" }), false);
  // With a holdout policy on the signal, pre-enroll states are store-only, later ones mirror.
  const holdout = new Set(["hiring-signal"]);
  assert.equal(isCrmHeldOut({ signal_source: "Hiring Signal", status: "routed" }, holdout), true);
  assert.equal(isCrmHeldOut({ signal_source: "hiring-signal", status: "triaged" }, holdout), true);
  assert.equal(isCrmHeldOut({ signal_source: "Hiring Signal", status: "enrolled-paused" }, holdout), false);
  assert.equal(isCrmHeldOut({ signal_source: "Hiring Signal", status: "skipped" }, holdout), false);
  assert.equal(isCrmHeldOut({ signal_source: "unknown-signal", status: "routed" }, holdout), false);
});

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("smoke test passed");
