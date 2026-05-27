import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { emit as emitClaude } from './plugin-emit-claude.js';
import { emit as emitCodex } from './plugin-emit-codex.js';
import { claudeMarketplaceSchema, codexMarketplaceSchema } from './plugin-manifest.js';
import { scrumlordPluginSpec } from './plugin-spec.js';

// Test helper: generated JSON is read loosely so assertions can index freely.
const readJson = (root: string, ...segments: string[]): any =>
  JSON.parse(readFileSync(join(root, ...segments), 'utf-8'));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scrumlord-emit-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('emitClaude', () => {
  it('writes a plugin.json with $schema and displayName', async () => {
    await emitClaude(scrumlordPluginSpec, root);
    const manifest = readJson(root, '.claude-plugin', 'plugin.json');
    expect(manifest['$schema']).toContain('claude-code-plugin-manifest');
    expect(manifest['displayName']).toBe(scrumlordPluginSpec.codexInterface.displayName);
    expect(manifest['name']).toBe(scrumlordPluginSpec.name);
  });

  it('writes a marketplace.json with an owner derived from the spec and no Codex fields', async () => {
    await emitClaude(scrumlordPluginSpec, root);
    const marketplace = readJson(root, '.claude-plugin', 'marketplace.json');
    expect(claudeMarketplaceSchema.safeParse(marketplace).success).toBe(true);
    expect(marketplace['owner']).toEqual(scrumlordPluginSpec.author);
    expect(marketplace['interface']).toBeUndefined();
    expect(marketplace['plugins'][0]?.['source']).toBe('./');
    expect(marketplace['plugins'][0]?.['policy']).toBeUndefined();
  });
});

describe('emitCodex', () => {
  it('nests the plugin under plugins/<name>/.codex-plugin so codex can install it', async () => {
    await emitCodex(scrumlordPluginSpec, root);
    const manifestPath = join(
      root,
      '.codex-plugin',
      'plugins',
      scrumlordPluginSpec.name,
      '.codex-plugin',
      'plugin.json',
    );
    expect(() => readFileSync(manifestPath, 'utf-8')).not.toThrow();
  });

  it('writes the marketplace at .agents/plugins pointing source.path at the nested plugin', async () => {
    await emitCodex(scrumlordPluginSpec, root);
    const marketplace = readJson(root, '.codex-plugin', '.agents', 'plugins', 'marketplace.json');
    expect(codexMarketplaceSchema.safeParse(marketplace).success).toBe(true);
    expect(marketplace['plugins'][0]?.['source']).toEqual({
      source: 'local',
      path: `./plugins/${scrumlordPluginSpec.name}`,
    });
  });
});
