# 0002. Capture-first: a verbatim raw layer under everything

## Context

Early versions interpreted API responses in the same step that fetched them and kept only
the conclusion. When a routing decision was later questioned there was nothing to re-read,
and when the same domain returned from a source a second time there was no record of what
it had said the first time. Job-posting text, the richest artifact the pipeline touches,
was not kept at all.

## Decision

Every API, scrape, or browser response is written to `raw/` verbatim before anything reads
it. Modules are one of three kinds and never two:

- Gathering modules write `raw/` plus minimal state flags and interpret nothing.
- Processing modules read `raw/`, write `accounts/`, and never fetch (M2's named
  verification sources are the one exception, and each is captured first).
- Mirroring modules read `accounts/`, write the CRM, and neither fetch nor interpret.

Every derived claim carries a pointer into `raw/`. `evidence.md` cites one raw path per
fact. Store-lint fails on a pointer or citation that does not resolve. The browser has no
API, so browser findings are written to `raw/salesnav/` at observation time, never
reconstructed later from memory.

## Consequences

- The derived layer is rebuildable from `raw/`. A bad prompt edit can be re-run against
  captured inputs instead of re-bought.
- Eval fixtures are excerpts of real captures, so the eval suite tests the same inputs the
  module saw.
- Disk is cheap; payloads are large. Read them with `rg`, never whole.
- Recovery from any layer that lacks provenance (the CRM) is lossy by construction. The
  one time a blind write destroyed live accounts, outreach state came back from the mirror
  and raw pointers did not.
