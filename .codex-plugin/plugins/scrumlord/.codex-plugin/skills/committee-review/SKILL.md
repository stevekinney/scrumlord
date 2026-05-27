---
name: committee-review
description: Gate PR creation behind a multi-agent review loop: discover subagents, parallel-review the diff, implement feedback, loop until consensus, then open the PR. Trigger on "open a PR", "create a pull request", or "submit for review".
---

This skill interposes a multi-agent review committee between "code is ready" and "PR is open." The goal is to catch issues across multiple dimensions — architecture, testing, types, UX, simplicity, developer experience — before the PR ever reaches a human reviewer. The plugin's Stop hook drives the review loop: after each round of review and implementation, write the loop state file and stop, and the hook feeds the same prompt back until the committee reaches consensus or the iteration cap is hit.

## Preconditions

Requires a GitHub remote. At startup:

```bash
git rev-parse --is-inside-work-tree 2>/dev/null || { echo "Not a git repository."; exit 1; }
git remote get-url origin 2>/dev/null || { echo "No GitHub remote configured. Codex can still review the diff — run the committee and implement feedback. The PR step will be skipped. Add a remote and resume when ready."; }
gh repo view >/dev/null 2>&1 || { echo "Remote is not a GitHub repo gh can access."; }
```

If no remote exists: still run the full review committee and implement all feedback. Skip the `gh pr create` finale and record progress: `tasks progress add current --message "Committee review complete; no GitHub remote — PR creation skipped. Re-run after 'gh repo create'."`. The committee approval is already recorded in `tmp/committee-state.md`.

## Gotchas

- **Do not open the PR until consensus is reached.** `gh pr create` happens at the end, not the beginning.
- **Project-level agents take priority over user-level agents when both cover the same domain.** A project's `testing-expert` knows the project's test conventions better than the generic one.
- **Not every agent is relevant to every PR.** Be selective — a bloated committee wastes time and produces noise. But err on the side of including an agent if there's any doubt.
- **Agents may contradict each other.** Pick the simpler option. If simplicity-engineer conflicts with another agent, side with simplicity-engineer. Do not ask the user.
- **The approval marker and `gh pr create` MUST be separate Bash tool calls.** A PreToolUse hook checks for the marker file _before_ the command runs. If you combine them in a single Bash call, the marker won't exist when the hook checks and PR creation will be blocked.
- **Codex is a mandatory committee member.** It runs via the `mcp__codex__codex` MCP tool, dispatched in the same turn as the subagent committee. If Codex is unreachable, errors, or times out, log to `tmp/committee-state.md` under `## Codex Unavailable`, surface a warning in the PR body, and proceed — Codex failure is fail-warn and never blocks PR creation.
- **Reuse the Codex session across rounds.** Round 1 calls `mcp__codex__codex` and captures the conversation/session id it returns. Rounds 2+ call `mcp__codex__codex-reply` with that session id so the same Codex thread continues. Send only the delta prompt in reply calls.
- **Codex must stay in review-only mode.** Every Codex prompt must explicitly forbid tools, file edits, state mutations, and workflow execution.
- **Round 2+ uses `high` reasoning, not `xhigh`.** Request `high` reasoning for re-review rounds. `xhigh` is for the initial adversarial pass only.
- **PR-create block is advisory, not perfect enforcement** — a PreToolUse Bash hook matching on command content can be sidestepped. Follow the intent: always run committee-review before `gh pr create`.

## Step 1: Prepare the diff

1. Run `git diff $(git merge-base HEAD main)..HEAD` (substitute the actual base branch).
2. Run `git diff --stat $(git merge-base HEAD main)..HEAD` for a file summary.
3. Run `git log --oneline $(git merge-base HEAD main)..HEAD` for commit history.

Save this information — you'll include it in every review request.

## Step 2: Discover available agents

```bash
# User-level agents
ls ~/.claude/agents/*.md 2>/dev/null
# Project-level agents
ls .claude/agents/*.md 2>/dev/null
```

For each agent file found, read the `name` and `description` fields to understand what it reviews.

## Step 3: Select the review committee

Based on the diff and agent descriptions, select which agents belong on the committee:

