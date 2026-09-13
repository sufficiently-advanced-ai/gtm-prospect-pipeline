# 0007. Check-then-write and the pull guard

## Context

M1 asked the signal source to exclude every domain already in the store, trusted the
response, and wrote an account stub for each returned company. One day the source's
exclusion returned three domains that were already live in the store, two of them
mid-sequence. The stub write was blind. All three accounts were overwritten with `status:
pulled` and empty contacts. Outreach state was rebuilt from the CRM mirror; `raw_pointers`
could not be, because the CRM carries no provenance. One account's provenance is gone
permanently. The run was caught only because a pulled-versus-new count did not add up.

## Decision

A source calling a domain "new" is not evidence.

- `lib/pull-guard.ts` checks every returned domain against the store before a single write:
  normalized apex domain, plus alias keys (LinkedIn slug, ATS tenant) for companies whose
  primary domain differs between sources. EXISTS means merge evidence into the existing
  account; NEW means create.
- `createAccountStub()` in `lib/store.ts` refuses to overwrite an existing `account.yaml`.
  There is no force flag.
- The headless wrapper alerts on a run that exits 0 without an M7 progress record. The same
  incident showed that a silent-success run looked exactly like a quiet day.
- Recovering the store from the CRM is emergency-only and documented as lossy.

## Consequences

- Every gathering module pays a store read per returned domain. Cheap.
- Signals whose purpose is to re-encounter known domains (a "still open after N days"
  signal, for example) run in merge mode explicitly; the guard still runs.
- The store is the record. The CRM is a mirror. Nothing in this repo reverses that.
