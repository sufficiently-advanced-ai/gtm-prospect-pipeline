// account.yaml status vocabulary <-> Twenty SELECT values (the M8 mapping table).
// Store statuses `pulled`/`triaged` have no CRM presence — accounts enter Twenty at routing.
// `dropped` (route DROPPED) is STORE-ONLY: fit-triage drops are never mirrored to the CRM,
// so it has no OUTREACH_STATUS entry — M8 excludes it before mapping.

export const STORE_STATUSES = [
  "pulled", "triaged", "routed", "enriched", "enrolled-paused", "active",
  "replied", "finished", "opted-out", "skipped", "held", "flagged", "dropped",
] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];

export const OUTREACH_STATUS: Record<string, string | null> = {
  pulled: null,
  triaged: null,
  routed: "PENDING_VERIFY",
  enriched: "PENDING_VERIFY",
  "enrolled-paused": "ENROLLED_PAUSED",
  active: "LIVE",
  replied: "REPLIED",
  finished: "FINISHED",
  "opted-out": "OPTED_OUT",
  skipped: "SKIPPED",
  held: "HELD_NO_EMAIL",
  flagged: "PENDING_VERIFY",
  // no `dropped` entry — store-only, never mirrored (see header note)
};

// Route is CLASSIFICATION ONLY: M2 records the verdict of fit triage and nothing more. It
// does NOT select a sequence — sequence targeting lives in config/sequences.yaml `binds`
// (signals + optional routes qualifier), resolved by lib/sequence-resolver.ts, which is this
// list's first code consumer (it validates that every `binds.routes` entry is a real route).
//   QUALIFIED — fits the ICP (config/icp.md); eligible for a sequence via the resolver
//   SKIP      — never contact; the disqualifier goes in free-text `skip_reason`. A verified
//               suppression decision, so it IS mirrored to the CRM
//   FLAGGED   — sources disagree or evidence is thin; a human rules (decision ledger)
//   DROPPED   — not our buyer at all (a drop class from config/icp.md); store-only
// Any ICP-specific sub-classification belongs in the free-string `classification` field,
// never in this enum.
export const ROUTES = ["QUALIFIED", "SKIP", "FLAGGED", "DROPPED"] as const;

export const SEQUENCE_STATUSES = [
  "NOT_ENROLLED", "PAUSED", "ACTIVE", "FINISHED", "REPLIED", "REMOVED", "BOUNCED", "OPTED_OUT", "FAILED",
] as const;

export const VERIFICATION_METHODS = ["HEADLESS_3SOURCE", "SALES_NAV", "UNVERIFIED"] as const;

// Twenty inverse: outreachStatus -> store status (for migration / pull-back audits).
// LOSSY: routed/enriched/flagged all forward-map to PENDING_VERIFY, so the inverse picks
// "routed". Consumers must prefer an existing local status over this inverse whenever one
// exists — recovering store state from the CRM is emergency-only and carries no provenance.
export const STORE_STATUS_FROM_OUTREACH: Record<string, StoreStatus> = {
  PENDING_VERIFY: "routed",
  ENROLLED_PAUSED: "enrolled-paused",
  LIVE: "active",
  REPLIED: "replied",
  FINISHED: "finished",
  OPTED_OUT: "opted-out",
  SKIPPED: "skipped",
  HELD_NO_EMAIL: "held",
};
