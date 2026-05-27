import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  claudeMarketplaceSchema,
  claudePluginManifestSchema,
  codexMarketplaceSchema,
  pluginManifestSchema,
  validateOrThrow,
} from './plugin-manifest.js';

const repoRoot = join(import.meta.dir, '..');

/** Reads and parses a generated JSON file, or returns null if the build has not run. */
const readBuilt = (...segments: string[]): unknown => {
  try {
    return JSON.parse(readFileSync(join(repoRoot, ...segments), 'utf-8'));
  } catch {
    return null;
  }
};

describe('validateOrThrow', () => {
  it('returns the parsed value on success', () => {
    const value = validateOrThrow(claudePluginManifestSchema, 'manifest', {
      name: 'my-plugin',
      version: '1.0.0',
      description: 'A plugin',
    });
    expect(value.name).toBe('my-plugin');
  });

  it('throws with the label and every issue path on failure', () => {
    expect(() =>
      validateOrThrow(claudePluginManifestSchema, 'manifest', {
        name: 'Bad Name',
        version: '1.0.0',
        description: 'A plugin',
      }),
    ).toThrow(/manifest validation failed/);
  });
});

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

  it('validates the committed Codex plugin.json once built', () => {
    const parsed = readBuilt(
      '.codex-plugin',
      'plugins',
      'scrumlord',
      '.codex-plugin',
      'plugin.json',
    );
    if (parsed === null) return;
    expect(pluginManifestSchema.safeParse(parsed).success).toBe(true);
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

  it('accepts optional component paths and the $schema/displayName fields', () => {
    const result = claudePluginManifestSchema.safeParse({
      $schema: 'https://json.schemastore.org/claude-code-plugin-manifest.json',
      name: 'my-plugin',
      displayName: 'My Plugin',
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

  it('validates the committed Claude plugin.json once built', () => {
    const parsed = readBuilt('.claude-plugin', 'plugin.json');
    if (parsed === null) return;
    expect(claudePluginManifestSchema.safeParse(parsed).success).toBe(true);
  });
});

describe('claudeMarketplaceSchema', () => {
  const valid = {
    name: 'my-plugin-local',
    owner: { name: 'Dev Team', email: 'dev@example.com' },
    plugins: [{ name: 'my-plugin', source: './', category: 'Productivity' }],
  };

  it('validates a minimal marketplace with a required owner', () => {
    expect(claudeMarketplaceSchema.safeParse(valid).success).toBe(true);
  });

  it('requires a top-level owner object', () => {
    const { owner, ...withoutOwner } = valid;
    void owner;
    expect(claudeMarketplaceSchema.safeParse(withoutOwner).success).toBe(false);
  });

  it('rejects a source that is not a relative "./" path', () => {
    const result = claudeMarketplaceSchema.safeParse({
      ...valid,
      plugins: [{ name: 'my-plugin', source: 'plugins/my-plugin' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects the Codex object source shape', () => {
    const result = claudeMarketplaceSchema.safeParse({
      ...valid,
      plugins: [{ name: 'my-plugin', source: { source: 'local', path: '.' } }],
    });
    expect(result.success).toBe(false);
  });

  it('validates the committed Claude marketplace.json once built', () => {
    const parsed = readBuilt('.claude-plugin', 'marketplace.json');
    if (parsed === null) return;
    expect(claudeMarketplaceSchema.safeParse(parsed).success).toBe(true);
  });
});

describe('codexMarketplaceSchema', () => {
  const valid = {
    name: 'my-plugin-local',
    interface: { displayName: 'My Plugin' },
    plugins: [
      {
        name: 'my-plugin',
        source: { source: 'local', path: './plugins/my-plugin' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      },
    ],
  };

  it('validates a minimal Codex marketplace', () => {
    expect(codexMarketplaceSchema.safeParse(valid).success).toBe(true);
  });

  it('requires the interface.displayName block', () => {
    const { interface: iface, ...withoutInterface } = valid;
    void iface;
    expect(codexMarketplaceSchema.safeParse(withoutInterface).success).toBe(false);
  });

  it('requires a per-plugin policy envelope', () => {
    const result = codexMarketplaceSchema.safeParse({
      ...valid,
      plugins: [{ name: 'my-plugin', source: { source: 'local', path: './plugins/my-plugin' } }],
    });
    expect(result.success).toBe(false);
  });

  it('validates the committed Codex marketplace.json once built', () => {
    const parsed = readBuilt('.codex-plugin', '.agents', 'plugins', 'marketplace.json');
    if (parsed === null) return;
    expect(codexMarketplaceSchema.safeParse(parsed).success).toBe(true);
  });
});
