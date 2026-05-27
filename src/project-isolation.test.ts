import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectRejection } from '../test/store';
import { runTasksCli } from './cli-runner';
import type { CommandResult, CommandRunner } from './command-runner';
import { createTaskStore } from './database-open';
import { ScrumlordError } from './errors';
import { resolveProject } from './project-identity';
import { runMigrations } from './schema';
import type { TaskStore } from './types';

const directories: string[] = [];
const tempDir = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
};

const initRepo = async (root: string): Promise<void> => {
  await Bun.spawn(['git', 'init'], { cwd: root, stdout: 'pipe', stderr: 'pipe' }).exited;
};

/**
 * Gives the repo a deterministic `origin` so project resolution (which always
 * uses the real git runner on the CLI path) names it `owner/repo` offline,
 * without depending on `gh`.
 */
const initRepoWithRemote = async (root: string, nameWithOwner: string): Promise<void> => {
  await initRepo(root);
  await Bun.spawn(['git', 'remote', 'add', 'origin', `https://github.com/${nameWithOwner}.git`], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  }).exited;
};

/** A runner that names `gh repo view` deterministically and delegates the rest. */
const namedRunner = (nameForCwd: (cwd: string) => string): CommandRunner => {
  return async (command, cwd): Promise<CommandResult> => {
    const joined = command.join(' ');
    if (joined.startsWith('gh repo view')) {
      return { exitCode: 0, stdout: `${nameForCwd(cwd)}\n`, stderr: '' };
    }
    if (joined === 'git remote get-url origin') {
      return { exitCode: 0, stdout: `https://github.com/${nameForCwd(cwd)}.git\n`, stderr: '' };
    }
    const { runCommand } = await import('./command-runner');
    return runCommand(command, cwd);
  };
};

const taskIds = (tasks: { id: string }[]): string[] => tasks.map((task) => task.id);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { force: true, recursive: true })));
});

