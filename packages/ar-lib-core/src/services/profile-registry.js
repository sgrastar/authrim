import { BUILTIN_RUNTIME_PROFILES, DEFAULT_AUDIT_PROFILE_ID, DEFAULT_RESIDENCY_PROFILE_ID, DEFAULT_STORAGE_PROFILE_ID, } from '../types/runtime-profile';
const DEFAULT_PREFIX = 'profile-registry';
function normalizeProfileId(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
function makeRegistryKey(prefix, kind, id) {
    return `${prefix}:${kind}:${id}`;
}
function parseProfilePayload(raw) {
    return JSON.parse(raw);
}
export class KVProfileRegistryBackend {
    kv;
    prefix;
    constructor(kv, prefix = DEFAULT_PREFIX) {
        this.kv = kv;
        this.prefix = prefix;
    }
    async get(kind, id) {
        const raw = await this.kv.get(makeRegistryKey(this.prefix, kind, id));
        return raw ? parseProfilePayload(raw) : null;
    }
    async list(kind) {
        const prefix = makeRegistryKey(this.prefix, kind, '');
        const listed = await this.kv.list({ prefix });
        const profiles = await Promise.all(listed.keys.map(async ({ name }) => {
            const raw = await this.kv.get(name);
            return raw ? parseProfilePayload(raw) : null;
        }));
        const resolved = [];
        for (const profile of profiles) {
            if (profile) {
                resolved.push(profile);
            }
        }
        return resolved;
    }
    async put(profile) {
        await this.kv.put(makeRegistryKey(this.prefix, profile.kind, profile.id), JSON.stringify(profile));
    }
    async delete(kind, id) {
        await this.kv.delete(makeRegistryKey(this.prefix, kind, id));
        return true;
    }
}
export class DatabaseProfileRegistryBackend {
    adapter;
    tableName;
    constructor(adapter, tableName = 'profile_registry') {
        this.adapter = adapter;
        this.tableName = tableName;
    }
    async get(kind, id) {
        const row = await this.adapter.queryOne(`SELECT payload_json FROM ${this.tableName} WHERE kind = ? AND id = ?`, [kind, id]);
        return row ? parseProfilePayload(row.payload_json) : null;
    }
    async list(kind) {
        const rows = await this.adapter.query(`SELECT payload_json FROM ${this.tableName} WHERE kind = ? ORDER BY id ASC`, [kind]);
        return rows.map((row) => parseProfilePayload(row.payload_json));
    }
    async put(profile) {
        const payload = JSON.stringify(profile);
        const now = new Date().toISOString();
        const updated = await this.adapter.execute(`UPDATE ${this.tableName} SET payload_json = ?, updated_at = ? WHERE kind = ? AND id = ?`, [payload, now, profile.kind, profile.id]);
        if (updated.rowsAffected > 0) {
            return;
        }
        try {
            await this.adapter.execute(`INSERT INTO ${this.tableName} (id, kind, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, [profile.id, profile.kind, payload, now, now]);
        }
        catch (error) {
            const retried = await this.adapter.execute(`UPDATE ${this.tableName} SET payload_json = ?, updated_at = ? WHERE kind = ? AND id = ?`, [payload, now, profile.kind, profile.id]);
            if (retried.rowsAffected === 0) {
                throw error;
            }
        }
    }
    async delete(kind, id) {
        const result = await this.adapter.execute(`DELETE FROM ${this.tableName} WHERE kind = ? AND id = ?`, [kind, id]);
        return result.rowsAffected > 0;
    }
}
export class RuntimeProfileRegistry {
    backend;
    builtinMap = new Map();
    builtinProfiles;
    constructor(backend, builtinProfiles = BUILTIN_RUNTIME_PROFILES) {
        this.backend = backend;
        this.builtinProfiles = builtinProfiles;
        for (const profile of builtinProfiles) {
            this.builtinMap.set(`${profile.kind}:${profile.id}`, profile);
        }
    }
    async get(kind, id) {
        const builtin = this.builtinMap.get(`${kind}:${id}`);
        if (builtin) {
            return builtin;
        }
        return this.backend.get(kind, id);
    }
    async list(kind, options = {}) {
        const includeBuiltins = options.includeBuiltins ?? true;
        const stored = await this.backend.list(kind);
        if (!includeBuiltins) {
            return stored;
        }
        const ids = new Set(stored.map((profile) => profile.id));
        const builtins = this.builtinProfiles.filter((profile) => profile.kind === kind && !ids.has(profile.id));
        return [...builtins, ...stored];
    }
    async put(profile) {
        if (profile.id.startsWith('builtin:')) {
            throw new Error('builtin_runtime_profiles_are_read_only');
        }
        await this.backend.put(profile);
    }
    async delete(kind, id) {
        if (id.startsWith('builtin:')) {
            return false;
        }
        return this.backend.delete(kind, id);
    }
}
export function readEnvironmentProfileDefaults(settings) {
    return {
        storageProfileId: normalizeProfileId(settings?.['infra.default_storage_profile_id']) ??
            DEFAULT_STORAGE_PROFILE_ID,
        auditProfileId: normalizeProfileId(settings?.['infra.default_audit_profile_id']) ?? DEFAULT_AUDIT_PROFILE_ID,
        residencyProfileId: normalizeProfileId(settings?.['infra.default_residency_profile_id']) ??
            DEFAULT_RESIDENCY_PROFILE_ID,
    };
}
export function readTenantProfileOverrides(settings) {
    return {
        storageProfileId: normalizeProfileId(settings?.['tenant.storage_profile_id']) ?? null,
        auditProfileId: normalizeProfileId(settings?.['tenant.audit_profile_id']) ?? null,
        residencyProfileId: normalizeProfileId(settings?.['tenant.residency_profile_id']) ?? null,
    };
}
export function resolveEffectiveProfileRefs(defaults, overrides) {
    const storageOverride = normalizeProfileId(overrides?.storageProfileId);
    const auditOverride = normalizeProfileId(overrides?.auditProfileId);
    const residencyOverride = normalizeProfileId(overrides?.residencyProfileId);
    return {
        storageProfileId: storageOverride ?? defaults.storageProfileId,
        auditProfileId: auditOverride ?? defaults.auditProfileId,
        residencyProfileId: residencyOverride ?? defaults.residencyProfileId,
        inherited: {
            storage: !storageOverride,
            audit: !auditOverride,
            residency: !residencyOverride,
        },
    };
}
export async function resolveRuntimeProfiles(registry, refs) {
    const [storageProfile, auditProfile, residencyProfile] = await Promise.all([
        registry.get('storage', refs.storageProfileId),
        registry.get('audit', refs.auditProfileId),
        registry.get('residency', refs.residencyProfileId),
    ]);
    if (!storageProfile) {
        throw new Error(`storage_profile_not_found:${refs.storageProfileId}`);
    }
    if (!auditProfile) {
        throw new Error(`audit_profile_not_found:${refs.auditProfileId}`);
    }
    if (!residencyProfile) {
        throw new Error(`residency_profile_not_found:${refs.residencyProfileId}`);
    }
    return {
        refs,
        storageProfile,
        auditProfile,
        residencyProfile,
    };
}
