import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-gh-'));
  temporaryDirectories.push(directory);
  return directory;
};

const workspaceRoot = async (): Promise<string> => {
  const root = await temporaryDirectory();
  await mkdir(join(root, 'packages', 'example'), { recursive: true });
  await Bun.write(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  return root;
};

const writeExecutable = async (
  directory: string,
  name: string,
  contents: string,
): Promise<void> => {
  const path = join(directory, name);
  await Bun.write(path, contents);
  await chmod(path, 0o755);
};

const writeGit = async (directory: string): Promise<void> => {
  await writeExecutable(
    directory,
    'git',
    `#!/bin/sh
if [ "$3" = "rev-parse" ]; then
  exit 1
fi
if [ "$1" = "branch" ] && [ "$2" = "--show-current" ]; then
  echo "feature/task-graph"
  exit 0
fi
exit 1
`,
  );
};

const runCli = async (
  root: string,
  path: string,
  command: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const subprocess = Bun.spawn([process.execPath, join(import.meta.dir, 'cli.ts'), ...command], {
    cwd: join(root, 'packages', 'example'),
    env: { ...Bun.env, PATH: path },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('GitHub CLI commands', () => {
  it('returns a JSON error when gh is not installed', async () => {
    const root = await workspaceRoot();
    const emptyPath = await temporaryDirectory();

    const subprocess = Bun.spawn([process.execPath, join(import.meta.dir, 'cli.ts'), 'pr'], {
      cwd: join(root, 'packages', 'example'),
      env: { ...Bun.env, PATH: emptyPath },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(await subprocess.exited).toBe(1);
    expect(await new Response(subprocess.stdout).text()).toBe('');
    expect(JSON.parse(await new Response(subprocess.stderr).text())).toEqual({
      error: {
        code: 'gh_not_found',
        message: 'The GitHub CLI (`gh`) is required for this command.',
      },
    });
  });

  it('returns a JSON error when gh is not authenticated', async () => {
    const root = await workspaceRoot();
    const bin = await temporaryDirectory();
    await writeGit(bin);
    await writeExecutable(
      bin,
      'gh',
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  exit 0
fi
if [ "$1" = "auth" ]; then
  echo "not logged in" >&2
  exit 1
fi
exit 1
`,
    );

    const result = await runCli(root, bin, ['pr']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe('gh_not_authenticated');
  });

  it('returns a JSON error when the GitHub repository cannot be resolved', async () => {
    const root = await workspaceRoot();
    const bin = await temporaryDirectory();
    await writeGit(bin);
    await writeExecutable(
      bin,
      'gh',
      `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1" = "auth" ]; then exit 0; fi
if [ "$1" = "repo" ]; then
  echo "no repository" >&2
  exit 1
fi
exit 1
`,
    );

    const result = await runCli(root, bin, ['pr']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe('github_repository_not_found');
  });

  it('returns a JSON error when no open pull request exists for the current branch', async () => {
    const root = await workspaceRoot();
    const bin = await temporaryDirectory();
    await writeGit(bin);
    await writeExecutable(
      bin,
      'gh',
      `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1" = "auth" ]; then exit 0; fi
if [ "$1" = "repo" ]; then echo "owner/repository"; exit 0; fi
if [ "$1" = "api" ]; then printf 'HTTP/2 200 OK\r\netag: "pulls"\r\n\r\n[]\n'; exit 0; fi
exit 1
`,
    );

    const result = await runCli(root, bin, ['pr']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr).error).toEqual({
      code: 'pull_request_not_found',
      message: 'No open pull request found for branch feature/task-graph.',
    });
  });

  it('returns a JSON error when gh returns malformed JSON', async () => {
    const root = await workspaceRoot();
    const bin = await temporaryDirectory();
    await writeGit(bin);
    await writeExecutable(
      bin,
      'gh',
      `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1" = "auth" ]; then exit 0; fi
if [ "$1" = "repo" ]; then echo "owner/repository"; exit 0; fi
if [ "$1" = "api" ]; then printf 'HTTP/2 200 OK\r\netag: "pulls"\r\n\r\nnot-json\n'; exit 0; fi
exit 1
`,
    );

    const result = await runCli(root, bin, ['pr']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe('github_json_parse_failed');
  });

  it('returns a JSON error when the pull request URL cannot be opened', async () => {
    const root = await workspaceRoot();
    const bin = await temporaryDirectory();
    await writeGit(bin);
    await writeExecutable(
      bin,
      'gh',
      `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1" = "auth" ]; then exit 0; fi
if [ "$1" = "repo" ]; then echo "owner/repository"; exit 0; fi
if [ "$1" = "api" ]; then
  printf 'HTTP/2 200 OK\r\netag: "pulls"\r\n\r\n[{"number":1,"html_url":"https://github.test/pull/1","head":{"ref":"feature/task-graph","sha":"abc123"},"title":"Task graph"}]\n'
  exit 0
fi
exit 1
`,
    );
    await writeExecutable(bin, 'open', '#!/bin/sh\nexit 1\n');

    const result = await runCli(root, bin, ['pr', '--open']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe('browser_open_failed');
  });

  it('reports a pull request as ready to merge when reviews are resolved and checks are green', async () => {
    const root = await workspaceRoot();
    const bin = await temporaryDirectory();
    await writeGit(bin);
    await writeExecutable(
      bin,
      'gh',
      `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1" = "auth" ]; then exit 0; fi
if [ "$1" = "repo" ]; then echo "owner/repository"; exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"isResolved":true,"comments":{"nodes":[{"id":"resolved-comment","url":"https://github.test/resolved"}]}}]}}}}}'
  exit 0
fi
if [ "$1" = "api" ]; then
  case "$*" in
    *'/check-runs'*)
      printf 'HTTP/2 200 OK\r\netag: "checks"\r\n\r\n{"check_runs":[{"name":"build","status":"completed","conclusion":"success","html_url":"https://github.test/checks/build","completed_at":"2026-05-11T12:00:00Z","check_suite":{"app":{"name":"Validate"}}},{"name":"optional","status":"completed","conclusion":"skipped","html_url":"https://github.test/checks/optional","completed_at":"2026-05-11T12:01:00Z","check_suite":{"app":{"name":"Validate"}}}]}\n'
      exit 0
      ;;
    *'/statuses'*)
      printf 'HTTP/2 200 OK\r\netag: "statuses"\r\n\r\n[]\n'
      exit 0
      ;;
    *)
      printf 'HTTP/2 200 OK\r\netag: "pulls"\r\n\r\n[{"number":42,"html_url":"https://github.test/owner/repository/pull/42","head":{"ref":"feature/task-graph","sha":"abc123"},"title":"Task graph"}]\n'
      exit 0
      ;;
  esac
fi
exit 1
`,
    );

    const result = await runCli(root, bin, ['pr', 'status']);

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.readyToMerge).toBe(true);
    expect(report.reviewComments).toEqual({
      allResolved: true,
      unresolvedCount: 0,
      unresolved: [],
    });
    expect(report.continuousIntegration.allGreen).toBe(true);
    expect(report.continuousIntegration.pending).toEqual([]);
    expect(report.continuousIntegration.failed).toEqual([]);
    expect(report.continuousIntegration.checks[0]).toMatchObject({
      name: 'build',
      conclusion: 'successful',
      url: 'https://github.test/checks/build',
      synopsis: 'Validate: build passed.',
    });
  });

  it('reports unresolved review comments, pending checks, and failed checks', async () => {
    const root = await workspaceRoot();
    const bin = await temporaryDirectory();
    await writeGit(bin);
    await writeExecutable(
      bin,
      'gh',
      `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1" = "auth" ]; then exit 0; fi
if [ "$1" = "repo" ]; then echo "owner/repository"; exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"isResolved":false,"comments":{"nodes":[{"id":"PRRC_kwDOExample","path":"src/github.ts","line":123,"body":"Please summarize failed checks.","author":{"login":"reviewer"},"url":"https://github.test/comment"}]}},{"isResolved":false,"comments":{"nodes":[{"body":"missing id"}]}}]}}}}}'
  exit 0
