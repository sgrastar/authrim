import { ensureDatabaseAdapter, type DatabaseAdapter, type DatabaseSource } from '../../db';

export interface AuditPersistenceSourceEnv {
  DB: DatabaseSource;
  DB_PII?: DatabaseSource | null;
}

export interface AuditPersistenceSources {
  coreSource: DatabaseSource;
  piiSource: DatabaseSource;
}

export function resolveAuditPersistenceSourcesFromEnv(
  env: AuditPersistenceSourceEnv
): AuditPersistenceSources {
  return {
    coreSource: env.DB,
    piiSource: env.DB_PII ?? env.DB,
  };
}

export function resolveAuditPersistenceAdapterFromEnv(
  env: AuditPersistenceSourceEnv,
  logType: 'event' | 'pii',
  partition: string
): DatabaseAdapter {
  const sources = resolveAuditPersistenceSourcesFromEnv(env);
  return ensureDatabaseAdapter(
    logType === 'pii' ? sources.piiSource : sources.coreSource,
    partition
  );
}

export function resolveLegacyAuditLogAdapterFromEnv(
  env: AuditPersistenceSourceEnv,
  partition: string = 'legacy-audit-log'
): DatabaseAdapter {
  return resolveAuditPersistenceAdapterFromEnv(env, 'event', partition);
}
