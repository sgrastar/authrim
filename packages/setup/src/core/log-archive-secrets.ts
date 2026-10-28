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

/** Separate from config and status responses; the private file also survives interrupted setup. */
export async function stageLogArchiveSecrets(
  baseDir: string,
  environment: string,
  secrets: unknown
): Promise<void> {
  await writePrivateFileAtomically(
    pendingPath(baseDir, environment),
    JSON.stringify(validate(secrets))
  );
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
  if (existsSync(pending))
    return validate(
      JSON.parse(
        (await readPrivateFileSecurely(pending, {
          maxBytes: 32 * 1024,
          invalidError: 'log_archive_secret_file_invalid',
          permissionsError: 'log_archive_secret_file_permissions_invalid',
        })) ?? '{}'
      )
    );
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
  if (mode === 'scheduled')
    await unlink(pendingPath(baseDir, environment)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  return secrets;
}
