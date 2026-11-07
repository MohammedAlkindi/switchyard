import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkGatewayHealth, findCortexAiDir } from '../src/commands/gateway.js';
import { spawn } from '../src/commands/spawn.js';
import { makeTempRepo, type TempRepo } from './helpers.js';

describe('fleet gateway', () => {
  it('finds packages/cortexai directory', async () => {
    const cortexDir = await findCortexAiDir();
    expect(existsSync(cortexDir)).toBe(true);
    expect(existsSync(path.join(cortexDir, 'package.json'))).toBe(true);
  });

  it('reports running false when no server is listening', async () => {
    // Port 29999 is unlikely to be listening
    const res = await checkGatewayHealth('127.0.0.1', 29999);
    expect(res.running).toBe(false);
  });

  it('reports running true when a server responds on /health', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'test-gateway' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(29998, '127.0.0.1', resolve));

    try {
      const res = await checkGatewayHealth('127.0.0.1', 29998);
      expect(res.running).toBe(true);
      expect(res.status).toBe('ok');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('fleet spawn --gateway', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await makeTempRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('provisions .env.fleet with gateway configuration when --gateway is passed', async () => {
    const result = await spawn('claude-agent', {
      cwd: repo.root,
      gateway: true,
    });

    const envFleetPath = path.join(result.worktreePath, '.env.fleet');
    expect(existsSync(envFleetPath)).toBe(true);

    const content = readFileSync(envFleetPath, 'utf8');
    expect(content).toContain('OPENAI_BASE_URL="http://127.0.0.1:8000/v1"');
    expect(content).toContain('ANTHROPIC_BASE_URL="http://127.0.0.1:8000/v1"');
    expect(content).toContain('FLEET_AGENT="claude-agent"');
  });

  it('omits .env.fleet when --gateway is not passed', async () => {
    const result = await spawn('codex-agent', {
      cwd: repo.root,
      gateway: false,
    });

    const envFleetPath = path.join(result.worktreePath, '.env.fleet');
    expect(existsSync(envFleetPath)).toBe(false);
  });
});
