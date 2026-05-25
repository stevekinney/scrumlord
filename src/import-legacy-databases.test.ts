import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTasksCli } from './cli-runner';
import { expectRejection } from '../test/store';
import type { CommandResult, CommandRunner } from './command-runner';
import { defaultLegacySources, importLegacyDatabases } from './import-legacy-databases';

const directories: string[] = [];
const tempDir = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { force: true, recursive: true })));
});

type SeedRow = {
  id: string;
  tags?: string[];
  blockedBy?: string[];
  progress?: { id: string; message?: string; createdAt?: string; commitSha?: string | null }[];
};

const legacySchema = (db: Database): void => {
  db.run(
    `CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL, created_at TEXT NOT NULL,
      start_date TEXT, due_date TEXT, last_modified_at TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0, branch TEXT, plan TEXT, provider TEXT, session TEXT);`,
  );
  db.run(`CREATE TABLE task_tags (task_id TEXT, tag TEXT);`);
  db.run(`CREATE TABLE task_dependencies (task_id TEXT, blocked_by_task_id TEXT);`);
  db.run(
    `CREATE TABLE task_progress (id TEXT PRIMARY KEY, task_id TEXT, message TEXT, created_at TEXT,
      provider TEXT, session TEXT, event TEXT, tool TEXT, cwd TEXT, transcript_path TEXT, commit_sha TEXT);`,
  );
};

type ProgressSeed = NonNullable<SeedRow['progress']>[number];

const insertProgress = (db: Database, taskId: string, entry: ProgressSeed): void => {
  // A commit SHA is only valid alongside event='commit' (the v7 trigger
  // enforces this), matching how real legacy rows were written.
  db.query(
    `INSERT INTO task_progress (id, task_id, message, created_at, event, commit_sha)
     VALUES ($id, $task, $message, $createdAt, $event, $commitSha)`,
  ).run({
    id: entry.id,
    task: taskId,
    message: entry.message ?? 'note',
    createdAt: entry.createdAt ?? '2026-01-01',
    event: entry.commitSha ? 'commit' : null,
    commitSha: entry.commitSha ?? null,
  });
};

const insertSeedRow = (db: Database, row: SeedRow): void => {
  db.query(
    `INSERT INTO tasks (id, title, status, priority, created_at, last_modified_at)
     VALUES ($id, $title, 'ready', 1, '2026-01-01', '2026-01-01')`,
  ).run({ id: row.id, title: `Title ${row.id}` });
  for (const tag of row.tags ?? []) {
    db.query('INSERT INTO task_tags (task_id, tag) VALUES ($id, $tag)').run({ id: row.id, tag });
  }
  for (const blocker of row.blockedBy ?? []) {
    db.query(
      'INSERT INTO task_dependencies (task_id, blocked_by_task_id) VALUES ($id, $blocker)',
    ).run({ id: row.id, blocker });
  }
  for (const entry of row.progress ?? []) insertProgress(db, row.id, entry);
};

/** Builds a legacy (v7-shaped) `tmp/tasks.db` with no `project_id` column. */
const buildLegacySource = async (root: string, rows: SeedRow[]): Promise<void> => {
  await mkdir(join(root, 'tmp'), { recursive: true });
  await Bun.spawn(['git', 'init'], { cwd: root, stdout: 'pipe', stderr: 'pipe' }).exited;
  const db = new Database(join(root, 'tmp', 'tasks.db'), { create: true, strict: true });
  legacySchema(db);
  for (const row of rows) insertSeedRow(db, row);
  db.close();
};

const nameRunner = (name: (cwd: string) => string): CommandRunner => {
  return async (command, cwd): Promise<CommandResult> => {
    const joined = command.join(' ');
    if (joined.startsWith('gh repo view'))
      return { exitCode: 0, stdout: `${name(cwd)}\n`, stderr: '' };
    if (joined === 'git remote get-url origin') {
      return { exitCode: 0, stdout: `https://github.com/${name(cwd)}.git\n`, stderr: '' };
    }
    const { runCommand } = await import('./command-runner');
    return runCommand(command, cwd);
  };
};

