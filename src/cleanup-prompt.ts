import { basename } from 'node:path';
import type { CommandRunner } from './command-runner.js';

type CleanupPromptStore = {
  countInProgress(): number;
  countBranched(): number;
};

type CleanupPromptContext = {
  store: CleanupPromptStore;
  projectRoot: string;
  runner: CommandRunner;
  now: () => Date;
};

const parseRepoName = (url: string): string | null => {
  const trimmed = url.trim();
  // SSH: git@github.com:owner/repo.git
  const sshMatch = /^git@[^:]+:(.+?)(?:\.git)?$/.exec(trimmed);
  if (sshMatch) return sshMatch[1] ?? null;
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = /^https?:\/\/[^/]+\/(.+?)(?:\.git)?$/.exec(trimmed);
  if (httpsMatch) return httpsMatch[1] ?? null;
  return null;
};

const resolveRepoName = async (projectRoot: string, runner: CommandRunner): Promise<string> => {
  const result = await runner(['git', 'remote', 'get-url', 'origin'], projectRoot);
  if (result.exitCode === 0) {
    const parsed = parseRepoName(result.stdout);
    if (parsed) return parsed;
  }
  return basename(projectRoot);
};

export const buildCleanupPrompt = async (context: CleanupPromptContext): Promise<string> => {
  const { store, projectRoot, runner, now } = context;
  const [repoName, inProgressCount, branchedCount] = await Promise.all([
    resolveRepoName(projectRoot, runner),
    Promise.resolve(store.countInProgress()),
    Promise.resolve(store.countBranched()),
  ]);
  const generatedAtIso = now().toISOString();

  return `# Role

You are an autonomous repository hygienist for the \`${repoName}\` project at \`${projectRoot}\`. Your job is to bring the \`tasks\` CLI's view of the world into agreement with the actual Git, GitHub, filesystem, and dependency-graph state, then write a report.

# Deliverable

A single Markdown report with these sections, in order:

1. **Summary**: one paragraph describing the starting state and what you changed.
2. **Reconciliations applied**: table of task id, field changed, before, after, evidence (command + exit status).
3. **Open questions**: anything that needs human judgment.
4. **Suggested follow-ups**: concrete commands a human should consider running.

Before writing the report, run \`mkdir -p tmp\` from the project root. Save it to \`tmp/cleanup-report-${generatedAtIso}.md\` (use the exact timestamp slot provided in the context snapshot below) and also print it to stdout.

# Constraints

- **Read-only Git**: never run \`git branch -d\`, \`git branch -D\`, \`git worktree remove\`, \`git worktree prune\`, \`git push\`, \`git reset\`, or anything that rewrites refs. Surface orphan branches and worktrees in **Suggested follow-ups** for a human to handle.
- **No \`--hard\` deletes** on tasks. Soft-delete only.
- **No GitHub mutations**: do not close, merge, comment on, or label any PR or issue. Surface findings in the report.
- **One write per finding**: don't batch unrelated reconciliations into a single \`tasks update\`. Exception: \`tasks cleanup --orphans-only\` is a per-task-atomic batch — it's allowed and expected to handle multiple orphans in one invocation. Each individual orphan recovery is its own transaction in the CLI; the batch is **not** all-or-nothing, so if the command exits non-zero after applying some recoveries, capture the partial result in the report and continue.
- **Cap retries at 5**: if you can't get clean state for a finding in five attempts, document it and move on.
- **Use existing CLIs first**: \`tasks\`, \`gh\`, \`git\`. Do not install new packages. \`bun x\` is fine for devDependencies already in the project.
- **Trust the CLI, not assumptions**: if a command in this prompt doesn't exist, run \`tasks help\` and report the discrepancy.

# Ordered checklist

After each step, write a one-line progress note prefixed with the step number.

1. **Inventory tasks.** \`tasks list --all --count\`, \`tasks list\`, \`tasks blocked\`, \`tasks available --count\`. Cache stdout.
2. **Resolve base branch.** Run \`git symbolic-ref --quiet refs/remotes/origin/HEAD\` (it returns something like \`refs/remotes/origin/main\`). If that fails, try \`git config --get init.defaultBranch\`. If both fail, treat the base branch as **unknown** and skip every comparison that depends on it.
3. **Inventory Git state.** \`git branch --list 'task/*'\`, \`git worktree list --porcelain\`, \`git for-each-ref --format='%(refname:short) %(committerdate:iso)' refs/heads refs/remotes/origin\`.
4. **Inventory GitHub state.** \`gh pr list --state all --limit 200 --json number,headRefName,state,mergedAt,baseRefName,url\`. If \`gh\` is unavailable, note it and skip PR-derived reconciliations.
5. **Inventory tasks-CLI metadata.** For each \`in-progress\`, \`in-review\`, or branch-bound task: \`tasks get <id>\`. Capture \`branch\`, \`plan\`, \`session\`, \`provider\`.
6. **Detect orphan tasks (use the per-task atomic CLI).** Preview with \`tasks cleanup --orphans-only --dry-run\` and read the report. If the candidates look correct, run \`tasks cleanup --orphans-only\` to apply them. Each individual task recovery is one transaction in the CLI, but the batch is not all-or-nothing — if the command exits non-zero, treat the result as partial and record exactly which tasks were applied. Do **not** chain \`tasks set-status\`/\`tasks clear-branch\`/\`tasks clear-session\` by hand — those are three separate writes per task and would leave half-applied state on failure.
7. **Detect orphan branches (report-only).** Branches matching \`task/*\` with no task pointing at them and no open PR. List them in **Suggested follow-ups**. Do not delete.
8. **Detect orphan worktrees (report-only).** Worktrees in \`git worktree list\` whose branch has no task and no open PR. List them in **Suggested follow-ups**. Do not remove.
9. **Reconcile PR-derived status (one-to-one only).** For each PR from step 4, run \`tasks with-branch <headRefName>\` to find tasks pointing at that branch. **Only act when exactly one non-deleted task matches.** Zero matches ⇒ note "PR has no task" in **Open questions**. Multiple matches ⇒ note "ambiguous PR→task mapping" in **Open questions**. Otherwise: PR \`MERGED\` into the base branch (from step 2) ⇒ \`tasks set-status <id> completed\`. \`OPEN\` ⇒ \`tasks set-status <id> in-review\`. \`CLOSED\` without merge ⇒ leave the task as-is, flag in report. If base branch is **unknown** (step 2 failed), skip the merge-completed reconciliation but still apply the \`OPEN\`→\`in-review\` mapping.
10. **Reconcile plan paths.** For every task with \`plan\`, check the file exists. Missing ⇒ \`tasks clear-plan <id>\` and note it.
11. **Audit blockers.** \`tasks blocked\`. For each edge: confirm the blocker exists and isn't soft-deleted. Stale ⇒ \`tasks remove-blocker\`. Cycles ⇒ flag in **Open questions**, do not auto-break.
12. **Audit dependency graph health.** Tasks blocked by a \`completed\` task ⇒ remove the edge. Tasks \`ready\` but blocked by a \`draft\` ⇒ flag in **Open questions**.
13. **Audit progress trail.** \`in-progress\` for >7 days with no progress in the last 3 days ⇒ flag for human review.
14. **Soft-delete aged tasks.** \`tasks cleanup 30\` (no \`--hard\`). Capture count.
15. **Write the report.** \`mkdir -p tmp\`, write to the path above, print to stdout. Include exact commands run in order with exit status.

# Output discipline

- One reconciliation per \`tasks\` invocation, except \`tasks cleanup --orphans-only\` (see the Constraints exception above). For that one command, split its output into one report row per recovered task id.
- Every write logs command + stdout/stderr in the report's evidence column.
- If a step finds nothing, write the one-line note and continue.
- Anything destructive that isn't on the allowed list above stops the run and goes in **Open questions**.

# Context snapshot (auto-generated; trust your own observations over this)

- Repo: \`${repoName}\`
- Project root: \`${projectRoot}\`
- Active in-progress tasks: ${inProgressCount}
- Non-deleted tasks with a recorded branch: ${branchedCount}
- Prompt generated at: ${generatedAtIso}

Begin with step 1.
`;
};
