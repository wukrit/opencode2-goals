import { describe, expect, test } from "bun:test"
import { MockContext } from "./harness"

const SID = "ses_test_tasks_1"

describe("goal tasks + widget bridge", () => {
  test("tasks start empty and survive reload", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set ship it")
    expect(ctx.goal(SID)?.tasks).toEqual([])

    const reloaded = new MockContext({}, ctx.store)
    await reloaded.start()
    expect(reloaded.goal(SID)?.tasks).toEqual([])
  })

  test("old records without tasks normalize to []", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set ship it")
    const raw = ctx.store.get(`goal/${SID}`) as Record<string, unknown>
    delete raw.tasks
    ctx.store.set(`goal/${SID}`, raw)

    await ctx.runGoal(SID, "view")
    // View must not crash and the record normalizes on next load.
    expect(ctx.notices.length).toBeGreaterThan(0)
    const goal = ctx.goal(SID)
    expect(Array.isArray(goal?.tasks)).toBe(true)
  })

  test("/goal task add + update by number", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set ship it")
    await ctx.runGoal(SID, "task add Write tests")
    await ctx.runGoal(SID, "task add Update docs")
    expect(ctx.goal(SID)?.tasks).toHaveLength(2)

    await ctx.runGoal(SID, "task 1 doing")
    expect(ctx.goal(SID)?.tasks[0]?.status).toBe("doing")
    await ctx.runGoal(SID, "task done 2")
    expect(ctx.goal(SID)?.tasks[1]?.status).toBe("done")

    await ctx.runGoal(SID, "view")
    const last = ctx.notices[ctx.notices.length - 1]?.text ?? ""
    expect(last).toContain("1/2 done")
    expect(last).toContain("Write tests")
  })

  test("model tools add and update tasks", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set ship it")
    const added = await ctx.callTool(SID, "goal_add_task", { title: "Wire widget" })
    expect(added.content).toContain("added")
    const id = ctx.goal(SID)?.tasks[0]?.id ?? ""
    expect(id.length).toBeGreaterThan(0)

    const updated = await ctx.callTool(SID, "goal_update_task", { ref: "1", status: "doing" })
    expect(updated.content).toContain("doing")
    expect(ctx.goal(SID)?.tasks[0]?.status).toBe("doing")

    const bad = await ctx.callTool(SID, "goal_update_task", { ref: "99", status: "done" })
    expect(bad.content).toContain("no such task")
  })

  test("every save emits an RPC updated event and get returns a snapshot", async () => {
    const ctx = new MockContext()
    await ctx.start()
    expect(ctx.rpcHandlers?.get).toBeDefined()
    await ctx.runGoal(SID, "set ship it")
    await ctx.runGoal(SID, "task add First")
    const updates = ctx.rpcEvents.filter((e) => e.event === "updated")
    expect(updates.length).toBeGreaterThanOrEqual(2)

    const get = ctx.rpcHandlers?.["get"]
    expect(get).toBeDefined()
    const result = (await get!({ sessionID: SID } as never, {} as never)) as {
      goal?: { objective?: string; tasks?: unknown[] }
    }
    expect(result.goal?.objective).toBe("ship it")
    expect(result.goal?.tasks).toHaveLength(1)
  })

  test("snapshot omits unset optionals so host output validation passes", async () => {
    const { toSnapshot } = await import("../src/rpc")
    const { createGoal } = await import("../src/state")
    const goal = createGoal({ sessionID: SID, objective: "ship it" })
    const snapshot = toSnapshot(goal) as Record<string, unknown>
    // The live host rejects `undefined` for string fields (observed L20:
    // `rpc.invalid_output` at ["goal"]["evidence"]). Unset optionals must be
    // absent, not present-with-undefined.
    expect("evidence" in snapshot).toBe(false)
    expect("blocker" in snapshot).toBe(false)
    expect("outcome" in snapshot).toBe(false)
    // JSON round-trip (what the host validates) keeps required fields + tasks.
    const roundTripped = JSON.parse(JSON.stringify({ goal: snapshot })) as {
      goal: { sessionID: string; objective: string; status: string; tasks: unknown[] }
    }
    expect(roundTripped.goal.sessionID).toBe(SID)
    expect(roundTripped.goal.tasks).toEqual([])
  })
})

