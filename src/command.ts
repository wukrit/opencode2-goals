/**
 * `/goal` argument parsing and human-readable status/history formatting.
 *
 * The registered command receives the raw text typed after `/goal`; this module
 * turns it into a structured operation. A bare, non-verb argument is treated as
 * `set`, so `/goal ship the release` works as a shorthand.
 */

import { capSummary, taskCounts, type GoalCap, type GoalRecord, type GoalTaskStatus, isTerminal } from "./state"
import { parallelGroups, taskNumber } from "./graph"

export type GoalCommand =
  | { kind: "view" }
  | { kind: "set"; objective: string; cap: GoalCap; unbounded: boolean; graph?: string }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" }
  | { kind: "complete"; evidence: string }
  | { kind: "block"; reason: string }
  | { kind: "taskAdd"; title: string; depends?: string; acceptance?: string; verify?: string }
  | { kind: "taskUpdate"; ref: string; status: GoalTaskStatus }
  | { kind: "taskList" }
  | { kind: "history" }

const VERBS = new Set(["set", "view", "status", "pause", "resume", "clear", "complete", "done", "block", "blocked", "task", "tasks", "history", "log"])

const UNBOUNDED_FLAGS = new Set(["--unbounded", "--no-cap", "--unlimited"])

function parseCap(tokens: string[]): { cap: GoalCap; rest: string[]; unbounded: boolean } {
  const cap: GoalCap = {}
  const rest: string[] = []
  let unbounded = false
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (UNBOUNDED_FLAGS.has(token.toLowerCase())) {
      unbounded = true
      continue
    }
    const eq = /^--(turns|tokens|cap)=(\d+)$/.exec(token)
    if (eq) {
      const value = Number(eq[2])
      if (eq[1] === "tokens") cap.tokens = value
      else cap.turns = value
      continue
    }
    if (token === "--turns" || token === "--tokens" || token === "--cap") {
      const next = tokens[i + 1]
      if (next !== undefined && /^\d+$/.test(next)) {
        if (token === "--tokens") cap.tokens = Number(next)
        else cap.turns = Number(next)
        i++
        continue
      }
    }
    rest.push(token)
  }
  return { cap, rest, unbounded }
}

/**
 * Extract `--graph <issue>` / `--graph=<issue>` / bare `--graph` (issue
 * unspecified) and `--no-graph` from tokens left over by `parseCap`.
 */
function parseGraphFlag(tokens: string[]): { graph?: string; rest: string[] } {
  let graph: string | undefined
  const rest: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const lower = token.toLowerCase()
    if (lower === "--no-graph") {
      graph = undefined
      continue
    }
    const eq = /^--graph=(.*)$/.exec(token)
    if (eq) {
      graph = eq[1]!.trim()
      continue
    }
    if (lower === "--graph") {
      const next = tokens[i + 1]
      if (next !== undefined && !next.startsWith("--")) {
        graph = next.trim()
        i++
      } else {
        graph = ""
      }
      continue
    }
    rest.push(token)
  }
  return graph === undefined ? { rest } : { graph, rest }
}