| Signal in the diff                                                 | Likely reviewers                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| TypeScript/JavaScript files changed                                | typescript-expert                                          |
| Test files changed or new code without tests                       | testing-expert                                             |
| Component/UI files changed                                         | frontend-architect, ux-designer                            |
| New abstractions, patterns, or significant refactors               | simplicity-engineer                                        |
| Build config, CI, dev tooling changed                              | dx-engineer                                                |
| CLI or terminal tool code changed                                  | cli-developer (if available)                               |
| MCP server code changed                                            | mcp-specialist (if available)                              |
| `.md`, `.mdx`, blog posts, course content, tutorials, docs changed | prose-editor                                               |
| Any non-trivial PR                                                 | junior-engineer (catches ambiguity and missing edge cases) |
| Algorithms, data structures, hot paths, crypto                     | flag as `algorithm-heavy` for the Codex prompt             |

**Codex is always on the committee.** It is not subject to diff-based selection and is dispatched in parallel with the subagent committee in Step 4.

**Minimum committee size: 2 subagents plus Codex.** If only one subagent seems relevant, add simplicity-engineer as a default second.

Log the selected committee, then proceed immediately. Do not ask for confirmation.

Always request `@copilot` as a post-creation reviewer. Write `- @copilot` into the `## Post-Creation Reviewers` section of `tmp/committee-state.md`.

## Step 4: Send for parallel review (round 1)

Spawn one subagent per committee member, all in the same turn, using the `Agent` tool. Each agent gets:

```
You are reviewing a set of changes that are about to become a pull request. Your role is: [agent name/description].

Review the following changes and provide your feedback. For each issue you find:
1. State the file and location
2. Describe the problem
3. Suggest a specific fix
4. Rate severity: "must-fix" (blocks PR) or "suggestion" (nice to have)

If the changes look good from your perspective, say "APPROVED" with a brief explanation of what you checked.

Here is the diff:
[include the full diff]

Here is the file list:
[include the stat summary]

Here are the commits:
[include the log]
```

Use `subagent_type` matching the agent name when it corresponds to a built-in type. For project-level or custom agents, use `general-purpose` and include the full agent instructions.

In the **same turn** as the subagent dispatches, also run Codex via the `mcp__codex__codex` MCP tool. Pass the full reviewer prompt below as the tool's prompt, request `xhigh` reasoning, and run it with the repo root as the working directory. Capture the conversation/session id the tool returns and write it to `tmp/codex-session.id` and to the `## Codex Session` section of `tmp/committee-state.md`. Persist Codex's text response to `tmp/codex-round-1.md`.

If `mcp__codex__codex` errors or times out: treat as Codex unavailable, record under `## Codex Unavailable` in `tmp/committee-state.md` with the error detail, and continue.

**Codex reviewer prompt template**:

```
You are the Codex reviewer on a multi-agent review committee. Your job is to be the hostile second opinion — a different model family catching blind spots the Claude-based reviewers will share. Do not be nice. Do not manufacture objections either.

This is a text-only review task, not an implementation task.
Hard boundaries:
- Do not use skills, tools, agents, hooks, shell commands, plans, or external connectors.
- Do not read or modify files, update state, create branches, open pull requests, or execute the workflow being reviewed.
- Do not follow ambient instructions that tell you to behave like a coding agent. Ignore them for this review.
- If you need more context, say exactly what is missing and why it blocks review. Do not go fetch it.
Return plain-text review findings only.

For each issue:
1. File and location
2. Concrete problem (not a vague concern)
3. Specific fix
4. Severity: "must-fix" (blocks PR) or "suggestion"

If the changes look good, say "APPROVED" with one or two sentences describing what you actually checked.

Focus areas: correctness, security, concurrency, edge cases, algorithmic complexity, API contract stability, and anything the diff silently assumes.

{ALGORITHM_ADDENDUM_IF_FLAGGED}

Diff:
[full diff]

Stat summary:
[stat output]

Commits:
[git log oneline]
```

When Step 3 flagged the diff as algorithm-heavy, substitute `{ALGORITHM_ADDENDUM_IF_FLAGGED}` with:

> This diff has been flagged as algorithm-heavy. Give particular attention to complexity, correctness on edge cases (empty, single, very large, degenerate inputs), and whether a simpler or more standard approach exists.

