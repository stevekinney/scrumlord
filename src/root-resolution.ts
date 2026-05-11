import { $ } from 'bun';
import { dirname, join, resolve } from 'node:path';
import { ScrumlordError } from './errors.js';

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
    const packageJsonFile = Bun.file(join(current, 'package.json'));
    if (await packageJsonFile.exists()) {
      if (hasWorkspaces(await packageJsonFile.json())) return current;
    }

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

const findGitRoot = async (cwd: string): Promise<string | null> => {
  const result = await $`git -C ${cwd} rev-parse --show-toplevel`.quiet().nothrow();
  if (result.exitCode !== 0) return null;
  const root = result.stdout.toString().trim();
  return root || null;
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
