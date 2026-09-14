# 0010. Pay for what changed since the last run

## Context

The discovery signals ran a description-pattern filter over a wide posting window every
morning. Searches took tens of seconds and some timed out at the gateway. The working
diagnosis for weeks was the domain-exclusion leg: it was long, and the failures were read
through the MCP client as a billed parse error. The cap was lowered, the leg was ranked more
carefully, and the timeouts continued.

The vendor's own request log said something different. The failures were gateway timeouts,
none billed; one of them carried only a handful of excluded domains; legs many times longer
had never failed. Grouped by filter shape, every search without a description pattern
finished in a few seconds at any window. With one, latency scaled with the window. A
description pattern cannot use an index: it is a regex over the description text of every
posting in the window.

## Decision

- Discovery signals ask only for what the source discovered since the last billed pull:
  `discovered_at_lookback: auto` in `config/signal.yaml`, computed by
  `lib/discovered-window.ts` (gap since the last pull plus a pad). `posted_at_*` stays in
  the payload; the API requires it, and the scan is bounded by the smaller window.
- The lookback is dropped, and the full window scanned, whenever the previous pull could
  not have drained the pool: it returned exactly `limit`, there is no prior pull, the
  previous capture did not record its limit, or the run is the weekly sweep. A posting that
  ages out of the discovered_at window unfetched never re-enters it.
- Posting-age signals (merge mode, "still open after N days") never carry the lookback.
  They ask how old a posting is; that is a posted_at question. The script reads the signal
  block from config and plans the full window for any block that does not opt in.
- The domain-exclusion cap is documented as a payload courtesy. The capless path is the
  server-side list, fed at zero credits from ids already in `raw/` (`lib/list-feed.ts`).
- Indexed keyword slugs were measured as a replacement for the regex and rejected: a slug
  found a fraction of the companies the phrase did, and job filters AND together so a slug
  cannot widen a pattern.

## Consequences

- The identical query returned the same companies several-fold faster. Fewer timeouts,
  fewer retries, and retries were where the accidental spend was.
- A wrong diagnosis survived for weeks because it was plausible and the client's error text
  supported it. Timeouts are now diagnosed from the server's request log first.
- The lookback is a script, not a habit, because the failure mode of getting it wrong is
  silent and permanent.
