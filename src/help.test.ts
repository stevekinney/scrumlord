import { describe, expect, it } from 'bun:test';
import { helpTopics, renderHelp } from './help';

const expectedTopics = [
  'init',
  'available',
  'list',
  'blocked',
  'completed',
  'current',
  'next',
  'remaining',
  'repository',
  'session',
  'progress',
  'start',
  'resume',
  'pipeline',
  'get',
  'tagged',
  'with-branch',
  'blocked-by',
  'blocking',
  'priority',
  'with-priority',
  'create',
  'update',
  'set-status',
  'set-branch',
  'clear-branch',
  'set-plan',
  'clear-plan',
  'set-session',
  'clear-session',
  'add-progress',
  'delete',
  'add-tag',
  'remove-tag',
  'add-blocker',
  'remove-blocker',
  'cleanup',
  'sync-git-status',
  'overview',
  'setup-skills',
  'setup',
  'setup status',
  'setup-subagents',
  'setup-git-hooks',
  'setup-agent-hooks',
  'agent-hook',
  'pr',
];

describe('renderHelp', () => {
  it('has a help topic for every CLI command', () => {
    expect(helpTopics).toEqual(expectedTopics);
  });

  it('renders comprehensive main help', () => {
    const help = renderHelp([], 'never');

    expect(help).toContain('Scrumlord Tasks CLI');
    expect(help).toContain('tasks <command> [options]');
    expect(help).toContain('init');
    expect(help).toContain('setup');
    expect(help).toContain('setup-subagents');
    expect(help).toContain('setup-git-hooks');
    expect(help).toContain('setup-agent-hooks');
    expect(help).toContain('All data commands return JSON.');
    expect(help).not.toContain('\u001b[');
  });

  it('renders command help with color when requested', () => {
    const help = renderHelp(['create'], 'always');

    expect(help).toContain('\u001b[');
    expect(help).toContain('tasks create --title <title> [options]');
    expect(help).toContain('--blocked-by');
    expect(help).toContain('--provider');
  });

  it('renders nested command help', () => {
    const setupStatusHelp = renderHelp(['setup', 'status'], 'never');
    expect(setupStatusHelp).toContain('tasks setup status');
    expect(setupStatusHelp).toContain('tasksExecutable');
  });

  it('renders command arguments', () => {
    const help = renderHelp(['get'], 'never');

    expect(help).toContain('Arguments:');
    expect(help).toContain('[task-id]: Optional task ID.');
    expect(help).toContain('single active task assigned to the current Git branch');
  });

  it('returns null for unknown topics', () => {
    expect(renderHelp(['unknown'], 'never')).toBeNull();
  });
});
