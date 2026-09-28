/**
 * Top-level TUI entrypoint for local directory installs.
 *
 * The OpenCode 2.0.16 CLI discovers a local package directory's TUI as a
 * top-level `tui.tsx`/`tui.ts` file (the same layout as
 * `<global-config>/plugins/<name>/tui.ts` discovery); a directory entry
 * without that file is silently ignored (observed on 2.0.16). The npm shape
 * doesn't need this file: `exports["./tui"]` resolves to the pre-compiled
 * `dist/tui.js`, which directory installs usually lack because `dist/` is a
 * publish-time artifact. This shim gives the CLI a file it discovers while
 * keeping the real widget in `src/tui.tsx`.
 */

export { default } from "./src/tui"
