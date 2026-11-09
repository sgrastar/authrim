import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import { AUDIT_PII_CATEGORY, AUDIT_PII_CONFIG_KEY } from '../../types/settings/audit-pii';
import {
  AUDIT_ROUTING_CATEGORY,
  AUDIT_ROUTING_RULES_KEY,
} from '../../types/settings/audit-routing';
import { generateVersion } from '../../utils/settings-manager';
import {
  auditPIIProjectionKey,
  isValidAuditSettingsTenantId,
  listTenantPIIConfigs,
  loadAuditRoutingState,
  loadPIIConfigState,
  syncLegacyAuditRoutingRules,
} from '../audit-settings-documents';

function canonicalRow(category: string, data: Record<string, unknown>, tenantId?: string) {
  return {
    tenant_id: tenantId ?? '',
    scope_type: tenantId ? 'tenant' : 'platform',
    scope_id: tenantId ?? '',
    category,
    document_json: JSON.stringify(data),
    version: generateVersion(data),
  };
}

function environment() {
  const query = vi.fn();
  const queryOne = vi.fn();
  const execute = vi.fn();
  const adapter = {
    query,
    queryOne,
    execute,
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn(() => 'd1'),
    close: vi.fn(),
  };
  const settingsGet = vi.fn(async () => null as string | null);
  const legacyGet = vi.fn(async () => null as string | null);
  const legacyPut = vi.fn();
  const legacyDelete = vi.fn();
  const legacyList = vi.fn(async () => ({ keys: [] as { name: string }[] }));
  const env = {
    DB_ADMIN: adapter,
    SETTINGS: { get: settingsGet },
    AUTHRIM_CONFIG: {
      get: legacyGet,
      put: legacyPut,
      delete: legacyDelete,
      list: legacyList,
    },
  } as unknown as Env;
  return {
    env,
    query,
    queryOne,
    execute,
    settingsGet,
    legacyGet,
    legacyPut,
    legacyDelete,
    legacyList,
  };
}

describe('audit settings document identity', () => {
  it('rejects unsafe tenant identifiers before looking up a PII configuration', async () => {
    for (const value of ['tenant-1', 'tenant_1', 'Tenant-1']) {
      expect(isValidAuditSettingsTenantId(value)).toBe(true);
    }
    for (const value of ['', '../tenant', 'tenant/a', 'tenant:a', 'a'.repeat(129)]) {
      expect(isValidAuditSettingsTenantId(value)).toBe(false);
      await expect(loadPIIConfigState(environment().env, value)).rejects.toThrow(
        'invalid_tenant_id'
      );
    }
  });
});

