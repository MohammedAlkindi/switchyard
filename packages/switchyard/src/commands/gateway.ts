import { spawn as spawnProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetError } from '../lib/errors.js';
import { bold, dim, ok, warn } from '../lib/format.js';
import { getMainRepoRoot } from '../lib/git.js';

export interface GatewayOptions {
  port?: number;
  host?: string;
  status?: boolean;
  cwd?: string;
}

/** Check if the gateway is running and responding on the specified port. */
export async function checkGatewayHealth(
  host = '127.0.0.1',
  port = 8000,
): Promise<{ running: boolean; status?: string; details?: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host,
        port,
        path: '/health',
        timeout: 1500,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const data = JSON.parse(raw);
              resolve({ running: true, status: data.status, details: data });
            } catch {
              resolve({ running: true, status: 'ok' });
            }
          } else {
            resolve({ running: false, status: `HTTP ${res.statusCode}` });
          }
        });
      },
    );

    req.on('error', () => {
      resolve({ running: false });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ running: false });
    });
  });
}

/** Find the absolute path to packages/cortexai in the repository. */
export async function findCortexAiDir(startDir?: string): Promise<string> {
  const currentFile = fileURLToPath(import.meta.url);
  // Try relative to current source file: packages/switchyard/src/commands -> packages/cortexai
  const relativeSibling = path.resolve(path.dirname(currentFile), '../../../cortexai');
  if (existsSync(relativeSibling)) {
    return relativeSibling;
  }

  // Try from repo root
  try {
    const repoRoot = await getMainRepoRoot(startDir ?? process.cwd());
    const monorepoPath = path.join(repoRoot, 'packages', 'cortexai');
    if (existsSync(monorepoPath)) {
      return monorepoPath;
    }
  } catch {
    // Ignore and proceed
  }

  throw new FleetError(
    'Could not locate `packages/cortexai`. Ensure you are inside the Switchyard repository.',
  );
}

/**
 * Start the CortexAI local model proxy and fleet gateway.
 */
export async function gateway(opts: GatewayOptions = {}): Promise<void> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 8000;

  if (opts.status) {
    const health = await checkGatewayHealth(host, port);
    if (health.running) {
      console.log(ok(`Switchyard Fleet Gateway is running on http://${host}:${port}`));
      console.log(`  Health: ${health.status ?? 'ok'}`);
      console.log(`  OpenAI Base URL:    http://${host}:${port}/v1`);
      console.log(`  Anthropic Base URL: http://${host}:${port}/v1`);
      console.log(`  Fleet Agents API:   http://${host}:${port}/fleet/agents`);
    } else {
      console.log(warn(`Switchyard Fleet Gateway is NOT running on http://${host}:${port}`));
      console.log(dim('Run `fleet gateway` to start it.'));
    }
    return;
  }

  const cortexDir = await findCortexAiDir(opts.cwd);

  console.log(bold('Starting Switchyard Fleet Gateway (CortexAI Proxy)...'));
  console.log(`  Directory: ${cortexDir}`);
  console.log(`  Endpoint:  http://${host}:${port}`);
  console.log(`  Base URL:  http://${host}:${port}/v1`);
  console.log(dim('  Press Ctrl+C to stop.\n'));

  // Use python/py executable
  const isWindows = process.platform === 'win32';
  const pythonCmd = isWindows ? 'py' : 'python3';
  const pythonArgs = isWindows
    ? ['-3', '-m', 'uvicorn', 'api.server:app', '--host', host, '--port', String(port)]
    : ['-m', 'uvicorn', 'api.server:app', '--host', host, '--port', String(port)];

  return new Promise((resolve, reject) => {
    const child = spawnProcess(pythonCmd, pythonArgs, {
      cwd: cortexDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        PYTHONPATH: cortexDir,
      },
    });

    child.on('error', (err) => {
      reject(
        new FleetError(
          `Failed to launch Python gateway: ${err.message}. ` +
            'Ensure Python 3.11+ and uvicorn are installed (`pip install -r packages/cortexai/requirements.txt`).',
        ),
      );
    });

    const shutdown = () => {
      child.kill('SIGINT');
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    child.on('close', (code) => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new FleetError(`Gateway exited with code ${code}`));
      }
    });
  });
}
