import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { claudePluginManifestSchema, pluginManifestSchema } from './plugin-manifest.js';

describe('pluginManifestSchema (Codex)', () => {
  it('validates a minimal manifest', () => {
    const result = pluginManifestSchema.safeParse({
      name: 'my-plugin',
      version: '1.0.0',
      description: 'A plugin',
      interface: {
        displayName: 'My Plugin',
        shortDescription: 'Does stuff.',
        category: 'Productivity',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-kebab-case name', () => {
    const result = pluginManifestSchema.safeParse({
      name: 'MyPlugin',
      version: '1.0.0',
      description: 'A plugin',
      interface: {
        displayName: 'My Plugin',
        shortDescription: 'Does stuff.',
        category: 'Productivity',
      },
    });
    expect(result.success).toBe(false);
  });

  it('requires interface.displayName', () => {
    const result = pluginManifestSchema.safeParse({
      name: 'my-plugin',
      version: '1.0.0',
      description: 'A plugin',
      interface: {
        shortDescription: 'Does stuff.',
        category: 'Productivity',
      },
    });
    expect(result.success).toBe(false);
  });

  it('requires interface.category', () => {
    const result = pluginManifestSchema.safeParse({
      name: 'my-plugin',
      version: '1.0.0',
      description: 'A plugin',
      interface: {
        displayName: 'My Plugin',
        shortDescription: 'Does stuff.',
      },
    });
    expect(result.success).toBe(false);
  });

  it('validates the committed .codex-plugin/plugin.json once built', () => {
    const manifestPath = join(import.meta.dir, '..', '.codex-plugin', 'plugin.json');
    let raw: string;
    try {
      raw = readFileSync(manifestPath, 'utf-8');
    } catch {
      // Plugin has not been built yet — skip rather than fail.
      return;
    }
    const parsed: unknown = JSON.parse(raw);
    const result = pluginManifestSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });
});

describe('claudePluginManifestSchema', () => {
  it('validates a minimal manifest', () => {
    const result = claudePluginManifestSchema.safeParse({
      name: 'my-plugin',
      version: '1.0.0',
      description: 'A plugin',
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional component paths', () => {
    const result = claudePluginManifestSchema.safeParse({
      name: 'my-plugin',
      version: '1.0.0',
      description: 'A plugin',
      skills: './skills/',
      agents: './agents/',
      hooks: './hooks/hooks.json',
      mcpServers: './.mcp.json',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-kebab-case name', () => {
    const result = claudePluginManifestSchema.safeParse({
      name: 'MyPlugin',
      version: '1.0.0',
      description: 'A plugin',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a name with spaces', () => {
    const result = claudePluginManifestSchema.safeParse({
      name: 'my plugin',
      version: '1.0.0',
      description: 'A plugin',
    });
    expect(result.success).toBe(false);
  });

  it('validates the committed .claude-plugin/plugin.json once built', () => {
    const manifestPath = join(import.meta.dir, '..', '.claude-plugin', 'plugin.json');
    let raw: string;
    try {
      raw = readFileSync(manifestPath, 'utf-8');
    } catch {
      // Plugin has not been built yet — skip rather than fail.
      return;
    }
    const parsed: unknown = JSON.parse(raw);
    const result = claudePluginManifestSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });
});
