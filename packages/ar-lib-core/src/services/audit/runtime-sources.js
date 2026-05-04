import { ensureDatabaseAdapter } from '../../db';
export function resolveAuditPersistenceSourcesFromEnv(env) {
    return {
        coreSource: env.DB,
        piiSource: env.DB_PII ?? env.DB,
    };
}
export function resolveAuditPersistenceAdapterFromEnv(env, logType, partition) {
    const sources = resolveAuditPersistenceSourcesFromEnv(env);
    return ensureDatabaseAdapter(logType === 'pii' ? sources.piiSource : sources.coreSource, partition);
}
export function resolveLegacyAuditLogAdapterFromEnv(env, partition = 'legacy-audit-log') {
    return resolveAuditPersistenceAdapterFromEnv(env, 'event', partition);
}
