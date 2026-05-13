/**
 * Structured PR-body identity footer parsing.
 *
 * The agent contract (set by `PIPELINE_SYSTEM_PROMPT`) is to write a final
 * line of exactly `pipeline-task-id: <task-id>` in the PR body it creates.
 * Substring matching against the body is intentionally rejected — only a
 * line matching the regex below counts.
 *
 * Three discrete flags govern how the pipeline uses the footer:
 *   - `SCRUMLORD_PIPELINE_PR_FOOTER_VERIFY` (default off): require the
 *     footer to be present and match the current task id.
 *   - `SCRUMLORD_PIPELINE_PR_FOOTER_REPAIR` (default off): when the footer
 *     is missing, append it via `gh pr edit --body`. Mismatched footers are
 *     never auto-repaired because that would mask a real identity bug.
 *   - `SCRUMLORD_PIPELINE_PR_IDENTITY` (default off): the recovery sweep
 *     and `pullRequestForTask` use the footer (when present) as the
 *     authoritative match instead of branch name only.
 *
 * Defaults are off in code; flag flips happen in separate follow-up PRs
 * with field evidence, not as in-flight changes inside this PR.
 */

const FOOTER_REGEX = /^pipeline-task-id:\s+(\S+)\s*$/m;
const FOOTER_LINE = (taskId: string): string => `pipeline-task-id: ${taskId}`;

/**
 * Inspects a PR body and returns the parsed footer state for a given task id.
 * `missing` covers both "no footer line at all" and "malformed line".
 */
export const parsePullRequestFooter = (
  body: string | null,
  taskId: string,
): { kind: 'match' } | { kind: 'missing' } | { kind: 'mismatch'; foundTaskId: string } => {
  if (!body) return { kind: 'missing' };
  const match = FOOTER_REGEX.exec(body);
  if (!match) return { kind: 'missing' };
  const foundTaskId = match[1]!;
  if (foundTaskId === taskId) return { kind: 'match' };
  return { kind: 'mismatch', foundTaskId };
};

/**
 * Builds the body to send to `gh pr edit --body` when the repair flag is
 * on AND the existing body has no footer. The original body is preserved
 * verbatim and the footer is appended on its own line after a blank line.
 */
export const buildRepairedPullRequestBody = (
  originalBody: string | null,
  taskId: string,
): string => {
  const original = (originalBody ?? '').replace(/\s+$/, '');
  if (original.length === 0) return FOOTER_LINE(taskId);
  return `${original}\n\n${FOOTER_LINE(taskId)}`;
};

/** Flag resolution. Returns `true` only when the env var is exactly `on`. */
export const isFlagOn = (
  environment: Record<string, string | undefined>,
  key:
    | 'SCRUMLORD_PIPELINE_PR_FOOTER_VERIFY'
    | 'SCRUMLORD_PIPELINE_PR_FOOTER_REPAIR'
    | 'SCRUMLORD_PIPELINE_PR_IDENTITY',
): boolean => {
  return environment[key] === 'on';
};
