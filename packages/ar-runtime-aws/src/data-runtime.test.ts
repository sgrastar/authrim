import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import {
  createLookupBlindIndex,
  type LookupIdentifierRow,
} from '@authrim/ar-lib-core/services/lookup-directory/index';
import { createAwsRuntimeDataPorts, type AwsDataTenantInventory } from './data-runtime';

const READ_KEY = { generation: 1, secret: 'lookup-secret-with-at-least-thirty-two-bytes' };
const ACCOUNT_ID = 'account:user-1';
const ROUTE = {
  schemaVersion: 1,
  accountRouteGeneration: 3,
  residencyPolicyId: 'default',
  targets: [
    {
      dataRole: 'tenant_core/users',
      residencyPartition: 'global',
      shardId: 'core-1',
      bindingRef: 'TEST_TDB_CORE',
      requiredBindingRouteGeneration: 2,
    },
    {
      dataRole: 'tenant_pii',
      residencyPartition: 'global',
      shardId: 'pii-1',
      bindingRef: 'TEST_TDB_PII',
      requiredBindingRouteGeneration: 2,
    },
  ],
};

async function lookupRow(
  tenantId: string,
  kind: 'account_id' | 'external_subject',
  identifier: string | { issuer: string; subject: string }
): Promise<LookupIdentifierRow> {
  const index = await createLookupBlindIndex(kind, identifier, READ_KEY);
  return {
    virtual_bucket: index.virtualBucket,
    index_kind: index.indexKind,
    normalization_version: index.normalizationVersion,
    hmac_key_generation: index.hmacKeyGeneration,
    identifier_blind_digest: index.digest,
    tenant_id: tenantId,
    account_id: ACCOUNT_ID,
    route_schema_version: ROUTE.schemaVersion,
    account_route_generation: ROUTE.accountRouteGeneration,
    required_binding_route_generation: 2,
    residency_policy_id: ROUTE.residencyPolicyId,
    route_projection_json: JSON.stringify(ROUTE),
    tenant_lifecycle_state: 'active',
    runtime_route_status: 'active',
    lifecycle_state: 'active',
  };
}

function fakePostgres(
  account: {
    id: string;
    legacy_user_id: string;
    lifecycle_state: string;
    directory_publication_state: string;
  } | null
) {
  const queryOne = vi.fn(async () => account);
  return {
    db: { getType: () => 'postgres', queryOne } as unknown as DatabaseAdapter,
    queryOne,
  };
}

async function inventory(tenantId = 'alpha') {
  const metadata = fakePostgres(null);
  const core = fakePostgres({
    id: ACCOUNT_ID,
    legacy_user_id: 'user-1',
    lifecycle_state: 'active',
    directory_publication_state: 'active',
  });
  const pii = fakePostgres(null);
  const externalSubject = { issuer: 'passkey:example.org', subject: 'credential-1' };
  const value: AwsDataTenantInventory = {
    tenantId,
    allocationScope: 'shared_pool',
    metadataCoreDb: metadata.db,
    accountCoreByBindingRef: { TEST_TDB_CORE: core.db },
    accountPiiByBindingRef: { TEST_TDB_PII: pii.db },
    lookupRows: [
      await lookupRow(tenantId, 'account_id', ACCOUNT_ID),
      await lookupRow(tenantId, 'external_subject', externalSubject),
    ],
    coreAccountRouteGenerations: { [ACCOUNT_ID]: ROUTE.accountRouteGeneration },
    lookupReadKeys: [READ_KEY],
  };
  return { value, core, externalSubject };
}

describe('AWS runtime data ports', () => {
  it('routes an imported passkey membership and checks the active Core account', async () => {
    const { value, core, externalSubject } = await inventory();
    const ports = createAwsRuntimeDataPorts([value]);
    expect((await ports.resolveTenant('alpha')).route.allocationScope).toBe('shared_pool');
    const resolved = await ports.resolveAccount({
      tenantId: 'alpha',
      indexKind: 'external_subject',
      identifier: externalSubject,
    });
    expect(resolved.accountId).toBe(ACCOUNT_ID);
    expect(resolved.legacyUserId).toBe('user-1');
    expect(resolved.coreBindingRef).toBe('TEST_TDB_CORE');
    expect(resolved.piiBindingRef).toBe('TEST_TDB_PII');
    expect(core.queryOne).toHaveBeenCalledWith(expect.stringContaining('identity_accounts'), [
      'alpha',
      ACCOUNT_ID,
    ]);
  });

  it('rejects cross-tenant lookup and inactive restored accounts', async () => {
    const { value, core, externalSubject } = await inventory();
    const ports = createAwsRuntimeDataPorts([value]);
    await expect(
      ports.resolveAccount({
        tenantId: 'beta',
        indexKind: 'external_subject',
        identifier: externalSubject,
      })
    ).rejects.toThrow('tenant_not_found');
    core.queryOne.mockResolvedValueOnce({
      id: ACCOUNT_ID,
      legacy_user_id: 'user-1',
      lifecycle_state: 'suspended',
      directory_publication_state: 'active',
    });
    await expect(
      ports.resolveAccountCore({ tenantId: 'alpha', accountId: ACCOUNT_ID })
    ).rejects.toThrow('account_inactive');
  });

  it('refuses a Lookup row copied into the wrong tenant inventory', async () => {
    const { value } = await inventory();
    expect(() => createAwsRuntimeDataPorts([{ ...value, tenantId: 'beta' }])).toThrow(
      'lookup_tenant_mismatch'
    );
  });

  it('refuses Lookup routes whose generation does not match the imported Core account', async () => {
    const { value } = await inventory();
    expect(() =>
      createAwsRuntimeDataPorts([
        {
          ...value,
          coreAccountRouteGenerations: { [ACCOUNT_ID]: ROUTE.accountRouteGeneration + 1 },
        },
      ])
    ).toThrow('core_route_generation_mismatch');
    expect(() =>
      createAwsRuntimeDataPorts([{ ...value, coreAccountRouteGenerations: {} }])
    ).toThrow('core_route_generation_mismatch');
  });

  it('refuses a Core account whose legacy user does not match its canonical ID', async () => {
    const { value, core } = await inventory();
    const ports = createAwsRuntimeDataPorts([value]);
    core.queryOne.mockResolvedValueOnce({
      id: ACCOUNT_ID,
      legacy_user_id: 'different-user',
      lifecycle_state: 'active',
      directory_publication_state: 'active',
    });
    await expect(
      ports.resolveAccountCore({ tenantId: 'alpha', accountId: ACCOUNT_ID })
    ).rejects.toThrow('account_inactive');
  });
});