describe('audit routing and PII reads', () => {
  it('prefers a canonical routing document over stale projection and legacy KV values', async () => {
    const f = environment();
    const rules = [{ sink: 'current' }];
    f.queryOne.mockResolvedValue(
      canonicalRow(AUDIT_ROUTING_CATEGORY, { [AUDIT_ROUTING_RULES_KEY]: rules })
    );
    f.settingsGet.mockResolvedValue(
      JSON.stringify({ [AUDIT_ROUTING_RULES_KEY]: [{ sink: 'stale' }] })
    );
    f.legacyGet.mockResolvedValue(JSON.stringify([{ sink: 'legacy' }]));

    const state = await loadAuditRoutingState(f.env);

    expect(state.rules).toEqual(rules);
    expect(state.version).toBe(generateVersion({ [AUDIT_ROUTING_RULES_KEY]: rules }));
    expect(state.adopt).toBeUndefined();
    expect(f.settingsGet).not.toHaveBeenCalled();
    expect(f.legacyGet).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.legacyPut).not.toHaveBeenCalled();
  });

  it('reads legacy routing rules without writing while awaiting explicit adoption', async () => {
    const f = environment();
    f.queryOne.mockResolvedValue(null);
    const rules = [{ sink: 'legacy' }];
    f.legacyGet.mockResolvedValue(JSON.stringify(rules));

    const state = await loadAuditRoutingState(f.env);

    expect(state.rules).toEqual(rules);
    expect(state.version).toBe(generateVersion({ [AUDIT_ROUTING_RULES_KEY]: rules }));
    expect(state.adopt).toEqual(expect.any(Function));
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.legacyPut).not.toHaveBeenCalled();
  });

  it('fails closed when legacy routing data is not an array', async () => {
    const f = environment();
    f.queryOne.mockResolvedValue(null);
    f.legacyGet.mockResolvedValue(JSON.stringify({ role: 'admin' }));

    await expect(loadAuditRoutingState(f.env)).rejects.toThrow('audit_retention_rules_invalid');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('uses the projected tenant PII configuration before a stale legacy value', async () => {
    const f = environment();
    f.queryOne.mockResolvedValue(null);
    const projected = { fieldMasking: 'strict' };
    f.settingsGet.mockResolvedValue(JSON.stringify({ [AUDIT_PII_CONFIG_KEY]: projected }));
    f.legacyGet.mockResolvedValue(JSON.stringify({ fieldMasking: 'legacy' }));

    const state = await loadPIIConfigState(f.env, 'tenant-a');

    expect(state.stored).toEqual(projected);
    expect(state.version).toBe(generateVersion({ [AUDIT_PII_CONFIG_KEY]: projected }));
    expect(state.adopt).toEqual(expect.any(Function));
    expect(f.settingsGet).toHaveBeenCalledWith(auditPIIProjectionKey('tenant-a'));
    expect(f.legacyGet).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('returns no tenant override when neither canonical nor legacy settings exist', async () => {
    const f = environment();
    f.queryOne.mockResolvedValue(null);
    expect((await loadPIIConfigState(f.env, 'tenant-a')).stored).toBeNull();
    expect(f.execute).not.toHaveBeenCalled();
  });
});

describe('legacy projection synchronization', () => {
  it('updates only an existing legacy key from the canonical routing document', async () => {
    const f = environment();
    const current = [{ sink: 'current' }];
    f.queryOne.mockResolvedValue(
      canonicalRow(AUDIT_ROUTING_CATEGORY, { [AUDIT_ROUTING_RULES_KEY]: current })
    );
    f.legacyGet.mockResolvedValue(JSON.stringify([{ sink: 'old' }]));

    await syncLegacyAuditRoutingRules(f.env);

    expect(f.legacyPut).toHaveBeenCalledExactlyOnceWith(
      'audit_routing_rules',
      JSON.stringify(current)
    );
    expect(f.queryOne).toHaveBeenCalledTimes(2);
    expect(f.legacyDelete).not.toHaveBeenCalled();
  });

  it('does not create a legacy copy when that key never existed', async () => {
    const f = environment();
    await syncLegacyAuditRoutingRules(f.env);
    expect(f.queryOne).not.toHaveBeenCalled();
    expect(f.legacyPut).not.toHaveBeenCalled();
  });
});

describe('tenant PII configuration listing', () => {
  it('prefers documented values and skips malformed legacy JSON', async () => {
    const f = environment();
    f.query.mockResolvedValue([
      {
        scope_id: 'tenant-a',
        document_json: JSON.stringify({ [AUDIT_PII_CONFIG_KEY]: { mode: 'current' } }),
      },
      { scope_id: 'tenant-b', document_json: '{corrupt' },
    ]);
    f.legacyList.mockResolvedValue({
      keys: [
        { name: 'pii_config:tenant-a' },
        { name: 'pii_config:tenant-b' },
        { name: 'pii_config:tenant-c' },
        { name: 'pii_config:tenant-d' },
      ],
    });
    f.legacyGet.mockImplementation(async (key: string) => {
      if (key === 'pii_config:tenant-c') return JSON.stringify({ mode: 'legacy' });
      return '{invalid';
    });

    expect(await listTenantPIIConfigs(f.env)).toEqual([
      { tenantId: 'tenant-a', config: { mode: 'current' } },
      { tenantId: 'tenant-c', config: { mode: 'legacy' } },
    ]);
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining('tenant_settings_documents'), [
      AUDIT_PII_CATEGORY,
    ]);
    expect(f.legacyGet).toHaveBeenCalledTimes(2);
    expect(f.legacyGet).not.toHaveBeenCalledWith('pii_config:tenant-a');
    expect(f.legacyGet).not.toHaveBeenCalledWith('pii_config:tenant-b');
  });
});