fi
if [ "$1" = "api" ]; then
  case "$*" in
    *'/check-runs'*)
      printf 'HTTP/2 200 OK\r\netag: "checks"\r\n\r\n{"check_runs":[{"name":"test","status":"in_progress","conclusion":null,"html_url":"https://github.test/checks/test","completed_at":null,"check_suite":{"app":{"name":"Validate"}}},{"name":"lint","status":"completed","conclusion":"failure","html_url":"https://github.test/checks/lint","completed_at":"2026-05-11T12:00:00Z","check_suite":{"app":{"name":"Validate"}}},{"name":"unknown","status":"mystery","conclusion":null,"html_url":null,"completed_at":null,"check_suite":{}},{"name":"build","status":"completed","conclusion":"success","html_url":"https://github.test/checks/build","completed_at":"2026-05-11T12:02:00Z","check_suite":{"app":{"name":"Validate"}}},{"status":"completed","conclusion":"success"}]}\n'
      exit 0
      ;;
    *'/statuses'*)
      printf 'HTTP/2 200 OK\r\netag: "statuses"\r\n\r\n[]\n'
      exit 0
      ;;
    *)
      printf 'HTTP/2 200 OK\r\netag: "pulls"\r\n\r\n[{"number":42,"html_url":"https://github.test/owner/repository/pull/42","head":{"ref":"feature/task-graph","sha":"abc123"},"title":"Task graph"}]\n'
      exit 0
      ;;
  esac
