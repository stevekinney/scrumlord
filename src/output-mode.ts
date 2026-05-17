/** Resolved output mode for a CLI invocation. */
export type OutputMode = 'json' | 'pretty';

/**
 * Inputs to {@link resolveOutputMode}. All boundary state (env, TTY) is
 * injected so the resolver stays pure and testable.
 */
export type OutputModeInputs = {
  /** Did the user pass `--json` on this command? */
  jsonFlag: boolean;
  /** Process environment, boundary-injected. */
  environment: Record<string, string | undefined>;
  /** Whether stdout is a TTY. Boundary-injected. */
  isTty: boolean;
};

/**
 * Environment variables that, when present and non-empty, mark the caller as a
 * machine-readable consumer (agent harness, CI). Exported so tests can iterate
 * the full list and so the README/help text can stay in sync.
 *
 * The list is exhaustive — no prefix matching. Prefix matching would silently
 * capture unrelated env vars and is a debugging trap.
 */
export const machineReadableEnvironmentKeys = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_MANAGED_BY_BUN',
  'CODEX_SANDBOX',
  'CI',
  'SCRUMLORD_JSON',
] as const;

/**
 * Returns `true` when the caller looks machine-readable: any whitelisted env
 * key is present with a non-empty trimmed value.
 */
export const isMachineReadableEnvironment = (
  environment: Record<string, string | undefined>,
): boolean => {
  for (const key of machineReadableEnvironmentKeys) {
    const value = environment[key];
    if (typeof value === 'string' && value.trim() !== '') return true;
  }
  return false;
};

/**
 * Resolves the output mode for a CLI invocation. Precedence (top wins):
 *
 * 1. `jsonFlag === true` → `'json'`. User/scripting override.
 * 2. `SCRUMLORD_PRETTY === '0'` → `'json'`. Disaster-recovery override.
 * 3. Machine-readable env present → `'json'`.
 * 4. Stdout is not a TTY → `'json'`. Pipes, redirects, CI logs.
 * 5. Otherwise → `'pretty'`.
 */
export const resolveOutputMode = (inputs: OutputModeInputs): OutputMode => {
  if (inputs.jsonFlag) return 'json';
  if (inputs.environment['SCRUMLORD_PRETTY'] === '0') return 'json';
  if (isMachineReadableEnvironment(inputs.environment)) return 'json';
  if (!inputs.isTty) return 'json';
  return 'pretty';
};