const sharedCount = (home: string, table: string): number => {
  const db = new Database(join(home, '.scrumlord', 'tasks.db'), { readonly: true });
  const row = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM ${table}`).get();
  db.close();
  return row?.c ?? 0;
};

describe('importLegacyDatabases', () => {
  it('imports tasks, tags, dependencies, and progress, stamping projects', async () => {
    const home = await tempDir('imp-home-');
    const a = await tempDir('imp-a-');
    const b = await tempDir('imp-b-');
    await buildLegacySource(a, [
      { id: 'a1', tags: ['x'], progress: [{ id: 'ap1', commitSha: 'sha-a' }] },
      { id: 'a2', blockedBy: ['a1'] },
    ]);
    await buildLegacySource(b, [{ id: 'b1', tags: ['y'] }]);
    const runner = nameRunner((cwd) => (cwd.startsWith(a) ? 'octo/alpha' : 'octo/beta'));

    const result = await importLegacyDatabases({
      from: [a, b],
      dryRun: false,
      homeDirectory: home,
      runner,
    });

    expect(sharedCount(home, 'tasks')).toBe(3);
    expect(sharedCount(home, 'task_tags')).toBe(2);
    expect(sharedCount(home, 'task_dependencies')).toBe(1);
    expect(sharedCount(home, 'task_progress')).toBe(1);
    expect(sharedCount(home, 'projects')).toBe(2);
    expect(result.backupPath).not.toBeNull();
    expect(result.sources.map((s) => s.nameWithOwner)).toEqual(['octo/alpha', 'octo/beta']);
  });

  it('is idempotent on re-run and writes nothing on --dry-run', async () => {
    const home = await tempDir('imp-home-');
    const a = await tempDir('imp-a-');
    await buildLegacySource(a, [
      { id: 'a1', progress: [{ id: 'ap1' }, { id: 'ap2', commitSha: 'sha-a' }] },
      { id: 'a2' },
    ]);
    const runner = nameRunner(() => 'octo/alpha');

    const dry = await importLegacyDatabases({
      from: [a],
      dryRun: true,
      homeDirectory: home,
      runner,
    });
    expect(dry.backupPath).toBeNull();
    expect(dry.sources[0]?.tasks.imported).toBe(2);
    expect(sharedCount(home, 'tasks')).toBe(0);

    await importLegacyDatabases({ from: [a], dryRun: false, homeDirectory: home, runner });
    expect(sharedCount(home, 'tasks')).toBe(2);
    expect(sharedCount(home, 'task_progress')).toBe(2);

    const second = await importLegacyDatabases({
      from: [a],
      dryRun: false,
      homeDirectory: home,
      runner,
    });
    expect(second.sources[0]?.tasks.imported).toBe(0);
    expect(second.sources[0]?.tasks.skipped).toBe(2);
    // Both progress rows (commit-sha and timestamp natural keys) skip on re-run.
    expect(second.sources[0]?.progress).toEqual({ imported: 0, skipped: 2 });
    expect(sharedCount(home, 'tasks')).toBe(2);
    expect(sharedCount(home, 'task_progress')).toBe(2);
  });

  it('validates dependency endpoints against the source during a dry run', async () => {
    const home = await tempDir('imp-home-');
    const a = await tempDir('imp-a-');
    // A real dependency edge whose endpoints are both genuine source tasks.
    await buildLegacySource(a, [{ id: 'a1' }, { id: 'a2', blockedBy: ['a1'] }]);
    const runner = nameRunner(() => 'octo/alpha');

    // Dry run must not falsely abort: the tasks are not yet written to the
    // shared database, so endpoint validation has to consult the source.
    const dry = await importLegacyDatabases({
      from: [a],
      dryRun: true,
      homeDirectory: home,
      runner,
    });
    expect(dry.sources[0]?.dependencies).toEqual({ imported: 1, skipped: 0 });
    expect(sharedCount(home, 'task_dependencies')).toBe(0);
  });

  it('preserves a progress id from a second source even when it collides', async () => {
    const home = await tempDir('imp-home-');
    const a = await tempDir('imp-a-');
    const b = await tempDir('imp-b-');
    // Both sources reuse progress id `shared-p` for different tasks.
    await buildLegacySource(a, [{ id: 'a1', progress: [{ id: 'shared-p' }] }]);
    await buildLegacySource(b, [{ id: 'b1', progress: [{ id: 'shared-p' }] }]);
    const runner = nameRunner((cwd) => (cwd.startsWith(a) ? 'octo/alpha' : 'octo/beta'));

    await importLegacyDatabases({ from: [a, b], dryRun: false, homeDirectory: home, runner });

    // Both progress rows land (the second under a fresh id), attached to distinct tasks.
    expect(sharedCount(home, 'task_progress')).toBe(2);
  });

  it('skips already-present tags and dependencies on re-import', async () => {
    const home = await tempDir('imp-home-');
    const a = await tempDir('imp-a-');
    await buildLegacySource(a, [
      { id: 'a1', tags: ['x', 'y'] },
      { id: 'a2', blockedBy: ['a1'] },
    ]);
    const runner = nameRunner(() => 'octo/alpha');
    await importLegacyDatabases({ from: [a], dryRun: false, homeDirectory: home, runner });
    const second = await importLegacyDatabases({
      from: [a],
      dryRun: false,
      homeDirectory: home,
      runner,
    });
    expect(second.sources[0]?.tags).toEqual({ imported: 0, skipped: 2 });
    expect(second.sources[0]?.dependencies).toEqual({ imported: 0, skipped: 1 });
    expect(sharedCount(home, 'task_tags')).toBe(2);
    expect(sharedCount(home, 'task_dependencies')).toBe(1);
  });

  it('aborts when a progress row diverges from an existing one', async () => {
    const home = await tempDir('imp-home-');
    const a = await tempDir('imp-a-');
    await buildLegacySource(a, [{ id: 'a1', progress: [{ id: 'p1', commitSha: 'sha-1' }] }]);
    const runner = nameRunner(() => 'octo/alpha');
    await importLegacyDatabases({ from: [a], dryRun: false, homeDirectory: home, runner });

    // Change the message for the same (task_id, commit_sha) natural key.
    const sourceDb = new Database(join(a, 'tmp', 'tasks.db'), { strict: true });
    sourceDb.run("UPDATE task_progress SET message = 'different' WHERE id = 'p1'");
    sourceDb.close();

    await expectRejection(
      importLegacyDatabases({ from: [a], dryRun: false, homeDirectory: home, runner }),
      { message: 'diverges' },
    );
  });

  it('aborts a source on a divergent same-id task without partial writes', async () => {
    const home = await tempDir('imp-home-');
    const a = await tempDir('imp-a-');
    await buildLegacySource(a, [{ id: 'dup' }]);
    const runner = nameRunner(() => 'octo/alpha');
    await importLegacyDatabases({ from: [a], dryRun: false, homeDirectory: home, runner });

    // Mutate the source so `dup` now has different content, then re-import.
    const sourceDb = new Database(join(a, 'tmp', 'tasks.db'), { strict: true });
    sourceDb.run("UPDATE tasks SET title = 'Changed' WHERE id = 'dup'");
    sourceDb
      .query(
        `INSERT INTO tasks (id, title, status, priority, created_at, last_modified_at)
       VALUES ('new', 'New', 'ready', 1, '2026-01-01', '2026-01-01')`,
      )
      .run();
    sourceDb.close();

    await expectRejection(
      importLegacyDatabases({ from: [a], dryRun: false, homeDirectory: home, runner }),
      { message: 'already exists' },
    );
    // The aborted transaction left the new task unimported.
    expect(sharedCount(home, 'tasks')).toBe(1);
  });

  it('aborts on a dependency edge whose endpoint is missing from the project', async () => {
    const home = await tempDir('imp-home-');
    const a = await tempDir('imp-a-');
    await buildLegacySource(a, [{ id: 'a1' }]);
    // Inject a dangling dependency edge (blocker task does not exist).
    const sourceDb = new Database(join(a, 'tmp', 'tasks.db'), { strict: true });
    sourceDb
      .query('INSERT INTO task_dependencies (task_id, blocked_by_task_id) VALUES ($t, $b)')
      .run({ t: 'a1', b: 'ghost' });
    sourceDb.close();
    const runner = nameRunner(() => 'octo/alpha');

    await expectRejection(
      importLegacyDatabases({ from: [a], dryRun: false, homeDirectory: home, runner }),
      { message: 'missing' },
    );
  });

  it('skips tags and progress that reference a task missing from the source', async () => {
    const home = await tempDir('imp-home-');
    const a = await tempDir('imp-a-');
    await buildLegacySource(a, [{ id: 'a1' }]);
    // Inject a tag and a progress row for a task id that has no `tasks` row.
    const sourceDb = new Database(join(a, 'tmp', 'tasks.db'), { strict: true });
    sourceDb
      .query('INSERT INTO task_tags (task_id, tag) VALUES ($t, $g)')
      .run({ t: 'ghost', g: 'z' });
    sourceDb
      .query(
        `INSERT INTO task_progress (id, task_id, message, created_at)
         VALUES ('orphan-p', 'ghost', 'note', '2026-01-01')`,
      )
      .run();
    sourceDb.close();
    const runner = nameRunner(() => 'octo/alpha');

    const result = await importLegacyDatabases({
      from: [a],
      dryRun: false,
      homeDirectory: home,
      runner,
    });
    expect(result.sources[0]?.tags).toEqual({ imported: 0, skipped: 1 });
    expect(result.sources[0]?.progress.skipped).toBe(1);
    expect(sharedCount(home, 'task_tags')).toBe(0);
  });

  it('errors when a legacy source database is missing', async () => {
    const home = await tempDir('imp-home-');
    const missing = await tempDir('imp-missing-');
    await expectRejection(
      importLegacyDatabases({ from: [missing], dryRun: true, homeDirectory: home }),
      { message: 'No legacy database' },
    );
  });

  it('exposes the three default sources under the home directory', () => {
    const defaults = defaultLegacySources('/home/dev');
    expect(defaults).toEqual([
      '/home/dev/Developer/weft',
      '/home/dev/Developer/cinder',
      '/home/dev/Developer/scrumlord',
    ]);
  });
});

describe('tasks import-legacy-databases CLI', () => {
  it('requires --confirm before importing the default sources', async () => {
    const home = await tempDir('imp-home-');
    const result = await runTasksCli(['import-legacy-databases'], { homeDirectory: home });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe('import_sources_unconfirmed');
  });

  it('imports an explicit --from source and reports a summary', async () => {
    const home = await tempDir('imp-home-');
    const a = await tempDir('imp-a-');
    await buildLegacySource(a, [{ id: 'a1' }]);
    const result = await runTasksCli(['import-legacy-databases', '--from', a, '--dry-run'], {
      homeDirectory: home,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { dryRun: boolean; sources: { source: string }[] };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.sources[0]?.source).toBe(a);
    expect(existsSync(join(home, '.scrumlord', 'tasks.db'))).toBe(true);
  });
});
