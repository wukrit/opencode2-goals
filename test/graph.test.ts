import { afterEach, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { assistantWithTool, MockContext, userMessage } from "./harness"
import { DEFAULT_CONTINUATION_PROMPT } from "../src/controller"
import { detectGraph } from "../src/detect"
import { DEFAULT_GRAPH_OPTIONS } from "../src/options"
import { parseGoalCommand } from "../src/command"
import type { PluginEvent } from "../src/types"

const SID = "ses_test_graph_1"
const tmpDirs: string[] = []
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

function seedRepoGraph(dir: string, roles: string[] = ["graph-planner", "graph-worker", "graph-verifier"]): void {
  mkdirSync(join(dir, ".opencode", "agents"), { recursive: true })
  mkdirSync(join(dir, ".opencode", "commands"), { recursive: true })
  for (const role of roles) writeFileSync(join(dir, ".opencode", "agents", `${role}.md`), "# role")
  writeFileSync(join(dir, ".opencode", "commands", "graph-run.md"), "# run")
}

function fullRegistry(ctx: MockContext): void {
  ctx.registryAgents = [{ id: "graph-planner" }, { id: "graph-worker" }, { id: "graph-verifier" }]
  ctx.registryCommands = [{ name: "graph-run" }]
}

async function emitToolTurn(ctx: MockContext, sessionID: string, eventID: string): Promise<void> {
  const goalID = ctx.goal(sessionID)?.id
  await ctx.emit({
    id: `evt_in_${eventID}`,
    type: "session.inbox.enqueued",
    data: {
      sessionID,
      inboxID: `msg_${eventID}`,
      item: { type: "user", payload: { text: "continue", metadata: { goalContinuation: true, goalID } } },
    },
  } satisfies PluginEvent)
  await ctx.emit({ id: `evt_start_${eventID}`, type: "session.execution.started", data: { sessionID } })
  ctx.setMessages(sessionID, [
    userMessage("msg_cont", { goalContinuation: true, goalID }),
    assistantWithTool("msg_tool"),
  ])
  await ctx.emit({ id: eventID, type: "session.execution.succeeded", data: { sessionID } } satisfies PluginEvent)
}

describe("--graph flag parsing", () => {
  test("set with --graph captures the issue", () => {
    const cmd = parseGoalCommand("set Fix auth --graph 123")
    expect(cmd.kind).toBe("set")
    if (cmd.kind === "set") {
      expect(cmd.graph).toBe("123")
      expect(cmd.objective).toBe("Fix auth")
    }
  })

  test("bare set, --graph= form, bare --graph, and --no-graph", () => {
    const bare = parseGoalCommand("Fix auth --graph 7")
    expect(bare.kind).toBe("set")
    if (bare.kind === "set") {
      expect(bare.graph).toBe("7")
      expect(bare.objective).toBe("Fix auth")
    }
    const eq = parseGoalCommand("set Fix auth --graph=7")
    if (eq.kind === "set") expect(eq.graph).toBe("7")
    const flagOnly = parseGoalCommand("set Fix auth --graph")
    if (flagOnly.kind === "set") {
      expect(flagOnly.graph).toBe("")
      expect(flagOnly.objective).toBe("Fix auth")
    }
    const negated = parseGoalCommand("set Fix auth --graph 7 --no-graph")
    if (negated.kind === "set") {
      expect(negated.graph).toBeUndefined()
      expect(negated.objective).toBe("Fix auth")
    }
  })
})

describe("detectGraph", () => {
  test("full registry resolves without fs", async () => {
    const ctx = new MockContext()
    fullRegistry(ctx)
    const found = await detectGraph(ctx as never, DEFAULT_GRAPH_OPTIONS)
    expect(found.full).toBe(true)
    expect(found.present).toBe(true)
    expect(found.via).toBe("registry")
    expect(found.missing).toEqual([])
  })

  test("partial registry names the gap", async () => {
    const ctx = new MockContext()
    ctx.registryAgents = [{ id: "graph-planner" }]
    ctx.registryCommands = []
    const found = await detectGraph(ctx as never, DEFAULT_GRAPH_OPTIONS)
    expect(found.full).toBe(false)
    expect(found.present).toBe(true)
    expect(found.missing).toEqual(["graph-worker", "graph-verifier"])
  })

  test("absent registries and empty dir resolve absent", async () => {
    const ctx = new MockContext()
    const dir = mkdtempSync(join(tmpdir(), "goals-nograph-"))
    tmpDirs.push(dir)
    ctx.location.directory = dir
    const found = await detectGraph(ctx as never, DEFAULT_GRAPH_OPTIONS)
    expect(found.present).toBe(false)
    expect(found.via).toBe("none")
  })

  test("fs fallback finds repo graph files", async () => {
    const ctx = new MockContext()
    const dir = mkdtempSync(join(tmpdir(), "goals-graph-"))
    tmpDirs.push(dir)
    seedRepoGraph(dir, ["graph-planner", "graph-worker"])
    ctx.location.directory = dir
    const found = await detectGraph(ctx as never, DEFAULT_GRAPH_OPTIONS)
    expect(found.present).toBe(true)
    expect(found.full).toBe(false)
    expect(found.command).toBe(true)
    expect(found.missing).toEqual(["graph-verifier"])
  })

  test("mode off never detects", async () => {
    const ctx = new MockContext()
    fullRegistry(ctx)
    const found = await detectGraph(ctx as never, { ...DEFAULT_GRAPH_OPTIONS, mode: "off" })
    expect(found.present).toBe(false)
  })
})

describe("graph-mode goals", () => {
  test("graph opt-in without detection refuses and sets nothing", async () => {
    const ctx = new MockContext()
    await ctx.start()
    const dir = mkdtempSync(join(tmpdir(), "goals-nograph-"))
    tmpDirs.push(dir)
    ctx.location.directory = dir
    const result = await ctx.callTool(SID, "goal_set", { objective: "Ship it", graph: "123" })
    expect(result.content).toContain("no repo graph detected")
    expect(ctx.goal(SID)).toBeUndefined()
  })

  test("graph opt-in with detection starts the phase machine", async () => {
    const ctx = new MockContext()
    await ctx.start()
    fullRegistry(ctx)
    const result = await ctx.callTool(SID, "goal_set", { objective: "Ship it", graph: "123" })
    expect(result.content).toContain("set")
    const goal = ctx.goal(SID)
    expect(goal?.graph?.mode).toBe("graph")
    expect(goal?.graph?.phase).toBe("work") // kickoff prompt was plan; optimistic advance
    expect(goal?.graph?.runId).toContain("graph-123-")
    const prompts = ctx.promptsFor(SID)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.text).toContain("plan phase")
    expect(prompts[0]?.text).toContain("graph-planner")
    const system = await ctx.systemFor(SID)
    expect(system).toContain("ORCHESTRATOR")
  })

  test("continuations advance work → verify → publish with phase prompts", async () => {
    const ctx = new MockContext()
    await ctx.start()
    fullRegistry(ctx)
    await ctx.callTool(SID, "goal_set", { objective: "Ship it", graph: "123" })

    await emitToolTurn(ctx, SID, "g1")
    expect(ctx.goal(SID)?.graph?.phase).toBe("verify")
    await emitToolTurn(ctx, SID, "g2")
    expect(ctx.goal(SID)?.graph?.phase).toBe("publish")
    await emitToolTurn(ctx, SID, "g3")
    expect(ctx.goal(SID)?.graph?.phase).toBe("done")

    const texts = ctx.promptsFor(SID).map((p) => p.text)
    expect(texts).toHaveLength(4)
    expect(texts[1]).toContain("work phase")
    expect(texts[1]).toContain("graph-worker")
    expect(texts[2]).toContain("verify phase")
    expect(texts[2]).toContain("graph-verifier")
    expect(texts[3]).toContain("publish phase")
    expect(texts[3]).toContain("goal_complete")
  })

  test("partial graph proceeds with a missing-roles warning", async () => {
    const ctx = new MockContext()
    await ctx.start()
    ctx.registryAgents = [{ id: "graph-planner" }]
    ctx.registryCommands = [{ name: "graph-run" }]
    await ctx.callTool(SID, "goal_set", { objective: "Ship it", graph: "123" })
    expect(ctx.goal(SID)?.graph?.mode).toBe("graph")
    const warning = ctx.notices.map((n) => n.text).join("\n")
    expect(warning).toContain("partial roles")
    expect(warning).toContain("graph-worker")
  })

  test("loop goals keep the byte-identical default prompt", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set ship it")
    expect(ctx.goal(SID)?.graph).toBeUndefined()
    const prompts = ctx.promptsFor(SID)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.text).toBe(DEFAULT_CONTINUATION_PROMPT)
  })

  test("snapshot omits graph for loop goals, carries it for graph goals", async () => {
    const { toSnapshot } = await import("../src/rpc")
    const { createGoal } = await import("../src/state")
    const loop = createGoal({ sessionID: SID, objective: "loop" })
    expect("graph" in toSnapshot(loop)).toBe(false)

    const ctx = new MockContext()
    await ctx.start()
    fullRegistry(ctx)
    await ctx.callTool(SID, "goal_set", { objective: "Ship it", graph: "123" })
    const snapshot = toSnapshot(ctx.goal(SID)!) as Record<string, unknown>
    expect((snapshot.graph as { mode?: string })?.mode).toBe("graph")
    const roundTripped = JSON.parse(JSON.stringify({ goal: snapshot })) as {
      goal: { graph: { runId: string; phase: string } }
    }
    expect(roundTripped.goal.graph.phase).toBe("work")
  })
})
