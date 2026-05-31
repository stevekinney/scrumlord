import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { emit as emitClaude } from '../src/plugin-emit-claude.js';
import { emit as emitCodex } from '../src/plugin-emit-codex.js';
import { scrumlordPluginSpec } from '../src/plugin-spec.js';

/**
 * Drift guard for the generated plugin trees.
 *
 * The repo *is* the plugin: everything under `.claude-plugin/` and
 * `.codex-plugin/` is emitted from `src/plugin-spec.ts` by the emitters in
 * `src/plugin-emit-claude.ts` and `src/plugin-emit-codex.ts`. Nothing in those
 * trees may be hand-edited.
 *
 * This script runs two gates and is non-mutating — it never writes into the
 * working tree:
 *
 *   1. Drift: emit the trees into a throwaway temp directory and diff them
 *      against the committed trees. Any difference means the committed output
 *      is stale; run `bun run plugin:build` and commit the result.
 *   2. Schema: if the `claude` CLI is on PATH, run `claude plugin validate`
 *      against the committed plugin (the repo root is the marketplace root).
 *      The CLI is an optional convenience — when it is absent we warn and
 *      continue, but when it is present and reports an error we fail, catching
 *      schema mistakes the build-time Zod schemas do not model.
 */

const repoRoot = join(import.meta.dir, '..');
const generatedTrees = ['.claude-plugin', '.codex-plugin'];

const scratch = mkdtempSync(join(tmpdir(), 'scrumlord-plugin-check-'));
let driftDetected = false;
try {
  await emitClaude(scrumlordPluginSpec, scratch);
  await emitCodex(scrumlordPluginSpec, scratch);

  // `diff -ru` exits 0 (identical), 1 (differs), or 2 (trouble — e.g. a tree is
  // missing because an emitter crashed). Report every tree in one pass and exit
  // *after* the `finally` cleanup, so a failure never leaks the scratch dir.
  for (const tree of generatedTrees) {
    const diff = await $`diff -ru ${join(repoRoot, tree)} ${join(scratch, tree)}`.nothrow().quiet();
    if (diff.exitCode === 1) {
      process.stderr.write(
        `Generated plugin tree \`${tree}\` is out of date. Run \`bun run plugin:build\` and commit the result.\n\n`,
      );
      process.stderr.write(diff.stdout.toString());
      driftDetected = true;
    } else if (diff.exitCode !== 0) {
      process.stderr.write(
        `Could not compare plugin tree \`${tree}\` (diff exit ${diff.exitCode}); an emitter likely produced no output. This is a bug, not stale output.\n`,
      );
      process.stderr.write(diff.stderr.toString() || diff.stdout.toString());
      driftDetected = true;
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (driftDetected) process.exit(1);

process.stdout.write('Plugin trees are in sync with the spec.\n');

if (Bun.which('claude') === null) {
  process.stdout.write('`claude` CLI not on PATH; skipping marketplace schema validation.\n');
} else {
  // The repo root is the Claude marketplace root (it holds `.claude-plugin/`).
  // We only care about the exit code, not the human-readable output.
  const validation = await $`claude plugin validate ${repoRoot} --strict`.nothrow();
  if (validation.exitCode !== 0) {
    const detail = [validation.stderr.toString(), validation.stdout.toString()]
      .map((stream) => stream.trim())
      .filter(Boolean)
      .join('\n');
    process.stderr.write(`\`claude plugin validate --strict\` failed:\n${detail}\n`);
    process.exit(1);
  }
  process.stdout.write('Claude plugin manifest passed `claude plugin validate --strict`.\n');
}
