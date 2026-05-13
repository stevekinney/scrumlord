import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_OUTPUT_BEGIN_SENTINEL, defaultSpawnAgent, verifyAgentReachable } from './pipeline';
import type { AgentInvocation } from './agent-providers';

const noControls = () => ({ stderr: () => {}, signal: new AbortController().signal });

const bunScript = (script: string): AgentInvocation => ({
  command: ['bun', '-e', script],
  cwd: process.cwd(),
  environment: {},
});

describe('defaultSpawnAgent — STUCK detection rules', () => {
  it('matches STUCK on stderr from process start (legacy behavior)', async () => {
    const result = await defaultSpawnAgent(
      bunScript('process.stderr.write("STUCK: tests broke\\n"); process.exit(2)'),
      { idleMs: 10_000, maxMs: 10_000 },
      noControls(),
    );
    expect(result.stuck).toBe('tests broke');
    expect(result.exitCode).toBe(2);
  });

  it('matches STUCK on stdout AFTER AGENT_OUTPUT_BEGIN sentinel', async () => {
    const result = await defaultSpawnAgent(
      bunScript(
        'process.stdout.write("' +
          AGENT_OUTPUT_BEGIN_SENTINEL +
          '\\n"); process.stdout.write("STUCK: bailed\\n"); process.exit(1)',
      ),
      { idleMs: 10_000, maxMs: 10_000 },
      noControls(),
    );
    expect(result.stuck).toBe('bailed');
  });

  it('does NOT match STUCK on stdout BEFORE sentinel (prompt echo safe)', async () => {
    const result = await defaultSpawnAgent(
      bunScript('process.stdout.write("the prompt said STUCK: example\\n"); process.exit(0)'),
      { idleMs: 10_000, maxMs: 10_000 },
      noControls(),
    );
    expect(result.stuck).toBeNull();
    expect(result.exitCode).toBe(0);
  });

  it('captures the trailing tail of stdout/stderr', async () => {
    const result = await defaultSpawnAgent(
      bunScript(
        'for (let i = 0; i < 5; i++) process.stdout.write(`line ${i}\\n`); process.exit(0)',
      ),
      { idleMs: 10_000, maxMs: 10_000 },
      noControls(),
    );
    expect(result.tail).toContain('line 0');
    expect(result.tail).toContain('line 4');
  });

  it('extracts <promise> tag from the tail', async () => {
    const result = await defaultSpawnAgent(
      bunScript(
        'process.stdout.write("working…\\n<promise>PR ready</promise>\\n"); process.exit(0)',
      ),
      { idleMs: 10_000, maxMs: 10_000 },
      noControls(),
    );
    expect(result.promise).toBe('PR ready');
  });

  it('writes a transcript to the supplied path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scrumlord-spawn-test-'));
    const transcriptPath = join(directory, 'transcript.log');
    try {
      const result = await defaultSpawnAgent(
        bunScript('process.stdout.write("hello world\\n"); process.exit(0)'),
        { idleMs: 10_000, maxMs: 10_000 },
        {
          stderr: () => {},
          signal: new AbortController().signal,
          transcriptPath,
        },
      );
      expect(result.exitCode).toBe(0);
      const contents = await readFile(transcriptPath, 'utf8');
      expect(contents).toContain('hello world');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('respects SCRUMLORD_PIPELINE_PREFLIGHT=off (no-op)', async () => {
    await verifyAgentReachable('claude', {
      environment: { SCRUMLORD_PIPELINE_PREFLIGHT: 'off' },
      // No `spawn` injected — if the env-off check did not short-circuit we
      // would try to launch the real claude binary and the assertion would
      // not return cleanly. Reaching this point proves we skipped.
    });
  });

  it('throws agent_preflight_failed when the spawned CLI exits non-zero', async () => {
    let spawned = false;
    const fakeSpawn = ((_cmd: string[]): unknown => {
      spawned = true;
      return {
        stdin: { write() {}, end() {} },
        exited: Promise.resolve(127),
        kill() {},
      };
    }) as unknown as typeof Bun.spawn;
    let threw: Error | null = null;
    try {
      await verifyAgentReachable('claude', {
        environment: {},
        spawn: fakeSpawn,
      });
    } catch (error) {
      threw = error as Error;
    }
    expect(spawned).toBe(true);
    expect(threw).not.toBeNull();
    expect((threw as { code?: string }).code).toBe('agent_preflight_failed');
  });

  it('pipes stdin to the child when invocation.stdin is set', async () => {
    const captured: string[] = [];
    const stderr = (line: string): void => {
      captured.push(line);
    };
    const result = await defaultSpawnAgent(
      {
        command: ['bun', '-e', 'process.stdin.pipe(process.stdout)'],
        cwd: process.cwd(),
        environment: {},
        stdin: 'piped-prompt-body',
      },
      { idleMs: 10_000, maxMs: 10_000 },
      { stderr, signal: new AbortController().signal },
    );
    expect(result.exitCode).toBe(0);
    expect(captured.join('')).toContain('piped-prompt-body');
  });
});
