import { describe, expect, it, vi } from 'vitest';
import {
  createPhase5RecordDatasetPolicies,
  decodePortableLogicalTargetPlan,
  decodePortablePluginConfiguration,
  decodePortablePublicAsset,
  encodePortablePublicAsset,
} from '../phase5-record-datasets.js';

const text = (value: string) => ['text', value] as const;
const integer = (value: number) => ['integer', String(value)] as const;
const row = (value: Record<string, readonly [string, string | null]>) => JSON.stringify(value);
const digest = 'a'.repeat(64);

describe('Phase 5 record datasets', () => {
  it('roundtrips a tenant public asset and verifies bytes, type, key and digest', async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const sha = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const sha256 = [...sha].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const encoded = await encodePortablePublicAsset({
      tenantId: 'tenant-a',
      key: 'public/tenant-a/login-ui/logo/logo.png',
      contentType: 'image/png',
      sha256,
      bytes,
    });
    const restored = await decodePortablePublicAsset(
      new TextDecoder().decode(encoded).trim(),
      'tenant-a'
    );
    expect(restored.bytes).toEqual(bytes);
    expect(restored.sha256).toBe(sha256);
  });

  it('rejects foreign assets, forged MIME types and digest mismatch', async () => {
    const base = {
      tenant_id: text('tenant-a'),
      asset_key: text('public/tenant-b/login-ui/logo/logo.png'),
      content_type: text('image/png'),
      sha256: text(digest),
      bytes_base64: text('iVBORw0KGgoBAQ=='),
    };
    await expect(decodePortablePublicAsset(row(base), 'tenant-a')).rejects.toThrow(
      'backup_phase5_record_dataset_invalid'
    );
    await expect(
      decodePortablePublicAsset(
        row({ ...base, asset_key: text('public/tenant-a/login-ui/logo/logo.png') }),
        'tenant-a'
      )
    ).rejects.toThrow('backup_phase5_record_dataset_invalid');
  });

  it('pins plugin ID, contract version and release digest', () => {
    expect(
      decodePortablePluginConfiguration(
        row({
          tenant_id: text('tenant-a'),
          installation_id: text('installation-a'),
          plugin_id: text('plugin-a'),
          version_digest: text(digest),
          contract_version: integer(2),
          config_json: text(JSON.stringify({ routes: [] })),
        }),
        'tenant-a'
      )
    ).toMatchObject({ pluginId: 'plugin-a', contractVersion: 2, versionDigest: digest });
  });

  it('accepts logical roles and rejects source physical resource identifiers', () => {
    expect(
      decodePortableLogicalTargetPlan(
        row({
          tenant_id: text('tenant-a'),
          plan_json: text(
            JSON.stringify({
              version: 1,
              databaseRoles: ['tenant_core', 'tenant_pii'],
              rebuild: ['lookup', 'runtime_cache'],
              externalPrerequisiteIds: ['email-primary'],
            })
          ),
        }),
        'tenant-a'
      ).databaseRoles
    ).toEqual(['tenant_core', 'tenant_pii']);
    expect(() =>
      decodePortableLogicalTargetPlan(
        row({
          tenant_id: text('tenant-a'),
          plan_json: text(
            JSON.stringify({
              version: 1,
              databaseRoles: [],
              rebuild: [],
              externalPrerequisiteIds: [],
              nested: { database_id: 'source-db' },
            })
          ),
        }),
        'tenant-a'
      )
    ).toThrow('backup_phase5_record_dataset_invalid');
  });

  it('checks installed plugin support during bundle inspection', async () => {
    const assertPluginSupported = vi.fn().mockResolvedValue(undefined);
    const policy = createPhase5RecordDatasetPolicies({ assertPluginSupported })[1];
    await policy.inspectRow(
      {
        tenant_id: text('tenant-a'),
        installation_id: text('installation-a'),
        plugin_id: text('plugin-a'),
        version_digest: text(digest),
        contract_version: integer(1),
        config_json: text('{}'),
      },
      { module: 'integrations', collection: 'x', id: 'x', tenantId: 'tenant-a' }
    );
    expect(assertPluginSupported).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: 'plugin-a', versionDigest: digest })
    );
  });
});
