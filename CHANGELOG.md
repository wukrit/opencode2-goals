# Changelog

All notable changes to `opencode2-goals` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/) and the project
adheres to [Semantic Versioning](https://semver.org/). GitHub release notes
are extracted from the matching section of this file by the release workflow.

## [Unreleased]

## [1.0.4] - 2026-09-28

### Added
- Weekly CI job (`compat.yml`) that floats `@opencode/plugin` to the latest
  2.x and re-runs typecheck + tests, so host type/event drift is caught
  before users hit it. Manual trigger: `gh workflow run compat.yml`.
- `CHANGELOG.md` (this file), `CONTRIBUTING.md`, and issue/PR templates.
- Demo: sidebar goal-loop capture in the README.
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
