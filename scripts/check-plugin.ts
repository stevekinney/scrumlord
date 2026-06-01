import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { emit as emitClaude } from '../src/plugin-emit-claude.js';
import { emit as emitCodex } from '../src/plugin-emit-codex.js';
import { codexMarketplaceSchema, validateOrThrow } from '../src/plugin-manifest.js';
import { scrumlordPluginSpec } from '../src/plugin-spec.js';

/**
 * Drift guard for the generated plugin trees.
 *
 * The repo *is* the plugin: everything under `.claude-plugin/` and
 * `.codex-plugin/` is emitted from `src/plugin-spec.ts` by the emitters in
 * `src/plugin-emit-claude.ts` and `src/plugin-emit-codex.ts`. Nothing in those
 * trees may be hand-edited.
 *
 * This script runs three gates and is non-mutating — it never writes into the
 * working tree:
 *
 *   1. Drift: emit the trees into a throwaway temp directory and diff them
 *      against the committed trees. Any difference means the committed output
 *      is stale; run `bun run plugin:build` and commit the result.
 *   2. Codex layout: validate the committed Codex marketplace entry resolves to
 *      an installable plugin root and that plugin component paths exist where
 *      Codex expects them.
 *   3. Schema: if the `claude` CLI is on PATH, run `claude plugin validate`
 *      against the committed plugin (the repo root is the marketplace root).
 *      The CLI is an optional convenience — when it is absent we warn and
 *      continue, but when it is present and reports an error we fail, catching
 *      schema mistakes the build-time Zod schemas do not model.
 */

const repoRoot = join(import.meta.dir, '..');
const generatedTrees = ['.claude-plugin', '.codex-plugin'];

const readJsonObject = async (path: string, label: string): Promise<Record<string, unknown>> => {
  const payload = await Bun.file(path).json();
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return payload as Record<string, unknown>;
};

const assertPathExists = (path: string, label: string): void => {
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
};

const assertDirectoryExists = (path: string, label: string): void => {
  assertPathExists(path, label);
  if (!statSync(path).isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
};

const assertFileExists = (path: string, label: string): void => {
  assertPathExists(path, label);
  if (!statSync(path).isFile()) throw new Error(`${label} must be a file: ${path}`);
};

const relativeComponentPath = (rawPath: unknown, field: string): string => {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('./')) {
    throw new Error(`Codex plugin manifest field \`${field}\` must be a ./ relative path`);
  }
  return rawPath.slice(2).replace(/\/+$/, '');
};

const validateCodexPluginTree = async (): Promise<void> => {
  const marketplaceRoot = join(repoRoot, '.codex-plugin');
  const marketplacePath = join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json');
  const marketplace = validateOrThrow(
    codexMarketplaceSchema,
    'Codex marketplace manifest',
    await readJsonObject(marketplacePath, 'Codex marketplace manifest'),
  );
  const plugin = marketplace.plugins.find((entry) => entry.name === scrumlordPluginSpec.name);
  if (!plugin) {
    throw new Error(`Codex marketplace is missing plugin \`${scrumlordPluginSpec.name}\``);
  }

  const pluginRoot = join(marketplaceRoot, plugin.source.path.slice(2));
  const manifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
  assertFileExists(manifestPath, 'Codex plugin manifest');

  const manifest = await readJsonObject(manifestPath, 'Codex plugin manifest');
  if (manifest['name'] !== plugin.name) {
    throw new Error('Codex marketplace plugin name must match plugin.json name');
  }
  if (manifest['hooks'] !== undefined) {
    throw new Error('Codex plugin manifest must not contain unsupported `hooks` field');
  }

  const skillsPath = relativeComponentPath(manifest['skills'], 'skills');
  assertDirectoryExists(join(pluginRoot, skillsPath), 'Codex plugin skills directory');

  const mcpPath = relativeComponentPath(manifest['mcpServers'], 'mcpServers');
  const mcpManifestPath = join(pluginRoot, mcpPath);
  assertFileExists(mcpManifestPath, 'Codex plugin MCP manifest');
  const mcpManifest = await readJsonObject(mcpManifestPath, 'Codex plugin MCP manifest');
  if (typeof mcpManifest['mcpServers'] !== 'object' || mcpManifest['mcpServers'] === null) {
    throw new Error('Codex plugin MCP manifest must contain an `mcpServers` object');
  }

  process.stdout.write('Codex plugin marketplace and component paths are installable.\n');
};

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

try {
  await validateCodexPluginTree();
} catch (error) {
  process.stderr.write(
    `Codex plugin tree validation failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}

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
