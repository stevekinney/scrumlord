import { $ } from 'bun';

/**
 * Drift guard for the generated plugin trees.
 *
 * The repo *is* the plugin: everything under `.claude-plugin/` and
 * `.codex-plugin/` is emitted from `src/plugin-spec.ts` by the emitters in
 * `src/plugin-emit-claude.ts` and `src/plugin-emit-codex.ts`. Nothing in those
 * trees may be hand-edited. This script regenerates them and fails if the
 * working tree no longer matches what is committed, so stale generated content
 * can never land silently.
 */

const generatedTrees = ['.claude-plugin', '.codex-plugin'];

await $`bun run scripts/build-plugin.ts`.quiet();

const diff = await $`git status --porcelain -- ${generatedTrees}`.text();

if (diff.trim().length > 0) {
  process.stderr.write(
    'Generated plugin trees are out of date. Run `bun run plugin:build` and commit the result.\n\n' +
      'Drifted paths:\n' +
      diff,
  );
  process.exit(1);
}

process.stdout.write('Plugin trees are in sync with the spec.\n');
