import { $ } from 'bun';
import pkg from '../package.json' with { type: 'json' };

const entrypoints = ['./src/index.ts', './src/cli.ts', './src/mcp-cli.ts'];
const external = Array.from(
  new Set([
    ...Object.keys(
      (pkg as Record<string, unknown> & { dependencies?: Record<string, string> }).dependencies ??
        {},
    ),
    ...Object.keys(
      (pkg as Record<string, unknown> & { peerDependencies?: Record<string, string> })
        .peerDependencies ?? {},
    ),
    ...Object.keys(
      (pkg as Record<string, unknown> & { optionalDependencies?: Record<string, string> })
        .optionalDependencies ?? {},
    ),
  ]),
);

await $`rm -rf dist`;

await Bun.build({
  entrypoints,
  outdir: './dist',
  target: 'bun',
  format: 'esm',
  naming: '[name].js',
  sourcemap: 'linked',
  minify: false,
  loader: { '.md': 'text' },
  external,
});

await $`bun run tsc --declaration --emitDeclarationOnly --project tsconfig.build.json`;

const library = await import(new URL('../dist/index.js', import.meta.url).href);
for (const name of [
  'createTaskStore',
  'createScrumlordMcpServer',
  'next',
  'remaining',
  'runScrumlordMcpServer',
  'ScrumlordError',
] as const) {
  if (typeof library[name] === 'undefined') {
    throw new Error(`Built library entrypoint is missing ${name}.`);
  }
}

console.log('Build complete.');
