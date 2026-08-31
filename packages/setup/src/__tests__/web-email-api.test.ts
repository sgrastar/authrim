import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import { generateAllSecrets, saveKeysToDirectory } from '../core/keys.js';
import { getEnvironmentPaths } from '../core/paths.js';
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
    const initialConfig = createDefaultConfig(env);
    initialConfig.features.email.verificationProtocolOriginTrial = {
      tokens: { 'https://login.example.com': 'A'.repeat(64) },
    };
    await writeFile(join(envDir, 'config.json'), JSON.stringify(initialConfig, null, 2));

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
          verificationProtocolOriginTrial: {
            tokens: Record<string, string>;
          };
        };
      };
    };
    expect(config.features.email).toMatchObject({
      provider: 'cloudflare',
      configured: true,
      fromAddress: 'no-reply@example.com',
      fromName: 'Authrim',
    });
    expect(config.features.email.verificationProtocolOriginTrial.tokens).toEqual({
      'https://login.example.com': 'A'.repeat(64),
    });
    await expect(
      readFile(join(tempDir!, '.authrim-keys', env, 'email_from.txt'), 'utf-8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const pending = JSON.parse(
      await readFile(getEnvironmentPaths({ baseDir: tempDir!, env }).pendingEmailSecrets, 'utf-8')
    ) as { provider: string; fromAddress: string };
    expect(pending).toMatchObject({
      provider: 'cloudflare',
      fromAddress: 'no-reply@example.com',
    });
  });

  it('writes email secrets directly to a complete external bundle pinned by config', async () => {
    const env = 'prod';
    const envDir = join(tempDir!, '.authrim', env);
    const pinnedBase = join(tempDir!, 'original-setup-directory');
    const pinnedKeysDir = join(pinnedBase, '.authrim-keys', env);
    await mkdir(envDir, { recursive: true });
    const initialConfig = createDefaultConfig(env);
    initialConfig.keys = {
      ...initialConfig.keys,
      storageType: 'external',
      secretsPath: `${pinnedKeysDir}/`,
    };
    await writeFile(join(envDir, 'config.json'), JSON.stringify(initialConfig, null, 2));
    await saveKeysToDirectory(generateAllSecrets('pinned-email-key'), {
      targetDir: pinnedKeysDir,
    });

    const token = generateSessionToken();
    const response = await createApiRoutes().request('/email/configure', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({
        env,
        provider: 'cloudflare',
        fromAddress: 'pinned@example.com',
      }),
    });

    expect(response.status).toBe(200);
    await expect(readFile(join(pinnedKeysDir, 'email_from.txt'), 'utf-8')).resolves.toBe(
      'pinned@example.com'
    );
    await expect(
      readFile(join(tempDir!, '.authrim-keys', env, 'email_from.txt'), 'utf-8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('promotes staged email secrets after atomic key generation', async () => {
    const env = 'fresh';
    const envDir = join(tempDir!, '.authrim', env);
    await mkdir(envDir, { recursive: true });
    await writeFile(join(envDir, 'config.json'), JSON.stringify(createDefaultConfig(env), null, 2));
    const token = generateSessionToken();
    const app = createApiRoutes();

    const configureResponse = await app.request('/email/configure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify({
        env,
        provider: 'resend',
        apiKey: 're_fresh_secret',
        fromAddress: 'fresh@example.com',
      }),
    });
    expect(configureResponse.status).toBe(200);

    const keyResponse = await app.request('/keys/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify({ env, keyId: 'fresh-email-key' }),
    });
    expect(keyResponse.status).toBe(200);
    await expect(keyResponse.json()).resolves.toMatchObject({ success: true });

    const keysDir = join(tempDir!, '.authrim-keys', env);
    await expect(readFile(join(keysDir, 'email_from.txt'), 'utf-8')).resolves.toBe(
      'fresh@example.com'
    );
    await expect(readFile(join(keysDir, 'resend_api_key.txt'), 'utf-8')).resolves.toBe(
      're_fresh_secret'
    );
    await expect(
      readFile(getEnvironmentPaths({ baseDir: tempDir!, env }).pendingEmailSecrets, 'utf-8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const committedConfig = JSON.parse(
      await readFile(getEnvironmentPaths({ baseDir: tempDir!, env }).config, 'utf-8')
    ) as { keys: { keyId?: string; publicKeyJwk?: unknown; secretsPath: string } };
    expect(committedConfig.keys.keyId).toBe('fresh-email-key');
    expect(committedConfig.keys.publicKeyJwk).toBeTruthy();
    expect(committedConfig.keys.secretsPath).toBe(`${keysDir}/`);
  });

  it('rejects direct key generation without a config and leaves no key artifact', async () => {
    const env = 'missing-key-config';
    const response = await createApiRoutes().request('/keys/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': generateSessionToken(),
      },
      body: JSON.stringify({ env, keyId: 'must-not-exist' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'environment_config_required',
    });
    await expect(
      readFile(join(tempDir!, '.authrim-keys', env, 'metadata.json'), 'utf-8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(getEnvironmentPaths({ baseDir: tempDir!, env }).config, 'utf-8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves no secret artifact when configuring an unknown environment', async () => {
    const env = 'missing-email-env';
    const response = await createApiRoutes().request('/email/configure', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': generateSessionToken(),
      },
      body: JSON.stringify({
        env,
        provider: 'resend',
        apiKey: 're_must_not_be_written',
        fromAddress: 'missing@example.com',
      }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ success: false });
    await expect(
      readFile(getEnvironmentPaths({ baseDir: tempDir!, env }).pendingEmailSecrets, 'utf-8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(join(tempDir!, '.authrim-keys', env, 'email_from.txt'), 'utf-8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('orders email transactions as stage, config commit, then promotion', async () => {
    const source = await readFile(new URL('../web/api.ts', import.meta.url), 'utf-8');
    const configureRoute = source.slice(
      source.indexOf("api.post('/email/configure'"),
      source.indexOf("api.post('/service-site/configure'")
    );
    const configureStage = configureRoute.indexOf('await stagePendingEmailSecrets({');
    const configureCommit = configureRoute.indexOf('await saveEnvironmentConfig(');
    const configurePromotion = configureRoute.indexOf('await promotePendingEmailSecrets({');
    expect(configureStage).toBeGreaterThanOrEqual(0);
    expect(configureCommit).toBeGreaterThan(configureStage);
    expect(configurePromotion).toBeGreaterThan(configureCommit);

    const enableRoute = source.slice(
      source.indexOf("api.post('/env/email/cloudflare/enable'"),
      source.indexOf("api.post('/", source.indexOf("api.post('/env/email/cloudflare/enable'") + 1)
    );
    const enableStage = enableRoute.indexOf('await stagePendingEmailSecrets({');
    const enableCommit = enableRoute.indexOf('await saveEnvironmentConfig(');
    const enablePromotion = enableRoute.indexOf('await promotePendingEmailSecrets({');
    expect(enableStage).toBeGreaterThanOrEqual(0);
    expect(enableCommit).toBeGreaterThan(enableStage);
    expect(enablePromotion).toBeGreaterThan(enableCommit);
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
