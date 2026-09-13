// Per-signal CRM policy, read from config/signal.yaml.
// Signals with `policy.push_to_crm_after: enrolled` are HOLDOUT signals: their accounts
// enter the CRM only once enrolled-paused or later. `skipped` still mirrors (verified
// suppression decisions belong in the CRM); `dropped` is store-only for every signal
// and is excluded upstream before this check runs.
// Matching is by canonical signal KEY, so legacy `signal_source` spellings covered by a
// block's `aliases:` are held out too — an exact name match is not required.
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { configPath } from "./env.ts";
import { canonicalSignalKey } from "./sequence-resolver.ts";

const signals: Record<string, any> = YAML.parse(readFileSync(configPath("signal.yaml"), "utf8"));

export const HOLDOUT_SIGNAL_KEYS: Set<string> = new Set(
  Object.entries(signals)
    .filter(([, s]: [string, any]) => s && typeof s === "object" && s.policy?.push_to_crm_after === "enrolled")
    .map(([key]) => key),
);

// Canonical stamps of the holdout signals — kept for reporting/back-compat with callers
// that think in `signal_source` strings. Membership tests should use isCrmHeldOut().
export const HOLDOUT_SIGNAL_NAMES: Set<string> = new Set(
  Object.entries(signals)
    .filter(([key]) => HOLDOUT_SIGNAL_KEYS.has(key))
    .map(([, s]: [string, any]) => String(s.name)),
);

// Store statuses that precede a sequence enrollment. pulled/triaged are also pre-enroll,
// but for holdout signals the exclusion must be UNCONDITIONAL (a leftover crm pointer must
// not sneak one in), so they're listed here too rather than relying on the generic gate.
const PRE_ENROLL_STATUSES = new Set(["pulled", "triaged", "routed", "enriched", "flagged", "held"]);

// `holdoutKeys` defaults to the shipped config; tests pass a fixture set.
export function isCrmHeldOut(a: any, holdoutKeys: Set<string> = HOLDOUT_SIGNAL_KEYS): boolean {
  const key = canonicalSignalKey(a?.signal_source);
  return key !== undefined && holdoutKeys.has(key) && PRE_ENROLL_STATUSES.has(a?.status);
}
