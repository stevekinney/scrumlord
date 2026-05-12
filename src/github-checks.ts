import { ScrumlordError } from './errors.js';

export type PullRequestCheck = {
  name: string;
  state: string;
  bucket: string | null;
  workflow: string | null;
  url: string | null;
  completedAt: string | null;
};

export type PullRequestCheckConclusion = 'successful' | 'pending' | 'failed';

export type PullRequestCheckReport = PullRequestCheck & {
  conclusion: PullRequestCheckConclusion;
  synopsis: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === 'object';
};

const nestedRecord = (
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined => {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
};

const stringOrNull = (value: unknown): string | null => {
  return typeof value === 'string' ? value : null;
};

const checkRunFrom = (value: unknown): PullRequestCheck | undefined => {
  if (!isRecord(value) || typeof value['name'] !== 'string') return undefined;
  const checkSuite = nestedRecord(value, 'check_suite');
  const app = nestedRecord(checkSuite, 'app');
  return {
    name: value['name'],
    state: stringOrNull(value['conclusion']) ?? stringOrNull(value['status']) ?? 'UNKNOWN',
    bucket: stringOrNull(value['conclusion']) ?? stringOrNull(value['status']),
    workflow: stringOrNull(app?.['name']),
    url: stringOrNull(value['html_url']),
    completedAt: stringOrNull(value['completed_at']),
  };
};

export const checkRunsFrom = (response: unknown): PullRequestCheck[] => {
  if (!isRecord(response) || !Array.isArray(response['check_runs'])) {
    throw new ScrumlordError(
      'ci_status_invalid',
      'Expected GitHub check runs to return a check_runs array.',
    );
  }
  return response['check_runs'].flatMap((value) => {
    const check = checkRunFrom(value);
    return check ? [check] : [];
  });
};

const commitStatusFrom = (value: unknown): PullRequestCheck | undefined => {
  if (!isRecord(value) || typeof value['context'] !== 'string') return undefined;
  return {
    name: value['context'],
    state: typeof value['state'] === 'string' ? value['state'] : 'UNKNOWN',
    bucket: stringOrNull(value['state']),
    workflow: null,
    url: stringOrNull(value['target_url']),
    completedAt: stringOrNull(value['updated_at']) ?? stringOrNull(value['created_at']),
  };
};

export const commitStatusesFrom = (response: unknown): PullRequestCheck[] => {
  if (!Array.isArray(response)) {
    throw new ScrumlordError(
      'ci_status_invalid',
      'Expected GitHub commit statuses to return a JSON array.',
    );
  }
  return response.flatMap((value) => {
    const status = commitStatusFrom(value);
    return status ? [status] : [];
  });
};

const normalizeState = (value: string | null): string => {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replaceAll(/[\s-]+/g, '_');
};

const successfulStates = new Set([
  'pass',
  'passed',
  'success',
  'successful',
  'skipped',
  'skipping',
  'neutral',
]);

const pendingStates = new Set([
  'pending',
  'queued',
  'in_progress',
  'waiting',
  'requested',
  'expected',
]);

const failedStates = new Set([
  'fail',
  'failed',
  'failure',
  'error',
  'cancel',
  'cancelled',
  'canceled',
  'timed_out',
  'action_required',
]);

const classifyCheck = (check: PullRequestCheck): PullRequestCheckConclusion => {
  const bucket = normalizeState(check.bucket);
  const state = normalizeState(check.state);

  if (failedStates.has(bucket) || failedStates.has(state)) return 'failed';
  if (pendingStates.has(bucket) || pendingStates.has(state)) return 'pending';
  if (successfulStates.has(bucket) || successfulStates.has(state)) return 'successful';
  return 'pending';
};

const checkSynopsis = (check: PullRequestCheck, conclusion: PullRequestCheckConclusion): string => {
  const workflow = check.workflow ? `${check.workflow}: ` : '';
  if (conclusion === 'failed') return `${workflow}${check.name} failed with state ${check.state}.`;
  if (conclusion === 'pending') return `Waiting on ${workflow}${check.name} (${check.state}).`;
  return `${workflow}${check.name} passed.`;
};

export const reportForCheck = (check: PullRequestCheck): PullRequestCheckReport => {
  const conclusion = classifyCheck(check);
  return {
    ...check,
    conclusion,
    synopsis: checkSynopsis(check, conclusion),
  };
};