describe('cross-project isolation', () => {
  // Two real repos sharing one database (one isolated home) so we can assert
  // project A never sees or mutates project B.
  const seedTwoProjects = async (): Promise<{
    home: string;
    rootA: string;
    rootB: string;
    runner: CommandRunner;
    storeA: () => Promise<TaskStore>;
    storeB: () => Promise<TaskStore>;
  }> => {
    const home = await tempDir('iso-home-');
    const rootA = await tempDir('iso-a-');
    const rootB = await tempDir('iso-b-');
    await initRepo(rootA);
    await initRepo(rootB);
    const runner = namedRunner((cwd) => (cwd.startsWith(rootA) ? 'octo/alpha' : 'octo/beta'));
    return {
      home,
      rootA,
      rootB,
      runner,
      storeA: () => createTaskStore({ cwd: rootA, homeDirectory: home, runner }),
      storeB: () => createTaskStore({ cwd: rootB, homeDirectory: home, runner }),
    };
  };

  it('keeps lists, lookups, tags, and dependencies scoped to one project', async () => {
    const ctx = await seedTwoProjects();

    const a = await ctx.storeA();
    const aTask = a.create({ id: 'a-1', title: 'Alpha task', tags: ['shared'] });
    const aBlocker = a.create({ id: 'a-2', title: 'Alpha blocker', tags: ['shared'] });
    a.addBlocker(aTask.id, aBlocker.id);
    a.close();

    const b = await ctx.storeB();
    b.create({ id: 'b-1', title: 'Beta task', tags: ['shared'] });
    b.close();

    const a2 = await ctx.storeA();
    expect(taskIds(a2.list())).toEqual(['a-1', 'a-2']);
    expect(taskIds(a2.withTag('shared'))).toEqual(['a-1', 'a-2']);
    expect(a2.remaining()).toBe(2);
    expect(a2.getTask('b-1')).toBeNull();
    expect(a2.allTags()).toEqual(['shared']);
    expect(taskIds(a2.blockedBy('a-1'))).toEqual(['a-2']);
    a2.close();

    const b2 = await ctx.storeB();
    expect(taskIds(b2.list())).toEqual(['b-1']);
    expect(b2.remaining()).toBe(1);
    expect(b2.getTask('a-1')).toBeNull();
    b2.close();
  });

  it('allTagsAcrossProjects spans every project; allTags stays scoped', async () => {
    const ctx = await seedTwoProjects();

    const a = await ctx.storeA();
    a.create({ id: 'a-1', title: 'Alpha task', tags: ['Alpha', 'shared'] });
    const aDeleted = a.create({ id: 'a-2', title: 'Alpha deleted', tags: ['gone'] });
    a.delete(aDeleted.id);
    a.close();

    const b = await ctx.storeB();
    b.create({ id: 'b-1', title: 'Beta task', tags: ['beta', 'shared'] });
    b.close();

    const a2 = await ctx.storeA();
    // Scoped view sees only this project's live tags (normalized to lowercase).
    expect(a2.allTags()).toEqual(['alpha', 'shared']);
    // Cross-project view is sorted, deduped (shared appears once), and excludes
    // the soft-deleted task's tag.
    expect(a2.allTagsAcrossProjects()).toEqual(['alpha', 'beta', 'shared']);
    a2.close();

    // The same cross-project answer regardless of which project's store asks.
    const b2 = await ctx.storeB();
    expect(b2.allTagsAcrossProjects()).toEqual(['alpha', 'beta', 'shared']);
    b2.close();
  });

  it('refuses to mutate or depend on another project’s task by id', async () => {
    const ctx = await seedTwoProjects();
    const a = await ctx.storeA();
    a.create({ id: 'a-1', title: 'Alpha task' });
    a.close();

    const b = await ctx.storeB();
    const bTask = b.create({ id: 'b-1', title: 'Beta task' });
    // Project B cannot see, update, delete, or block-on project A's task.
    expect(() => b.update('a-1', { title: 'hijack' })).toThrow(ScrumlordError);
    expect(() => b.delete('a-1')).toThrow(ScrumlordError);
    expect(() => b.addBlocker(bTask.id, 'a-1')).toThrow(ScrumlordError);
    b.close();

    // Project A's task is untouched.
    const a2 = await ctx.storeA();
    expect(a2.getTask('a-1')?.title).toBe('Alpha task');
    a2.close();
  });

  it('cleanup only deletes the current project’s tasks', async () => {
    const ctx = await seedTwoProjects();
    const old = () => new Date('2020-01-01T00:00:00.000Z');

    const a = await createTaskStore({
      cwd: ctx.rootA,
      homeDirectory: ctx.home,
      runner: ctx.runner,
      now: old,
    });
    a.create({ id: 'a-done', title: 'Old done', status: 'completed' });
    a.close();

    const b = await createTaskStore({
      cwd: ctx.rootB,
      homeDirectory: ctx.home,
      runner: ctx.runner,
      now: old,
    });
    b.create({ id: 'b-done', title: 'Old done', status: 'completed' });
    b.close();

    const aCleanup = await ctx.storeA();
    expect(aCleanup.cleanup(0, { hard: true })).toEqual({ deleted: 1 });
    aCleanup.close();

    // Project B's completed task survives A's cleanup.
    const b2 = await ctx.storeB();
    expect(b2.getTask('b-done')?.status).toBe('completed');
    b2.close();
  });
});

