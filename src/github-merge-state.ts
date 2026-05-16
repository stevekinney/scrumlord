export type MergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
export type MergeStateStatus =
  | 'BEHIND'
  | 'BLOCKED'
  | 'CLEAN'
  | 'DIRTY'
  | 'DRAFT'
  | 'HAS_HOOKS'
  | 'UNKNOWN'
  | 'UNSTABLE';

export const mergeableStateFrom = (value: Record<string, unknown>): MergeableState | null => {
  const raw = value['mergeable'];
  if (raw === 'MERGEABLE' || raw === 'CONFLICTING' || raw === 'UNKNOWN') return raw;
  // REST API returns boolean: true = MERGEABLE, false = CONFLICTING, null = UNKNOWN
  if (raw === true) return 'MERGEABLE';
  if (raw === false) return 'CONFLICTING';
  return null;
};

const VALID_MERGE_STATE_STATUSES: MergeStateStatus[] = [
  'BEHIND',
  'BLOCKED',
  'CLEAN',
  'DIRTY',
  'DRAFT',
  'HAS_HOOKS',
  'UNKNOWN',
  'UNSTABLE',
];

export const mergeStateStatusFrom = (value: Record<string, unknown>): MergeStateStatus | null => {
  const raw = value['mergeStateStatus'] ?? value['merge_state_status'];
  return VALID_MERGE_STATE_STATUSES.includes(raw as MergeStateStatus)
    ? (raw as MergeStateStatus)
    : null;
};
