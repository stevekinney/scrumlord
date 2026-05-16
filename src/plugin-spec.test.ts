import { existsSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { scrumlordPluginSpec } from './plugin-spec.js';

describe('scrumlordPluginSpec', () => {
  it('every skill sourcePath exists', () => {
    for (const skill of scrumlordPluginSpec.skills) {
      expect(existsSync(skill.sourcePath), `Missing: ${skill.sourcePath}`).toBe(true);
    }
  });

  it('every agent sourcePath exists', () => {
    for (const agent of scrumlordPluginSpec.agents) {
      expect(existsSync(agent.sourcePath), `Missing: ${agent.sourcePath}`).toBe(true);
    }
  });

  it('every hook has at least one provider', () => {
    for (const hook of scrumlordPluginSpec.hooks) {
      expect(
        hook.providers.length,
        `Hook ${hook.event}/${hook.matcher} has no providers`,
      ).toBeGreaterThan(0);
    }
  });

  it('providers contain only valid values', () => {
    const valid = new Set(['codex', 'claude']);
    for (const hook of scrumlordPluginSpec.hooks) {
      for (const provider of hook.providers) {
        expect(valid.has(provider), `Unknown provider: ${provider}`).toBe(true);
      }
    }
  });

  it('hook events match the Claude installer (setupClaudeHooks)', () => {
    const claudeHooks = scrumlordPluginSpec.hooks
      .filter((h) => h.providers.includes('claude'))
      .map((h) => `${h.event}/${h.matcher ?? 'null'}`);

    // Must cover all 7 events registered in agent-hooks.ts:163-169
    expect(claudeHooks).toContain('SessionStart/startup|resume');
    expect(claudeHooks).toContain('UserPromptSubmit/null');
    expect(claudeHooks).toContain('PostToolUse/ExitPlanMode');
    expect(claudeHooks).toContain('PostToolUse/Bash');
    expect(claudeHooks).toContain('Stop/null');
    expect(claudeHooks).toContain('SessionEnd/null');
    expect(claudeHooks).toContain('SubagentStop/null');
  });

  it('hook events match the Codex installer (setupCodexHooks)', () => {
    const codexHooks = scrumlordPluginSpec.hooks
      .filter((h) => h.providers.includes('codex'))
      .map((h) => `${h.event}/${h.matcher ?? 'null'}`);

    // Must cover all 4 events registered in agent-hooks.ts:200-203
    expect(codexHooks).toContain('SessionStart/startup|resume');
    expect(codexHooks).toContain('UserPromptSubmit/null');
    expect(codexHooks).toContain('PostToolUse/Bash');
    expect(codexHooks).toContain('Stop/null');
  });

  it('has a non-empty name and version', () => {
    expect(scrumlordPluginSpec.name).toBeTruthy();
    expect(scrumlordPluginSpec.version).toBeTruthy();
  });
});
