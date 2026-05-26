import { afterEach, beforeEach, mock, setSystemTime } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Sentinel so tests can assert the preload actually ran.
(globalThis as Record<string, unknown>).__BUN_TEST_SETUP_LOADED__ = true;

// Isolate the shared task database (`~/.scrumlord/tasks.db`) per test so tests
// never read or write the developer's real database, and so state never leaks
// between tests. `database-open.ts` honors SCRUMLORD_HOME ahead of the real home
// directory. Each test gets a fresh throwaway home, removed afterward.
let sharedHome: string | undefined;

beforeEach(() => {
  sharedHome = mkdtempSync(join(tmpdir(), 'scrumlord-home-'));
  process.env['SCRUMLORD_HOME'] = sharedHome;
  // Drop the developer's ambient provider selection so provider-resolution tests
  // (`scrumlord_cli_required`, `--cli`/SCRUMLORD_CLI precedence) are hermetic and
  // don't pass or fail based on whether SCRUMLORD_CLI happens to be exported.
  delete process.env['SCRUMLORD_CLI'];
});

afterEach(() => {
  mock.restore();
  setSystemTime();
  delete process.env['SCRUMLORD_HOME'];
  if (sharedHome) {
    rmSync(sharedHome, { force: true, recursive: true });
    sharedHome = undefined;
  }
});
