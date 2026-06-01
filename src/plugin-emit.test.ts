import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { emit as emitClaude } from './plugin-emit-claude.js';
import { emit as emitCodex } from './plugin-emit-codex.js';
import {
  claudeMarketplaceSchema,
  codexMarketplaceSchema,
  pluginManifestSchema,
} from './plugin-manifest.js';
import { scrumlordPluginSpec } from './plugin-spec.js';

// Test helper: generated JSON is read loosely so assertions can index freely.
const readJson = (root: string, ...segments: string[]): any =>
  JSON.parse(readFileSync(join(root, ...segments), 'utf-8'));

describe('emitClaude', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'scrumlord-emit-claude-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

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

  it('writes each agent as a flat .md with name frontmatter', async () => {
    await emitClaude(scrumlordPluginSpec, root);
    const agent = scrumlordPluginSpec.agents[0]!;
    const body = readFileSync(join(root, '.claude-plugin', 'agents', `${agent.name}.md`), 'utf-8');
    expect(body.startsWith(`---\nname: '${agent.name}'`)).toBe(true);
    expect(body).toContain('skills:\n  - tasks');
  });
});

describe('emitCodex', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'scrumlord-emit-codex-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('nests an installable plugin.json under plugins/<name>/.codex-plugin', async () => {
    await emitCodex(scrumlordPluginSpec, root);
    const pluginRoot = join(root, '.codex-plugin', 'plugins', scrumlordPluginSpec.name);
    const manifest = readJson(pluginRoot, '.codex-plugin', 'plugin.json');
    expect(pluginManifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest['name']).toBe(scrumlordPluginSpec.name);
    expect(manifest['hooks']).toBeUndefined();
    expect(readJson(pluginRoot, '.mcp.json')).toEqual({
      mcpServers: {
        [scrumlordPluginSpec.mcp.serverName]: {
          command: scrumlordPluginSpec.mcp.command,
          args: scrumlordPluginSpec.mcp.args,
        },
      },
    });
    expect(readFileSync(join(pluginRoot, 'skills', 'tasks', 'SKILL.md'), 'utf-8')).toContain(
      "name: 'tasks'",
    );
    expect(manifest['interface']['displayName']).toBe(
      scrumlordPluginSpec.codexInterface.displayName,
    );
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
