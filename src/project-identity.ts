import type { Database } from 'bun:sqlite';
import { basename, dirname } from 'node:path';
import { runCommand as defaultRunner, type CommandRunner } from './command-runner.js';
import { ScrumlordError } from './errors.js';
import { repositoryName } from './github.js';
import { repoCommonDir } from './worktree.js';

type QueryBindings = Record<string, string | number | null>;

/**
 * A row in the shared database's `projects` table. `git_common_dir` is the
 * canonical (absolute, symlink-resolved) `.git/` directory of the repository,
 * used both as the resolution cache key and as the filesystem anchor for
 * git/worktree-dependent commands. It is `null` for projects that exist only as
 * a database scope (e.g. selected via `--project` before the repo is known).
 */
export type ProjectRow = {
  id: number;
  name_with_owner: string;
  name_with_owner_key: string;
  repository_name_key: string;
  git_common_dir: string | null;
  remote_url: string | null;
  last_resolved_at: string | null;
};

/**
 * The result of resolving the project scope for a command. A resolved project
 * carries its surrogate id and cached identity; an unresolved project (no git,
 * no `gh`, offline first run with no cache) scopes reads to zero rows and makes
 * mutating commands fail with `project_unresolved`.
 */
export type ResolvedProject =
  | { status: 'resolved'; id: number; nameWithOwner: string; gitCommonDir: string | null }
  | { status: 'unresolved' };

export type ResolveProjectOptions = {
  /** Working directory used for git/`gh` resolution. */
  cwd: string;
  /** Explicit `--project` selector (exact `owner/repo` or a bare repo name). */
  projectFlag?: string;
  runner?: CommandRunner;
};

const normalizeKey = (value: string): string => value.trim().toLowerCase();

/**
 * Parses an `owner/repo` slug out of a git remote URL. Handles SSH
 * (`git@host:owner/repo.git`) and HTTPS (`https://host/owner/repo.git`) forms.
 * Returns `null` when neither shape matches.
 */
export const parseRepoName = (url: string): string | null => {
  const trimmed = url.trim();
  const sshMatch = /^git@[^:]+:(.+?)(?:\.git)?$/.exec(trimmed);
  if (sshMatch) return sshMatch[1] ?? null;
  const httpsMatch = /^https?:\/\/[^/]+\/(.+?)(?:\.git)?$/.exec(trimmed);
  if (httpsMatch) return httpsMatch[1] ?? null;
  return null;
};

const findProjectByNameKey = (database: Database, key: string): ProjectRow | null =>
  database
    .query<ProjectRow, QueryBindings>('SELECT * FROM projects WHERE name_with_owner_key = $key')
    .get({ key });

const findProjectsByRepositoryKey = (database: Database, key: string): ProjectRow[] =>
  database
    .query<
      ProjectRow,
      QueryBindings
    >('SELECT * FROM projects WHERE repository_name_key = $key ORDER BY name_with_owner_key ASC')
    .all({ key });

const findProjectByCommonDir = (database: Database, dir: string): ProjectRow | null =>
  database
    .query<ProjectRow, QueryBindings>('SELECT * FROM projects WHERE git_common_dir = $dir')
    .get({ dir });

const repositoryKeyOf = (nameWithOwner: string): string => {
  const [, name] = nameWithOwner.split('/');
  return normalizeKey(name ?? nameWithOwner);
};

/**
 * Inserts or updates the `projects` row for a freshly-resolved repository,
 * keyed by `git_common_dir`. Renames (a new `name_with_owner` for an existing
 * common dir) update the row in place so its tasks stay attached. A new name
 * that already belongs to a *different* row is a conflict — we never split one
 * repository's tasks across two surrogate ids.
 */
