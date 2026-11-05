import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * tests/lock-race.test.ts drives dist/cli.js as real subprocesses — the only
 * way to exercise the inter-process lock. Build once per test run so the
 * compiled CLI is never stale.
 */
export default function buildCli(): void {
  execSync('npm run build', {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: 'inherit',
  });
}
