import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { emit as emitClaude } from '../src/plugin-emit-claude.js';
import { emit as emitCodex } from '../src/plugin-emit-codex.js';
import { scrumlordPluginSpec } from '../src/plugin-spec.js';

const root = new URL('..', import.meta.url).pathname;

rmSync(join(root, '.codex-plugin'), { recursive: true, force: true });
rmSync(join(root, '.claude-plugin'), { recursive: true, force: true });

await emitCodex(scrumlordPluginSpec, root);
await emitClaude(scrumlordPluginSpec, root);

process.stdout.write(`Plugin build complete (v${scrumlordPluginSpec.version}).\n`);
