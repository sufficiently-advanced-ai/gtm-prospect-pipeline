# Architecture diagrams

Excalidraw scenes describing the pipeline as documented in ARCHITECTURE.md. Open them at
[excalidraw.com](https://excalidraw.com) (File → Open) or in the VS Code Excalidraw
extension. Everything is editable: boxes carry their text as grouped elements and arrows are
bound to the shapes they connect, so dragging a box keeps its label and arrows attached.

| file | what it answers |
|---|---|
| `00-overview.excalidraw` | What are the pieces and who owns what? Modules, config, store, external systems, the system-of-record hierarchy, the hard rules, and where the one human gate sits. |
| `01-data-flow.excalidraw` | What actually moves, in order? One batch left to right across four bands (external call → module → store write → resulting state), plus the policy gates, the browser-pass degrade path, and the daily reconcile. |
| `02-eval-system.excalidraw` | How does `evals/` keep a SKILL.md edit from silently un-learning a paid-for lesson? Prompt sources → runners → model (live or replay) → scoring → baseline diff → gates, plus the fixture flywheel. |

## Slide versions

Same three subjects, cut to what survives a projector: 16:9, about nine boxes each, one idea
per box, no file paths or config keys. Each sits in a named Excalidraw **frame**, so you can
right-click the frame → *Copy to clipboard as PNG/SVG*, or export just that frame, and drop
it into a deck.

| file | slide |
|---|---|
| `10-slide-overview.excalidraw` | The five stages, the one store under them, the single human gate, the rules that never bend. |
| `11-slide-data-flow.excalidraw` | Stage → source → resulting state, plus capture-first, state-is-permission, and degrade-never-guess. |
| `12-slide-evals.excalidraw` | Frozen fixtures + the live rulebook → run → score → pass/block, and why the fixtures exist. |

The detailed versions are the reference; the slides are the story. When the contract
changes, update both.

## Regenerating

    node docs/diagrams/generate.ts

`generate.ts` is the source of truth for the scenes; hand edits to the `.excalidraw` files
are overwritten on the next run (fine for a one-off annotation, not for content that should
last). The generator asserts that no two boxes overlap and exits 1 if any do, so text that
outgrows its box fails the build instead of shipping as an unreadable diagram.

These diagrams are documentation, not a contract: ARCHITECTURE.md and the config files are
authoritative. When the contract changes, update `generate.ts` in the same change.