const upsertResolvedProject = (
  database: Database,
  input: {
    nameWithOwner: string;
    gitCommonDir: string;
    remoteUrl: string | null;
    now: string;
  },
): ProjectRow => {
  const nameKey = normalizeKey(input.nameWithOwner);
  const repoKey = repositoryKeyOf(input.nameWithOwner);
  const existingByDir = findProjectByCommonDir(database, input.gitCommonDir);
  const existingByName = findProjectByNameKey(database, nameKey);

  // The name is taken by a different surrogate id than the one anchored to this
  // common dir, and that other row is bound to its own (different) working tree.
  // Reconciling would mean merging two task scopes — refuse.
  if (
    existingByName &&
    (!existingByDir || existingByName.id !== existingByDir.id) &&
    existingByName.git_common_dir &&
    existingByName.git_common_dir !== input.gitCommonDir
  ) {
    throw new ScrumlordError(
      'project_identity_conflict',
      `GitHub repository ${input.nameWithOwner} is already registered for a different ` +
        `working tree (${existingByName.git_common_dir}). Reconcile the projects manually.`,
    );
  }

  const target = existingByDir ?? existingByName;
  if (target) {
    database
      .query<unknown, QueryBindings>(
        `UPDATE projects SET
           name_with_owner = $nameWithOwner,
           name_with_owner_key = $nameKey,
           repository_name_key = $repoKey,
           git_common_dir = $gitCommonDir,
           remote_url = $remoteUrl,
           last_resolved_at = $now
         WHERE id = $id`,
      )
      .run({
        nameWithOwner: input.nameWithOwner,
        nameKey,
        repoKey,
        gitCommonDir: input.gitCommonDir,
        remoteUrl: input.remoteUrl,
        now: input.now,
        id: target.id,
      });
    return database
      .query<ProjectRow, QueryBindings>('SELECT * FROM projects WHERE id = $id')
      .get({ id: target.id })!;
  }

  database
    .query<unknown, QueryBindings>(
      `INSERT INTO projects (
         name_with_owner, name_with_owner_key, repository_name_key,
         git_common_dir, remote_url, last_resolved_at
       ) VALUES ($nameWithOwner, $nameKey, $repoKey, $gitCommonDir, $remoteUrl, $now)`,
    )
    .run({
      nameWithOwner: input.nameWithOwner,
      nameKey,
      repoKey,
      gitCommonDir: input.gitCommonDir,
      remoteUrl: input.remoteUrl,
      now: input.now,
    });
  return findProjectByCommonDir(database, input.gitCommonDir)!;
};

/**
 * Resolves the project named by a `--project` selector. Matches an exact
 * `owner/repo` first, then falls back to a bare repository-name shorthand that
 * must match exactly one stored project. Never shells out to `gh` — an explicit
 * selector is authoritative.
 */
const resolveFromFlag = (database: Database, projectFlag: string): ResolvedProject => {
  const key = normalizeKey(projectFlag);
  const exact = findProjectByNameKey(database, key);
  if (exact) {
    return {
      status: 'resolved',
      id: exact.id,
      nameWithOwner: exact.name_with_owner,
      gitCommonDir: exact.git_common_dir,
    };
  }

  const shorthandMatches = findProjectsByRepositoryKey(database, key);
  if (shorthandMatches.length === 0) {
    throw new ScrumlordError(
      'project_not_found',
      `No project matches --project ${projectFlag}. Pass an exact owner/repo, or run a command ` +
        `from the repository to register it.`,
    );
  }
  if (shorthandMatches.length > 1) {
    const names = shorthandMatches.map((row) => row.name_with_owner).join(', ');
    throw new ScrumlordError(
      'ambiguous_project',
      `--project ${projectFlag} is ambiguous. Matches: ${names}. Pass an exact owner/repo.`,
    );
  }
  const [match] = shorthandMatches;
  return {
    status: 'resolved',
    id: match!.id,
    nameWithOwner: match!.name_with_owner,
    gitCommonDir: match!.git_common_dir,
  };
};

const remoteUrlOf = async (cwd: string, runner: CommandRunner): Promise<string | null> => {
  const result = await runner(['git', 'remote', 'get-url', 'origin'], cwd);
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
};

/**
 * Derives a stable `local/<repo>` name from a repository's canonical
 * `git_common_dir`. Used as the offline fallback when neither `gh` nor a
 * parseable remote can name the repository, so any git repo still scopes to a
 * deterministic project. The row stays keyed by `git_common_dir`, so a later
 * successful `gh` resolve upgrades the name in place.
 */
const localProjectName = (gitCommonDir: string): string => {
  // git_common_dir is usually `<repo>/.git`; the repo is its parent's basename.
  const parent = basename(dirname(gitCommonDir)) || basename(gitCommonDir) || 'repository';
  return `local/${parent}`;
};

