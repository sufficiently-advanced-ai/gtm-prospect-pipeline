# 0005. DROPPED is store-only; SKIP is mirrored

## Context

Fit-triage drops (vendors in your own category, staffing firms, investors, job boards,
companies far outside the size band) were mirrored to the CRM alongside everything else.
They outnumbered live accounts, cluttered every view, and carried no decision worth
revisiting. A `SKIP`, by contrast, is a verified judgment about a company that fits the
ICP but must not be contacted, exactly the kind of record the CRM exists to keep.

## Decision

- `status: dropped` / `route: DROPPED` accounts keep their directory and evidence in the
  store but never reach the CRM. M8 push excludes them unconditionally, even when a stale
  `crm` pointer exists. Audit treats their absence from the CRM as correct and flags a
  present one as a stray to remove (with an audit log written first).
- `SKIP` accounts are mirrored with their `skip_reason`. Suppression checks read them.
- Per-signal `push_to_crm_after: enrolled` can hold a signal's accounts out of the CRM
  until enrollment; `skipped` still mirrors under that holdout.

## Consequences

- The CRM shows the pipeline's decisions, not its noise.
- A dropped company that later emits a real signal is re-encountered by the pull-guard as
  an existing account and re-triaged from its store record, with the old evidence intact.
- Recovering the store from the CRM would lose every drop. The store is canonical; see 0007.
