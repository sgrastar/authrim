import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  adminDb: {} as DatabaseAdapter,
  coreDb: {} as DatabaseAdapter,
  resolveMapping: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: () => 'tenant-1',
    requireDedicatedAdminDatabaseAdapter: () => mocks.adminDb,
    createAuthContextFromHono: () => ({ coreAdapter: mocks.coreDb }),
    resolveRuntimeIdentityMappingBinding: mocks.resolveMapping,
    createAuditLogFromContext: mocks.audit,
    getLogger: () => ({ module: () => ({ warn: vi.fn(), error: vi.fn() }) }),
  };
});

import { adminCredentialProfilePublishHandler } from '../admin-credential-profiles';

function context(): Context<{ Bindings: Env }> {
  return {
    env: {},
    req: {
      param: (name: string) => (name === 'id' ? 'profile-1' : 'version-1'),
    },
    get: () => ({ userId: 'admin-1' }),
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as unknown as Context<{ Bindings: Env }>;
}

const profile = {
  id: 'profile-1',
  tenant_id: 'tenant-1',
  lifecycle_state: 'draft',
};
const version = {
  id: 'version-1',
  tenant_id: 'tenant-1',
  credential_profile_id: 'profile-1',
  version_number: 1,
  lifecycle_state: 'draft',
  credential_configuration_id: 'AgeCredential',
  issuance_flow_id: 'flow-issue',
  verification_flow_id: 'flow-verify',
  issuance_mapping_set_id: 'mapping-issue',
  verification_mapping_set_id: 'mapping-verify',
  claim_allowlist_json: '["age_over_18"]',
  offer_ttl_seconds: 300,
  maximum_attribute_age_seconds: 3600,
  transaction_code_required: 0,
};

describe('credential profile publication', () => {
  beforeEach(() => {
    mocks.audit.mockReset().mockResolvedValue(undefined);
    mocks.resolveMapping.mockReset();
    mocks.adminDb = {
      queryOne: vi.fn(async (sql: string) =>
        sql.includes('credential_profiles WHERE') ? profile : version
      ),
      transaction: vi.fn(async (callback) =>
        callback({ execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }) })
      ),
    } as unknown as DatabaseAdapter;
    mocks.coreDb = {
      queryOne: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('credential_configurations'))
          return { configuration_id: 'AgeCredential', is_active: 1 };
        if (sql.includes('FROM flows')) {
          return {
            id: params?.[1],
            published_version_id: String(params?.[1]).includes('issue')
              ? 'flow-version-issue'
              : 'flow-version-verify',
            status: 'published',
            kind: String(params?.[1]).includes('issue')
              ? 'credential_issuance'
              : 'attribute_elevation',
          };
        }
        if (sql.includes('FROM flow_versions')) {
          const issuance = String(params?.[1]).includes('issue');
          return {
            runtime_snapshot_json: JSON.stringify({
              flow_kind: issuance ? 'credential_issuance' : 'attribute_elevation',
              ui: {
                steps: issuance
                  ? [
                      {
                        id: 'claims',
                        source_node_id: 'n1',
                        component: 'credential_claims',
                        render: false,
                        config: { credential_profile_ref: 'profile-1' },
                      },
                      {
                        id: 'offer',
                        source_node_id: 'n2',
                        component: 'credential_offer',
                        render: false,
                        config: { credential_profile_ref: 'profile-1' },
                      },
                    ]
                  : [
                      {
                        id: 'presentation',
                        source_node_id: 'n1',
                        component: 'credential_presentation',
                        render: false,
                        config: { credential_profile_ref: 'profile-1' },
                      },
                      {
                        id: 'commit',
                        source_node_id: 'n2',
                        component: 'verified_attribute',
                        render: false,
                        config: { credential_profile_ref: 'profile-1' },
                      },
                    ],
              },
            }),
          };
        }
        return null;
      }),
    } as unknown as DatabaseAdapter;
    mocks.resolveMapping
      .mockResolvedValueOnce({
        fieldMappingVersionId: 'mapping-version-issue',
        mappingSnapshotHash: 'mapping-snapshot-issue',
        edges: [
          {
            targetRef: {
              side: 'destination',
              namespace: 'vc.claims.AgeCredential',
              path: 'age_over_18',
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        fieldMappingVersionId: 'mapping-version-verify',
        mappingSnapshotHash: 'mapping-snapshot-verify',
      });
  });

  it('pins only published flows and exact active mapping snapshots', async () => {
    const response = await adminCredentialProfilePublishHandler(context());
    const body = (await response.json()) as { snapshot_hash: string };
    expect(response.status).toBe(200);
    expect(body.snapshot_hash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(mocks.adminDb.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'credential_profile.published',
      'credential_profile',
      'profile-1',
      expect.objectContaining({ version_id: 'version-1' })
    );
  });

  it('fails closed without mutating state when an issuance Flow is not published', async () => {
    vi.mocked(mocks.coreDb.queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes('credential_configurations'))
        return { configuration_id: 'AgeCredential', is_active: 1 };
      if (sql.includes('FROM flows'))
        return {
          id: 'flow-issue',
          published_version_id: null,
          status: 'draft',
          kind: 'credential_issuance',
        };
      return null;
    });
    const response = await adminCredentialProfilePublishHandler(context());
    expect(response.status).toBe(409);
    expect(mocks.adminDb.transaction).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
