import type { ReplicationConfiguration } from './plan';
import { assertAwsDatabaseTlsUrl } from '../startup/deployment-config';

/** Bootstrap credentials are used only for explicit initialization of the same database. */
export function replicationAuthorityDatabaseUrl(
  authority: ReplicationConfiguration['authority'],
  mode: string,
  secret: (name: string) => string
): string {
  const invalid = (): never => {
    throw new Error('replication_cli_invalid');
  };
  if (!['initialize', 'sync', 'switch', 'failover'].includes(mode)) invalid();
  const journalDatabaseUrl = secret(authority.databaseUrlEnv);
  assertAwsDatabaseTlsUrl(journalDatabaseUrl);
  let databaseUrl = journalDatabaseUrl;
  const bootstrap = authority.bootstrap;
  if (bootstrap) {
    const journalUrl = new URL(journalDatabaseUrl);
    if (journalUrl.username !== bootstrap.journalRole) invalid();
    if (mode === 'initialize') {
      databaseUrl = secret(bootstrap.databaseUrlEnv);
      assertAwsDatabaseTlsUrl(databaseUrl);
      const ownerUrl = new URL(databaseUrl);
      if (
        ownerUrl.hostname !== journalUrl.hostname ||
        (ownerUrl.port || '5432') !== (journalUrl.port || '5432') ||
        ownerUrl.pathname !== journalUrl.pathname ||
        [bootstrap.serviceRole, bootstrap.journalRole].includes(ownerUrl.username)
      )
        invalid();
    }
  }
  return databaseUrl;
}
