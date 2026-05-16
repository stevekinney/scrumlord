import { describe, expect, it } from 'bun:test';
import { isRawOutput, rawOutput } from './cli-raw-output';

describe('rawOutput', () => {
  it('constructs a RawOutput marker', () => {
    expect(rawOutput('hello')).toEqual({ kind: 'raw-output', value: 'hello' });
  });
});

describe('isRawOutput', () => {
  it('accepts a well-formed RawOutput', () => {
    expect(isRawOutput({ kind: 'raw-output', value: 'hello' })).toBe(true);
  });

  it('rejects plain objects', () => {
    expect(isRawOutput({})).toBe(false);
  });

  it('rejects objects with wrong kind', () => {
    expect(isRawOutput({ kind: 'other', value: 'hello' })).toBe(false);
  });

  it('rejects objects with non-string value', () => {
    expect(isRawOutput({ kind: 'raw-output', value: 42 })).toBe(false);
  });

  it('rejects null', () => {
    expect(isRawOutput(null)).toBe(false);
  });

  it('rejects primitives', () => {
    expect(isRawOutput('hello')).toBe(false);
    expect(isRawOutput(42)).toBe(false);
    expect(isRawOutput(true)).toBe(false);
  });
});
