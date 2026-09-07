import { existsSync } from 'node:fs';
import { lstat, open, readdir, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadKeysFromDirectory } from './keys.js';
import { readPrivateFileSecurely, writePrivateFileAtomically } from './atomic-file.js';
import { getEnvironmentPaths } from './paths.js';

export type PendingEmailProvider = 'cloudflare' | 'resend' | 'sendgrid' | 'ses' | 'none';

export interface PendingEmailSecretsInput {
  provider: PendingEmailProvider;
  fromAddress?: string;
  fromName?: string;
  apiKey?: string;
}

export interface CommittedEmailConfig {
  provider?: string;
  fromAddress?: string;
  fromName?: string;
  configured?: boolean;
}

export interface PendingEmailSecretsArtifact {
  version: 1;
  environment: string;
  provider: Exclude<PendingEmailProvider, 'none'>;
  fromAddress: string;
  fromName?: string;
  apiKey?: string;
}

const ENVIRONMENT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const ACTIVE_PROVIDERS = new Set<PendingEmailSecretsArtifact['provider']>([
  'cloudflare',
  'resend',
  'sendgrid',
  'ses',
]);
const LEGACY_BOOTSTRAP_FILES = new Set([
  'email_from.txt',
  'email_from_name.txt',
  'resend_api_key.txt',
]);
const MAX_PENDING_EMAIL_SECRETS_BYTES = 64 * 1024;
const MAX_LEGACY_EMAIL_SECRET_BYTES = 64 * 1024;

function validateEnvironment(environment: string): void {
  if (!ENVIRONMENT_PATTERN.test(environment)) {
    throw new Error('invalid_pending_email_environment');
  }
}

async function removeFileDurably(path: string): Promise<void> {
  if (!existsSync(path)) return;
  await rm(path, { force: true });
  const directoryHandle = await open(dirname(path), 'r').catch(() => undefined);
  if (!directoryHandle) return;
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

function parsePendingEmailSecrets(
  raw: unknown,
  expectedEnvironment: string
): PendingEmailSecretsArtifact {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('pending_email_secrets_invalid');
  }
  const value = raw as Record<string, unknown>;
  if (
    value.version !== 1 ||
    value.environment !== expectedEnvironment ||
    typeof value.provider !== 'string' ||
    !ACTIVE_PROVIDERS.has(value.provider as PendingEmailSecretsArtifact['provider']) ||
    typeof value.fromAddress !== 'string' ||
    value.fromAddress.trim().length === 0 ||
    (value.fromName !== undefined && typeof value.fromName !== 'string') ||
    (value.apiKey !== undefined && typeof value.apiKey !== 'string')
  ) {
    throw new Error('pending_email_secrets_invalid');
  }
  const provider = value.provider as PendingEmailSecretsArtifact['provider'];
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : undefined;
  if (provider === 'resend' && !apiKey) {
    throw new Error('pending_email_secrets_invalid');
  }
  return {
    version: 1,
    environment: expectedEnvironment,
    provider,
    fromAddress: value.fromAddress.trim(),
    fromName:
      typeof value.fromName === 'string' && value.fromName.trim()
        ? value.fromName.trim()
        : undefined,
    apiKey,
  };
}

export async function clearPendingEmailSecrets(input: {
  baseDir: string;
  environment: string;
}): Promise<void> {
  validateEnvironment(input.environment);
  await removeFileDurably(
    getEnvironmentPaths({ baseDir: input.baseDir, env: input.environment }).pendingEmailSecrets
  );
}

/**
 * Persist bootstrap email material outside the canonical key directory. The key directory must
 * stay absent/empty until saveKeysToDirectory atomically publishes a complete bundle.
 */
export async function stagePendingEmailSecrets(input: {
  baseDir: string;
  environment: string;
  email: PendingEmailSecretsInput;
}): Promise<void> {
  validateEnvironment(input.environment);
  if (input.email.provider === 'none') {
    await clearPendingEmailSecrets(input);
    return;
  }
  const fromAddress = input.email.fromAddress?.trim();
  const apiKey = input.email.apiKey?.trim();
  if (!fromAddress || (input.email.provider === 'resend' && !apiKey)) {
    throw new Error('pending_email_secrets_invalid');
  }
  const artifact: PendingEmailSecretsArtifact = {
    version: 1,
    environment: input.environment,
    provider: input.email.provider,
    fromAddress,
    fromName: input.email.fromName?.trim() || undefined,
    apiKey,
  };
  const path = getEnvironmentPaths({
    baseDir: input.baseDir,
    env: input.environment,
  }).pendingEmailSecrets;
  await writePrivateFileAtomically(path, `${JSON.stringify(artifact, null, 2)}\n`, 0o600);
}

export async function loadPendingEmailSecrets(input: {
  baseDir: string;
  environment: string;
}): Promise<PendingEmailSecretsArtifact | null> {
  validateEnvironment(input.environment);
  const path = getEnvironmentPaths({
    baseDir: input.baseDir,
    env: input.environment,
  }).pendingEmailSecrets;
  const content = await readPrivateFileSecurely(path, {
    maxBytes: MAX_PENDING_EMAIL_SECRETS_BYTES,
    invalidError: 'pending_email_secrets_invalid',
    permissionsError: 'pending_email_secrets_permissions_invalid',
  });
  if (content === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new Error('pending_email_secrets_invalid', { cause: error });
  }
  return parsePendingEmailSecrets(raw, input.environment);
}

