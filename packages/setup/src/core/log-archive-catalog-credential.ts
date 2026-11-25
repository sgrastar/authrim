import { getAccountId, getCloudflareApiToken } from './cloudflare.js';
import type { LogArchiveLock } from './log-archive-config.js';
import { loadPublishedLogArchiveWriteToken } from './log-archive-secrets.js';
import {
  assertTableCompactionHasCredential,
  ensureLogArchiveCatalogCredential,
  LogArchiveApi,
} from './log-archive.js';

export interface LogArchiveCatalogCredentialRepairOptions {
  baseDir: string;
  environment: string;
  keysDir: string;
  owned: LogArchiveLock;
  onProgress?: (message: string) => void;
}

/**
 * Deploy-time repair for archives provisioned before Setup registered the Catalog maintenance
 * credential, and for write-token rotations. Reads the write token as deployed (environment
 * override, else the published key file; never the staged copy), registers it when the provider
 * reports no credential or a different token, checks that the owned table no longer reports
 * `no_credential`, and returns the lock entry to persist. Never prints a token.
 */
export async function repairLogArchiveCatalogCredential(
  options: LogArchiveCatalogCredentialRepairOptions
): Promise<LogArchiveLock> {
  const accountId = await getAccountId();
  const credential = await getCloudflareApiToken();
  if (!accountId || !credential) throw new Error('log_archive_cloudflare_credentials_required');
  if (accountId !== options.owned.accountId)
    throw new Error('log_archive_catalog_credential_account_mismatch');
  const writeToken = await loadPublishedLogArchiveWriteToken(options.keysDir);
  const api = new LogArchiveApi(accountId, credential.token);
  const registered = await ensureLogArchiveCatalogCredential({
    api,
    bucketName: options.owned.bucketName,
    catalogWriteToken: writeToken,
    recorded: options.owned.maintenance.credential,
    onProgress: options.onProgress,
  });
  await assertTableCompactionHasCredential(api, options.owned);
  return {
    ...options.owned,
    maintenance: { ...options.owned.maintenance, credential: registered },
  };
}