fi
exit 1
`,
    );

    const result = await runCli(root, bin, ['pr', 'status']);

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.readyToMerge).toBe(false);
    expect(report.reviewComments.allResolved).toBe(false);
    expect(report.reviewComments.unresolvedCount).toBe(1);
    expect(report.reviewComments.unresolved).toEqual([
      {
        id: 'PRRC_kwDOExample',
        url: 'https://github.test/comment',
        path: 'src/github.ts',
        line: 123,
        body: 'Please summarize failed checks.',
        author: 'reviewer',
      },
    ]);
    expect(report.continuousIntegration.allGreen).toBe(false);
    expect(report.continuousIntegration.pendingCount).toBe(2);
    expect(report.continuousIntegration.failedCount).toBe(1);
    expect(
      report.continuousIntegration.pending.map((check: { name: string }) => check.name),
    ).toEqual(['test', 'unknown']);
    expect(report.continuousIntegration.failed).toEqual([
      {
        name: 'lint',
        state: 'failure',
        bucket: 'failure',
        workflow: 'Validate',
        url: 'https://github.test/checks/lint',
        completedAt: '2026-05-11T12:00:00Z',
        conclusion: 'failed',
        synopsis: 'Validate: lint failed with state failure.',
      },
    ]);
  });

  it('returns helpful errors for malformed GitHub pull request status data', async () => {
    const root = await workspaceRoot();
    const bin = await temporaryDirectory();
    await writeGit(bin);
    await writeExecutable(
      bin,
      'gh',
      `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1" = "auth" ]; then exit 0; fi
if [ "$1" = "repo" ]; then echo "owner/repository"; exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}'
  exit 0
fi
if [ "$1" = "api" ]; then
  case "$*" in
    *'/check-runs'*)
      printf 'HTTP/2 200 OK\r\netag: "checks"\r\n\r\n{"checks":[]}\n'
      exit 0
      ;;
    *'/statuses'*)
      printf 'HTTP/2 200 OK\r\netag: "statuses"\r\n\r\n[]\n'
      exit 0
      ;;
    *)
      printf 'HTTP/2 200 OK\r\netag: "pulls"\r\n\r\n[{"number":42,"html_url":"https://github.test/owner/repository/pull/42","head":{"ref":"feature/task-graph","sha":"abc123"},"title":"Task graph"}]\n'
      exit 0
      ;;
  esac
fi
exit 1
`,
    );

    const result = await runCli(root, bin, ['pr', 'status']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr).error).toEqual({
      code: 'ci_status_invalid',
      message: 'Expected GitHub check runs to return a check_runs array.',
    });
  });

  it('returns a JSON error when review comments cannot resolve a valid repository', async () => {
    const root = await workspaceRoot();
    const bin = await temporaryDirectory();
    await writeGit(bin);
    await writeExecutable(
      bin,
      'gh',
      `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1" = "auth" ]; then exit 0; fi
if [ "$1" = "repo" ]; then echo "owner-only"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  echo '[{"number":42,"url":"https://github.test/owner/repository/pull/42","headRefName":"feature/task-graph"}]'
  exit 0
fi
exit 1
`,
    );

    const result = await runCli(root, bin, ['comments']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr).error).toEqual({
      code: 'invalid_repository',
      message: 'Invalid GitHub repository: owner-only',
    });
  });
});
