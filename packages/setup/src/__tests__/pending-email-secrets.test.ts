import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateAllSecrets, saveKeysToDirectory } from '../core/keys.js';
import {
  loadPendingEmailSecrets,
  promotePendingEmailSecrets,
  recoverLegacyPreBundleEmailSecrets,
  stagePendingEmailSecrets,
} from '../core/pending-email-secrets.js';
import { getEnvironmentPaths } from '../core/paths.js';

describe('pending email secrets', () => {
  let root: string;
  const environment = 'email-test';
  const committedResend = {
    provider: 'resend',
    fromAddress: 'auth@example.com',
    configured: true,
  };

  beforeEach(async () => {
    root = await mkdtemp(join(process.cwd(), '.authrim-pending-email-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stages a private artifact outside the canonical key directory', async () => {
    await stagePendingEmailSecrets({
      baseDir: root,
      environment,
      email: {
        provider: 'resend',
        fromAddress: ' auth@example.com ',
        fromName: ' Authrim ',
        apiKey: ' re_secret ',
      },
    });

    const paths = getEnvironmentPaths({ baseDir: root, env: environment });
    expect(existsSync(paths.keys)).toBe(false);
    expect((await stat(paths.pendingEmailSecrets)).mode & 0o777).toBe(0o600);
    await expect(loadPendingEmailSecrets({ baseDir: root, environment })).resolves.toMatchObject({
      provider: 'resend',
      fromAddress: 'auth@example.com',
      fromName: 'Authrim',
      apiKey: 're_secret',
    });
  });

  it('rejects a world-readable, symlinked, or oversized pending artifact', async () => {
    await stagePendingEmailSecrets({
      baseDir: root,
      environment,
      email: {
        provider: 'resend',
        fromAddress: 'auth@example.com',
        apiKey: 're_secret',
      },
    });
    const path = getEnvironmentPaths({ baseDir: root, env: environment }).pendingEmailSecrets;

    if (process.platform !== 'win32') {
      await chmod(path, 0o644);
      await expect(loadPendingEmailSecrets({ baseDir: root, environment })).rejects.toThrow(
        'pending_email_secrets_permissions_invalid'
      );
      await chmod(path, 0o600);

      const outside = join(root, 'outside-pending-email.json');
      await writeFile(outside, await readFile(path), { mode: 0o600 });
      await rm(path);
      await symlink(outside, path);
      await expect(loadPendingEmailSecrets({ baseDir: root, environment })).rejects.toThrow(
        'pending_email_secrets_invalid'
      );
      await rm(path);
    }

    await writeFile(path, 'x'.repeat(64 * 1024 + 1), { mode: 0o600 });
    await expect(loadPendingEmailSecrets({ baseDir: root, environment })).rejects.toThrow(
      'pending_email_secrets_invalid'
    );
  });

  it('promotes only after a complete key bundle and removes pending state last', async () => {
    const keysDir = join(root, '.authrim-keys', environment);
    await stagePendingEmailSecrets({
      baseDir: root,
      environment,
      email: {
        provider: 'resend',
        fromAddress: 'auth@example.com',
        apiKey: 're_secret',
      },
    });

    await expect(
      promotePendingEmailSecrets({
        baseDir: root,
        environment,
        keysDir,
        configuredEmail: committedResend,
      })
    ).rejects.toThrow('complete_key_bundle_required_before_email_secret_promotion');
    expect(
      existsSync(getEnvironmentPaths({ baseDir: root, env: environment }).pendingEmailSecrets)
    ).toBe(true);

    await saveKeysToDirectory(generateAllSecrets('email-test-key'), { targetDir: keysDir });
    await expect(
      promotePendingEmailSecrets({
        baseDir: root,
        environment,
        keysDir,
        configuredEmail: committedResend,
      })
    ).resolves.toEqual({ promoted: true });
    await expect(readFile(join(keysDir, 'email_from.txt'), 'utf-8')).resolves.toBe(
      'auth@example.com'
    );
    await expect(readFile(join(keysDir, 'resend_api_key.txt'), 'utf-8')).resolves.toBe('re_secret');
    expect(
      existsSync(getEnvironmentPaths({ baseDir: root, env: environment }).pendingEmailSecrets)
    ).toBe(false);
    await expect(
      promotePendingEmailSecrets({
        baseDir: root,
        environment,
        keysDir,
        configuredEmail: committedResend,
      })
    ).resolves.toEqual({ promoted: false });
  });

  it('recovers a legacy email-only key directory before atomic bundle publication', async () => {
    const keysDir = join(root, '.authrim-keys', environment);
    await mkdir(keysDir, { recursive: true });
    await writeFile(join(keysDir, 'email_from.txt'), 'legacy@example.com', { mode: 0o600 });
    await writeFile(join(keysDir, 'resend_api_key.txt'), 're_legacy', { mode: 0o600 });

    await expect(
      recoverLegacyPreBundleEmailSecrets({
        baseDir: root,
        environment,
        keysDir,
        configuredProvider: 'resend',
      })
    ).resolves.toEqual({ recovered: true });
    expect(existsSync(keysDir)).toBe(false);
    await expect(loadPendingEmailSecrets({ baseDir: root, environment })).resolves.toMatchObject({
      provider: 'resend',
      fromAddress: 'legacy@example.com',
      apiKey: 're_legacy',
    });

    await saveKeysToDirectory(generateAllSecrets('legacy-email-key'), { targetDir: keysDir });
    await promotePendingEmailSecrets({
      baseDir: root,
      environment,
      keysDir,
      configuredEmail: {
        provider: 'resend',
        fromAddress: 'legacy@example.com',
        configured: true,
      },
    });
    await expect(readFile(join(keysDir, 'email_from.txt'), 'utf-8')).resolves.toBe(
      'legacy@example.com'
    );
  });

  it('never promotes an insecure legacy API-key artifact', async () => {
    if (process.platform === 'win32') return;
    const keysDir = join(root, '.authrim-keys', environment);
    await mkdir(keysDir, { recursive: true });
    await writeFile(join(keysDir, 'email_from.txt'), 'legacy@example.com', { mode: 0o600 });
    await writeFile(join(keysDir, 'resend_api_key.txt'), 're_world_readable', { mode: 0o644 });

    await expect(
      recoverLegacyPreBundleEmailSecrets({
        baseDir: root,
        environment,
        keysDir,
        configuredProvider: 'resend',
      })
    ).rejects.toThrow('legacy_email_secrets_permissions_invalid');
    expect(
      existsSync(getEnvironmentPaths({ baseDir: root, env: environment }).pendingEmailSecrets)
    ).toBe(false);

    const outside = join(root, 'outside-resend-api-key.txt');
    await writeFile(outside, 're_outside', { mode: 0o600 });
    await rm(join(keysDir, 'resend_api_key.txt'));
    await symlink(outside, join(keysDir, 'resend_api_key.txt'));
    await expect(
      recoverLegacyPreBundleEmailSecrets({
        baseDir: root,
        environment,
        keysDir,
        configuredProvider: 'resend',
      })
    ).rejects.toThrow('legacy_email_secrets_invalid');
    expect(
      existsSync(getEnvironmentPaths({ baseDir: root, env: environment }).pendingEmailSecrets)
    ).toBe(false);
  });

  it('rejects an oversized legacy API-key artifact', async () => {
    const keysDir = join(root, '.authrim-keys', environment);
    await mkdir(keysDir, { recursive: true });
    await writeFile(join(keysDir, 'email_from.txt'), 'legacy@example.com', { mode: 0o600 });
    await writeFile(join(keysDir, 'resend_api_key.txt'), 'x'.repeat(64 * 1024 + 1), {
      mode: 0o600,
    });

    await expect(
      recoverLegacyPreBundleEmailSecrets({
        baseDir: root,
        environment,
        keysDir,
        configuredProvider: 'resend',
      })
    ).rejects.toThrow('legacy_email_secrets_invalid');
  });

  it('does not promote until the durable email config matches the pending transaction', async () => {
    const keysDir = join(root, '.authrim-keys', environment);
    await saveKeysToDirectory(generateAllSecrets('config-commit-key'), { targetDir: keysDir });
    await stagePendingEmailSecrets({
      baseDir: root,
      environment,
      email: {
        provider: 'resend',
        fromAddress: 'new@example.com',
        apiKey: 're_new',
      },
    });

    await expect(
      promotePendingEmailSecrets({
        baseDir: root,
        environment,
        keysDir,
        configuredEmail: {
          provider: 'cloudflare',
          fromAddress: 'old@example.com',
          configured: true,
        },
      })
    ).rejects.toThrow('pending_email_config_not_committed');
    expect(existsSync(join(keysDir, 'email_from.txt'))).toBe(false);
    expect(
      existsSync(getEnvironmentPaths({ baseDir: root, env: environment }).pendingEmailSecrets)
    ).toBe(true);

    await expect(
      promotePendingEmailSecrets({
        baseDir: root,
        environment,
        keysDir,
        configuredEmail: {
          provider: 'resend',
          fromAddress: 'new@example.com',
          configured: true,
        },
      })
    ).resolves.toEqual({ promoted: true });
  });

  it('removes stale optional secrets when changing provider and clearing fromName', async () => {
    const keysDir = join(root, '.authrim-keys', environment);
    await saveKeysToDirectory(generateAllSecrets('provider-change-key'), { targetDir: keysDir });
    await writeFile(join(keysDir, 'email_from_name.txt'), 'Old Name');
    await writeFile(join(keysDir, 'resend_api_key.txt'), 're_old');
    await stagePendingEmailSecrets({
      baseDir: root,
      environment,
      email: { provider: 'cloudflare', fromAddress: 'cloudflare@example.com' },
    });

    await promotePendingEmailSecrets({
      baseDir: root,
      environment,
      keysDir,
      configuredEmail: {
        provider: 'cloudflare',
        fromAddress: 'cloudflare@example.com',
        configured: true,
      },
    });

    expect(existsSync(join(keysDir, 'email_from_name.txt'))).toBe(false);
    expect(existsSync(join(keysDir, 'resend_api_key.txt'))).toBe(false);
  });

  it('does not remove unknown or incomplete key material during recovery', async () => {
    const keysDir = join(root, '.authrim-keys', environment);
    await mkdir(keysDir, { recursive: true });
    await writeFile(join(keysDir, 'private.pem'), 'not-a-key');
    await writeFile(join(keysDir, 'email_from.txt'), 'legacy@example.com');

    await expect(
      recoverLegacyPreBundleEmailSecrets({ baseDir: root, environment, keysDir })
    ).resolves.toEqual({ recovered: false });
    expect(existsSync(join(keysDir, 'private.pem'))).toBe(true);
    expect(
      existsSync(getEnvironmentPaths({ baseDir: root, env: environment }).pendingEmailSecrets)
    ).toBe(false);
  });
});