const asResolved = (row: ProjectRow): ResolvedProject => ({
  status: 'resolved',
  id: row.id,
  nameWithOwner: row.name_with_owner,
  gitCommonDir: row.git_common_dir,
});

/**
 * Determines the GitHub name for a repository: the authoritative `gh repo view`
 * result, falling back (when `gh` is unavailable) to the cached name, then the
 * parsed remote URL, then a stable `local/<repo>` derived from the git dir.
 */
const resolveNameWithOwner = async (
  cwd: string,
  runner: CommandRunner,
  gitCommonDir: string,
  currentRemote: string | null,
  cached: ProjectRow | null,
): Promise<string | null> => {
  try {
    return await repositoryName(cwd, { runner });
  } catch {
    if (cached) return null; // signal: keep the cached row as-is
    return (currentRemote ? parseRepoName(currentRemote) : null) ?? localProjectName(gitCommonDir);
  }
};

/**
 * Resolves the project scope for the current command. Resolution order:
 *
 * 1. `--project` selector (exact then bare-name shorthand).
 * 2. The repository's cached row, keyed by canonical `git_common_dir`. Cache
 *    hits are revalidated cheaply against the current `origin` remote URL.
 * 3. A fresh `gh repo view` lookup, persisted for next time.
 *
 * When none of these can produce a project (no git, no `gh`, offline first run
 * with no cache), returns the `unresolved` sentinel.
 */
export const resolveProject = async (
  database: Database,
  options: ResolveProjectOptions,
): Promise<ResolvedProject> => {
  const runner = options.runner ?? defaultRunner;

  if (options.projectFlag !== undefined && options.projectFlag.trim()) {
    return resolveFromFlag(database, options.projectFlag);
  }

  let gitCommonDir: string;
  try {
    gitCommonDir = await repoCommonDir(options.cwd, runner);
  } catch {
    return { status: 'unresolved' };
  }

  const currentRemote = await remoteUrlOf(options.cwd, runner);
  const cached = findProjectByCommonDir(database, gitCommonDir);
  if (cached && cached.remote_url === currentRemote) return asResolved(cached);

  const nameWithOwner = await resolveNameWithOwner(
    options.cwd,
    runner,
    gitCommonDir,
    currentRemote,
    cached,
  );
  if (nameWithOwner === null && cached) return asResolved(cached);

  const row = upsertResolvedProject(database, {
    nameWithOwner: nameWithOwner!,
    gitCommonDir,
    remoteUrl: currentRemote,
    now: new Date().toISOString(),
  });
  return asResolved(row);
};

/**
 * Ensures a `projects` row exists for the current repository and returns its id.
 * Used by mutating entry points (task creation, `init`, the importer) that must
 * have a concrete project to attach rows to. Throws `project_unresolved` when no
 * repository can be identified.
 */
export const requireProjectId = async (
  database: Database,
  options: ResolveProjectOptions,
): Promise<number> => {
  const resolved = await resolveProject(database, options);
  if (resolved.status === 'resolved') return resolved.id;
  throw new ScrumlordError(
    'project_unresolved',
    'Could not determine the current project. Run inside a git repository with an ' +
      'authenticated `gh`, or pass --project owner/repo.',
  );
};

/**
 * Guards filesystem/git-dependent commands against a `--project` selector that
 * points at a different repository than the current working directory. Mutating
 * path-bearing metadata (plan paths, worktrees, PR state) for project B while
 * standing in project A's tree would corrupt both, so we require the selected
 * project's cached `git_common_dir` to match the live one.
 */
export const assertProjectMatchesWorkingTree = async (
  project: Extract<ResolvedProject, { status: 'resolved' }>,
  cwd: string,
  runner: CommandRunner = defaultRunner,
): Promise<void> => {
  let liveCommonDir: string;
  try {
    liveCommonDir = await repoCommonDir(cwd, runner);
  } catch {
    throw new ScrumlordError(
      'project_root_mismatch',
      `This command needs to run inside the ${project.nameWithOwner} working tree.`,
    );
  }
  if (project.gitCommonDir === null || project.gitCommonDir !== liveCommonDir) {
    throw new ScrumlordError(
      'project_root_mismatch',
      `--project ${project.nameWithOwner} does not match the current working tree ` +
        `(${basename(cwd)}). Run this command from that repository.`,
    );
  }
};
