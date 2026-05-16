/** Marker for store-command results that should bypass JSON wrapping and emit raw text. */
export type RawOutput = { kind: 'raw-output'; value: string };

/** Constructs a raw-output marker. Use from store-command handlers that emit raw text. */
export const rawOutput = (value: string): RawOutput => ({ kind: 'raw-output', value });

const hasKind = (value: object): value is { kind: unknown } => 'kind' in value;
const hasValue = (value: object): value is { value: unknown } => 'value' in value;

/** Type guard. True when the value is a RawOutput marker with a string payload. */
export const isRawOutput = (value: unknown): value is RawOutput => {
  if (typeof value !== 'object' || value === null) return false;
  if (!hasKind(value) || value.kind !== 'raw-output') return false;
  if (!hasValue(value) || typeof value.value !== 'string') return false;
  return true;
};
