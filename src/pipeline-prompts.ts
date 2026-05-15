import type { AgentProvider } from './types.js';

/**
 * System prompt prepended (via `--append-system-prompt` for Claude, or inlined
 * before the task prompt for Codex) to every pipeline agent invocation. Names
 * the four-phase workflow and the merge-or-stop expectation.
 */
export const PIPELINE_SYSTEM_PROMPT = [
  'You are an autonomous task runner inside a `tasks pipeline` invocation.',
  'A per-task git worktree has already been created and the task row is already `in-progress`.',
  'Your contract: drive the task all the way to a merged pull request, or exit non-zero with `STUCK: <reason>` on stderr if you cannot.',
  'Do not stop at "ready to merge" — the pipeline considers the task complete only when the pull request is merged into the base branch.',
  'Use the tasks CLI for state. Record progress with `tasks progress add` at major checkpoints. Do not edit `tmp/tasks.db` directly.',
  'Do not call `gh pr create` directly; use the `committee-review` skill to open the pull request.',
  'Use the `address-pr` skill to drive review feedback to resolution.',
  'Print the line `AGENT_OUTPUT_BEGIN` on its own line on stdout before any other agent-authored output.',
  'When you create the pull request body, include a final line of exactly `pipeline-task-id: <task-id>` (no other text on that line) so the pipeline can verify PR identity later.',
].join(' ');

/**
 * Builds the per-task prompt for the initial agent run. The Claude variant
 * delegates to the `next-task` skill; the Codex variant inlines the four-phase
 * workflow because the Codex side does not have an equivalent skill we can
 * depend on.
 */
export const pipelinePrompt = (provider: AgentProvider, taskId: string): string => {
  if (provider === 'claude') {
    return [
      `Invoke the \`next-task\` skill on task \`${taskId}\` and drive it through merge.`,
      'The skill handles plan → committee-review → address-pr → merge.',
      'Return only when the pull request is merged or you have hit a `STUCK:` condition.',
    ].join('\n');
  }
  return [
    `You are working on Scrumlord task \`${taskId}\`. Drive it through the four phases:`,
    '',
    '1. Plan. Read any existing plan at the task plan path. If none exists or the plan is incomplete, write one to `tmp/tasks/<task-id>/PLAN.md` and run `tasks update <task-id> --plan <path>`. Record progress with `tasks progress add`.',
    '2. Implement against the plan. Run the project verify commands (`bun test`, `bun run typecheck`, `bun run lint`) and fix anything you break. Commit your work; never skip hooks.',
    '3. Open the pull request via the `committee-review` skill — never call `gh pr create` yourself.',
    '4. Drive the pull request to merge via the `address-pr` skill. The task is not done until the pull request is merged.',
    '',
    'Run `tasks pr --sync` whenever GitHub state may have changed.',
    'If you cannot proceed, exit non-zero with `STUCK: <reason>` on stderr.',
  ].join('\n');
};

/**
 * Builds the plan-only prompt used by the W-E phase split. The agent's
 * single contract is: write a plan to `tmp/tasks/<task-id>/PLAN.md`, run
 * `tasks update <task-id> --plan <path>`, then exit. No implementation, no
 * PR, no merge. Used when `SCRUMLORD_PIPELINE_PHASES=split` and the
 * task has no plan yet.
 */
export const planOnlyPrompt = (taskId: string): string => {
  return [
    `You are running the plan-only phase for Scrumlord task \`${taskId}\`.`,
    'Your single contract:',
    '',
    `1. Write a concrete implementation plan to \`tmp/tasks/${taskId}/PLAN.md\`. Include: files to touch, the change in each, the verification approach, and any risks.`,
    `2. Run \`tasks update ${taskId} --plan tmp/tasks/${taskId}/PLAN.md\` so the pipeline records the plan path.`,
    '3. Exit cleanly.',
    '',
    'Do NOT implement the task. Do NOT open a pull request. Do NOT merge anything.',
    'If you cannot draft a plan, exit non-zero with `STUCK: <reason>` on stderr.',
  ].join('\n');
};

/**
 * Builds the prompt used when the pipeline dispatches an additional agent round
 * specifically to address open review threads or failing CI on a known PR.
 */
export const addressPrPrompt = (taskId: string, pullRequestNumber: number): string => {
  return [
    `Invoke the \`address-pr\` skill on pull request #${pullRequestNumber} for Scrumlord task \`${taskId}\`.`,
    'The pipeline has detected actionable work right now (failing checks or unresolved review threads).',
    'Loop until: zero unresolved review threads, CI is green, and all requested review bots have posted.',
    'Do not stop until the pull request is ready to merge or merged.',
    'If you cannot proceed, exit non-zero with `STUCK: <reason>` on stderr.',
  ].join('\n');
};
