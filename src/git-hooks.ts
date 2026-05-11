import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandRunner, CommandResult } from './command-runner.js';
import { runCommand } from './command-runner.js';

export type SetupGitHooksResult = {
  configurationPath: string | null;
  changed: boolean;
  hooks: string[];
  install: CommandResult | null;
};

type SetupGitHooksOptions = {
  runner?: CommandRunner;
  install?: boolean;
};

const managedHooks = ['post-checkout', 'post-commit', 'post-merge', 'pre-push'] as const;
const managedCommand = 'tasks sync-git-status --quiet';
const managedJob = ['    - name: tasks-sync-git-status', `      run: ${managedCommand}`];
const lefthookConfigurationNames = [
  'lefthook.yml',
  'lefthook.yaml',
  '.lefthook.yml',
  '.lefthook.yaml',
];

const findConfigurationPath = (projectRoot: string): string | null => {
  for (const name of lefthookConfigurationNames) {
    const path = join(projectRoot, name);
    if (existsSync(path)) return path;
  }
  return null;
};

const sectionRange = (lines: string[], hook: string): { start: number; end: number } | null => {
  const start = lines.findIndex((line) => line === `${hook}:`);
  if (start === -1) return null;
  const nextTopLevel = lines.findIndex(
    (line, index) => index > start && /^\S[^:]*:\s*$/.test(line),
  );
  return { start, end: nextTopLevel === -1 ? lines.length : nextTopLevel };
};

const appendHook = (lines: string[], hook: string): void => {
  if (lines.at(-1) !== '') lines.push('');
  lines.push(`${hook}:`, '  jobs:', ...managedJob);
};

const ensureHook = (lines: string[], hook: string): boolean => {
  const range = sectionRange(lines, hook);
  if (!range) {
    appendHook(lines, hook);
    return true;
  }

  const section = lines.slice(range.start, range.end);
  if (section.some((line) => line.includes(managedCommand))) return false;

  const jobsIndex = lines.findIndex(
    (line, index) => index > range.start && index < range.end && line.trim() === 'jobs:',
  );
  if (jobsIndex === -1) {
    lines.splice(range.start + 1, 0, '  jobs:', ...managedJob);
    return true;
  }

  lines.splice(jobsIndex + 1, 0, ...managedJob);
  return true;
};

/** Adds Lefthook jobs that keep branch-bound task status synchronized with Git and GitHub. */
export const setupGitHooks = async (
  projectRoot: string,
  options: SetupGitHooksOptions = {},
): Promise<SetupGitHooksResult> => {
  const configurationPath = findConfigurationPath(projectRoot);
  if (!configurationPath) {
    return { configurationPath: null, changed: false, hooks: [], install: null };
  }

  const configuration = await Bun.file(configurationPath).text();
  const lines = configuration.split('\n');
  const changedHooks = managedHooks.filter((hook) => ensureHook(lines, hook));
  if (changedHooks.length > 0) {
    await Bun.write(configurationPath, `${lines.join('\n').replace(/\n*$/, '')}\n`);
  }

  const install =
    options.install === false
      ? null
      : await (options.runner ?? runCommand)(['bun', 'run', 'lefthook', 'install'], projectRoot);

  return { configurationPath, changed: changedHooks.length > 0, hooks: [...managedHooks], install };
};
