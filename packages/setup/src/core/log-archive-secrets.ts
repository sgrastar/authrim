import { loadPendingBootstrap } from './pending-control-bootstrap.js';
import { createHash } from 'node:crypto';
import { ensureLogArchiveContentHmacKey } from './keys.js';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readPrivateFileSecurely, writePrivateFileAtomically } from './atomic-file.js';
import { loadLockFileAuto } from './lock.js';
import { loadProvisioningIntent } from './provisioning-intent.js';
import { getEnvironmentPaths } from './paths.js';
import { ensureLogArchiveRootKeyring } from './log-archive-root-keyring.js';

export interface LogArchiveCatalogSecrets {
  readToken: string;
  writeToken: string;
  sinkToken?: string;
}
export interface LogArchiveIssuedTokenIds {
  readTokenId: string;
  writeTokenId: string;
  sinkTokenId?: string;
}

export interface LogArchiveStageBinding {
  accountId: string;
  mode: 'scheduled' | 'pipeline';
  issuance?: LogArchiveIssuedTokenIds & {
    bootstrapTokenId: string;
    bootstrapTokenFingerprint: string;
    consumedBootstrapFingerprints?: string[];
  };
}

export interface LogArchiveStagedEvidence extends LogArchiveStageBinding {
  version: 1;
  environment: string;
  secretsFingerprint: string;
  bootstrapRevoked: boolean;
}

const FILES = {
  readToken: 'log_archive_catalog_read_token.txt',
  writeToken: 'log_archive_catalog_write_token.txt',
} as const;

function pendingPath(baseDir: string, environment: string): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(environment))
    throw new Error('log_archive_environment_invalid');
  return join(
    getEnvironmentPaths({ baseDir, env: environment }).root,
    'pending-log-archive-secrets.json'
  );
}

function validate(value: unknown): LogArchiveCatalogSecrets {
  const input = value as Partial<LogArchiveCatalogSecrets> | null;
  if (
    !input ||
    typeof input.readToken !== 'string' ||
    typeof input.writeToken !== 'string' ||
    !input.readToken.trim() ||
    !input.writeToken.trim() ||
    input.readToken.trim() === input.writeToken.trim()
  )
    throw new Error('log_archive_distinct_catalog_credentials_required');
  const sinkToken = input.sinkToken?.trim();
  if (
    sinkToken !== undefined &&
    (!sinkToken || sinkToken === input.readToken.trim() || sinkToken === input.writeToken.trim())
  )
    throw new Error('log_archive_distinct_sink_credential_required');
  return {
    readToken: input.readToken.trim(),
    writeToken: input.writeToken.trim(),
    ...(sinkToken ? { sinkToken } : {}),
  };
}

/** Manual input must not replace the generation a recovery checkpoint still owns. */
export async function assertLogArchiveManualEntryAllowed(
  baseDir: string,
  environment: string
): Promise<void> {
  if (await loadPendingBootstrap({ baseDir, environment, purpose: 'log-archive' }))
    throw new Error('log_archive_pending_recovery_required');
}

/** Separate from config and status responses; the private file also survives interrupted setup. */
export async function stageLogArchiveSecrets(
  baseDir: string,
  environment: string,
  secrets: unknown,
  binding?: LogArchiveStageBinding
): Promise<void> {
  if (!binding?.issuance) await assertLogArchiveManualEntryAllowed(baseDir, environment);
  await writePrivateFileAtomically(
    pendingPath(baseDir, environment),
    JSON.stringify(validate(secrets))
  );
  if (binding) {
    await writePrivateFileAtomically(
      metadataPath(baseDir, environment),
      JSON.stringify({
        version: 1,
        environment,
        ...binding,
        secretsFingerprint: logArchiveSecretsFingerprint(validate(secrets)),
        bootstrapRevoked: false,
      }),
      0o600
    );
  } else {
    await unlink(metadataPath(baseDir, environment)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw new Error('log_archive_secret_file_invalid');
    });
  }
}

