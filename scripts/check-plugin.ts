import { $ } from 'bun';

/**
 * Drift guard for the generated plugin trees.
 *
 * The repo *is* the plugin: everything under `.claude-plugin/` and
 * `.codex-plugin/` is emitted from `src/plugin-spec.ts` by the emitters in
 * `src/plugin-emit-claude.ts` and `src/plugin-emit-codex.ts`. Nothing in those
 * trees may be hand-edited.
 *
 * This script runs two gates:
 *
 *   1. Drift: regenerate the trees and fail if the working tree no longer
 *      matches what is committed, so stale generated content can never land.
 *   2. Schema: if the `claude` CLI is on PATH, run `claude plugin validate`
 *      against the plugin (the repo root is the marketplace root). The CLI is an
 *      optional convenience — when it is absent we warn and continue, but when
 *      it is present and reports an error we fail, catching schema mistakes the
 *      build-time Zod schemas do not model.
 */

const generatedTrees = ['.claude-plugin', '.codex-plugin'];

await $`bun run scripts/build-plugin.ts`.quiet();

// Drift = rebuilding changed a tracked file relative to the index, or produced
// an untracked file. Comparing the working tree against the index (rather than
// HEAD) means staged-but-uncommitted regenerations pass, so this works mid-edit
// and in the pre-push hook alike: after a rebuild, a clean tree means the
// committed/staged output already matches the spec.
const unstaged = await $`git diff --stat -- ${generatedTrees}`.text();
const untracked = await $`git ls-files --others --exclude-standard -- ${generatedTrees}`.text();
const drift = [unstaged.trim(), untracked.trim()].filter(Boolean).join('\n');

if (drift.length > 0) {
  process.stderr.write(
    'Generated plugin trees are out of date. Run `bun run plugin:build` and stage the result.\n\n' +
      'Drifted paths:\n' +
      drift +
      '\n',
  );
  process.exit(1);
}

process.stdout.write('Plugin trees are in sync with the spec.\n');

const claudeProbe = await $`command -v claude`.nothrow().quiet();
const claudeOnPath = claudeProbe.exitCode === 0;

if (!claudeOnPath) {
  process.stdout.write('`claude` CLI not on PATH; skipping marketplace schema validation.\n');
} else {
  // The repo root is the Claude marketplace root (it holds `.claude-plugin/`).
  // We only care about the exit code, not the human-readable output.
  const validation = await $`claude plugin validate . --strict`.nothrow();
  if (validation.exitCode !== 0) {
    process.stderr.write('`claude plugin validate . --strict` failed:\n');
    process.stderr.write(validation.stderr.toString() || validation.stdout.toString());
    process.exit(1);
  }
  process.stdout.write('Claude plugin manifest passed `claude plugin validate --strict`.\n');
}
