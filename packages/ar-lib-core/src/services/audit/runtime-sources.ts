import { ensureDatabaseAdapter, type DatabaseAdapter, type DatabaseSource } from '../../db';

export interface AuditPersistenceSourceEnv {
  DB: DatabaseSource;
  DB_PII: DatabaseSource;
}

export interface AuditPersistenceSources {
  coreSource: DatabaseSource;
  piiSource: DatabaseSource;
}

export function resolveAuditPersistenceSourcesFromEnv(
  env: AuditPersistenceSourceEnv
): AuditPersistenceSources {
  if (!env.DB_PII) {
    throw new Error('audit_pii_database_binding_missing');
  }
  return {
    coreSource: env.DB,
    piiSource: env.DB_PII,
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