export async function loadStagedLogArchiveSecrets(
  baseDir: string,
  environment: string
): Promise<LogArchiveCatalogSecrets> {
  const content = await readPrivateFileSecurely(pendingPath(baseDir, environment), {
    maxBytes: 32 * 1024,
    invalidError: 'log_archive_secret_file_invalid',
    permissionsError: 'log_archive_secret_file_permissions_invalid',
  });
  if (content === null) throw new Error('log_archive_catalog_credentials_required');
  try {
    return validate(JSON.parse(content));
  } catch {
    throw new Error('log_archive_secret_file_invalid');
  }
}

export async function loadLogArchiveSecrets(
  baseDir: string,
  environment: string,
  keysDir?: string
): Promise<LogArchiveCatalogSecrets> {
  const fromEnvironment = {
    readToken: process.env.LOG_ARCHIVE_CATALOG_READ_TOKEN,
    writeToken: process.env.LOG_ARCHIVE_CATALOG_WRITE_TOKEN,
    sinkToken: process.env.LOG_ARCHIVE_CATALOG_SINK_TOKEN,
  };
  if (fromEnvironment.readToken !== undefined || fromEnvironment.writeToken !== undefined)
    return validate(fromEnvironment);
  const pending = pendingPath(baseDir, environment);
  if (existsSync(pending)) return loadStagedLogArchiveSecrets(baseDir, environment);
  if (keysDir) {
    const readToken = await readPrivateFileSecurely(join(keysDir, FILES.readToken), {
      maxBytes: 16 * 1024,
      invalidError: 'log_archive_secret_file_invalid',
      permissionsError: 'log_archive_secret_file_permissions_invalid',
    });
    const writeToken = await readPrivateFileSecurely(join(keysDir, FILES.writeToken), {
      maxBytes: 16 * 1024,
      invalidError: 'log_archive_secret_file_invalid',
      permissionsError: 'log_archive_secret_file_permissions_invalid',
    });
    return validate({ readToken, writeToken });
  }
  throw new Error('log_archive_catalog_credentials_required');
}

export async function publishLogArchiveSecrets(
  baseDir: string,
  environment: string,
  keysDir: string,
  mode: 'pipeline' | 'scheduled',
  keyVersion = 1
): Promise<LogArchiveCatalogSecrets> {
  const pending = await loadPendingBootstrap({ baseDir, environment, purpose: 'log-archive' });
  if (pending) {
    const evidence = await requireStagedLogArchiveEvidence(
      baseDir,
      environment,
      pending.accountId,
      mode
    );
    if (
      pending.phase !== 'issued' ||
      (!pending.bootstrapRevoked && !evidence.bootstrapRevoked) ||
      evidence.secretsFingerprint !== pending.stagedSecretsFingerprint
    )
      throw new Error('log_archive_bootstrap_revocation_unconfirmed');
  }
  const secrets = await loadLogArchiveSecrets(baseDir, environment, keysDir);
  if (mode === 'pipeline' && !secrets.sinkToken)
    throw new Error('log_archive_sink_credential_required');
  const { lock } = await loadLockFileAuto(baseDir, environment);
  const intent = await loadProvisioningIntent({ baseDir, environment });
  await ensureLogArchiveRootKeyring(keysDir, {
    keyVersion,
    requireExisting: Boolean(lock?.logArchive) || Object.keys(intent?.resources ?? {}).length > 0,
  });
  await ensureLogArchiveContentHmacKey(keysDir, {
    requireExisting: Boolean(lock?.logArchive) || Object.keys(intent?.resources ?? {}).length > 0,
  });
  const publishedKeys = ['readToken', 'writeToken'] as const;
  for (const key of publishedKeys)
    await writePrivateFileAtomically(join(keysDir, FILES[key]), `${secrets[key]}\n`);
  // Pipeline's third credential belongs to the Sink, never to a Worker secret upload plan.
  if (mode === 'scheduled' && !pending)
    await unlink(pendingPath(baseDir, environment)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  return secrets;
}

/** Only remove a staged generation created by this issuance attempt, never unrelated credentials. */
export function logArchiveSecretsFingerprint(secrets: LogArchiveCatalogSecrets): string {
  return createHash('sha256')
    .update(JSON.stringify(validate(secrets)))
    .digest('hex');
}

export async function discardIssuedLogArchiveSecrets(
  baseDir: string,
  environment: string,
  fingerprint: string | null
): Promise<void> {
  if (!fingerprint || !existsSync(pendingPath(baseDir, environment))) return;
  const secrets = await loadStagedLogArchiveSecrets(baseDir, environment);
  if (logArchiveSecretsFingerprint(secrets) === fingerprint) {
    await unlink(metadataPath(baseDir, environment)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw new Error('log_archive_secret_file_invalid');
    });
    await unlink(pendingPath(baseDir, environment));
  }
}

