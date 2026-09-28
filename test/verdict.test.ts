import { afterEach, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { assistantWithTool, MockContext, userMessage } from "./harness"
import { parseVerdict } from "../src/verdict"

const SID = "ses_test_verdict_1"
const tmpDirs: string[] = []
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

const PASS_VERDICT = `# Verdict — graph-123-abc
verdict: pass
gate: pnpm verify — 42 passed, 0 failed
checklist: 5 pass, 1 skip

## Findings

### P1 — must fix before PR
- No findings.

### P2 — should fix
- src/tui.tsx:12 — muted suffix could be dimmer — cosmetic

### P3 — notes
- none

## Node acceptance
- N1: proven by commit a1b2c3 + bun test schema green
- N2: proven by commit d4e5f6 + migration applies cleanly

## Not verified
- none
`

function fullRegistry(ctx: MockContext): void {
  ctx.registryAgents = [{ id: "graph-planner" }, { id: "graph-worker" }, { id: "graph-verifier" }]
  ctx.registryCommands = [{ name: "graph-run" }]
}

/** Graph-mode goal with the session dir pointed at tmp; returns the run id. */
async function graphGoal(ctx: MockContext, sessionID: string): Promise<string> {
  fullRegistry(ctx)
  await ctx.callTool(sessionID, "goal_set", { objective: "Ship it", graph: "123" })
  const runId = ctx.goal(sessionID)?.graph?.runId ?? ""
  expect(runId).toContain("graph-123-")
  return runId
}

function writeVerdict(dir: string, runId: string, body: string): string {
  const runDir = join(dir, ".opencode", "runs", runId)
  mkdirSync(runDir, { recursive: true })
  const file = join(runDir, "verdict.md")
  writeFileSync(file, body)
  return file
}

/** Transcript grounding for the verdict path + gate tokens. */
function groundVerdict(ctx: MockContext, sessionID: string, runId: string, extra = ""): void {
  ctx.setMessages(sessionID, [
    userMessage("m1", {}),
    {
      id: "m2",
      type: "assistant",
      content: [
        {
          type: "text",
          text: `verifier wrote .opencode/runs/${runId}/verdict.md with verdict pass, gate pnpm verify 42 passed ${extra}`,
        },
      ],
    },
    assistantWithTool("m3"),
  ])
}

describe("parseVerdict", () => {
  test("full pass template parses", () => {
    const parsed = parseVerdict(PASS_VERDICT)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.verdict).toBe("pass")
    expect(parsed.gateGreen).toBe(true)
    expect(parsed.p1).toBe(0)
    expect(parsed.p2).toBe(1)
    expect(parsed.unproven).toEqual([])
  })

  test("fail verdict, red gate, P1 items, unproven nodes", () => {
    const parsed = parseVerdict(`# Verdict — x
verdict: FAIL
gate: pnpm verify — 3 passed, 1 failed

## Findings
### P1 — must fix
- a.ts:1 — bad — breaks prod
- b.ts:2 — worse — breaks staging

## Node acceptance
- N1: proven by commit abc
- N2: not proven (missing gate output)
`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.verdict).toBe("fail")
    expect(parsed.gateGreen).toBe(false)
    expect(parsed.p1).toBe(2)
    expect(parsed.unproven).toEqual(["N2"])
  })

  test("missing verdict, gate, or node-acceptance lines are parse errors", () => {
    expect(parseVerdict("gate: pnpm verify pass\n## Node acceptance\n- N1: proven by x\n").ok).toBe(false)
    expect(parseVerdict("verdict: pass\n## Node acceptance\n- N1: proven by x\n").ok).toBe(false)
    expect(parseVerdict("verdict: pass\ngate: pnpm verify pass\n").ok).toBe(false)
    expect(parseVerdict("verdict: pass\ngate: pnpm verify pass\n## Node acceptance\n").ok).toBe(false)
  })

  test("gate green/red token matrix", () => {
    const gate = (g: string) =>
      parseVerdict(`verdict: pass\ngate: ${g}\n## Node acceptance\n- N1: proven by x\n`)
    const green = (g: string) => {
      const p = gate(g)
      expect(p.ok).toBe(true)
      if (p.ok) expect(p.gateGreen).toBe(true)
    }
    const red = (g: string) => {
      const p = gate(g)
      expect(p.ok).toBe(true)
      if (p.ok) expect(p.gateGreen).toBe(false)
    }
    green("pnpm verify — exit 0")
    green("42 passed, suite ok")
    red("3 passed, 1 failed")
    red("exit 1")
    red("error: connection refused")
  })
})