export function parseGoalCommand(raw: string): GoalCommand {
  const text = (raw ?? "").trim()
  if (!text) return { kind: "view" }

  const firstSpace = text.search(/\s/)
  const head = (firstSpace === -1 ? text : text.slice(0, firstSpace)).toLowerCase()
  const tail = firstSpace === -1 ? "" : text.slice(firstSpace).trim()

  if (!VERBS.has(head)) {
    const { cap, rest, unbounded } = parseCap(text.split(/\s+/))
    const { graph, rest: objectiveTokens } = parseGraphFlag(rest)
    const set: Extract<GoalCommand, { kind: "set" }> = {
      kind: "set",
      objective: objectiveTokens.join(" ").trim(),
      cap,
      unbounded,
    }
    if (graph !== undefined) set.graph = graph
    return set
  }

  switch (head) {
    case "view":
    case "status":
      return { kind: "view" }
    case "history":
    case "log":
      return { kind: "history" }
    case "task":
    case "tasks":
      return parseTaskCommand(tail)
    case "pause":
      return { kind: "pause" }
    case "resume":
      return { kind: "resume" }
    case "clear":
      return { kind: "clear" }
    case "complete":
    case "done":
      return { kind: "complete", evidence: tail }
    case "block":
    case "blocked":
      return { kind: "block", reason: tail }
    case "set": {
      const { cap, rest, unbounded } = parseCap(tail.split(/\s+/))
      const { graph, rest: objectiveTokens } = parseGraphFlag(rest)
      const set: Extract<GoalCommand, { kind: "set" }> = {
        kind: "set",
        objective: objectiveTokens.join(" ").trim(),
        cap,
        unbounded,
      }
      if (graph !== undefined) set.graph = graph
      return set
    }
    default:
      return { kind: "view" }
  }
}

function parseTaskCommand(tail: string): GoalCommand {
  const text = (tail ?? "").trim()
  if (!text || text.toLowerCase() === "list") return { kind: "taskList" }
  const firstSpace = text.search(/\s/)
  const head = (firstSpace === -1 ? text : text.slice(0, firstSpace)).toLowerCase()
  const rest = firstSpace === -1 ? "" : text.slice(firstSpace).trim()
  if (head === "add") return parseTaskAdd(rest)
  if (head === "done" || head === "doing" || head === "todo" || head === "blocked") {
    return { kind: "taskUpdate", ref: rest.split(/\s+/)[0] ?? "", status: head as GoalTaskStatus }
  }
  // Shorthand: `/goal task 2 done` or `/goal task 2 doing`
  const parts = text.split(/\s+/)
  if (parts.length === 2) {
    const [ref, status] = parts as [string, string]
    const lower = status.toLowerCase()
    if (lower === "done" || lower === "doing" || lower === "todo" || lower === "blocked") {
      return { kind: "taskUpdate", ref, status: lower as GoalTaskStatus }
    }
  }
  return { kind: "taskList" }
}

/** Split on whitespace, keeping double-quoted spans together (quotes stripped). */
function splitTaskArgs(text: string): string[] {
  const parts: string[] = []
  let current = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/.test(ch)) {
      if (current) {
        parts.push(current)
        current = ""
      }
      continue
    }
    current += ch
  }
  if (current) parts.push(current)
  return parts
}

/**
 * `/goal task add <title> [--depends 1,2] [--acceptance "..."] [--verify "..."]`.
 * The title is the leading bare tokens before the first flag.
 */
function parseTaskAdd(rest: string): GoalCommand {
  const tokens = splitTaskArgs(rest)
  const titleParts: string[] = []
  let depends: string | undefined
  let acceptance: string | undefined
  let verify: string | undefined
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!.toLowerCase()
    if (token === "--depends" || token === "--acceptance" || token === "--verify") {
      const value = tokens[i + 1]
      if (value !== undefined && !value.startsWith("--")) {
        if (token === "--depends") depends = value
        else if (token === "--acceptance") acceptance = value
        else verify = value
        i++
      }
      continue
    }
    if (tokens[i]!.startsWith("--")) continue
    if (depends === undefined && acceptance === undefined && verify === undefined) {
      titleParts.push(tokens[i]!)
    }
    // Bare tokens after flags are ignored (flags take values, not positionals).
  }
  const out: Extract<GoalCommand, { kind: "taskAdd" }> = { kind: "taskAdd", title: titleParts.join(" ").trim() }
  if (depends !== undefined) out.depends = depends
  if (acceptance !== undefined) out.acceptance = acceptance
  if (verify !== undefined) out.verify = verify
  return out
}