describe('project resolution', () => {
  it('caches the gh-resolved name and reuses it without calling gh again', async () => {
    const home = await tempDir('res-home-');
    const root = await tempDir('res-repo-');
    await initRepo(root);
    let ghCalls = 0;
    const runner: CommandRunner = async (command, cwd) => {
      const joined = command.join(' ');
      if (joined.startsWith('gh repo view')) {
        ghCalls += 1;
        return { exitCode: 0, stdout: 'octo/cached\n', stderr: '' };
      }
      if (joined === 'git remote get-url origin') {
        return { exitCode: 0, stdout: 'https://github.com/octo/cached.git\n', stderr: '' };
      }
      const { runCommand } = await import('./command-runner');
      return runCommand(command, cwd);
    };

    const first = await createTaskStore({ cwd: root, homeDirectory: home, runner });
    first.close();
    const second = await createTaskStore({ cwd: root, homeDirectory: home, runner });
    second.close();

    expect(ghCalls).toBe(1);
  });

  it('falls back to a stable local/<repo> name when gh is unavailable', async () => {
    const home = await tempDir('res-home-');
    const root = await tempDir('res-local-');
    await initRepo(root);
    const offline: CommandRunner = async (command, cwd) => {
      const joined = command.join(' ');
      if (joined.startsWith('gh repo view')) return { exitCode: 1, stdout: '', stderr: 'no gh' };
      if (joined === 'git remote get-url origin') return { exitCode: 1, stdout: '', stderr: '' };
      const { runCommand } = await import('./command-runner');
      return runCommand(command, cwd);
    };
    const directory = join(home, '.scrumlord');
    await mkdir(directory, { recursive: true });
    const database = new Database(join(directory, 'tasks.db'), { create: true, strict: true });
    runMigrations(database, () => new Date(), { projectRoot: directory });
    const resolved = await resolveProject(database, { cwd: root, runner: offline });
    database.close();
    expect(resolved.status).toBe('resolved');
    if (resolved.status === 'resolved') expect(resolved.nameWithOwner).toMatch(/^local\//);
  });

  it('reports an unresolved project for a non-git directory and rejects writes', async () => {
    const root = await tempDir('res-bare-');
    const home = await tempDir('res-home-');

    const read = await runTasksCli(['available'], { cwd: root, homeDirectory: home });
    expect(read.exitCode).toBe(0);
    expect(read.stderr).toContain('project: unresolved');
    expect(JSON.parse(read.stdout)).toEqual([]);

    const write = await runTasksCli(['create', '--title', 'Nope'], {
      cwd: root,
      homeDirectory: home,
    });
    expect(write.exitCode).toBe(1);
    expect(JSON.parse(write.stderr).error.code).toBe('project_unresolved');
  });

  it('resolves an exact owner/repo and an unambiguous bare shorthand, and rejects ambiguity', async () => {
    const home = await tempDir('res-home-');
    const directory = join(home, '.scrumlord');
    await mkdir(directory, { recursive: true });
    const database = new Database(join(directory, 'tasks.db'), { create: true, strict: true });
    runMigrations(database, () => new Date(), { projectRoot: directory });
    const insert = (nameWithOwner: string, repo: string) =>
      database
        .query(
          `INSERT INTO projects (name_with_owner, name_with_owner_key, repository_name_key)
           VALUES ($n, $nk, $rk)`,
        )
        .run({ n: nameWithOwner, nk: nameWithOwner.toLowerCase(), rk: repo.toLowerCase() });
    insert('octo/widget', 'widget');
    insert('acme/widget', 'widget');
    insert('octo/gadget', 'gadget');

    const exact = await resolveProject(database, { cwd: '/x', projectFlag: 'octo/widget' });
    expect(exact.status === 'resolved' && exact.nameWithOwner).toBe('octo/widget');

    const shorthand = await resolveProject(database, { cwd: '/x', projectFlag: 'gadget' });
    expect(shorthand.status === 'resolved' && shorthand.nameWithOwner).toBe('octo/gadget');

    await expectRejection(resolveProject(database, { cwd: '/x', projectFlag: 'widget' }), {
      code: 'ambiguous_project',
    });
    await expectRejection(resolveProject(database, { cwd: '/x', projectFlag: 'missing' }), {
      code: 'project_not_found',
    });

    database.close();
  });
});

describe('--project working-tree guard', () => {
  it('rejects a filesystem-dependent command pointed at a different project', async () => {
    const home = await tempDir('guard-home-');
    const rootA = await tempDir('guard-a-');
    const rootB = await tempDir('guard-b-');
    await initRepoWithRemote(rootA, 'octo/alpha');
    await initRepoWithRemote(rootB, 'octo/beta');

    // Register both projects by running a database-only command in each.
    await runTasksCli(['available'], { cwd: rootA, homeDirectory: home });
    await runTasksCli(['available'], { cwd: rootB, homeDirectory: home });

    // A locate (filesystem-dependent) from rootA but scoped to project beta
    // must be refused rather than operating across working trees.
    const result = await runTasksCli(['locate', 'whatever', '--project', 'octo/beta'], {
      cwd: rootA,
      homeDirectory: home,
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe('project_root_mismatch');
  });

  it('allows a database-only command to target another project with --project', async () => {
    const home = await tempDir('guard-home-');
    const rootA = await tempDir('guard-a-');
    const rootB = await tempDir('guard-b-');
    await initRepoWithRemote(rootA, 'octo/alpha');
    await initRepoWithRemote(rootB, 'octo/beta');

    const beta = await createTaskStore({ cwd: rootB, homeDirectory: home });
    beta.create({ id: 'beta-1', title: 'Beta task' });
    beta.close();

    // From rootA, list project beta by exact name — allowed (no filesystem work).
    const result = await runTasksCli(['list', '--project', 'octo/beta'], {
      cwd: rootA,
      homeDirectory: home,
    });
    expect(result.exitCode).toBe(0);
    expect(taskIds(JSON.parse(result.stdout))).toEqual(['beta-1']);
  });
});

describe('createTaskStore failure paths', () => {
  it('wraps a migration failure as migration_failed and closes the database', async () => {
    const home = await tempDir('mf-home-');
    const root = await tempDir('mf-repo-');
    await initRepo(root);
    const directory = join(home, '.scrumlord');
    await mkdir(directory, { recursive: true });
    // Seed a pre-v8 shared database with a stray task so v8's guard trips.
    const database = new Database(join(directory, 'tasks.db'), { create: true, strict: true });
    database.run(
      `CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL, created_at TEXT NOT NULL,
        start_date TEXT, due_date TEXT, last_modified_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0, branch TEXT, plan TEXT, provider TEXT, session TEXT);`,
    );
    database.run(`CREATE TABLE task_tags (task_id TEXT, tag TEXT);`);
    database.run(`CREATE TABLE task_dependencies (task_id TEXT, blocked_by_task_id TEXT);`);
    database.run(
      `CREATE TABLE task_progress (id TEXT PRIMARY KEY, task_id TEXT, message TEXT, created_at TEXT,
        provider TEXT, session TEXT, event TEXT, tool TEXT, cwd TEXT, transcript_path TEXT, commit_sha TEXT);`,
    );
    database.run(
      `CREATE TABLE task_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);`,
    );
    for (let version = 1; version <= 7; version += 1) {
      database
        .query('INSERT INTO task_migrations (version, name, applied_at) VALUES ($v, $n, $a)')
        .run({ v: version, n: `legacy-${version}`, a: '2026-01-01' });
    }
    database.run(
      `INSERT INTO tasks (id, title, status, priority, created_at, last_modified_at)
       VALUES ('stray', 'Stray', 'ready', 1, '2026-01-01', '2026-01-01');`,
    );
    database.close();

    await expectRejection(createTaskStore({ cwd: root, homeDirectory: home }), {
      code: 'migration_failed',
    });
  });

  it('propagates an ambiguous --project error and closes the database', async () => {
    const home = await tempDir('amb-home-');
    const root = await tempDir('amb-repo-');
    await initRepo(root);
    const directory = join(home, '.scrumlord');
    await mkdir(directory, { recursive: true });
    const database = new Database(join(directory, 'tasks.db'), { create: true, strict: true });
    runMigrations(database, () => new Date(), { projectRoot: directory });
    const insert = (nameWithOwner: string, repo: string) =>
      database
        .query(
          `INSERT INTO projects (name_with_owner, name_with_owner_key, repository_name_key)
           VALUES ($n, $nk, $rk)`,
        )
        .run({ n: nameWithOwner, nk: nameWithOwner.toLowerCase(), rk: repo.toLowerCase() });
    insert('octo/widget', 'widget');
    insert('acme/widget', 'widget');
    database.close();

    await expectRejection(
      createTaskStore({ cwd: root, homeDirectory: home, projectFlag: 'widget' }),
      {
        code: 'ambiguous_project',
      },
    );
  });
});

describe('migration v8 guard', () => {
  it('throws migration_unsafe when the tasks table already has rows', async () => {
    const database = new Database(':memory:', { create: true, strict: true });
    // Build the pre-v8 schema with one row, then run migrations.
    database.run(
      `CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL, created_at TEXT NOT NULL,
        start_date TEXT, due_date TEXT, last_modified_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0, branch TEXT, plan TEXT, provider TEXT, session TEXT);`,
    );
    database.run(`CREATE TABLE task_tags (task_id TEXT, tag TEXT);`);
    database.run(`CREATE TABLE task_dependencies (task_id TEXT, blocked_by_task_id TEXT);`);
    database.run(
      `CREATE TABLE task_progress (id TEXT PRIMARY KEY, task_id TEXT, message TEXT, created_at TEXT,
        provider TEXT, session TEXT, event TEXT, tool TEXT, cwd TEXT, transcript_path TEXT, commit_sha TEXT);`,
    );
    database.run(
      `CREATE TABLE task_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);`,
    );
    for (let version = 1; version <= 7; version += 1) {
      database
        .query('INSERT INTO task_migrations (version, name, applied_at) VALUES ($v, $n, $a)')
        .run({ v: version, n: `legacy-${version}`, a: '2026-01-01' });
    }
    database.run(
      `INSERT INTO tasks (id, title, status, priority, created_at, last_modified_at)
       VALUES ('x', 'Stray', 'ready', 1, '2026-01-01', '2026-01-01');`,
    );

    expect(() => runMigrations(database, () => new Date(), { projectRoot: '/tmp' })).toThrow(
      ScrumlordError,
    );
    try {
      runMigrations(database, () => new Date(), { projectRoot: '/tmp' });
    } catch (error) {
      expect((error as ScrumlordError).code).toBe('migration_unsafe');
    }
    database.close();
  });
});
