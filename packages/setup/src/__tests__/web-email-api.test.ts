import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import { createApiRoutes, generateSessionToken, parseEnvironmentConfigForEnv } from '../web/api.js';

const originalCwd = process.cwd();
let tempDir: string | null = null;

describe('setup web email API', () => {
  beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'authrim-web-email-api-')));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('persists Cloudflare Email Service provider state into the environment config', async () => {
    const env = 'prod';
    const envDir = join(tempDir!, '.authrim', env);
    await mkdir(envDir, { recursive: true });
    await writeFile(join(envDir, 'config.json'), JSON.stringify(createDefaultConfig(env), null, 2));

    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/email/configure', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({
        env,
        provider: 'cloudflare',
        fromAddress: 'no-reply@example.com',
        fromName: 'Authrim',
      }),
    });

    expect(response.status).toBe(200);

    const config = JSON.parse(await readFile(join(envDir, 'config.json'), 'utf-8')) as {
      features: {
        email: {
          provider: string;
          configured: boolean;
          fromAddress: string;
          fromName: string;
        };
      };
    };
    expect(config.features.email).toMatchObject({
      provider: 'cloudflare',
      configured: true,
      fromAddress: 'no-reply@example.com',
      fromName: 'Authrim',
    });
    await expect(
      readFile(join(tempDir!, '.authrim-keys', env, 'email_from.txt'), 'utf-8')
    ).resolves.toBe('no-reply@example.com');
  });

  it('rejects path-like environment names before setup actions run', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/deploy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({
        env: '../prod',
        dryRun: true,
        skipBuild: true,
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Invalid environment name',
    });
  });

  it('rejects a config file from a different environment', () => {
    const prodConfig = createDefaultConfig('prod');

    expect(() => parseEnvironmentConfigForEnv(prodConfig, 'staging')).toThrow(
      'Config environment mismatch'
    );
  });
});
