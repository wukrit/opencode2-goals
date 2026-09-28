<!-- Keep it short: what changes and why. -->

## Checklist

- [ ] `bun run typecheck && bun test` pass locally
- [ ] `CHANGELOG.md` has an `[Unreleased]` line (skip for internal-only changes)
- [ ] Touched `src/tui.tsx`? Ran `bun run build:tui` and verified the npm shape
- [ ] Event-model or hook-surface change? Latest `compat.yml` run is green
