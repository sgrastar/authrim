import { describe, expect, it, vi } from 'vitest';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import type { VerifiedTenantBackupV2 } from './backup-reader';
import { deriveAwsStateSourceExpectations } from './state-source-expectations';

const text = (value: string) => ['text', value] as const;
const integer = (value: string) => ['integer', value] as const;

const users: PortableSqliteRow[] = [
  { tenant_id: text('tenant-a'), id: text('user-a') },
  { tenant_id: text('tenant-a'), id: text('user-b') },
];
const accounts: PortableSqliteRow[] = [
  {
    tenant_id: text('tenant-a'),
    id: text('account-a'),
    legacy_user_id: text('user-a'),
    account_type: text('user'),
    lifecycle_state: text('active'),
  },
  {
    tenant_id: text('tenant-a'),
    id: text('service-a'),
    account_type: text('service'),
  },
];
const passkeys: PortableSqliteRow[] = [
  {
    tenant_id: text('tenant-a'),
    id: text('passkey-a'),
    user_id: text('user-a'),
    credential_id: text('credential-a'),
    counter: integer('42'),
  },
];

function dataset(id: string, rows: PortableSqliteRow[]) {
  const readNextRow = vi.fn(async (cursor: string | null) => {
    const index = cursor === null ? 0 : Number(cursor);
    const row = rows[index];
    return row ? { rowJson: JSON.stringify(row), nextCursor: String(index + 1) } : null;
  });
  return { id, rows: rows.length, bytes: 0, readNextRow };
}

function backup(
  options: {
    users?: PortableSqliteRow[];
    accounts?: PortableSqliteRow[];
    passkeys?: PortableSqliteRow[];
    tenantId?: string;
  } = {}
) {
  const entries = new Map([
    ['core.users_core', dataset('core.users_core', options.users ?? users)],
    ['core.identity_accounts', dataset('core.identity_accounts', options.accounts ?? accounts)],
    ['core.passkeys', dataset('core.passkeys', options.passkeys ?? passkeys)],
  ]);
  const get = vi.fn((id: string) => {
    const value = entries.get(id);
    if (!value) throw new Error('unexpected_dataset');
    return value;
  });
  const source = {
    manifest: { source: { tenantId: options.tenantId ?? 'tenant-a' } },
    dataset: get,
  } as unknown as VerifiedTenantBackupV2;
  return { source, entries, get };
}

describe('AWS auth state source expectations', () => {
  it('derives user, active account, and passkey identities from verified SQL rows', async () => {
    const fixture = backup();

    await expect(deriveAwsStateSourceExpectations(fixture.source)).resolves.toEqual({
      users: [{ userId: 'user-a' }, { userId: 'user-b' }],
      accounts: [
        {
          accountId: 'account-a',
          userId: 'user-a',
          lifecycle: 'active',
        },
      ],
      passkeys: [
        {
          passkeyId: 'passkey-a',
          userId: 'user-a',
          credentialId: 'credential-a',
          sourceCounter: '42',
        },
      ],
    });
    expect(fixture.get.mock.calls.map(([id]) => id)).toEqual([
      'core.users_core',
      'core.identity_accounts',
      'core.passkeys',
    ]);
    for (const entry of fixture.entries.values()) {
      expect(entry.readNextRow).toHaveBeenCalledTimes(entry.rows + 1);
    }
  });

  it.each([
    ['user', { users: [{ tenant_id: text('tenant-b'), id: text('user-a') }] }],
    [
      'account',
      {
        accounts: [
          {
            ...accounts[0],
            tenant_id: text('tenant-b'),
          },
        ],
      },
    ],
    [
      'passkey',
      {
        passkeys: [
          {
            ...passkeys[0],
            tenant_id: text('tenant-b'),
          },
        ],
      },
    ],
  ])('refuses a cross-tenant %s row', async (_kind, rows) => {
    await expect(deriveAwsStateSourceExpectations(backup(rows).source)).rejects.toThrow(
      'aws_offline_restore_invalid'
    );
  });

  const invalidUsers: PortableSqliteRow[][] = [
    [{ ...users[0], id: ['integer', '1'] as const }],
    [{ ...users[0], id: text('') }],
    [{ id: text('user-a'), tenant_id: text('tenant-a') }, { tenant_id: text('tenant-a') }],
  ];
  it.each(invalidUsers.map((rows) => [rows] as const))(
    'rejects malformed mandatory text in a user row',
    async (rows) => {
      await expect(
        deriveAwsStateSourceExpectations(backup({ users: rows }).source)
      ).rejects.toThrow('aws_offline_restore_invalid');
    }
  );

  const invalidPasskeys: PortableSqliteRow[] = [
    { ...passkeys[0], counter: text('42') },
    { ...passkeys[0], counter: ['integer', null] as const },
    { tenant_id: text('tenant-a'), id: text('passkey-a'), user_id: text('user-a') },
  ];
  it.each(invalidPasskeys.map((row) => [row] as const))(
    'rejects a passkey without an integer counter cell',
    async (row) => {
      await expect(
        deriveAwsStateSourceExpectations(backup({ passkeys: [row] }).source)
      ).rejects.toThrow('aws_offline_restore_invalid');
    }
  );

  it('rejects an early dataset end instead of silently reducing the source inventory', async () => {
    const fixture = backup();
    const entry = fixture.entries.get('core.users_core');
    expect(entry).toBeDefined();
    entry?.readNextRow.mockResolvedValueOnce(null);

    await expect(deriveAwsStateSourceExpectations(fixture.source)).rejects.toThrow(
      'aws_offline_restore_invalid'
    );
  });

  it('rejects a repeated cursor instead of looping over the same row', async () => {
    const fixture = backup();
    const entry = fixture.entries.get('core.users_core');
    expect(entry).toBeDefined();
    entry?.readNextRow.mockResolvedValueOnce({
      rowJson: JSON.stringify(users[0]),
      nextCursor: null as unknown as string,
    });

    await expect(deriveAwsStateSourceExpectations(fixture.source)).rejects.toThrow(
      'aws_offline_restore_invalid'
    );
  });

  it('rejects an extra row beyond the verified row count', async () => {
    const fixture = backup({ users: [users[0]] });
    const entry = fixture.entries.get('core.users_core');
    expect(entry).toBeDefined();
    entry?.readNextRow.mockResolvedValueOnce({
      rowJson: JSON.stringify(users[0]),
      nextCursor: '1',
    });
    entry?.readNextRow.mockResolvedValueOnce({
      rowJson: JSON.stringify(users[1]),
      nextCursor: '2',
    });

    await expect(deriveAwsStateSourceExpectations(fixture.source)).rejects.toThrow(
      'aws_offline_restore_invalid'
    );
  });

  it('accepts empty verified datasets only when each reader also reports EOF', async () => {
    const fixture = backup({ users: [], accounts: [], passkeys: [] });
    await expect(deriveAwsStateSourceExpectations(fixture.source)).resolves.toEqual({
      users: [],
      accounts: [],
      passkeys: [],
    });
    for (const entry of fixture.entries.values()) {
      expect(entry.readNextRow).toHaveBeenCalledExactlyOnceWith(null);
    }
  });
});