describe("goal task DAG (depends / acceptance / verify / blocked)", () => {
  test("tool add records DAG fields; unknown deps rejected", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set ship it")
    const first = await ctx.callTool(SID, "goal_add_task", { title: "N1 schema" })
    expect(first.content).toContain("added")
    const second = await ctx.callTool(SID, "goal_add_task", {
      title: "N2 migrate",
      depends: "1",
      acceptance: "migration applies cleanly",
      verify: "bun test migrate",
    })
    expect(second.content).toContain("added")
    const tasks = ctx.goal(SID)?.tasks ?? []
    expect(tasks[1]?.depends).toHaveLength(1)
    expect(tasks[1]?.depends[0]).toBe(tasks[0]?.id)
    expect(tasks[1]?.acceptance).toBe("migration applies cleanly")
    expect(tasks[1]?.verify).toBe("bun test migrate")

    const bad = await ctx.callTool(SID, "goal_add_task", { title: "N3 bad", depends: "99" })
    expect(bad.content).toContain("no such task")
    expect(ctx.goal(SID)?.tasks).toHaveLength(2)
  })

  test("doing/done require deps done; blocked takes a note, done takes evidence", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set ship it")
    await ctx.callTool(SID, "goal_add_task", { title: "N1" })
    await ctx.callTool(SID, "goal_add_task", { title: "N2", depends: "1" })

    const early = await ctx.callTool(SID, "goal_update_task", { ref: "2", status: "doing" })
    expect(early.content).toContain("waits on 1")
    expect(ctx.goal(SID)?.tasks[1]?.status).toBe("todo")

    const blocked = await ctx.callTool(SID, "goal_update_task", { ref: "2", status: "blocked", note: "waiting on creds" })
    expect(blocked.content).toContain("blocked")
    expect(ctx.goal(SID)?.tasks[1]?.note).toBe("waiting on creds")

    await ctx.callTool(SID, "goal_update_task", { ref: "1", status: "done" })
    const late = await ctx.callTool(SID, "goal_update_task", {
      ref: "2",
      status: "done",
      evidence: "migration green in build/log.txt",
    })
    expect(late.content).toContain("done")
    expect(ctx.goal(SID)?.tasks[1]?.evidence).toBe("migration green in build/log.txt")
  })

  test("/goal task add flags + view renders deps, fields, parallel groups", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set ship it")
    await ctx.runGoal(SID, 'task add N1 schema --verify "bun test schema"')
    await ctx.runGoal(SID, 'task add N2 migrate --depends 1 --acceptance "applies cleanly"')
    await ctx.runGoal(SID, "task add N3 docs")
    await ctx.runGoal(SID, "task 3 blocked")

    await ctx.runGoal(SID, "view")
    const last = ctx.notices[ctx.notices.length - 1]?.text ?? ""
    expect(last).toContain("← after 1")
    expect(last).toContain("acceptance: applies cleanly")
    expect(last).toContain("verify: bun test schema")
    expect(last).toContain("[!] N3 docs")
    expect(last).toContain("1 blocked")
    // N1 and N3 share level 0 with no edge between them.
    expect(last).toContain("Parallel groups: {1,3}")
  })

  test("old tasks without DAG fields normalize to depends: []", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set ship it")
    await ctx.runGoal(SID, "task add Legacy")
    const raw = ctx.store.get(`goal/${SID}`) as { tasks: Record<string, unknown>[] }
    delete raw.tasks[0]!.depends
    delete raw.tasks[0]!.acceptance
    ctx.store.set(`goal/${SID}`, raw)

    await ctx.runGoal(SID, "view")
    const goal = ctx.goal(SID)
    expect(goal?.tasks[0]?.depends).toEqual([])
    await ctx.runGoal(SID, "task 1 doing")
    expect(ctx.goal(SID)?.tasks[0]?.status).toBe("doing")
  })

  test("past seven nodes warns without rejecting", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set ship it")
    for (let i = 1; i <= 7; i++) {
      const added = await ctx.callTool(SID, "goal_add_task", { title: `N${i}` })
      expect(added.content).not.toContain("splitting")
    }
    const eighth = await ctx.callTool(SID, "goal_add_task", { title: "N8" })
    expect(eighth.content).toContain("splitting this run")
    expect(ctx.goal(SID)?.tasks).toHaveLength(8)
  })
})

describe("graph.ts pure helpers", () => {
  test("validateDepends rejects self, unknown, and cycles", async () => {
    const { validateDepends } = await import("../src/graph")
    const mk = (id: string, depends: string[] = []) => ({
      id,
      title: id,
      status: "todo" as const,
      createdAt: 0,
      updatedAt: 0,
      depends,
    })
    const tasks = [mk("a", ["b"]), mk("b")]
    expect(validateDepends(tasks, "c", ["a"])).toBeUndefined()
    expect(validateDepends(tasks, "a", ["a"])).toContain("itself")
    expect(validateDepends(tasks, "c", ["zzz"])).toContain("no such task")
    // Synthetic cycle a→b→a (unreachable via add-only deps, guarded anyway).
    const cyclic = [mk("a", ["b"]), mk("b", ["a"])]
    expect(validateDepends(cyclic, "c", ["a"])).toContain("cycle")
  })

  test("readyTasks and parallelGroups derive from done state", async () => {
    const { readyTasks, parallelGroups } = await import("../src/graph")
    const mk = (id: string, status: "todo" | "done", depends: string[] = []) => ({
      id,
      title: id,
      status,
      createdAt: 0,
      updatedAt: 0,
      depends,
    })
    const tasks = [mk("a", "todo"), mk("b", "todo", ["a"]), mk("c", "todo")]
    expect(readyTasks(tasks).map((t) => t.id).sort()).toEqual(["a", "c"])
    expect(parallelGroups(tasks)).toEqual([["a", "c"]])
    const advanced = [mk("a", "done"), mk("b", "todo", ["a"]), mk("c", "todo")]
    expect(readyTasks(advanced).map((t) => t.id).sort()).toEqual(["b", "c"])
  })
})
