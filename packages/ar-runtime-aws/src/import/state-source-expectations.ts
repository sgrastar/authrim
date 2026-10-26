import type { AccountAuthenticationLifecycle } from '@authrim/ar-lib-core';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import type { VerifiedTenantBackupV2 } from './backup-reader';
import type { AwsStateSourceExpectations } from './state-restore';

function invalid(): never {
  throw new Error('aws_offline_restore_invalid');
}

function rowText(row: PortableSqliteRow, key: string): string {
  const value = row[key];
  if (!value || value[0] !== 'text' || typeof value[1] !== 'string' || !value[1]) invalid();
  return value[1];
}

async function rows(backup: VerifiedTenantBackupV2, id: string): Promise<PortableSqliteRow[]> {
  const dataset = backup.dataset(id);
  const result: PortableSqliteRow[] = [];
  let cursor: string | null = null;
  for (let index = 0; index < dataset.rows; index++) {
    const next = await dataset.readNextRow(cursor);
    if (!next || next.nextCursor === cursor) invalid();
    result.push(JSON.parse(next.rowJson) as PortableSqliteRow);
    cursor = next.nextCursor;
  }
  if ((await dataset.readNextRow(cursor)) !== null) invalid();
  return result;
}

/** Source coverage is derived from the verified SQL rows, independently of supplemental state. */
export async function deriveAwsStateSourceExpectations(
  backup: VerifiedTenantBackupV2
): Promise<AwsStateSourceExpectations> {
  const [users, accounts, passkeys] = await Promise.all([
    rows(backup, 'core.users_core'),
    rows(backup, 'core.identity_accounts'),
    rows(backup, 'core.passkeys'),
  ]);
  const tenantId = backup.manifest.source.tenantId;
  for (const row of [...users, ...accounts, ...passkeys])
    if (rowText(row, 'tenant_id') !== tenantId) invalid();
  return {
    users: users.map((row) => ({ userId: rowText(row, 'id') })),
    accounts: accounts
      .filter((row) => rowText(row, 'account_type') === 'user')
      .map((row) => ({
        accountId: rowText(row, 'id'),
        userId: rowText(row, 'legacy_user_id'),
        lifecycle: rowText(row, 'lifecycle_state') as AccountAuthenticationLifecycle,
      })),
    passkeys: passkeys.map((row) => {
      const counter = row.counter;
      if (!counter || counter[0] !== 'integer' || typeof counter[1] !== 'string') invalid();
      return {
        passkeyId: rowText(row, 'id'),
        userId: rowText(row, 'user_id'),
        credentialId: rowText(row, 'credential_id'),
        sourceCounter: counter[1],
      };
    }),
  };
}