function metadataPath(baseDir: string, environment: string): string {
  return pendingPath(baseDir, environment).replace(/\.json$/u, '.metadata.json');
}

export function hasStagedLogArchiveSecrets(baseDir: string, environment: string): boolean {
  return existsSync(pendingPath(baseDir, environment));
}

/** Non-secret evidence; fingerprint comparison also detects manual replacement of the private values. */
export async function loadStagedLogArchiveEvidence(
  baseDir: string,
  environment: string,
  keysDir?: string
): Promise<LogArchiveStagedEvidence | null> {
  const content = await readPrivateFileSecurely(metadataPath(baseDir, environment), {
    maxBytes: 16 * 1024,
    invalidError: 'log_archive_secret_file_invalid',
    permissionsError: 'log_archive_secret_file_permissions_invalid',
  });
  if (content === null) return null;
  let evidence: LogArchiveStagedEvidence;
  try {
    evidence = JSON.parse(content) as LogArchiveStagedEvidence;
    const allowed = [
      'version',
      'environment',
      'accountId',
      'mode',
      'secretsFingerprint',
      'bootstrapRevoked',
      'issuance',
    ];
    const ids = evidence.issuance;
    if (
      !evidence ||
      typeof evidence !== 'object' ||
      Array.isArray(evidence) ||
      Object.keys(evidence).some((key) => !allowed.includes(key)) ||
      evidence.version !== 1 ||
      evidence.environment !== environment ||
      typeof evidence.accountId !== 'string' ||
      !/^[a-f0-9]{32}$/u.test(evidence.accountId) ||
      !['scheduled', 'pipeline'].includes(evidence.mode) ||
      typeof evidence.bootstrapRevoked !== 'boolean' ||
      typeof evidence.secretsFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(evidence.secretsFingerprint) ||
      (ids !== undefined &&
        (!ids ||
          typeof ids !== 'object' ||
          Array.isArray(ids) ||
          Object.keys(ids).some(
            (key) =>
              ![
                'readTokenId',
                'writeTokenId',
                'sinkTokenId',
                'bootstrapTokenId',
                'bootstrapTokenFingerprint',
                'consumedBootstrapFingerprints',
              ].includes(key)
          ) ||
          ![
            ids.readTokenId,
            ids.writeTokenId,
            ids.bootstrapTokenId,
            ...(ids.sinkTokenId ? [ids.sinkTokenId] : []),
          ].every((id) => typeof id === 'string' && /^[a-f0-9]{32}$/u.test(id)) ||
          new Set([
            ids.readTokenId,
            ids.writeTokenId,
            ids.bootstrapTokenId,
            ...(ids.sinkTokenId ? [ids.sinkTokenId] : []),
          ]).size !== (ids.sinkTokenId ? 4 : 3) ||
          (ids.sinkTokenId !== undefined &&
            (typeof ids.sinkTokenId !== 'string' || !/^[a-f0-9]{32}$/u.test(ids.sinkTokenId))) ||
          (evidence.mode === 'pipeline') !== Boolean(ids.sinkTokenId) ||
          typeof ids.bootstrapTokenFingerprint !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(ids.bootstrapTokenFingerprint) ||
          (ids.consumedBootstrapFingerprints !== undefined &&
            (!Array.isArray(ids.consumedBootstrapFingerprints) ||
              ids.consumedBootstrapFingerprints.some(
                (fp) => typeof fp !== 'string' || !/^[a-f0-9]{64}$/u.test(fp)
              )))))
    )
      throw new Error();
  } catch {
    throw new Error('log_archive_secret_file_invalid');
  }
  if (!hasStagedLogArchiveSecrets(baseDir, environment) && !keysDir) return null;
  const secrets = hasStagedLogArchiveSecrets(baseDir, environment)
    ? await loadStagedLogArchiveSecrets(baseDir, environment)
    : await loadLogArchiveSecrets(baseDir, environment, keysDir);
  if (logArchiveSecretsFingerprint(secrets) !== evidence.secretsFingerprint)
    throw new Error('log_archive_secret_file_invalid');
  return evidence;
}

