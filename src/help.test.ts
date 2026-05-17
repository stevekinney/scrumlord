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
  'plan',
  'repository',
  'session',
  'progress',
  'progress list',
  'progress add',
  'clear',
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
  'delete',
  'add-tag',
  'remove-tag',
  'add-blocker',
  'remove-blocker',
  'cleanup',
  'overview',
  'setup',
  'setup status',
  'agent-hook',
  'pr',
  'search',
  'completions',
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
    expect(help).toContain('<task-id>: Task ID.');
    expect(help).toContain('"current" (the active task on the current Git branch)');
  });

  it('returns null for unknown topics', () => {
    expect(renderHelp(['unknown'], 'never')).toBeNull();
  });

  it('renders cleanup help with new flags', () => {
    const help = renderHelp(['cleanup'], 'never');
    expect(help).toContain('--recover-orphans');
    expect(help).toContain('--orphans-only');
    expect(help).toContain('--dry-run');
    expect(help).toContain('--prompt');
    expect(help).toContain('tasks cleanup --prompt | claude --print');
    expect(help).toContain('tasks cleanup --orphans-only');
    expect(help).toContain('tasks cleanup 30 --recover-orphans --dry-run');
  });
});
