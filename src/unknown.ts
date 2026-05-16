/** Returns true when `value` is a non-null object (i.e. a plain record). */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Narrows `value` to string, returning null for anything else. */
export const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

/** Narrows `value` to number, returning null for anything else. */
export const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' ? value : null;

/** Picks a nested object from a record by key, or returns undefined. */
export const nestedRecord = (
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined => {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
};
