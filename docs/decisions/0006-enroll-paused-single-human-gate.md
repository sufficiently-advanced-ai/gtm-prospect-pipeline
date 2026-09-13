# 0006. Enroll paused everywhere, with a single human gate

## Context

An autonomous chain that can enrich, enroll, and send is one prompt edit away from
sending to the wrong people. The first design had several human stops: confirm enrichment
spend, confirm the browser pass, confirm go-live. Stops in the middle of the chain were
skipped under time pressure or executed by reflex, and the batch stalled whenever the human
was away. A gate that is routinely waved through is not a gate.

## Decision

Every enrollment lands in the sequencer with status paused. `enrollment.always_paused:
true` in config; M3 has no unpaused code path. The chain M1 → M2 → research pass → M3 →
M8 → M7 runs unattended end to end.

There is exactly one human gate: M4 go-live. A human names a batch; M4 unpauses exactly
those contacts, per row, confirms counts back, and triggers an immediate CRM push. M4 never
runs headless and never infers a "go" from context, a passing batch, or a dashboard state.

Everything upstream can be wrong and nothing sends. The FLAG queue is a queue, not a gate:
the research pass resolves entries whose evidence now suffices and leaves the rest.

## Consequences

- Batches run daily without the operator present. Enrolled-paused accounts accumulate
  until someone reviews and names a batch.
- M4 pre-flight reads the "awaiting go" count, computed from the store every time (paused
  contacts on active sequences only), because that number is what authorizes real sends.
- The sequencer's bulk toolbar is banned in M4 after it ignored a verified selection; per-row
  actions only, and must-not-send contacts are removed before activation.
- Two independent gates protect each contact: sequence active AND contact active.
