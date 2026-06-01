---
description: 'Plan every unplanned incomplete task: fan out a subagent per task to draft a plan, gate each through plan-review, and associate approved plans back to the task. Trigger on "plan the tasks" or "plan the backlog".'
---

Batch-plan every task that lacks an approved plan. Where the `next` skill shepherds one task end-to-end, this skill pre-stages the planning queue: it finds tasks without a plan and fans out parallel subagents to draft one each, every draft gated through the same `plan-review` adversarial loop.

The parent (you) owns task discovery, filtering, concurrency, file paths, and every task metadata mutation. Subagents own drafting and review only. **Subagents do not write to the task database.** That keeps task metadata writes single-writer and predictable, and it keeps the run debuggable.

## Prerequisites

The `tasks` CLI must be on PATH with an initialized `tmp/tasks.db`. Run `tasks available` first to confirm the CLI works. If it is missing, surface the error and stop — do not invent a queue.

## Step 1: Discover the unplanned set

The CLI has a built-in `--unplanned` filter that returns tasks with no `plan` path set. Pick the scope:

| Scope               | Command                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| available (default) | `tasks list --incomplete --unplanned`                                                                          |
| `--all`             | `tasks list --unplanned` (broaden beyond the default available scope to include blocked and future-dated work) |

Run the appropriate command and parse the JSON. Build the unplanned list. If it is empty, report "no unplanned tasks" and stop.

> [!NOTE] Stale plan files
> A task returned by `--unplanned` has no `plan` path set, so it belongs in the set even if a stale `tmp/plans/<task-id>.md` lingers from a prior partial run. A capped-but-unassociated plan is correctly unplanned — no override needed.

## Step 2: Reserve plan paths

For each unplanned task, the plan path is `tmp/plans/<task-id>.md`. Create `tmp/plans/` if it does not exist. Overwriting a stale file for a genuinely unplanned task is allowed. Never overwrite a plan that belongs to a task the CLI considers planned.

## Step 3: Fan out parallel planning subagents

Default concurrency is **3**. Accept `--concurrency N` in the range `1..5`; hard-cap at 5.

For each batch (size = concurrency), dispatch one subagent per task in the batch in a **single message** so they run in parallel, using the `Agent` tool. Use the `general-purpose` subagent type unless a domain-specific one fits. After dispatching a batch, wait for every agent in it to return before dispatching the next.

Each subagent's prompt must:

- State the task id, title, description, and any existing partial plan content.
- Direct the agent to read the relevant code paths before drafting. Leave that reading to the agent so its context is purpose-built — the parent should not read the code.
- Require the agent to write the plan to `tmp/plans/<task-id>.md`.
- Require the agent to invoke the `plan-review` skill on the drafted plan and iterate to approval or the cap.
- Require the agent to return a structured result with exactly these fields:
  - `taskId`
  - `planPath`
  - `outcome`: one of `approved` | `capped` | `failed`
  - `notes` (short — what changed across rounds, or why it failed)

Subagents **must not** mutate task state. The parent associates plans after the agents return.

## Step 4: Associate approved plans

For each returned result, the parent acts on `outcome`:

- `approved`: run `tasks update <id> --plan tmp/plans/<id>.md`.
- `capped`: do **not** auto-associate. The plan exists on disk for inspection, but the task stays unplanned in the database. Surface the cap in the final report so the user can keep, revise, or re-run it.
- `failed`: leave the partial plan on disk, do not associate, and surface the failure reason.

If `--include-capped` is passed explicitly, treat `capped` like `approved`. Default behavior never silently promotes a capped plan.

## Step 5: Final report

Emit a compact summary bucketed by outcome. For each row, include task id and title:

- **Planned** (approved and associated)
- **Skipped — already planned** (filtered out at Step 1)
- **Skipped — capped review** (drafted, hit the cap, not associated)
- **Failed review** (drafted, plan-review failed, not associated)

## Gotchas

- **Cap is not approval.** `plan-review` emits an approval signal on both genuine approval and the 20-round cap. Distinguishing them is the subagent's job (via `outcome`). The parent must never associate a capped plan unless `--include-capped` is set.
- **Subagents do not mutate task state.** Every `tasks update --plan` call happens at the parent level after agents complete. No exceptions.
- **Concurrency above 5 is not a feature.** Each subagent runs its own plan-review loop (up to 20 rounds). At concurrency 5 the worst case is 100 review rounds in flight. Higher turns the run into an opaque batch job.
- **One subagent call per task per batch, in a single message.** That is the only way they run in parallel. Sending agents serially across messages defeats the point.
- **If the unplanned set is huge** (50+ tasks), warn the user and confirm scope before dispatching the full batch.
- **If a subagent returns prose instead of a structured result**, do not guess the outcome — record it as `failed` and surface the malformed return.

## Done criteria

A run is complete when the unplanned set was computed, every task was dispatched in a concurrency-bounded batch, every returned result was bucketed (`approved` associated, `capped` and `failed` reported), and the final report was emitted. This skill never opens PRs and never moves tasks past `ready`. Its only output is plan files on disk, `--plan` references in the database, and a report.
