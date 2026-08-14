import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SCIM_BULK_MAX_OPERATIONS,
  DEFAULT_SCIM_BULK_MAX_PAYLOAD_SIZE,
  getScimInboundSettings,
  scimSettingsKey,
} from '../scim-settings';

describe('SCIM inbound settings', () => {
  it('uses tenant-scoped defaults when no settings were saved', async () => {
    const settings = await getScimInboundSettings(
      { SETTINGS: { get: vi.fn(async () => null) } as unknown as KVNamespace },
      'tenant-a'
    );

    expect(settings).toEqual({
      enabled: false,
      usersEnabled: true,
      groupsEnabled: true,
      bulkEnabled: true,
      mappingSetId: null,
      bulkMaxOperations: DEFAULT_SCIM_BULK_MAX_OPERATIONS,
      bulkMaxPayloadSize: DEFAULT_SCIM_BULK_MAX_PAYLOAD_SIZE,
    });
  });

  it('reads Mapping Set selection and Bulk limits from the tenant settings key', async () => {
    const get = vi.fn(async () =>
      JSON.stringify({
        enabled: true,
        usersEnabled: true,
        groupsEnabled: false,
        bulkEnabled: true,
        mappingSetId: 'mapping-scim',
        bulkMaxOperations: 250,
        bulkMaxPayloadSize: 2_097_152,
      })
    );

    const settings = await getScimInboundSettings(
      { SETTINGS: { get } as unknown as KVNamespace },
      'tenant-a'
    );

    expect(get).toHaveBeenCalledWith(scimSettingsKey('tenant-a'));
    expect(settings).toMatchObject({
      mappingSetId: 'mapping-scim',
      groupsEnabled: false,
      bulkMaxOperations: 250,
      bulkMaxPayloadSize: 2_097_152,
    });
  });
});
