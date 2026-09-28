# Contributing

Thanks for taking an interest. Small, focused PRs are easiest to land.

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit (default + tsconfig.tui.json)
bun test            # bun's runner; mock-context harness in test/harness.ts
bun run build:tui   # compiles src/tui.tsx -> dist/tui.js (also runs via prepack)
```

Everything in CI has to pass locally: typecheck (both configs) and the full
test suite. Tests drive the real `setup()` from `index.ts` against a mocked
plugin context and a deterministic event bus — when you change loop, event,
or tool behavior, extend `test/goal-loop.test.ts` in that style.

**Widget gotcha:** if you change `src/tui.tsx`, run `bun run build:tui`
before testing the **npm** install shape — `exports["./tui"]` serves the
pre-compiled `dist/tui.js` because the host's JSX transform skips `.tsx`
under `node_modules` (see issue #3). Directory installs compile the source
directly and need no build step.

## Pull requests

- Add a line under `[Unreleased]` in `CHANGELOG.md` for anything user-visible.
  Internal-only changes (CI, dev tooling) don't need one.
- CI verifies the PR, so please don't push a tag from a feature branch.
- Prefer caret ranges (`^x.y.z`) in `package.json`.

### Dependabot policy

Dependabot PRs are **CI-verified and merged**, not closed — that's how
`typescript` 7 and the `actions/*` bumps landed. If an update is genuinely
undesired (e.g. a major that breaks the host contract), add an `ignore`
entry in `.github/dependabot.yml` with a comment explaining why, so the
decision is recorded rather than re-litigated weekly.

## Compatibility

The plugin is developed against the pinned `@opencode/plugin` devDep and
continuously checked against the **latest 2.x** by the weekly
`compat.yml` job — both the type surface (float + typecheck + tests) and a
**live smoke test** (`scripts/live-smoke.sh` boots an isolated real host and
asserts `/goal` is registered; no model call needed). If you're touching the
event model (`session.execution.*`
boundaries, `session.usage.updated`) or hook surfaces, run
`gh workflow run compat.yml` on your branch's pushed state and keep it green.

## Recording the demo

The README GIF is generated, not hand-recorded — `vhs scripts/demo.tape`
(install with `brew install vhs`). The tape drives `scripts/demo-env.sh`,
which boots a standalone TUI against throwaway XDG dirs and this checkout as
a directory install, so the capture shows current code without touching your
global config or shared database. Edit the tape, re-record, and save the
output as `docs/demo.gif`.

## Releasing

Maintainers: bump `version` in `package.json`, move the `[Unreleased]`
entries into a dated section in `CHANGELOG.md`, commit, then push a tag:

```sh
git tag v1.0.4 && git push origin v1.0.4
```

`.github/workflows/release.yml` verifies the tag matches `package.json`,
runs typecheck + tests, publishes to npm with **OIDC provenance** (`prepack`
rebuilds the widget), and creates the GitHub release with notes pulled from
`CHANGELOG.md`. 

**One-time npm setup:** npm does not auto-register trusted publishers — enable
them on npmjs.com → the package → **Access** tab → *Trusted publishing*: owner
`wukrit`, repository `opencode2-goals`, workflow name `release.yml`.
Optionally also toggle *provenance: required* so everything after is provable.
**Client-side gotchas (both cost us three failed v1.0.4 runs):** npm **11+**
is required — npm 10 never attempts the OIDC exchange and fails with a
client-side `ENEEDAUTH` (we run node 24, which ships npm 11). And
`actions/setup-node` injects `NPM_AUTH_TOKEN` defaulting to the
`GITHUB_TOKEN`, which also breaks the OIDC flow — the publish step strips it
with `env -u`; keep that if you ever refactor this file.
