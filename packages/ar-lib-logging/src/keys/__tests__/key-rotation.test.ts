import { describe, expect, it } from 'vitest';
import { buildLoggingKeyMaterialRef } from '../key-material-backend';
import { rotateLoggingKeyRegistry } from '../key-rotation';

describe('logging key rotation', () => {
  it('makes the new key version active immediately and marks old chunks for rewrap', () => {
    const newBackendRef = buildLoggingKeyMaterialRef({
      backend: 'r2_wrapped_key',
      scopeId: 'tk_abc:audit:archive',
      version: 2,
      keyId: 'logging-keys/scope/v2.json',
    });

    const result = rotateLoggingKeyRegistry({
      registry: {
        id: 'lkey_1',
        tenantKey: 'tk_abc',
        logType: 'audit',
        plane: 'archive',
        activeVersion: 1,
        status: 'active',
        updatedAt: 1000,
      },
      versions: [
        {
          keyRegistryId: 'lkey_1',
          version: 1,
          backendRef: 'logkey:r2_wrapped_key:tk_abc%3Aaudit%3Aarchive:v1:old',
          status: 'active',
          usageCount: 12,
          staleCount: 0,
          createdAt: 900,
        },
      ],
      newBackendRef,
      now: 2000,
    });

    expect(result.registry).toMatchObject({
      activeVersion: 2,
      status: 'stale',
      lastRotatedAt: 2000,
      updatedAt: 2000,
    });
    expect(result.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          version: 1,
          status: 'rewrap_required',
          staleCount: 12,
          retiredAt: null,
        }),
        expect.objectContaining({
          version: 2,
          backendRef: newBackendRef,
          status: 'active',
          usageCount: 0,
          staleCount: 0,
        }),
      ])
    );
  });

  it('rejects backend refs that do not match the next version', () => {
    const newBackendRef = buildLoggingKeyMaterialRef({
      backend: 'd1_wrapped_key',
      scopeId: 'tk_abc:audit:archive',
      version: 3,
      keyId: 'scope/v3',
    });

    expect(() =>
      rotateLoggingKeyRegistry({
        registry: {
          id: 'lkey_1',
          tenantKey: 'tk_abc',
          logType: 'audit',
          plane: 'archive',
          activeVersion: 1,
          status: 'active',
          updatedAt: 1000,
        },
        versions: [],
        newBackendRef,
        now: 2000,
      })
    ).toThrow('logging_key_rotation_backend_ref_version_mismatch');
  });
});
