/**
 * Bot-aware readiness gating for the pipeline (#7, #25).
 *
 * `SCRUMLORD_PIPELINE_EXPECTED_BOTS=<csv>` lists bot logins that must each
 * have submitted at least one active review on the **current head sha**
 * before the pipeline merges. Default is empty (off).
 *
 * Active = a review whose `state` is `APPROVED | CHANGES_REQUESTED |
 * COMMENTED`. Dismissed reviews do NOT count (per the approved plan):
 * mismatching/dismissed feedback would otherwise allow strict gating to
 * pass after someone deliberately dismissed stale notes. Reviews on a
 * stale head sha (HEAD has been force-pushed) also don't count.
 *
 * `SCRUMLORD_PIPELINE_BOT_WAIT=advisory|strict` (default advisory) governs
 * what happens when the wait budget exhausts with bots still pending and
 * nothing else actionable failing. Advisory accepts and proceeds with a
 * WARN line; strict fails with `expected_bots_never_reviewed`.
 */

export type BotReview = {
  /** Login of the review's author (the bot). */
  authorLogin: string;
  /** State as reported by the GitHub reviews API. */
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  /** Commit OID the review was filed against. Must match `headRefOid` to count. */
  commitOid: string | null;
};

/** Parses the comma-separated env value into a trimmed list of bot logins. */
export const parseExpectedBots = (raw: string | undefined): string[] => {
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
};

/**
 * Returns the list of expected bots that have not yet posted an active
 * review on the current head sha. An empty list means all expected bots
 * have weighed in (or no bots are expected at all).
 */
export const detectPendingBots = (input: {
  expectedBots: readonly string[];
  reviews: readonly BotReview[];
  headRefOid: string | null;
}): string[] => {
  if (input.expectedBots.length === 0) return [];
  const satisfied = new Set<string>();
  for (const review of input.reviews) {
    if (review.state === 'DISMISSED' || review.state === 'PENDING') continue;
    if (input.headRefOid !== null && review.commitOid !== input.headRefOid) continue;
    satisfied.add(review.authorLogin);
  }
  return input.expectedBots.filter((bot) => !satisfied.has(bot));
};

export type BotWaitPolicy = 'advisory' | 'strict';

export const parseBotWaitPolicy = (raw: string | undefined): BotWaitPolicy => {
  if (raw === 'strict') return 'strict';
  return 'advisory';
};

/**
 * Coerces the GitHub REST review state into our `BotReview['state']`. Unknown
 * states (or anything not on the active list) get bucketed as `PENDING` so
 * they never count toward satisfying the gate.
 */
export const reviewStateFromGitHub = (raw: unknown): BotReview['state'] => {
  if (raw === 'APPROVED' || raw === 'CHANGES_REQUESTED' || raw === 'COMMENTED') return raw;
  if (raw === 'DISMISSED') return 'DISMISSED';
  return 'PENDING';
};
