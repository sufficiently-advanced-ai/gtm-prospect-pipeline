# 0004. Route is classification only

## Context

`route` began as "which sequence does this account get" and accumulated values that were
really leadership-shape judgments, sequence names, and suppression decisions at once. When
two sequences were retired, two route values became decision-dead but remained in the enum
because historical accounts carried them. Evals then surfaced the two meanings contradicting
each other on the same account.

## Decision

`route` records what M2 found, once, at account level, and nothing more:

| Route | Meaning |
|---|---|
| `QUALIFIED` | Fits the ICP; no disqualifier; evidence sufficient. |
| `SKIP` | A binary disqualifier fired. The reason goes in `skip_reason`. Mirrored to the CRM as a verified suppression decision. |
| `FLAGGED` | Evidence conflicting or thin. Never guess; queue for the research pass or a human. |
| `DROPPED` | Fit triage failed (out-of-ICP class). `drop_class` names the class from `config/icp.md`. Store-only. |

Route may appear as an optional qualifier inside a sequence's `binds`, never as a targeting
mechanism of its own. Any ICP-specific sub-classification (leadership shape, evidence
grade) is a free-text `classification` tag defined in `config/icp.md`, not an enum in code.

## Consequences

- The public enum has four values and no legacy ones.
- Routing is binary and account-level: one titled disqualifier anywhere is `SKIP` for the
  whole account, never forced through for a contact who looks good.
- Evals score route as an exact match on the primary field; classification tags are
  reported, never gated.
- Changing your ICP changes `icp.md` and the fixtures, not `lib/status-map.ts`.