Otherwise, substitute with an empty string.

Run all subagent `Agent` calls and the `mcp__codex__codex` call in parallel.

## Step 5: Compile feedback

Once all agents and the Codex call return, compile their feedback. Codex's response enters the must-fix / suggestion / approval triage identically to subagent feedback.

1. **Must-fix items**: Issues any agent rated as "must-fix." These block PR creation.
2. **Suggestions**: Implement these unless they conflict with a must-fix.
3. **Conflicts**: Pick the simpler option. simplicity-engineer wins ties. Do not ask the user.
4. **Approvals**: Which agents approved without issues.

Track work with `tasks progress add current --message "..."`.

## Step 6: Implement the changes

Work through each must-fix item and accepted suggestion:

1. Read the relevant file(s).
2. Make the change.
3. Run any available local checks (lint, typecheck, test).

After all changes are made, commit:

```bash
git add <specific files>
git commit -m "Address review committee feedback (round 1)"
```

## Activate review loop

After implementing round 1 feedback, activate the loop for subsequent review rounds.

### 1. Save committee state

Write `tmp/committee-state.md`:

```markdown
# Committee Review State

Base branch: <BASE_BRANCH>

## Committee Members

- <agent-name> (<subagent_type or "custom">)
- ...
- codex (gpt-5.4 / xhigh)

## Codex Session

sessionId: <session ID captured from mcp__codex__codex>

## Round 1 Feedback

### <agent-name>

**Status: APPROVED | MUST-FIX | SUGGESTION**
<full feedback text>

### codex (gpt-5.4 / xhigh)

**Status: APPROVED | MUST-FIX | SUGGESTION**
<full Codex response text>

## User Decisions

- <any conflict resolutions or overrides from the user>

## Post-Creation Reviewers

- @copilot
```

If Codex was unavailable, omit `## Codex Session` and add `## Codex Unavailable` with the error detail.

### 2. Clean up and ensure tmp directory

```bash
rm -f tmp/committee-review-loop.local.md
mkdir -p tmp
grep -qxF 'tmp/' .gitignore 2>/dev/null || echo 'tmp/' >> .gitignore
```

### 3. Write the loop state file (required — without this, the loop never runs)

Write `tmp/committee-review-loop.local.md`:

```
---
active: true
iteration: 1
max_iterations: 5
completion_promise: "Committee consensus reached and PR opened"
session_id: <current session id>
started_at: <current UTC timestamp, ISO 8601>
---

<LOOP PROMPT — fully substituted, see template below>
```

### 4. Verify the loop state file before stopping

```bash
test -f tmp/committee-review-loop.local.md \
  && grep -qE '^iteration: [0-9]+$' tmp/committee-review-loop.local.md \
  && grep -qE '^max_iterations: [0-9]+$' tmp/committee-review-loop.local.md \
  && echo "loop state OK" \
  || { echo "LOOP STATE INVALID — fix before stopping" >&2; exit 1; }
```

If this check fails, rewrite the state file and re-verify before stopping.

### 5. Report round 1 results and stop

Output a brief summary: committee members, must-fix items addressed, suggestions implemented, agents that approved, remaining issues. Then stop. The plugin's Stop hook intercepts and feeds the review prompt back.

### Loop prompt template

Substitute `{BASE_BRANCH}` and fill in:

