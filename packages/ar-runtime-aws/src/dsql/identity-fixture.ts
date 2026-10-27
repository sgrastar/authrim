/** Encrypted synthetic identity rows for DSQL evaluation; never a login-ready backup. */
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import { POSTGRES_RESTORE_TABLE_CONTRACTS } from '../import/postgres-restore-table-contract';
import { createDsqlSubsetFixture, type DsqlSubsetFixture } from './subset-fixture';
export type DsqlIdentityFixture = DsqlSubsetFixture;
const TENANT = 'dsql-synthetic-identity';
const SUBSET = ['core.users_core', 'pii.users_pii', 'core.passkeys'] as const;

function invalid(): never {
  throw new Error('dsql_identity_fixture_invalid');
}

function syntheticRow(datasetId: string, index: number, now: number): PortableSqliteRow {
  const spec = POSTGRES_RESTORE_TABLE_CONTRACTS.find((entry) => entry.datasetId === datasetId);
  if (!spec) return invalid();
  const suffix = index.toString().padStart(6, '0');
  const userId = `synthetic-user-${suffix}`;
  const fields: Record<string, string | number | null> = {
    id: userId,
    tenant_id: TENANT,
    created_at: now,
    updated_at: now,
  };
  if (datasetId === 'core.users_core') {
    Object.assign(fields, {
      email_verified: 1,
      phone_number_verified: 0,
      email_domain_hash: 'synthetic-domain-hash',
      email_domain_hash_version: 1,
      password_hash: null,
      is_active: 1,
      user_type: 'end_user',
      pii_partition: 'default',
      pii_status: 'active',
      status: 'active',
      lifecycle_state: 'active',
    });
  } else if (datasetId === 'pii.users_pii') {
    Object.assign(fields, {
      pii_class: 'PROFILE',
      email: `${userId}@identity.example.test`,
      email_blind_index: `synthetic-email-${suffix}`,
      name: `合成ユーザー ${suffix}`,
      locale: 'ja',
      // Preserve source JSON number lexemes; JSON.stringify cannot represent this integer.
      custom_attributes_json:
        index === 0
          ? '{"purpose":"DSQL適合試験","ordinal":0,"preciseInteger":9007199254740993,"fraction":0.125,"exponent":1e-3}'
          : JSON.stringify({ purpose: 'DSQL適合試験', ordinal: index }),
    });
  } else if (datasetId === 'core.passkeys') {
    Object.assign(fields, {
      id: `synthetic-passkey-${suffix}`,
      user_id: userId,
      credential_id: `synthetic-credential-${suffix}`,
      // Deliberately not a usable WebAuthn credential. This fixture tests storage, not login.
      public_key: 'synthetic-public-key-not-valid-for-authentication',
      counter: index === 0 ? '9007199254740993' : String(index),
      transports: '["internal"]',
      device_name: 'Synthetic storage probe',
      rp_id: 'identity.example.test',
    });
  } else {
    return invalid();
  }
  return Object.fromEntries(
    spec.columns.map((column) => {
      const value = fields[column] ?? null;
      return [
        column,
        value === null
          ? ['null', null]
          : [spec.sqliteIntegerColumns.includes(column) ? 'integer' : 'text', String(value)],
      ];
    })
  );
}

/** Generates and then verifies AUTHRIM2 bytes with a separately produced in-memory receipt. */
export async function createDsqlIdentityFixture(
  options: { userCount?: number } = {}
): Promise<DsqlIdentityFixture> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) invalid();
  const userCount = options.userCount ?? 201;
  if (
    !Number.isSafeInteger(userCount) ||
    userCount < 1 ||
    userCount > 2000 ||
    Object.keys(options).some((key) => key !== 'userCount')
  )
    invalid();
  return createDsqlSubsetFixture({
    kind: 'identity',
    tenantId: TENANT,
    issuer: 'https://identity.example.test',
    expectedRows: Object.fromEntries(SUBSET.map((id) => [id, userCount])),
    row: syntheticRow,
  });
}
