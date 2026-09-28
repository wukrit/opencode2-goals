/**
 * DAG helpers for goal tasks (issue #5).
 *
 * Tasks are graph nodes; `depends` edges are ordering only — no parallel
 * execution, just readiness. Everything here is pure (no plugin context) so
 * the graph logic can be unit tested in isolation, mirroring `state.ts`.
 */

import { resolveTaskRef } from "./state"
import type { GoalTask } from "./state"

export const SOFT_NODE_WARN_COUNT = 7

/** Ids in `depends` that are not `done` yet (dangling ids count as unmet). */
export function unmetDeps(task: GoalTask, tasks: readonly GoalTask[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const unmet: string[] = []
  for (const dep of task.depends ?? []) {
    const node = byId.get(dep)
    if (!node || node.status !== "done") unmet.push(dep)
  }
  return unmet
}

/** Todo tasks whose deps are all done — the "next up" set. */
export function readyTasks(tasks: readonly GoalTask[]): GoalTask[] {
  return tasks.filter((t) => t.status === "todo" && unmetDeps(t, tasks).length === 0)
}

/**
 * Validate a fresh dep list for a task id against the current graph.
 * Returns a rejection reason, or undefined when the edges are legal.
 * Cycle-checked (iterative DFS) so future dep-editing stays safe; with
 * add-only deps a cycle is unreachable, but the guard is cheap.
 */
export function validateDepends(
  tasks: readonly GoalTask[],
  selfID: string,
  depIDs: readonly string[],
): string | undefined {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  for (const dep of depIDs) {
    if (dep === selfID) return `Task NOT added: a task cannot depend on itself.`
    if (!byId.has(dep)) return `Task NOT added: no such task ${dep}. See /goal view for numbers.`
  }
  // Cycle check over the graph as it would look with the new edges included.
  // Iterative DFS with gray/black marking from the new node: any back edge
  // (including a pre-existing cycle reachable from the deps) rejects.
  const edges = new Map<string, string[]>()
  for (const t of tasks) edges.set(t.id, [...(t.depends ?? [])])
  edges.set(selfID, [...depIDs])
  const gray = new Set<string>([selfID])
  const black = new Set<string>()
  const stack: Array<{ id: string; childIndex: number }> = [{ id: selfID, childIndex: 0 }]
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!
    const children = edges.get(top.id) ?? []
    if (top.childIndex >= children.length) {
      stack.pop()
      gray.delete(top.id)
      black.add(top.id)
      continue
    }
    const next = children[top.childIndex++]!
    if (gray.has(next)) return `Task NOT added: that dependency would create a cycle.`
    if (black.has(next)) continue
    gray.add(next)
    stack.push({ id: next, childIndex: 0 })
  }
  return undefined
}

/**
 * Resolve a `--depends` value (e.g. "1,2" or ["1","abc"]) to task ids.
 * Numbers are 1-based task positions via `resolveTaskRef`; anything else
 * must match a task id (suffix). Unknown refs are returned as errors.
 */
export function resolveDepends(
  tasks: readonly GoalTask[],
  raw: string | readonly string[] | undefined,
): { ids: string[] } | { error: string } {
  if (raw === undefined) return { ids: [] }
  const parts = (Array.isArray(raw) ? raw : String(raw).split(",")).map((p) => p.trim()).filter(Boolean)
  const ids: string[] = []
  for (const part of parts) {
    const index = resolveTaskRef(tasks, part)
    if (index < 0) return { error: `Task NOT added: no such task ${part}. See /goal view for numbers.` }
    const id = tasks[index]!.id
    if (!ids.includes(id)) ids.push(id)
  }
  return { ids }
}

/** 1-based task number for a task id, or the id suffix when unknown. */
export function taskNumber(tasks: readonly GoalTask[], id: string): string {
  const index = tasks.findIndex((t) => t.id === id)
  return index >= 0 ? String(index + 1) : id.slice(-6)
}

/**
 * Topological levels (Kahn's); levels with >1 member are parallel groups.
 * Dangling dep ids are ignored (normalizeGoal prunes them on load).
 */
export function parallelGroups(tasks: readonly GoalTask[]): string[][] {
  const ids = new Set(tasks.map((t) => t.id))
  const indegree = new Map<string, number>()
  const children = new Map<string, string[]>()
  for (const t of tasks) {
    const deps = (t.depends ?? []).filter((d) => ids.has(d) && d !== t.id)
    indegree.set(t.id, deps.length)
    for (const d of deps) {
      const list = children.get(d) ?? []
      list.push(t.id)
      children.set(d, list)
    }
  }
  const groups: string[][] = []
  let frontier = tasks.filter((t) => (indegree.get(t.id) ?? 0) === 0).map((t) => t.id)
  const visited = new Set<string>()
  while (frontier.length > 0) {
    if (frontier.length > 1) groups.push(frontier)
    for (const id of frontier) {
      visited.add(id)
      for (const child of children.get(id) ?? []) {
        indegree.set(child, (indegree.get(child) ?? 1) - 1)
      }
    }
    frontier = tasks.filter((t) => !visited.has(t.id) && (indegree.get(t.id) ?? 0) === 0).map((t) => t.id)
  }
  return groups
}
