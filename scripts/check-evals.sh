#!/usr/bin/env bash
# The $0 pre-edit gate for the eval suite: harness self-tests + fixture immutability +
# offline replay. No model calls, no credits, no network (evals/DESIGN.md §check-evals.sh).
#
# Run before landing ANY edit to skills/*/SKILL.md, config/icp.md, config/signal.yaml or
# config/sequences.yaml — exit 1 means a paid-for lesson regressed, or a fixture moved
# under the baseline. Fixture change procedure: evals/fixtures/SCHEMA.md §Immutability.
#
#   bash scripts/check-evals.sh
#
# Live confirmation (credits) is a separate, deliberate act: node evals/run.ts --task all.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> harness self-tests (test/evals-harness.test.ts)"
node test/evals-harness.test.ts

echo
echo "==> fixture immutability + completeness vs committed baseline"
node --input-type=module -e '
import { loadAllFixtures } from "./evals/harness/loader.ts";
import { checkFixtureCompleteness, checkFixtureImmutability, loadBaseline } from "./evals/harness/report.ts";

const fixtures = loadAllFixtures("evals/fixtures/cases");
const baseline = loadBaseline("evals/baselines/baseline.json");
if (!baseline) {
  console.error("IMMUTABILITY: no baseline at evals/baselines/baseline.json — record one with `node evals/run.ts --task all --baseline` (full live run)");
  process.exit(1);
}
const violations = checkFixtureImmutability(baseline, fixtures);
// This script loads the FULL cases tree, so every id the baseline recorded must still be
// here. Immutability alone only compares fixtures that still exist — deleting an
// inconvenient fixture dir would otherwise pass this gate in complete silence.
violations.push(...checkFixtureCompleteness(baseline, fixtures));
for (const v of violations) console.error(`IMMUTABILITY: ${v}`);
if (violations.length) process.exit(1);
const unbaselined = fixtures.filter((f) => !baseline.fixture_shas?.[f.id]).map((f) => f.id);
if (unbaselined.length)
  console.log(`NOTE: ${unbaselined.length} fixture(s) not in the baseline yet: ${unbaselined.join(", ")}`);
console.log(`OK: ${fixtures.length} fixtures unchanged vs baseline`);
'

echo
echo "==> offline replay run (evals/run.ts --task all --offline)"
node evals/run.ts --task all --offline

echo
echo "All eval pre-edit checks passed."
