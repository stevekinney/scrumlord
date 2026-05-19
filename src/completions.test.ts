import { afterEach, describe, expect, it } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commandSummaries,
  defaultInstallPath,
  escapeBashWordList,
  escapeZshDescription,
  extractCommandListRegion,
  generateBashCompletions,
  generateZshCompletions,
  renderBashPositionalBranch,
  renderZshAlternative,
  renderZshArgumentsLine,
} from './completions';
import { commandSpecifications } from './cli-arguments';

const tempFiles: string[] = [];

const writeTempFile = async (name: string, content: string): Promise<string> => {
  const path = join(tmpdir(), name);
  tempFiles.push(path);
  await writeFile(path, content, 'utf-8');
  return path;
};

afterEach(async () => {
  await Promise.all(tempFiles.splice(0).map((f) => rm(f, { force: true })));
});

describe('generateBashCompletions', () => {
  it('produces a non-empty bash script', () => {
    const script = generateBashCompletions();
    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(0);
  });

  it('ends with exactly one trailing newline', () => {
    const script = generateBashCompletions();
    expect(script.endsWith('\n')).toBe(true);
    expect(script.endsWith('\n\n')).toBe(false);
  });

  it('includes the bash shebang line', () => {
    expect(generateBashCompletions()).toContain('#!/usr/bin/env bash');
  });

  it('ends with complete -F _tasks tasks', () => {
    expect(generateBashCompletions()).toContain('complete -F _tasks tasks');
  });

  it('includes _init_completion fallback', () => {
    expect(generateBashCompletions()).toContain('declare -F _init_completion');
  });

  it('includes dynamic helpers that call completions-data', () => {
    const script = generateBashCompletions();
    expect(script).toContain('tasks completions-data ids');
    expect(script).toContain('tasks completions-data tags');
  });

  it('includes __tasks_positional_index helper', () => {
    expect(generateBashCompletions()).toContain('__tasks_positional_index');
  });

  it('validates bash syntax', async () => {
    const path = await writeTempFile('tasks-test.bash', generateBashCompletions());
    const proc = Bun.spawn(['bash', '-n', path], { stdout: 'pipe', stderr: 'pipe' });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });

  it('every visible command appears in the discovery list', () => {
    const script = generateBashCompletions();
    const specs = commandSpecifications;
    const visibleCommands = Object.keys(specs).filter(
      (name) => specs[name]?.visibleInCompletions !== false,
    );
    const region = extractCommandListRegion(script, 'bash');
    for (const name of visibleCommands) {
      expect(region).toContain(name);
    }
  });

  it('completions-data does not appear in the discovery list', () => {
    const region = extractCommandListRegion(generateBashCompletions(), 'bash');
    expect(region).not.toContain('completions-data');
  });

  it('includes static enum choices for --status', () => {
    expect(generateBashCompletions()).toContain('draft');
    expect(generateBashCompletions()).toContain('in-progress');
    expect(generateBashCompletions()).toContain('completed');
  });

  it('includes static enum choices for --priority', () => {
    const script = generateBashCompletions();
    expect(script).toContain('--priority)');
    expect(script).toContain('1 2 3');
  });
});

describe('generateZshCompletions', () => {
  it('produces a non-empty zsh script', () => {
    expect(generateZshCompletions().length).toBeGreaterThan(0);
  });

  it('ends with exactly one trailing newline', () => {
    const script = generateZshCompletions();
    expect(script.endsWith('\n')).toBe(true);
    expect(script.endsWith('\n\n')).toBe(false);
  });

  it('starts with #compdef tasks on line 1', () => {
    const firstLine = generateZshCompletions().split('\n')[0];
    expect(firstLine).toBe('#compdef tasks');
  });

  it('includes dynamic helpers that call completions-data', () => {
    const script = generateZshCompletions();
    expect(script).toContain('tasks completions-data ids');
    expect(script).toContain('tasks completions-data tags');
  });

  it('validates zsh syntax when zsh is available', async () => {
    const whichProc = Bun.spawn(['which', 'zsh'], { stdout: 'pipe', stderr: 'pipe' });
    const whichExit = await whichProc.exited;
    if (whichExit !== 0) {
      console.log('zsh not on PATH — skipping zsh syntax check');
      return;
    }
    const path = await writeTempFile('tasks-test.zsh', generateZshCompletions());
    const proc = Bun.spawn(['zsh', '-n', path], { stdout: 'pipe', stderr: 'pipe' });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });

  it('every visible command appears in the zsh describe list', () => {
    const script = generateZshCompletions();
    const specs = commandSpecifications;
    const visibleCommands = Object.keys(specs).filter(
      (name) => specs[name]?.visibleInCompletions !== false,
    );
    for (const name of visibleCommands) {
      expect(script).toContain(name);
    }
  });

  it('completions-data does not appear in the zsh command describe list', () => {
    const script = generateZshCompletions();
    expect(script).not.toContain('"completions-data:');
  });
});