/** Render archived goals (newest first) for `/goal history` and `goal_history`. */
export function formatGoalHistory(goals: readonly GoalRecord[], limit = 10): string {
  if (!goals.length) {
    return "No archived goals yet. Terminal or superseded goals are archived automatically as the session progresses."
  }
  const shown = goals.slice(0, limit)
  const rows = shown.map((g, i) => {
    const tokens =
      typeof g.used?.tokens === "number" && g.used.tokens >= 1000
        ? `${Math.round((g.used.tokens / 1000) * 10) / 10}k`
        : String(g.used?.tokens ?? 0)
    const objective = g.objective.length > 60 ? `${g.objective.slice(0, 57)}...` : g.objective
    const taskBits = g.tasks?.length ? ` · ${taskCounts(g.tasks).done}/${g.tasks.length} tasks` : ""
    const evidence = g.evidence ? ` · evidence: ${g.evidence.slice(0, 60)}${g.evidence.length > 60 ? "..." : ""}` : ""
    const blocker = g.blocker ? ` · blocked: ${g.blocker.slice(0, 60)}${g.blocker.length > 60 ? "..." : ""}` : ""
    return `${i + 1}. ${g.id} · ${g.status} · ${g.used?.turns ?? 0}t · ${tokens} tok${taskBits} · ${objective}${evidence}${blocker}`
  })
  const more = goals.length > shown.length ? `\n+${goals.length - shown.length} older entries archived` : ""
  return `Goal history (${goals.length} archived${goals.length > limit ? `, newest ${limit} shown` : ""}):\n${rows.join("\n")}${more}`
}

export function formatGoal(goal: GoalRecord | undefined, sessionID: string): string {
  if (!goal || goal.status === "cleared") {
    return `No goal is set for this session (${sessionID}).`
  }
  const tasks = goal.tasks ?? []
  const counts = taskCounts(tasks)
  const lines = [
    `Goal ${goal.id}: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Continuations: ${goal.continuations} · stalls: ${goal.stalls} · cap: ${capSummary(goal.cap)} · used: ${goal.used.turns} turns, ${goal.used.tokens} tokens`,
  ]
  if (goal.graph?.mode === "graph") {
    lines.push(`Graph: phase ${goal.graph.phase} · run ${goal.graph.runId} · issue ${goal.graph.issue || "(unspecified)"} · remediations ${goal.graph.remediationsUsed}`)
    if (goal.graph.lastVerdict) lines.push(`Last verdict: ${goal.graph.lastVerdict}`)
  }
  if (tasks.length > 0) {
    lines.push(
      `Tasks: ${counts.done}/${counts.total} done${counts.doing > 0 ? ` · ${counts.doing} doing` : ""}${counts.blocked > 0 ? ` · ${counts.blocked} blocked` : ""}`,
    )
    tasks.forEach((t, i) => {
      const box = t.status === "done" ? "x" : t.status === "doing" ? ">" : t.status === "blocked" ? "!" : " "
      const deps =
        t.depends?.length > 0 ? ` ← after ${t.depends.map((id) => taskNumber(tasks, id)).join(",")}` : ""
      lines.push(`  ${i + 1}. [${box}] ${t.title}${deps}`)
      if (t.acceptance) lines.push(`      acceptance: ${t.acceptance}`)
      if (t.verify) lines.push(`      verify: ${t.verify}`)
      if (t.note) lines.push(`      note: ${t.note}`)
      if (t.evidence) lines.push(`      evidence: ${t.evidence}`)
    })
    const groups = parallelGroups(tasks)
    if (groups.length > 0) {
      const rendered = groups
        .map((g) => `{${g.map((id) => taskNumber(tasks, id)).join(",")}}`)
        .join(" ")
      lines.push(`Parallel groups: ${rendered}`)
    }
  }
  if (goal.evidence) lines.push(`Evidence: ${goal.evidence}`)
  if (goal.blocker) lines.push(`Blocker: ${goal.blocker}`)
  if (goal.outcome) lines.push(`Outcome: ${goal.outcome}`)
  if (isTerminal(goal.status)) lines.push("(terminal — /goal resume to continue, /goal clear to remove)")
  return lines.join("\n")
}
