# 0009. View-only browser research pass; connect automation left out

## Context

Enrichment APIs are unreliable on recent hires. A titled disqualifier who joined last
month is often absent from the org sweep, and routing on that absence enrolls exactly the
accounts the ICP says to skip. Sales Navigator finds them, and it has no API. The private
pipeline also automated profile views and connection requests as sequence steps through the
same browser session.

## Decision

Ship the research pass; leave connection automation out.

The research pass runs every batch when a logged-in browser is reachable: view/search only,
rosters read as page text, findings written to `raw/salesnav/` at observation time, at most
`limits.salesnav_lookups_per_run` lookups with human-like pacing, overflow queued. It
confirms or flips the provisional route (`HEADLESS_3SOURCE` becomes `SALES_NAV`) before any
enrollment. Browser unreachable or an auth wall is a connector flake: one retry, then the
run degrades to no enrollment and reports DEGRADED. A restriction warning stops all
LinkedIn actions for the run; never retry through it, never rotate identity.

Connection-request and profile-visit sequence steps are not in this repo. They are the most
liability-laden part of the private system (terms of service, account restriction on a real
business asset) and the least generic: the caps, pacing, and note copy were tuned to one
account's history. A public template should not ship a default that can get a stranger's
account restricted.

## Consequences

- Without a browser the pipeline still runs, enrolls nothing on gated signals, and says so.
- The flip rate (provisional route versus post-pass final) is logged per run and is the
  pipeline's real error metric.
- Automating a browser against LinkedIn may violate its terms even when view-only. The pass
  is optional and off unless a browser is reachable; the operator owns the risk.
- Anyone who adds connect automation in a fork should keep it at the sequence layer, after
  the suppression check, behind a config flag that defaults off.
