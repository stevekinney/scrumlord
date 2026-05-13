import { describe, expect, it } from 'bun:test';
import { detectPendingBots, parseBotWaitPolicy, parseExpectedBots } from './pipeline-bot-reviews';

describe('parseExpectedBots', () => {
  it('returns an empty list when the env var is undefined or empty', () => {
    expect(parseExpectedBots(undefined)).toEqual([]);
    expect(parseExpectedBots('')).toEqual([]);
    expect(parseExpectedBots('   ')).toEqual([]);
  });

  it('splits, trims, and drops empty entries', () => {
    expect(parseExpectedBots('copilot, , dependabot ')).toEqual(['copilot', 'dependabot']);
  });
});

describe('parseBotWaitPolicy', () => {
  it('returns advisory by default', () => {
    expect(parseBotWaitPolicy(undefined)).toBe('advisory');
    expect(parseBotWaitPolicy('')).toBe('advisory');
    expect(parseBotWaitPolicy('lenient')).toBe('advisory');
  });

  it('returns strict only when the env value is exactly strict', () => {
    expect(parseBotWaitPolicy('strict')).toBe('strict');
  });
});

describe('detectPendingBots', () => {
  it('returns an empty list when no bots are expected', () => {
    expect(detectPendingBots({ expectedBots: [], reviews: [], headRefOid: 'sha' })).toEqual([]);
  });

  it('returns all expected bots when none have reviewed', () => {
    expect(
      detectPendingBots({
        expectedBots: ['copilot', 'dependabot'],
        reviews: [],
        headRefOid: 'sha',
      }),
    ).toEqual(['copilot', 'dependabot']);
  });

  it('removes a bot once it has posted an active review on the current head', () => {
    const result = detectPendingBots({
      expectedBots: ['copilot', 'dependabot'],
      reviews: [{ authorLogin: 'copilot', state: 'APPROVED', commitOid: 'sha' }],
      headRefOid: 'sha',
    });
    expect(result).toEqual(['dependabot']);
  });

  it('counts COMMENTED reviews as satisfying the requirement (observation wait)', () => {
    const result = detectPendingBots({
      expectedBots: ['copilot'],
      reviews: [{ authorLogin: 'copilot', state: 'COMMENTED', commitOid: 'sha' }],
      headRefOid: 'sha',
    });
    expect(result).toEqual([]);
  });

  it('does NOT count DISMISSED reviews', () => {
    const result = detectPendingBots({
      expectedBots: ['copilot'],
      reviews: [{ authorLogin: 'copilot', state: 'DISMISSED', commitOid: 'sha' }],
      headRefOid: 'sha',
    });
    expect(result).toEqual(['copilot']);
  });

  it('does NOT count PENDING reviews', () => {
    const result = detectPendingBots({
      expectedBots: ['copilot'],
      reviews: [{ authorLogin: 'copilot', state: 'PENDING', commitOid: 'sha' }],
      headRefOid: 'sha',
    });
    expect(result).toEqual(['copilot']);
  });

  it('rejects reviews on a stale head sha', () => {
    const result = detectPendingBots({
      expectedBots: ['copilot'],
      reviews: [{ authorLogin: 'copilot', state: 'APPROVED', commitOid: 'oldsha' }],
      headRefOid: 'newsha',
    });
    expect(result).toEqual(['copilot']);
  });

  it('skips the head-sha check when headRefOid is null (unknown head)', () => {
    const result = detectPendingBots({
      expectedBots: ['copilot'],
      reviews: [{ authorLogin: 'copilot', state: 'APPROVED', commitOid: 'whatever' }],
      headRefOid: null,
    });
    expect(result).toEqual([]);
  });
});
