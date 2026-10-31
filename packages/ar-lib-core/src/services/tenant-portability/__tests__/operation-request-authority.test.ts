import { describe, expect, it } from 'vitest';
import {
  encodeTenantBackupRequestIntent,
  parseTenantBackupRequestIntent,
} from '../operation-request';

const base = {
  version: 1,
  kind: 'import',
  source: { tenantId: 'tenant-a', issuer: 'https://tenant.example', productVersion: '0.4.2' },
  selection: {
    settings: true,
    users: false,
    admin: true,
    artifacts: false,
    logs: { audit: false, other: false, sensitive: false, period: 'all' },
  },
  inputs: [{ id: 'upload-a', digestSha256: 'aa'.repeat(32) }],
};
const authority = {
  actorId: 'admin-a',
  platformSettingsCategories: ['institution'],
  globalAdmin: { permitted: true, hierarchyLevel: 100 },
};

describe('import request authority', () => {
  it('keeps the requester authority in the canonical intent and its digest', async () => {
    const without = await encodeTenantBackupRequestIntent(base);
    const withAuthority = await encodeTenantBackupRequestIntent({ ...base, authority });
    expect(withAuthority.intent.authority).toEqual(authority);
    expect(withAuthority.digest).not.toBe(without.digest);
    const lower = await encodeTenantBackupRequestIntent({
      ...base,
      authority: { ...authority, globalAdmin: { permitted: true, hierarchyLevel: 90 } },
    });
    expect(lower.digest).not.toBe(withAuthority.digest);
  });

  it('keeps a fractional requester level, as role levels may be', async () => {
    const fractional = { ...authority, globalAdmin: { permitted: true, hierarchyLevel: 1.5 } };
    const encoded = await encodeTenantBackupRequestIntent({ ...base, authority: fractional });
    expect(parseTenantBackupRequestIntent(JSON.parse(encoded.json)).authority).toEqual(fractional);
  });

  it('reads an import requested before authority was recorded as granting nothing', () => {
    expect(parseTenantBackupRequestIntent(base).authority).toBeUndefined();
  });

  it.each([
    ['an export', { ...base, kind: 'export', inputs: [], authority }],
    [
      'unsorted categories',
      { ...base, authority: { ...authority, platformSettingsCategories: ['z', 'a'] } },
    ],
    [
      'a repeated category',
      { ...base, authority: { ...authority, platformSettingsCategories: ['a', 'a'] } },
    ],
    [
      'a non-boolean permission',
      { ...base, authority: { ...authority, globalAdmin: { permitted: 1, hierarchyLevel: 0 } } },
    ],
    [
      'a negative level',
      {
        ...base,
        authority: { ...authority, globalAdmin: { permitted: true, hierarchyLevel: -1 } },
      },
    ],
    ['an extra field', { ...base, authority: { ...authority, extra: true } }],
    [
      'a level that is not a finite number',
      {
        ...base,
        authority: { ...authority, globalAdmin: { permitted: true, hierarchyLevel: '9' } },
      },
    ],
    ['a missing actor', { ...base, authority: { ...authority, actorId: '' } }],
  ])('refuses authority on %s', (_label, value) => {
    expect(() => parseTenantBackupRequestIntent(value)).toThrow('invalid_backup_request_intent');
  });
});
