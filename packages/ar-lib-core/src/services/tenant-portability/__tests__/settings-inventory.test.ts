import { describe, expect, it } from 'vitest';
import {
  inspectBackupSettingFields,
  inventoryBackupSettings,
} from '../../../../../../scripts/tenant-backup/settings-inventory';
import { checkTenantSettingFieldCoverage } from '../settings-field-registry';

describe('backup settings metadata inventory', () => {
  it('loads the repository definitions and checks their reviewed classifications', async () => {
    const fields = await inventoryBackupSettings();
    expect(fields.length).toBeGreaterThan(0);
    expect(checkTenantSettingFieldCoverage(fields)).toEqual({
      unclassified: [],
      stale: [],
      duplicates: [],
      changedShape: [],
    });
  });

  it('emits only definition shapes, never values or secret defaults', () => {
    const fields = inspectBackupSettingFields({
      example: {
        environment: 'private-environment',
        settings: {
          'example.key': {
            key: 'example.key',
            type: 'string',
            default: 'private-secret-default',
            value: 'private-live-value',
            envKey: 'PRIVATE_KEY',
          },
        },
      },
    });
    expect(fields).toEqual([{ category: 'example', key: 'example.key', type: 'string' }]);
  });

  it.each([
    null,
    [],
    { example: null },
    { example: { settings: [] } },
    { example: { settings: { key: { key: 'different', type: 'string' } } } },
    { example: { settings: { key: { key: 'key', type: 1 } } } },
  ])('rejects malformed metadata rather than silently skipping definitions: %j', (metadata) => {
    expect(() => inspectBackupSettingFields(metadata)).toThrow('backup_settings_metadata_invalid');
  });

  it.each([{}, { example: { settings: {} } }])('rejects an empty inventory: %j', (metadata) => {
    expect(() => inspectBackupSettingFields(metadata)).toThrow('backup_settings_metadata_empty');
  });

  it('passes a future field type to the coverage checker for explicit review', () => {
    const fields = inspectBackupSettingFields({
      tokens: {
        settings: {
          'tokens.access_token_signing_key_id': {
            key: 'tokens.access_token_signing_key_id',
            type: 'future-secret-reference',
          },
        },
      },
    });
    expect(checkTenantSettingFieldCoverage(fields).changedShape).toEqual([
      'tokens.access_token_signing_key_id',
    ]);
  });
});
