/**
 * The number of leading characters of a task UUID that form its short id.
 *
 * This single constant binds three things together so they can never drift:
 * the prefix shown in `tasks list`/detail output, the prefix `resolveTaskId`
 * accepts as a "unique UUID prefix", and the `tasks/<shortId>` branch and
 * `tmp/worktrees/tasks/<shortId>` worktree names derived in `worktree.ts`. A
 * branch name is therefore the exact string you see in `tasks list` and can
 * paste straight back into any `tasks` command.
 */
export const TASK_ID_PREFIX_LENGTH = 8;
