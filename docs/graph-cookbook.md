# Graph cookbook

How to run a multi-agent graph through the goals plugin — and when not to.
The runtime pieces live in issues
[#4](https://github.com/wukrit/opencode2-goals/issues/4) (orchestrator),
[#5](https://github.com/wukrit/opencode2-goals/issues/5) (DAG tasks),
[#6](https://github.com/wukrit/opencode2-goals/issues/6) (verdict gate), and
[#7](https://github.com/wukrit/opencode2-goals/issues/7) (failure policy).
This file is the human-facing convention: the decision rule, the lifecycle,
and the fallback for repos without a predefined graph.

## Loop vs graph

Reach for a **loop** (plain `/goal set`) for single-file fixes, exploratory
spikes, and docs tweaks — anything one context can hold and self-check.

Reach for a **graph** (`/goal set --graph <issue>`) when an issue has a plan,
spans multiple packages, and benefits from independent verification. The three
tells that a loop has hit its ceiling:

1. The same agent would do the work *and* review it.
2. Independent checks would otherwise run one after another.
3. You cannot explain what happened without reading the whole transcript.

A loop is a node in a graph. The graph only adds what loops lack: clean
contexts per role, file-backed handoffs, and explicit routing.

## Run lifecycle

```
/goal set --graph <issue>
  │  refusal when no repo graph is detected (never a silent downgrade)
  ▼
plan      planner role → .opencode/runs/<run-id>/graph.md
  │  present ≤12 lines: nodes, parallel groups, files, risks
  │  ambiguity / strategy conflict → goal_block, no guessing
  ▼
work      worker role → executes graph.md, one commit per node
  │  → .opencode/runs/<run-id>/report.md (commits + evidence + gate)
  ▼
verify    verifier role → own gate run, checklist, P1/P2/P3
  │  → .opencode/runs/<run-id>/verdict.md (verdict + gate + acceptance)
  ▼
remediate (at most once) worker requeued with P1/P2 findings only
  │  second failure → stop, branch + artifacts left in place
  ▼
publish   PR opened/updated (never merged by agents) → goal_complete
          with the verdict path + gate result as evidence
```

Edges are files: `graph.md` is the worker's only work order; `report.md` +
the git diff are the verifier's inputs. Nothing trusts a chat summary.
Anything that must outlive the run is committed (code, plans) or summarized
on the issue/PR. Run directories are ephemeral and gitignored.

## Knowledge-graph convention

Files nothing points at are unreachable — to the model and to newcomers.
The fix is linkage plus a discipline, not a plugin feature:

- **Read before, append after.** In graph mode, read the repo's `MAP.md` /
  `graph.md` / linked plan (when present) before planning; append what you
  learned — artifact paths, decisions, follow-ups — to the run artifacts when
  each phase finishes. `goal_history()` is the cross-goal memory; plugin
  storage holds pointers and counters; **repo files hold knowledge**.
- **FOUND vs GUESSED.** When writing linkage, mark every connection: FOUND
  means both files state it, GUESSED means inferred. Never present a guess
  as a find.
- **One domain per folder.** Split folders the way the work divides (not by
  file type). Each folder that owns a job carries its own instructions; the
  model opens the folder and already knows the job.
- **What belongs where:** code and plans are committed; run artifacts
  (`.opencode/runs/`) are gitignored traces; decisions are summarized on the
  issue/PR. Findings live in artifacts and the PR — never chat-only.

No MAP.md generator ships with the plugin — that is deliberately out of
scope. The convention above is the whole feature.

## Fallback triple (repos with no predefined graph)

No `.opencode/agents/graph-*.md`? Use stock roles with the same contracts.
The orchestrator delegates through the Task tool exactly as with repo roles;
only the names change. Docs-first: bundle role files only after two real
dogfood runs prove the need.

**Planner** (`@explore`-style, read-only):

```text
You are the planner: issue + repo → work graph. Read-only — never write
product code, never commit. Produce nodes as outcomes with acceptance
criteria (not activities), ordering-only edges, files touched and verify
commands per node, ≤7 nodes, parallelism notes, Out-of-graph follow-ups,
and Risks/ambiguities. Never guess; flag ambiguity for escalation.
```

**Worker** (`@general`-style, full access):

```text
You are the worker: execute the approved work graph node by node on one
feature branch, one commit per node (conventional style, issue reference).
Run the gate before reporting; fix failures before reporting. If a node is
impossible — wrong plan, decision needed, human-only boundary — stop, leave
the branch at the last green node, and report the blocker. Never open PRs.
```

**Verifier** (read-only + gate):

```text
You are the verifier: an independent check, not a second worker. Re-derive
truth from artifacts and your own gate run — never from the worker's
summary. Report P1 (must fix) / P2 (should fix) / P3 (notes) plus per-node
proven-or-not acceptance. Missing evidence is fail, not "probably fine".
You do not fix code; you report.
```

Permission shapes mirror the repo frontmatter: planner/verifier deny edits,
the worker is scoped to the session directory. The plugin's permission
sandbox covers the parent session; child-session scoping is a live-host
verification item (see issue #4).

## Tuning

- **Models:** all roles inherit the parent session's model by default. Pin
  per role — planner on a frontier model, worker on a cheap one — via the
  role frontmatter (`model: <provider>/<id>`; see `opencode models`).
- **More nodes:** add a role only for a genuinely separate zone (e.g. a
  DB-migration specialist). Keep ≤5 roles — every node and edge is a failure
  surface.
- **Serial by default.** Parallel workers are not in the starter; the safe
  upgrade is one git worktree per node, merged through the verifier.
- **Deliberately excluded:** dynamic node spawning, auto-filing issues, cron
  automation. Add them only when a run proves the need.

## Claude Code port

The same role prompts work under `.claude/agents/`; only the frontmatter
shape differs (`description` + `mode: subagent` equivalents per Claude Code's
agent format). The lifecycle, artifact contract, and failure policy transfer
unchanged.
