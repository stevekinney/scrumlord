import { describe, expect, it } from 'bun:test';
import type { CommandResult, CommandRunner } from './command-runner.js';
import { buildCleanupPrompt } from './cleanup-prompt.js';

const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (): CommandResult => ({ exitCode: 1, stdout: '', stderr: '' });

const mockRunner =
  (replies: Record<string, CommandResult>): CommandRunner =>
  async (command) => {
    const joined = command.join(' ');
    return replies[joined] ?? fail();
  };

const fakeStore = (inProgressCount = 0, branchedCount = 0) => ({
  countInProgress: () => inProgressCount,
  countBranched: () => branchedCount,
});

const fixedNow = new Date('2026-05-15T12:00:00.000Z');

describe('buildCleanupPrompt', () => {
  it('contains all required section headers', async () => {
    const runner = mockRunner({ 'git remote get-url origin': ok('git@github.com:owner/repo.git') });
    const prompt = await buildCleanupPrompt({
      store: fakeStore(),
      projectRoot: '/project',
      runner,
      now: () => fixedNow,
    });
    expect(prompt).toContain('# Role');
    expect(prompt).toContain('# Deliverable');
    expect(prompt).toContain('# Constraints');
    expect(prompt).toContain('# Ordered checklist');
    expect(prompt).toContain('# Output discipline');
    expect(prompt).toContain('# Context snapshot');
  });

  it('has exactly 15 sequentially numbered steps in the ordered checklist', async () => {
    const runner = mockRunner({ 'git remote get-url origin': ok('git@github.com:owner/repo.git') });
    const prompt = await buildCleanupPrompt({
      store: fakeStore(),
      projectRoot: '/project',
      runner,
      now: () => fixedNow,
    });
    // Extract just the Ordered checklist section
    const checklistStart = prompt.indexOf('# Ordered checklist');
    const checklistEnd = prompt.indexOf('# Output discipline');
    const checklist = prompt.slice(checklistStart, checklistEnd);
    const matches = checklist.match(/^\d+\. \*\*/gm);
    expect(matches).toHaveLength(15);
    for (let i = 1; i <= 15; i++) {
      expect(checklist).toContain(`${i}. **`);
    }
  });

  it('has no uninterpolated template literals', async () => {
    const runner = mockRunner({ 'git remote get-url origin': ok('git@github.com:owner/repo.git') });
    const prompt = await buildCleanupPrompt({
      store: fakeStore(),
      projectRoot: '/project',
      runner,
      now: () => fixedNow,
    });
    expect(prompt).not.toContain('${');
  });

  it('parses HTTPS remote URL to owner/repo', async () => {
    const runner = mockRunner({
      'git remote get-url origin': ok('https://github.com/owner/my-repo.git'),
    });
    const prompt = await buildCleanupPrompt({
      store: fakeStore(),
      projectRoot: '/project',
      runner,
      now: () => fixedNow,
    });
    expect(prompt).toContain('owner/my-repo');
  });

  it('parses SSH remote URL to owner/repo', async () => {
    const runner = mockRunner({
      'git remote get-url origin': ok('git@github.com:acme/tools.git'),
    });
    const prompt = await buildCleanupPrompt({
      store: fakeStore(),
      projectRoot: '/project',
      runner,
      now: () => fixedNow,
    });
    expect(prompt).toContain('acme/tools');
  });

  it('falls back to basename(projectRoot) when git remote fails', async () => {
    const runner = mockRunner({ 'git remote get-url origin': fail() });
    const prompt = await buildCleanupPrompt({
      store: fakeStore(),
      projectRoot: '/home/user/my-project',
      runner,
      now: () => fixedNow,
    });
    expect(prompt).toContain('my-project');
  });

  it('ends with exactly one newline', async () => {
    const runner = mockRunner({ 'git remote get-url origin': ok('git@github.com:x/y.git') });
    const prompt = await buildCleanupPrompt({
      store: fakeStore(),
      projectRoot: '/project',
      runner,
      now: () => fixedNow,
    });
    expect(prompt.endsWith('\n')).toBe(true);
    expect(prompt.endsWith('\n\n')).toBe(false);
  });

  it('is pure: same inputs produce identical output', async () => {
    const runner = mockRunner({ 'git remote get-url origin': ok('git@github.com:x/y.git') });
    const context = {
      store: fakeStore(2, 5),
      projectRoot: '/project',
      runner,
      now: () => fixedNow,
    };
    const a = await buildCleanupPrompt(context);
    const b = await buildCleanupPrompt(context);
    expect(a).toBe(b);
  });

  it('interpolates inProgressCount and branchedCount into context snapshot', async () => {
    const runner = mockRunner({ 'git remote get-url origin': ok('git@github.com:x/y.git') });
    const prompt = await buildCleanupPrompt({
      store: fakeStore(7, 3),
      projectRoot: '/project',
      runner,
      now: () => fixedNow,
    });
    expect(prompt).toContain('Active in-progress tasks: 7');
    expect(prompt).toContain('Non-deleted tasks with a recorded branch: 3');
  });

  it('explicitly forbids destructive git operations in constraints', async () => {
    const runner = mockRunner({ 'git remote get-url origin': ok('git@github.com:x/y.git') });
    const prompt = await buildCleanupPrompt({
      store: fakeStore(),
      projectRoot: '/project',
      runner,
      now: () => fixedNow,
    });
    expect(prompt).toContain('git branch -d');
    expect(prompt).toContain('git worktree remove');
    expect(prompt).toContain('git push');
    expect(prompt).toContain('git reset');
    // All appear in the constraints, under "never run"
    const constraintsSection = prompt.slice(
      prompt.indexOf('# Constraints'),
      prompt.indexOf('# Ordered checklist'),
    );
    expect(constraintsSection).toContain('git branch -d');
  });
});
