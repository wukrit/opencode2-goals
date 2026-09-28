import { afterEach, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { assistantText, assistantWithTool, MockContext, userMessage } from "./harness"
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

describe("routeGraphSignal (pure)", () => {
  const base = {
    mode: "graph" as const,
    runId: "graph-123-abc",
    issue: "123",
    phase: "verify" as const,
    remediationsUsed: 0,
    agents: ["graph-planner", "graph-worker", "graph-verifier"],
  }
  const passVerdict = {
    ok: true as const,
    verdict: "pass" as const,
    gate: "pnpm verify — exit 0",
    gateGreen: true,
    p1: 0,
    p2: 1,
    p3: 0,
    unproven: [] as string[],
  }

  test("pass routes to publish; fail routes to remediate then stops", async () => {
    const { routeGraphSignal } = await import("../src/graph")
    const pass = routeGraphSignal(base, { kind: "verdict", verdict: passVerdict, path: "v.md" }, 1)
    expect(pass.next).toBe("publish")
    expect(pass.remediate).toBe(false)
    expect(pass.block).toBeUndefined()

    const fail = routeGraphSignal(
      base,
      { kind: "verdict", verdict: { ...passVerdict, verdict: "fail", p1: 2 }, path: "v.md" },
      1,
    )
    expect(fail.next).toBe("remediate")
    expect(fail.remediate).toBe(true)
    expect(fail.notice).toContain("1/1")

    const spent = routeGraphSignal({ ...base, remediationsUsed: 1 }, { kind: "verdict", verdict: { ...passVerdict, verdict: "fail", p1: 2 }, path: "v.md" }, 1)
    expect(spent.next).toBe("done")
    expect(spent.block).toContain("remediation(s)")
    expect(spent.notice).toContain("left in place")

    const strict = routeGraphSignal(base, { kind: "verdict", verdict: { ...passVerdict, verdict: "fail" }, path: "v.md" }, 0)
    expect(strict.block).toBeDefined()
  })

  test("blocked workers and ambiguity stop without spending budget", async () => {
    const { routeGraphSignal } = await import("../src/graph")
    const blocked = routeGraphSignal(base, { kind: "workerBlocked", reason: "Railway dashboard needed" }, 1)
    expect(blocked.block).toBe("Railway dashboard needed")
    expect(blocked.notice).toContain("last green node")

    const ambiguous = routeGraphSignal(base, { kind: "ambiguous", detail: "plan is ambiguous" }, 1)
    expect(ambiguous.block).toBe("plan is ambiguous")
    expect(ambiguous.notice).toContain("ambiguity")
  })
})

describe("failure-policy routing through real setup()", () => {
  const verdictBody = (verdict: string, gate: string, p1: string, nodes: string): string =>
    `# Verdict — run\nverdict: ${verdict}\ngate: ${gate}\n\n## Findings\n\n### P1 — must fix\n${p1}\n\n## Node acceptance\n${nodes}\n`

  const PASS = verdictBody("pass", "pnpm verify — exit 0", "- No findings.", "- N1: proven by commit abc")
  const FAIL = verdictBody(
    "fail",
    "pnpm verify — 1 failed",
    "- a.ts:1 — bad — breaks prod",
    "- N1: proven by commit abc\n- N2: not proven (no output)",
  )

  async function routedCtx(sessionID: string): Promise<{ ctx: MockContext; dir: string; runId: string }> {
    const ctx = new MockContext()
    await ctx.start()
    fullRegistry(ctx)
    const dir = mkdtempSync(join(tmpdir(), "goals-route-"))
    tmpDirs.push(dir)
    ctx.setSessionDirectory(sessionID, dir)
    await ctx.callTool(sessionID, "goal_set", { objective: "Ship it", graph: "123" })
    const runId = ctx.goal(sessionID)?.graph?.runId ?? ""
    // Advance plan → work → verify with tool-calling turns.
    await emitToolTurn(ctx, sessionID, `${sessionID}-w`)
    expect(ctx.goal(sessionID)?.graph?.phase).toBe("verify")
    return { ctx, dir, runId }
  }

  function writeVerdict(dir: string, runId: string, body: string): void {
    const runDir = join(dir, ".opencode", "runs", runId)
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, "verdict.md"), body)
  }

  async function emitTextTurn(ctx: MockContext, sessionID: string, eventID: string, text: string): Promise<void> {
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
      assistantText("msg_text", text),
    ])
    await ctx.emit({ id: eventID, type: "session.execution.succeeded", data: { sessionID } } satisfies PluginEvent)
  }

  test("pass verdict routes to the publish prompt", async () => {
    const { ctx, dir, runId } = await routedCtx("ses_route_pass")
    writeVerdict(dir, runId, PASS)
    await emitToolTurn(ctx, "ses_route_pass", "ses_route_pass-v")
    expect(ctx.goal("ses_route_pass")?.status).toBe("active")
    expect(ctx.goal("ses_route_pass")?.graph?.phase).toBe("done")
    expect(ctx.goal("ses_route_pass")?.graph?.lastVerdict).toContain("pass")
    const texts = ctx.promptsFor("ses_route_pass").map((p) => p.text)
    expect(texts[texts.length - 1]).toContain("publish phase")
    const notices = ctx.notices.map((n) => n.text).join("\n")
    expect(notices).toContain("verdict pass")
  })

  test("fail remediates once, then blocks with both verdicts named", async () => {
    const { ctx, dir, runId } = await routedCtx("ses_route_fail")
    writeVerdict(dir, runId, FAIL)
    await emitToolTurn(ctx, "ses_route_fail", "ses_route_fail-v1")
    expect(ctx.goal("ses_route_fail")?.graph?.remediationsUsed).toBe(1)
    expect(ctx.goal("ses_route_fail")?.graph?.phase).toBe("verify")
    const remediation = ctx.promptsFor("ses_route_fail").map((p) => p.text).pop() ?? ""
    expect(remediation).toContain("remediation phase")

    writeVerdict(dir, runId, FAIL)
    await emitToolTurn(ctx, "ses_route_fail", "ses_route_fail-v2")
    const goal = ctx.goal("ses_route_fail")
    expect(goal?.status).toBe("blocked")
    expect(goal?.blocker).toContain("remediation(s)")
    const stopNotice = ctx.notices[ctx.notices.length - 1]?.text ?? ""
    expect(stopNotice).toContain(runId)
    expect(stopNotice).toContain("left in place")

    // No third attempt: another terminal event changes nothing.
    const promptsBefore = ctx.promptsFor("ses_route_fail").length
    await emitToolTurn(ctx, "ses_route_fail", "ses_route_fail-v3")
    expect(ctx.promptsFor("ses_route_fail")).toHaveLength(promptsBefore)
    expect(ctx.goal("ses_route_fail")?.status).toBe("blocked")
  })

  test("worker-blocked text stops the run without spending budget", async () => {
    const { ctx } = await routedCtx("ses_route_blocked")
    await emitTextTurn(ctx, "ses_route_blocked", "ses_route_blocked-b", "BLOCKED: Railway dashboard needed for DNS")
    const goal = ctx.goal("ses_route_blocked")
    expect(goal?.status).toBe("blocked")
    expect(goal?.blocker).toContain("Railway dashboard")
    expect(goal?.graph?.remediationsUsed).toBe(0)
  })

  test("ambiguity text escalates instead of retrying", async () => {
    const { ctx } = await routedCtx("ses_route_amb")
    await emitTextTurn(ctx, "ses_route_amb", "ses_route_amb-a", "the plan is ambiguous here, needs human decision")
    const goal = ctx.goal("ses_route_amb")
    expect(goal?.status).toBe("blocked")
    expect(goal?.blocker).toContain("ambiguous")
    const notice = ctx.notices[ctx.notices.length - 1]?.text ?? ""
    expect(notice).toContain("ambiguity")
  })

  test("cap hit mid-graph reports budget_limited, never blocked", async () => {
    const ctx = new MockContext()
    await ctx.start()
    fullRegistry(ctx)
    const dir = mkdtempSync(join(tmpdir(), "goals-routecap-"))
    tmpDirs.push(dir)
    ctx.setSessionDirectory("ses_route_cap", dir)
    await ctx.callTool("ses_route_cap", "goal_set", { objective: "Ship it", graph: "123", turns: 1 })
    await emitToolTurn(ctx, "ses_route_cap", "ses_route_cap-1")
    expect(ctx.goal("ses_route_cap")?.status).toBe("budget_limited")
    expect(ctx.goal("ses_route_cap")?.outcome).toBe("budget_limited")
  })
})