/**
 * Idempotently promote staged email material only after a complete key bundle is readable.
 * The pending artifact remains the retry authority until every canonical write/removal succeeds.
 */
export async function promotePendingEmailSecrets(input: {
  baseDir: string;
  environment: string;
  keysDir: string;
  configuredEmail: CommittedEmailConfig;
}): Promise<{ promoted: boolean }> {
  const pending = await loadPendingEmailSecrets(input);
  if (!pending) return { promoted: false };

  if (
    input.configuredEmail.configured !== true ||
    input.configuredEmail.provider !== pending.provider ||
    input.configuredEmail.fromAddress?.trim() !== pending.fromAddress ||
    (input.configuredEmail.fromName?.trim() || undefined) !== pending.fromName
  ) {
    throw new Error('pending_email_config_not_committed');
  }

  const keys = await loadKeysFromDirectory({ targetDir: input.keysDir });
  if (!keys.keyPair?.keyId || !keys.keyPair.publicKeyJwk) {
    throw new Error('complete_key_bundle_required_before_email_secret_promotion');
  }

  await writePrivateFileAtomically(join(input.keysDir, 'email_from.txt'), pending.fromAddress);
  if (pending.fromName) {
    await writePrivateFileAtomically(join(input.keysDir, 'email_from_name.txt'), pending.fromName);
  }
  if (pending.provider === 'resend' && pending.apiKey) {
    await writePrivateFileAtomically(join(input.keysDir, 'resend_api_key.txt'), pending.apiKey);
  }

  if (!pending.fromName) {
    await removeFileDurably(join(input.keysDir, 'email_from_name.txt'));
  }
  if (pending.provider !== 'resend') {
    await removeFileDurably(join(input.keysDir, 'resend_api_key.txt'));
  }

  await clearPendingEmailSecrets(input);
  return { promoted: true };
}

/**
 * Recover directories produced by the pre-atomic setup flow, which wrote email bootstrap files
 * before publishing any key bundle. Only the three known email files may be moved; any other
 * incomplete/corrupt key material remains untouched so key generation fails closed.
 */
export async function recoverLegacyPreBundleEmailSecrets(input: {
  baseDir: string;
  environment: string;
  keysDir: string;
  configuredProvider?: Exclude<PendingEmailProvider, 'none'> | 'none';
}): Promise<{ recovered: boolean }> {
  validateEnvironment(input.environment);
  const published = await loadKeysFromDirectory({ targetDir: input.keysDir });
  if (published.keyPair?.keyId && published.keyPair.publicKeyJwk) {
    return { recovered: false };
  }
  if (!existsSync(input.keysDir)) return { recovered: false };

  const directoryMetadata = await lstat(input.keysDir).catch((error) => {
    throw new Error('legacy_email_secrets_invalid', { cause: error });
  });
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error('legacy_email_secrets_invalid');
  }

  const entries = await readdir(input.keysDir);
  if (!entries.every((entry) => LEGACY_BOOTSTRAP_FILES.has(entry))) {
    return { recovered: false };
  }
  if (entries.length === 0) {
    await rmdir(input.keysDir);
    return { recovered: true };
  }

  // Validate every legacy artifact even if a pending checkpoint already exists. This prevents a
  // symlinked API key (or another insecure legacy file) from being silently accepted or removed
  // as part of a later promotion retry.
  const legacyContents = new Map<string, string>();
  for (const entry of entries) {
    const content = await readPrivateFileSecurely(join(input.keysDir, entry), {
      maxBytes: MAX_LEGACY_EMAIL_SECRET_BYTES,
      invalidError: 'legacy_email_secrets_invalid',
      permissionsError: 'legacy_email_secrets_permissions_invalid',
    });
    if (content === null) throw new Error('legacy_email_secrets_invalid');
    legacyContents.set(entry, content);
  }

  let pending = await loadPendingEmailSecrets(input);
  if (!pending) {
    const fromAddress = legacyContents.get('email_from.txt')?.trim();
    if (!fromAddress) return { recovered: false };
    const fromName = legacyContents.get('email_from_name.txt')?.trim() || undefined;
    const apiKey = legacyContents.get('resend_api_key.txt')?.trim() || undefined;
    const provider =
      input.configuredProvider && input.configuredProvider !== 'none'
        ? input.configuredProvider
        : apiKey
          ? 'resend'
          : 'cloudflare';
    await stagePendingEmailSecrets({
      baseDir: input.baseDir,
      environment: input.environment,
      email: { provider, fromAddress, fromName, apiKey },
    });
    pending = await loadPendingEmailSecrets(input);
  }
  if (!pending) throw new Error('pending_email_secrets_recovery_failed');

  for (const entry of entries) {
    await removeFileDurably(join(input.keysDir, entry));
  }
  await rmdir(input.keysDir);
  return { recovered: true };
}
