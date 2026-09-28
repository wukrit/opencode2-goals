import type { PluginContext } from "./types"

export type GraphOptions = {
  /** "auto" uses a detected repo graph when the goal opts in; "off" never does. */
  mode: "auto" | "off"
  /** Orchestrator command name offered in prompts (repo owns the command). */
  command: string
  /** Role agent ids expected in the repo graph. */
  agents: string[]
  /** Verifier-fail remediation budget (routing lives in #7; stored here for forward-compat). */
  maxRemediations: number
}

export const DEFAULT_GRAPH_OPTIONS: GraphOptions = {
  mode: "auto",
  command: "graph-run",
  agents: ["graph-planner", "graph-worker", "graph-verifier"],
  maxRemediations: 1,
}

export type Options = {
  /** Consecutive tool-less continuation turns tolerated before the goal stalls. */
  stallLimit: number
  /** Replaces the default continuation prompt when set. */
  continuationText: string | undefined
  /** Default turn cap applied when `/goal set` gives no explicit cap. */
  defaultCapTurns: number
  /** Default token cap applied when `/goal set` gives no explicit cap. */
  defaultCapTokens: number
  /** Repo-graph orchestration config (issue #4). */
  graph: GraphOptions
}

export const DEFAULT_OPTIONS: Options = {
  stallLimit: 1,
  continuationText: undefined,
  defaultCapTurns: 10,
  defaultCapTokens: 100_000,
  graph: DEFAULT_GRAPH_OPTIONS,
}

function resolveGraphOptions(provided: unknown): GraphOptions {
  const raw = (provided ?? {}) as Partial<GraphOptions>
  const mode = raw.mode === "off" ? "off" : "auto"
  const command = typeof raw.command === "string" && raw.command.trim() ? raw.command.trim() : DEFAULT_GRAPH_OPTIONS.command
  const agents =
    Array.isArray(raw.agents) && raw.agents.length > 0 && raw.agents.every((a) => typeof a === "string")
      ? [...(raw.agents as string[])]
      : [...DEFAULT_GRAPH_OPTIONS.agents]
  const maxRemediations =
    typeof raw.maxRemediations === "number" && raw.maxRemediations >= 0
      ? Math.floor(raw.maxRemediations)
      : DEFAULT_GRAPH_OPTIONS.maxRemediations
  return { mode, command, agents, maxRemediations }
}

export function resolveOptions(ctx: PluginContext): Options {
  const provided = (ctx.options ?? {}) as Partial<Options>
  const stallLimit = typeof provided.stallLimit === "number" && provided.stallLimit >= 0 ? provided.stallLimit : DEFAULT_OPTIONS.stallLimit
  const continuationText = typeof provided.continuationText === "string" ? provided.continuationText : undefined
  const defaultCapTurns =
    typeof provided.defaultCapTurns === "number" && provided.defaultCapTurns > 0
      ? Math.floor(provided.defaultCapTurns)
      : DEFAULT_OPTIONS.defaultCapTurns
  const defaultCapTokens =
    typeof provided.defaultCapTokens === "number" && provided.defaultCapTokens > 0
      ? Math.floor(provided.defaultCapTokens)
      : DEFAULT_OPTIONS.defaultCapTokens
  return { stallLimit, continuationText, defaultCapTurns, defaultCapTokens, graph: resolveGraphOptions(provided.graph) }
}
