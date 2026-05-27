import { describe, expect, it } from 'bun:test';
import { helpTopics, renderHelp } from './help';

const expectedTopics = [
  'init',
  'available',
  'list',
  'blocked',
  'completed',
  'complete',
  'current',
  'peek',
  'remaining',
  'repository',
  'session',
  'progress',
  'progress list',
  'progress add',
  'clear',
  'start',
  'pipeline',
  'get',
  'tagged',
  'with-branch',
  'blocked-by',
  'blocking',
  'priority',
  'status',
  'create',
  'update',
  'delete',
  'tags',
  'tags add',
  'tags remove',
  'blockers',
  'blockers add',
  'blockers remove',
  'overview',
  'setup',
  'setup status',
  'agent-hook',
  'pr',
  'search',
  'prompt',
  'prompt next',
  'prompt plan',
  'prompt resolve',
  'prompt sync',
  'prompt audit',
  'prompt merge',
  'prompt cleanup',
  'teleport',
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

  it('renders prompt cleanup help with graph flags', () => {
    const help = renderHelp(['prompt', 'cleanup'], 'never');
    expect(help).toContain('--recover-orphans');
    expect(help).toContain('--orphans-only');
    expect(help).toContain('--dry-run');
    expect(help).toContain('--print');
    expect(help).toContain('tasks prompt cleanup --orphans-only --dry-run');
    expect(help).toContain('tasks prompt cleanup --cli claude');
  });
});

describe('renderHelp — teleport', () => {
  it('renders teleport help with usage, argument, and shell-function example', () => {
    const help = renderHelp(['teleport'], 'never');
    expect(help).not.toBeNull();
    expect(help).toContain('tasks teleport <task-id>');
    expect(help).toContain('<task-id>: UUID');
    expect(help).toContain('cd "$(tasks teleport current --print)"');
  });

  it('renders setup help listing --shell mode', () => {
    const help = renderHelp(['setup'], 'never');
    expect(help).toContain('--shell');
    expect(help).toContain('tasks setup --shell');
  });
});
