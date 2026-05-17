import { describe, expect, it } from 'bun:test';
import {
  isMachineReadableEnvironment,
  machineReadableEnvironmentKeys,
  resolveOutputMode,
} from './output-mode.js';

describe('isMachineReadableEnvironment', () => {
  it('returns true when any whitelisted key has a non-empty value', () => {
    for (const key of machineReadableEnvironmentKeys) {
      expect(isMachineReadableEnvironment({ [key]: '1' })).toBe(true);
    }
  });

  it('treats whitespace-only values as absent', () => {
    for (const key of machineReadableEnvironmentKeys) {
      expect(isMachineReadableEnvironment({ [key]: '' })).toBe(false);
      expect(isMachineReadableEnvironment({ [key]: '   ' })).toBe(false);
      expect(isMachineReadableEnvironment({ [key]: '\t\n' })).toBe(false);
    }
  });

  it('does not match unrelated CLAUDE_* / CODEX_* prefixes', () => {
    expect(isMachineReadableEnvironment({ CLAUDE_FOO: '1' })).toBe(false);
    expect(isMachineReadableEnvironment({ CODEX_FOO: '1' })).toBe(false);
    expect(isMachineReadableEnvironment({ SCRUMLORD_FOO: '1' })).toBe(false);
  });

  it('returns false for an empty environment', () => {
    expect(isMachineReadableEnvironment({})).toBe(false);
  });
});

describe('resolveOutputMode', () => {
  it('returns json when --json is passed, regardless of env or tty', () => {
    expect(resolveOutputMode({ jsonFlag: true, environment: {}, isTty: true })).toBe('json');
    expect(
      resolveOutputMode({ jsonFlag: true, environment: { CLAUDECODE: '1' }, isTty: false }),
    ).toBe('json');
  });

  it('returns json when SCRUMLORD_PRETTY=0 even on a TTY', () => {
    expect(
      resolveOutputMode({ jsonFlag: false, environment: { SCRUMLORD_PRETTY: '0' }, isTty: true }),
    ).toBe('json');
  });

  it('does not force json when SCRUMLORD_PRETTY is any other value', () => {
    expect(
      resolveOutputMode({ jsonFlag: false, environment: { SCRUMLORD_PRETTY: '1' }, isTty: true }),
    ).toBe('pretty');
  });

  it('returns json when any machine-readable env key is set', () => {
    for (const key of machineReadableEnvironmentKeys) {
      expect(resolveOutputMode({ jsonFlag: false, environment: { [key]: '1' }, isTty: true })).toBe(
        'json',
      );
    }
  });

  it('returns json when stdout is not a TTY', () => {
    expect(resolveOutputMode({ jsonFlag: false, environment: {}, isTty: false })).toBe('json');
  });

  it('returns pretty only when no override applies and stdout is a TTY', () => {
    expect(resolveOutputMode({ jsonFlag: false, environment: {}, isTty: true })).toBe('pretty');
  });
});
