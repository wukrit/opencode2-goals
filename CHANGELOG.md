# Changelog

All notable changes to `opencode2-goals` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/) and the project
adheres to [Semantic Versioning](https://semver.org/). GitHub release notes
are extracted from the matching section of this file by the release workflow.

## [Unreleased]

### Added
- Verdict-gated completion (issue #6, Graph-aware goals milestone): `src/verdict.ts`
  parses the run's `verdict.md` (pass/fail, gate green/red token matrix,
  P1/P2/P3 counts, per-node proven list); graph-mode `goal_complete` / `/goal
  complete` re-parse the file scoped to the session directory (pass + green
  gate + zero P1 + fully proven required, each rejection names the missing
  piece) and fall back to explicitly-tagged model-attested completion only
  when the file is unreadable. Loop-mode gating is untouched.
- Repo-graph orchestration (issue #4, Graph-aware goals milestone):
  `detectGraph` (agent/command registry first, `.opencode` fs fallback),
  `GoalRecord.graph` phase machine (`plan → work → verify → publish`, plus
  `remediate` for #7 routing), phase-specific orchestrator continuations with
  artifact-presence guards, and `--graph <issue>` / `graph` opt-in on `/goal
  set` and `goal_set` (explicit refusal when no graph is detected — never a
  silent downgrade). Loop prompts are byte-identical when graph mode is off.
- Goal tasks are a DAG (issue #5, Graph-aware goals milestone): `depends`
  (ordering edges), `acceptance`, `verify`, per-node `evidence`, `note`, and
  an explicit `blocked` status. `goal_add_task` takes `depends`/`acceptance`/
  `verify`; `goal_update_task` takes `todo`/`doing`/`done`/`blocked` plus
  optional `note`/`evidence`. `doing`/`done` are rejected while deps are
  unmet; new pure helpers live in `src/graph.ts` (cycle-checked validation,
  `readyTasks`, topological parallel groups). `/goal task add` accepts
  `--depends 1,2 --acceptance "..." --verify "..."`; `/goal view` and the
  sidebar widget render dep edges (`← after 1`), node fields, and parallel
  groups. Old records normalize (`depends: []`); loop behavior without deps
  is unchanged.

## [1.0.4] - 2026-09-28

### Added
- Weekly CI job (`compat.yml`) guarding host compatibility: floats
  `@opencode/plugin` to the latest 2.x and re-runs typecheck + tests, *and*
  boots a real isolated OpenCode server (`scripts/live-smoke.sh`) asserting
  `/goal` registers — drift is caught before users hit it. Manual trigger:
  `gh workflow run compat.yml`.
- `CHANGELOG.md` (this file, shipped in the npm package), `CONTRIBUTING.md`,
  and issue/PR templates.
- Demo GIF in the README (root `demo.gif`), recorded against a throwaway
  environment running this checkout; the VHS tape is maintainer-local.
- GitHub releases now take their notes from this file's matching section.

### Changed
- Development toolchain upgraded to TypeScript 7 (`tsc` 7.0.2, native port);
  typecheck and tests pass with zero source changes. No runtime impact.
- CI uses `actions/checkout@v7`.

## [1.0.3] - 2026-09-28

### Fixed
- `goal_complete`/`goal_block` and their slash-command twins now check goal
  presence and status before demanding evidence/reason, so a terminal or
  absent goal reports its actual state instead of a fixable-sounding
  rejection.

### Documentation
- README audit: documented `continuationText`, command aliases, and `todo`
  task status.

## [1.0.2] - 2026-09-25

### Fixed
- The TUI widget now ships pre-compiled as `dist/tui.js`, so **npm installs
  load the sidebar widget too** (issue #3: the host's JSX transform skips
  `.tsx` under `node_modules`).

## [1.0.1] - 2026-09-25

### Fixed
- Host TUI peers (`@opentui/core`, `@opentui/solid`, `solid-js`) marked
  optional; npm installs no longer fail dependency resolution (`ERESOLVE`).

## [1.0.0] - 2026-09-25

### Added
- First public release: the full goal loop (objective re-injection,
  execution-boundary continuation, stall detection), `/goal` command
  surface, evidence-gated completion, budget caps with `budget_limited`,
  durable goal history/archive, unattended permission sandbox, and the
  live TUI sidebar progress widget.