describe("graph-mode completion gating", () => {
  test("pass verdict completes the graph goal", async () => {
    const ctx = new MockContext()
    await ctx.start()
    const dir = mkdtempSync(join(tmpdir(), "goals-vpass-"))
    tmpDirs.push(dir)
    ctx.setSessionDirectory(SID, dir)
    const runId = await graphGoal(ctx, SID)
    writeVerdict(dir, runId, PASS_VERDICT)
    groundVerdict(ctx, SID, runId)

    const done = await ctx.callTool(SID, "goal_complete", {
      evidence: `verdict pass in .opencode/runs/${runId}/verdict.md, gate pnpm verify 42 passed, P1 count 0`,
    })
    expect(done.content).toContain("completed")
    expect(done.content).not.toContain("unverified")
    expect(ctx.goal(SID)?.status).toBe("completed")
  })

  test("P1 findings, red gate, and unproven nodes each reject specifically", async () => {
    const cases: Array<{ name: string; body: string; match: RegExp }> = [
      {
        name: "p1",
        body: PASS_VERDICT.replace("- No findings.", "- a.ts:1 — bad — breaks prod"),
        match: /P1 count 1/,
      },
      {
        name: "gate",
        body: PASS_VERDICT.replace("42 passed, 0 failed", "3 passed, 1 failed"),
        match: /gate is red/,
      },
      {
        name: "unproven",
        body: PASS_VERDICT.replace("- N2: proven by commit d4e5f6 + migration applies cleanly", "- N2: not proven (no output)"),
        match: /N2/,
      },
      {
        name: "fail",
        body: PASS_VERDICT.replace("verdict: pass", "verdict: fail"),
        match: /verdict is fail/,
      },
    ]
    for (const c of cases) {
      const ctx = new MockContext()
      await ctx.start()
      const dir = mkdtempSync(join(tmpdir(), `goals-v${c.name}-`))
      tmpDirs.push(dir)
      ctx.setSessionDirectory(SID, dir)
      const runId = await graphGoal(ctx, SID)
      writeVerdict(dir, runId, c.body)
      groundVerdict(ctx, SID, runId)
      const done = await ctx.callTool(SID, "goal_complete", {
        evidence: `verdict in .opencode/runs/${runId}/verdict.md, gate pnpm verify, P1 review`,
      })
      expect(done.content).toMatch(c.match)
      expect(ctx.goal(SID)?.status).toBe("active")
    }
  })

  test("mismatched run id and outside-dir paths reject", async () => {
    const ctx = new MockContext()
    await ctx.start()
    const dir = mkdtempSync(join(tmpdir(), "goals-vrun-"))
    tmpDirs.push(dir)
    ctx.setSessionDirectory(SID, dir)
    const runId = await graphGoal(ctx, SID)
    writeVerdict(dir, runId, PASS_VERDICT)
    groundVerdict(ctx, SID, runId)

    const wrong = await ctx.callTool(SID, "goal_complete", {
      evidence: "verdict pass in .opencode/runs/graph-999-other/verdict.md, gate pnpm verify 42 passed",
    })
    expect(wrong.content).toContain(runId)
    expect(ctx.goal(SID)?.status).toBe("active")

    const outside = await ctx.callTool(SID, "goal_complete", {
      evidence: `verdict pass in /tmp/elsewhere/${runId}/verdict.md, gate pnpm verify 42 passed`,
    })
    expect(outside.content).toContain("outside the session working directory")
    expect(ctx.goal(SID)?.status).toBe("active")
  })

  test("unreadable verdict falls back to attested with an explicit tag", async () => {
    const ctx = new MockContext()
    await ctx.start()
    const dir = mkdtempSync(join(tmpdir(), "goals-vmissing-"))
    tmpDirs.push(dir)
    ctx.setSessionDirectory(SID, dir)
    const runId = await graphGoal(ctx, SID)
    groundVerdict(ctx, SID, runId) // no file written

    const done = await ctx.callTool(SID, "goal_complete", {
      evidence: `verdict pass in .opencode/runs/${runId}/verdict.md, gate pnpm verify 42 passed, P1 count 0`,
    })
    expect(done.content).toContain("completed")
    expect(done.content).toContain("unverified")
    expect(ctx.goal(SID)?.status).toBe("completed")
  })

  test("loop goals ignore the graph gate entirely", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set ship it")
    ctx.setMessages(SID, [
      userMessage("m1", {}),
      { id: "m2", type: "assistant", content: [{ type: "text", text: "created phase1.txt and verified output in build" }] },
    ])
    const done = await ctx.callTool(SID, "goal_complete", {
      evidence: "created phase1.txt and verified output in build",
    })
    expect(done.content).toContain("completed")
  })
})