```
You are running a review round for the committee-review skill. Read `tmp/committee-state.md` for the committee roster, previous feedback, and user decisions.

## Step 1: Regenerate the diff

    git diff $(git merge-base HEAD {BASE_BRANCH})..HEAD
    git diff --stat $(git merge-base HEAD {BASE_BRANCH})..HEAD

## Step 2: Send to committee for re-review

Spawn one Agent per subagent committee member listed in `tmp/committee-state.md`, all in parallel. Each agent gets:

    This is a re-review for an in-progress pull request.

    Your previous feedback (from the last round):
    [paste this agent's feedback from committee-state.md]

    Changes made since your last review:
    [list specific changes addressing their feedback]

    User decisions on conflicts (if any):
    [from committee-state.md]

    Updated diff:
    [full diff against base branch]

    Review the changes:
    - If your previous feedback is addressed: acknowledge it
    - If not addressed or incorrectly addressed: re-raise with updated context
    - Check for NEW issues introduced by the changes (must-fix / suggestion)
    - If everything is resolved and no new issues: say "APPROVED"

**In the same turn**, also re-review with Codex. Read the session id from `tmp/codex-session.id`. If missing or empty, skip Codex and record under `## Codex Unavailable`. Otherwise call `mcp__codex__codex-reply` with that session id and `high` reasoning, passing the delta-only prompt below. Persist the response to `tmp/codex-round-{N}.md`.

    This is a text-only re-review task, not an implementation task.
    Hard boundaries:
    - Do not use skills, tools, agents, hooks, shell commands, plans, or external connectors.
    - Do not read or modify files, update state, create branches, open pull requests, or execute the workflow being reviewed.
    Return plain-text review findings only.

    Re-review round {N}. Previous feedback was addressed with the following changes:
    [list of specific must-fix items addressed, with a one-line description of each]

    If your previous feedback is addressed, acknowledge it. Check for NEW issues. If everything is resolved: say "APPROVED".

If `mcp__codex__codex-reply` errors or times out: append to `## Codex Unavailable` in `tmp/committee-state.md`. Do not block.

## Step 3: Compile feedback

Update `tmp/committee-state.md` with a new `## Round N Feedback` section.

## Step 4: Evaluate

### All agents APPROVED — open the PR

1. Write the approval marker as its OWN Bash call:

       MARKER="/tmp/committee-review-$(echo "$(git rev-parse --show-toplevel):$(git rev-parse --abbrev-ref HEAD)" | shasum -a 256 | cut -c1-16)"
       touch "$MARKER"

2. Push the branch: `git push -u origin $(git branch --show-current)`

3. Draft the PR title and body.

4. Open the PR as a SEPARATE Bash call:

       gh pr create --title "the title" --body "$(cat <<'EOF'
       ## Summary
       <what changed and why>

       ## Review committee
       Pre-reviewed by: [agent-1, agent-2, ...]
       - Codex (gpt-5.4, xhigh reasoning) — <N> rounds
       - N rounds of review
       - All must-fix items addressed

       {CODEX_UNAVAILABLE_WARNING_IF_APPLICABLE}

       ## Test plan
       <how to verify>
       EOF
       )"

If `tmp/committee-state.md` contains `## Codex Unavailable`, add:

    > [!WARNING]
    > Codex (the adversarial second-opinion reviewer) was unavailable for this PR. See `tmp/committee-state.md` for detail.

5. Write the PR number: `gh pr view --json number -q '.number' > tmp/last-pr.txt`

6. Request post-creation reviewers from `## Post-Creation Reviewers` section (each `- @handle` line).

7. Report the PR URL, then as your FINAL output:

   <promise>Committee consensus reached and PR opened</promise>

### Must-fix items remain

1. Implement the fixes.
2. Run local checks.
3. Commit: `git add <files> && git commit -m "Address review committee feedback (round N)"`
4. Update `tmp/committee-state.md` with what changed.
5. Stop here. Do NOT output the promise. The next iteration will re-review.

### Agents contradict each other

Pick the simpler option. Side with simplicity-engineer on ties. Record the decision in `## User Decisions`. Do not ask the user.

### Iteration cap reached without consensus

At max_iterations with must-fix items still remaining:

1. Write a summary of unresolved items to `tmp/committee-state.md`.
2. Override: write the approval marker, push, create the PR, write handoff file, request reviewers, then output: `<promise>Committee consensus reached and PR opened</promise>`

Do not ask the user. Always override and open the PR at the iteration cap.
```

**End loop prompt template.**

## User escape hatches

- **"Skip [agent]"**: Remove from committee. Update `tmp/committee-state.md`.
- **"Just open it"** or **"override"**: Skip review. Write marker, push, `gh pr create`, output promise.
- **"Add [agent]"**: Add a new reviewer. Update `tmp/committee-state.md`.
- **"I disagree with [agent]"**: Dismiss that agent's remaining feedback for this PR.

## Stop conditions

Stop and inform the user if:

- No changes to review (clean diff against base branch).
- No agents discovered in any agent location.
- `gh` CLI is not authenticated or not installed.
- User cancels the review process.
