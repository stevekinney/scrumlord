import { emit as emitClaude } from '../src/plugin-emit-claude.js';
import { emit as emitCodex } from '../src/plugin-emit-codex.js';
import { scrumlordPluginSpec } from '../src/plugin-spec.js';

const root = new URL('..', import.meta.url).pathname;

await emitCodex(scrumlordPluginSpec, root);
await emitClaude(scrumlordPluginSpec, root);

process.stdout.write(`Plugin build complete (v${scrumlordPluginSpec.version}).\n`);
