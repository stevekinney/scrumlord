import { $ } from 'bun';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ScrumlordError } from './errors.js';

type WorktreeEntry = {
  bare: boolean;
  path: string;
};

const hasWorkspaces = (packageJson: unknown): boolean => {
  if (!packageJson || typeof packageJson !== 'object') return false;
  if (!('workspaces' in packageJson)) return false;
  const { workspaces } = packageJson;
  if (Array.isArray(workspaces)) return workspaces.length > 0;
  if (!workspaces || typeof workspaces !== 'object' || !('packages' in workspaces)) return false;
  return Array.isArray(workspaces.packages) && workspaces.packages.length > 0;
};

const findWorkspaceRoot = async (cwd: string): Promise<string | null> => {
  let current = resolve(cwd);

  while (true) {
    const packageJsonPath = join(current, 'package.json');
    const packageJsonFile = Bun.file(packageJsonPath);
    if (await packageJsonFile.exists()) {
      try {
        if (hasWorkspaces(await packageJsonFile.json())) return current;
      } catch {
        throw new ScrumlordError(
          'invalid_workspace_package_json',
          `Could not parse workspace package.json: ${packageJsonPath}`,
        );
      }
    }

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

const resolveGitMetadataPath = (cwd: string, path: string): string =>
  isAbsolute(path) ? path : resolve(cwd, path);

const isInsideDirectory = (directory: string, candidate: string): boolean => {
  const relativePath = relative(directory, candidate);
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath);
};

const isLinkedWorktreeGitDirectory = (
  commonGitDirectory: string,
  absoluteGitDirectory: string,
): boolean => isInsideDirectory(join(commonGitDirectory, 'worktrees'), absoluteGitDirectory);

const parseWorktreeEntries = (output: string): WorktreeEntry[] => {
  const entries: WorktreeEntry[] = [];
  let currentEntry: WorktreeEntry | null = null;

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      currentEntry = { bare: false, path: line.slice('worktree '.length) };
      entries.push(currentEntry);
      continue;
    }

    if (line === 'bare' && currentEntry) currentEntry.bare = true;
  }

  return entries;
};

const findPrimaryWorktreeRoot = async (
  cwd: string,
  commonGitDirectory: string,
  absoluteGitDirectory: string,
): Promise<string | null> => {
  if (!isLinkedWorktreeGitDirectory(commonGitDirectory, absoluteGitDirectory)) return null;

  const result = await $`git -C ${cwd} worktree list --porcelain`.quiet().nothrow();
  if (result.exitCode !== 0) return null;

  const [primaryWorktree] = parseWorktreeEntries(result.stdout.toString());
  return primaryWorktree && !primaryWorktree.bare ? primaryWorktree.path : null;
};

const findGitRoot = async (cwd: string): Promise<string | null> => {
  if (!Bun.which('git')) return null;
  const result =
    await $`git -C ${cwd} rev-parse --show-toplevel --git-common-dir --absolute-git-dir`
      .quiet()
      .nothrow();
  if (result.exitCode !== 0) return null;
  const [workingTreeRoot, commonGitDirectory, absoluteGitDirectory] = result.stdout
    .toString()
    .trim()
    .split(/\r?\n/);
  if (!workingTreeRoot) return null;
  if (!commonGitDirectory || !absoluteGitDirectory) return workingTreeRoot;

  const primaryWorktreeRoot = await findPrimaryWorktreeRoot(
    cwd,
    resolveGitMetadataPath(cwd, commonGitDirectory),
    resolveGitMetadataPath(cwd, absoluteGitDirectory),
  );
  return primaryWorktreeRoot ?? workingTreeRoot;
};

/** Resolves the project root before any command creates a task database. */
export const resolveProjectRoot = async (cwd = process.cwd()): Promise<string> => {
  const gitRoot = await findGitRoot(cwd);
  if (gitRoot) return gitRoot;

  const workspaceRoot = await findWorkspaceRoot(cwd);
  if (workspaceRoot) return workspaceRoot;

  throw new ScrumlordError(
    'project_root_not_found',
    'Could not find a Git repository root or npm workspace root from the current directory.',
  );
};
