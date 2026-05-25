import { describe, expect, it } from 'vitest';
import { buildLoggingKeyMaterialRef } from '../key-material-backend';
import { buildRuntimeLoggingKeyRegistrySnapshot } from '../key-registry-snapshot';

describe('runtime logging key registry snapshot', () => {
  it('publishes key metadata and backend refs without key material', () => {
    const backendRef = buildLoggingKeyMaterialRef({
      backend: 'r2_wrapped_key',
      scopeId: 'tk_abc:audit:archive',
      version: 2,
      keyId: 'wrapped-current',
    });

    const snapshot = buildRuntimeLoggingKeyRegistrySnapshot(
      {
        id: 'lkey_1',
        tenantKey: 'tk_abc',
        logType: 'audit',
        plane: 'archive',
        activeVersion: 2,
        status: 'active',
        updatedAt: 1000,
      },
      [
        {
          keyRegistryId: 'lkey_1',
          version: 2,
          backendRef,
          status: 'active',
          usageCount: 10,
          staleCount: 0,
          createdAt: 900,
        },
      ]
    );

    expect(snapshot).toEqual({
      id: 'lkey_1',
      tenant_key: 'tk_abc',
      surface: null,
      log_type: 'audit',
      plane: 'archive',
      active_version: 2,
      status: 'active',
      last_rotated_at: null,
      updated_at: 1000,
      versions: [
        {
          version: 2,
          backend: 'r2_wrapped_key',
          backend_ref: backendRef,
          status: 'active',
          created_at: 900,
          retired_at: null,
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain('keyBytes');
  });
});