/**
 * Account that Setup issued the current log tokens for, or undefined when the values did not come
 * from an issuance (manual entry, environment variables) or cannot be proven unchanged. Issuance
 * verified each token's exact policy with the one-time token, and the evidence fingerprint binds
 * the values to it, so deploy may skip the policy read an OAuth login is not allowed to make.
 * Any doubt returns undefined, which keeps the full inspection. Environment overrides always do:
 * `loadLogArchiveSecrets` prefers them over the staged values this evidence describes.
 */
export async function loadIssuedLogArchiveAccountId(
  baseDir: string,
  environment: string,
  mode: 'scheduled' | 'pipeline',
  keysDir?: string
): Promise<string | undefined> {
  if (
    process.env.LOG_ARCHIVE_CATALOG_READ_TOKEN !== undefined ||
    process.env.LOG_ARCHIVE_CATALOG_WRITE_TOKEN !== undefined ||
    process.env.LOG_ARCHIVE_CATALOG_SINK_TOKEN !== undefined
  )
    return undefined;
  try {
    const evidence = await loadStagedLogArchiveEvidence(baseDir, environment, keysDir);
    return evidence?.issuance && evidence.mode === mode ? evidence.accountId : undefined;
  } catch {
    return undefined;
  }
}

export async function requireStagedLogArchiveEvidence(
  baseDir: string,
  environment: string,
  accountId: string,
  mode: 'scheduled' | 'pipeline',
  keysDir?: string
): Promise<LogArchiveStagedEvidence> {
  const evidence = await loadStagedLogArchiveEvidence(baseDir, environment, keysDir);
  if (!evidence) throw new Error('log_archive_staged_account_required');
  if (evidence.accountId !== accountId) throw new Error('log_archive_staged_account_mismatch');
  if (evidence.mode !== mode) throw new Error('log_archive_staged_mode_mismatch');
  return evidence;
}

export async function markStagedLogArchiveBootstrapRevoked(
  baseDir: string,
  environment: string,
  expectedFingerprint: string,
  consumedBootstrapFingerprints: readonly string[] = []
): Promise<void> {
  const evidence = await loadStagedLogArchiveEvidence(baseDir, environment);
  if (!evidence?.issuance || evidence.secretsFingerprint !== expectedFingerprint)
    throw new Error('log_archive_secret_file_invalid');
  await writePrivateFileAtomically(
    metadataPath(baseDir, environment),
    JSON.stringify({
      ...evidence,
      bootstrapRevoked: true,
      issuance: {
        ...evidence.issuance,
        consumedBootstrapFingerprints: [
          ...new Set([
            evidence.issuance.bootstrapTokenFingerprint,
            ...(evidence.issuance.consumedBootstrapFingerprints ?? []),
            ...consumedBootstrapFingerprints,
          ]),
        ],
      },
    }),
    0o600
  );
}