describe('renderBashPositionalBranch', () => {
  it('returns empty string for command with no positionalVariants', () => {
    expect(renderBashPositionalBranch('list')).toBe('');
  });

  it('returns empty string for unknown command', () => {
    expect(renderBashPositionalBranch('nonexistent')).toBe('');
  });

  it('tags position 1 includes task-id and tag action completion', () => {
    const branch = renderBashPositionalBranch('tags');
    expect(branch).toContain('__tasks_complete_ids');
    expect(branch).toContain('add');
    expect(branch).toContain('remove');
  });

  it('tags position 3 completes tags', () => {
    const branch = renderBashPositionalBranch('tags');
    expect(branch).toContain('3)');
    expect(branch).toContain('__tasks_complete_tags');
  });

  it('tags position 2 completes task IDs', () => {
    const branch = renderBashPositionalBranch('tags');
    expect(branch).toContain('2)');
    expect(branch).toContain('__tasks_complete_ids');
  });

  it('get position 1 completes task IDs', () => {
    const branch = renderBashPositionalBranch('get');
    expect(branch).toContain('__tasks_complete_ids');
  });

  it('completions position 1 completes shell names', () => {
    const branch = renderBashPositionalBranch('completions');
    expect(branch).toContain('bash');
    expect(branch).toContain('zsh');
  });

  it('blockers position 1 includes task-id and blocker action completion', () => {
    const branch = renderBashPositionalBranch('blockers');
    expect(branch).toContain('__tasks_complete_ids');
    expect(branch).toContain('add');
    expect(branch).toContain('remove');
  });

  it('blockers positions 2 and 3 complete task IDs', () => {
    const branch = renderBashPositionalBranch('blockers');
    expect(branch).toContain('2)');
    expect(branch).toContain('3)');
    expect((branch.match(/__tasks_complete_ids/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('renderZshArgumentsLine', () => {
  it('returns empty for unknown command', () => {
    expect(renderZshArgumentsLine('nonexistent', 0)).toBe('');
  });

  it('tags position 1 emits _alternative', () => {
    const line = renderZshArgumentsLine('tags', 0);
    expect(line).toContain('->pos1');
  });

  it('blockers position 1 emits _alternative', () => {
    const line = renderZshArgumentsLine('blockers', 0);
    expect(line).toContain('->pos1');
  });

  it('completions position 1 emits shell choices', () => {
    const line = renderZshArgumentsLine('completions', 0);
    expect(line).toContain('bash');
    expect(line).toContain('zsh');
  });
});

describe('renderZshAlternative', () => {
  it('renders _alternative for task-id and tag', () => {
    const result = renderZshAlternative(['task-id', 'tag']);
    expect(result).toContain('_alternative');
    expect(result).toContain('__tasks_ids');
    expect(result).toContain('__tasks_tags');
  });

  it('renders static choices for status', () => {
    const result = renderZshAlternative(['status']);
    expect(result).toContain('draft');
    expect(result).toContain('completed');
  });

  it('renders file completion for file kind', () => {
    const result = renderZshAlternative(['file']);
    expect(result).toContain('_files');
  });

  it('renders free-text as empty choices', () => {
    const result = renderZshAlternative(['free-text']);
    expect(result).toContain('free-text');
  });
});

describe('extractCommandListRegion', () => {
  it('extracts bash command list tokens', () => {
    const script = generateBashCompletions();
    const region = extractCommandListRegion(script, 'bash');
    expect(region).toContain('get');
    expect(region).toContain('completions');
    expect(region).not.toContain('completions-data');
  });

  it('extracts zsh command list tokens', () => {
    const script = generateZshCompletions();
    const region = extractCommandListRegion(script, 'zsh');
    expect(region.length).toBeGreaterThan(0);
  });

  it('returns empty for zsh script with no _describe command section', () => {
    const region = extractCommandListRegion('no describe here', 'zsh');
    expect(region).toEqual([]);
  });

  it('returns empty for bash script with no __tasks_reply_from_words', () => {
    const region = extractCommandListRegion('no match here', 'bash');
    expect(region).toEqual([]);
  });
});

describe('defaultInstallPath', () => {
  it('bash: uses BASH_COMPLETION_USER_DIR when set', () => {
    const path = defaultInstallPath('bash', { BASH_COMPLETION_USER_DIR: '/custom/bash' });
    expect(path).toBe('/custom/bash/completions/tasks');
  });

  it('bash: falls back to XDG_DATA_HOME', () => {
    const path = defaultInstallPath('bash', { XDG_DATA_HOME: '/xdg' });
    expect(path).toBe('/xdg/bash-completion/completions/tasks');
  });

  it('bash: falls back to HOME/.local/share', () => {
    const path = defaultInstallPath('bash', { HOME: '/home/user' });
    expect(path).toBe('/home/user/.local/share/bash-completion/completions/tasks');
  });

  it('bash: throws no_install_path when no env vars set', () => {
    expect(() => defaultInstallPath('bash', {})).toThrow();
  });

  it('zsh: uses XDG_DATA_HOME when set', () => {
    const path = defaultInstallPath('zsh', { XDG_DATA_HOME: '/xdg' });
    expect(path).toBe('/xdg/zsh/site-functions/_tasks');
  });

  it('zsh: falls back to HOME/.local/share', () => {
    const path = defaultInstallPath('zsh', { HOME: '/home/user' });
    expect(path).toBe('/home/user/.local/share/zsh/site-functions/_tasks');
  });

  it('zsh: throws no_install_path when no HOME or XDG set', () => {
    expect(() => defaultInstallPath('zsh', {})).toThrow();
  });
});

describe('escapeBashWordList', () => {
  it('escapes spaces', () => {
    expect(escapeBashWordList('tag with space')).toBe('tag\\ with\\ space');
  });

  it('escapes dollar signs', () => {
    expect(escapeBashWordList('tag$var')).toBe('tag\\$var');
  });

  it('escapes backticks', () => {
    expect(escapeBashWordList('tag`cmd`')).toBe('tag\\`cmd\\`');
  });

  it('escapes double quotes', () => {
    expect(escapeBashWordList('say "hello"')).toBe('say\\ \\"hello\\"');
  });

  it('escapes single quotes', () => {
    expect(escapeBashWordList("tag'quote")).toBe("tag\\'quote");
  });

  it('leaves plain text unchanged', () => {
    expect(escapeBashWordList('plaintext')).toBe('plaintext');
  });

  it('handles empty string', () => {
    expect(escapeBashWordList('')).toBe('');
  });
});

describe('escapeZshDescription', () => {
  it('escapes colons', () => {
    expect(escapeZshDescription('a:b')).toBe('a\\:b');
  });

  it('escapes brackets', () => {
    expect(escapeZshDescription('[opt]')).toBe('\\[opt\\]');
  });

  it('escapes single quotes', () => {
    expect(escapeZshDescription("it's")).toBe("it\\'s");
  });

  it('escapes dollar signs', () => {
    expect(escapeZshDescription('$var')).toBe('\\$var');
  });

  it('escapes backticks', () => {
    expect(escapeZshDescription('`cmd`')).toBe('\\`cmd\\`');
  });

  it('leaves plain text unchanged', () => {
    expect(escapeZshDescription('plaintext')).toBe('plaintext');
  });

  it('handles empty string', () => {
    expect(escapeZshDescription('')).toBe('');
  });
});

describe('commandSummaries', () => {
  it('covers every visible command', () => {
    const specs = commandSpecifications;
    const visibleCommands = Object.keys(specs).filter(
      (name) => specs[name]?.visibleInCompletions !== false,
    );
    for (const name of visibleCommands) {
      expect(commandSummaries).toHaveProperty(name);
      expect((commandSummaries[name] ?? '').length).toBeGreaterThan(0);
    }
  });

  it('does not include completions-data', () => {
    expect(commandSummaries).not.toHaveProperty('completions-data');
  });
});
