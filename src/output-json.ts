/**
 * Serializes a value as pretty-printed JSON with a trailing newline.
 *
 * This is the byte-identity bar for the `tasks` CLI: every command that emits
 * JSON routes through this helper so the on-stdout bytes stay stable when
 * pretty-mode plumbing is added downstream.
 */
export const formatJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
