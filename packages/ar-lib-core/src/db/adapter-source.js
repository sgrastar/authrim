import { D1Adapter } from './adapters';
export function isDatabaseAdapter(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value;
    return (typeof candidate.query === 'function' &&
        typeof candidate.queryOne === 'function' &&
        typeof candidate.execute === 'function' &&
        typeof candidate.transaction === 'function' &&
        typeof candidate.batch === 'function' &&
        typeof candidate.isHealthy === 'function' &&
        typeof candidate.getType === 'function' &&
        typeof candidate.close === 'function');
}
export function isD1DatabaseLike(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value;
    return typeof candidate.prepare === 'function' && typeof candidate.batch === 'function';
}
export function isDatabaseSource(value) {
    return isDatabaseAdapter(value) || isD1DatabaseLike(value);
}
export function ensureDatabaseAdapter(source, partition = 'core') {
    return isDatabaseAdapter(source) ? source : new D1Adapter({ db: source, partition });
}
export function ensureOptionalDatabaseAdapter(source, partition = 'core') {
    if (!source) {
        return null;
    }
    return ensureDatabaseAdapter(source, partition);
}
