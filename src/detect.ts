/**
 * Repo-graph detection (issue #4).
 *
 * Registry first, filesystem fallback — the host's agent/command registries
 * respect global config and load order; the fs scan only diagnoses partial
 * graphs (e.g. worker present, verifier missing). Everything is best-effort:
 * any failure resolves to "absent" rather than breaking goal setup.
 */

import type { GraphOptions } from "./options"
import type { PluginContext } from "./types"

export type GraphDetection = {
  /** All expected roles + the orchestrator command resolved. */
  full: boolean
  /** Anything at all found (role or command, either signal). */
  present: boolean
  /** Role agent ids observed (registry or fs). */
  agents: string[]
  /** Whether the orchestrator command was observed. */
  command: boolean
  /** Expected roles with no signal anywhere. */
  missing: string[]
  /** Which signal answered (for diagnostics, not behavior). */
  via: "registry" | "fs" | "both" | "none"
}

const ROLE_FILES = ["graph-planner", "graph-worker", "graph-verifier"] as const

function pickAgents(found: readonly string[], expected: readonly string[]): string[] {
  const lower = new Set(found.map((f) => f.toLowerCase()))
  return expected.filter((e) => lower.has(e.toLowerCase()))
}

async function registrySignal(
  ctx: PluginContext,
  expectedCommand: string,
): Promise<{ agents: string[]; command: boolean } | undefined> {
  try {
    const [agents, commands] = await Promise.all([
      ctx.agent?.list?.() ?? Promise.resolve(undefined),
      ctx.command.list?.() ?? Promise.resolve(undefined),
    ])
    if (agents === undefined && commands === undefined) return undefined
    return {
      agents: (agents ?? []).flatMap((a) => (typeof a?.id === "string" ? [a.id] : [])),
      command: (commands ?? []).some((c) => c?.name === expectedCommand),
    }
  } catch {
    return undefined
  }
}

async function fsSignal(directory: string | undefined): Promise<{ agents: string[]; command: boolean } | undefined> {
  if (!directory) return undefined
  try {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const agents = ROLE_FILES.filter((role) => {
      try {
        return fs.existsSync(path.join(directory, ".opencode", "agents", `${role}.md`))
      } catch {
        return false
      }
    })
    let command = false
    try {
      command = fs.existsSync(path.join(directory, ".opencode", "commands", "graph-run.md"))
    } catch {
      command = false
    }
    return { agents: [...agents], command }
  } catch {
    return undefined
  }
}

export async function detectGraph(ctx: PluginContext, options: GraphOptions): Promise<GraphDetection> {
  const empty: GraphDetection = { full: false, present: false, agents: [], command: false, missing: [...options.agents], via: "none" }
  if (options.mode === "off") return empty
  const [registry, fs] = await Promise.all([registrySignal(ctx, options.command), fsSignal(ctx.location?.directory)])
  if (!registry && !fs) return empty
  const seen = new Set<string>()
  for (const id of [...(registry?.agents ?? []), ...(fs?.agents ?? [])]) seen.add(id)
  const agents = pickAgents([...seen], options.agents)
  // A custom command name is only observable via registry; the fs signal only
  // knows the conventional graph-run.md file.
  const command = registry ? registry.command : options.command === "graph-run" && (fs?.command ?? false)
  const missing = options.agents.filter((e) => !agents.some((a) => a.toLowerCase() === e.toLowerCase()))
  const full = missing.length === 0 && command
  const regHit = (registry?.agents.length ?? 0) > 0 || (registry?.command ?? false)
  const fsHit =
    (fs?.agents.length ?? 0) > 0 || (options.command === "graph-run" && (fs?.command ?? false) && !registry)
  return {
    full,
    present: agents.length > 0 || command,
    agents,
    command,
    missing,
    via: regHit && fsHit ? "both" : regHit ? "registry" : fsHit ? "fs" : "none",
  }
}
