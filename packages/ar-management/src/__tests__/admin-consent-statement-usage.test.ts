import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { openCoreStore } from './helpers/core-schema-sqlite';

const state = vi.hoisted(() => ({
  metadata: null as DatabaseAdapter | null,
  tenantId: 'tenant-a',
}));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: () => state.tenantId,
  createAuthContextFromHono: () => ({ coreAdapter: state.metadata }),
  getLogger: () => ({ module: () => ({ error: vi.fn() }) }),
}));

import {
  adminConsentStatementUsageHandler,
  statementIdsInFlowDocument,
} from '../admin-consent-statement-usage';
import { findAdminRouteAccessRule } from '../admin-route-access';

const stores: ReturnType<typeof openCoreStore>[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.db.close();
  state.tenantId = 'tenant-a';
});
const context = () =>
  ({ json: (value: unknown, status = 200) => Response.json(value, { status }) }) as never;

const consentGraph = (ids: string[]) =>
  JSON.stringify({
    nodes: [
      { id: 'request', type: 'entry', config: {} },
      {
        id: 'consent',
        type: 'consent',
        config: { statements: ids.map((id, i) => ({ statement_id: id, required: i === 0 })) },
      },
    ],
    edges: [],
  });

function insertFlow(
  db: ReturnType<typeof openCoreStore>['db'],
  values: {
    id: string;
    tenant: string;
    name: string;
    draft: string | null;
    published?: string;
    deleted?: boolean;
  }
) {
  const versionId = values.published ? `${values.id}-v1` : null;
  db.prepare(
    `INSERT INTO flows (id, tenant_id, profile_id, name, display_name, graph_definition, kind,
       status, draft_editor_json, published_version_id, deleted_at, created_at, updated_at)
     VALUES (?, ?, 'human-basic', ?, ?, ?, 'login', 'draft', ?, ?, ?, 1, 1)`
  ).run(
    values.id,
    values.tenant,
    values.name,
    values.name,
    values.draft ?? '{"nodes":[],"edges":[]}',
    values.draft,
    versionId,
    values.deleted ? 1 : null
  );
  if (versionId) {
    db.prepare(
      `INSERT INTO flow_versions (id, tenant_id, flow_id, version_number, schema_version,
         editor_snapshot_json, runtime_snapshot_json, validation_result_json, published_at, created_at)
       VALUES (?, ?, ?, 1, '1', ?, '{}', '{}', 1, 1)`
    ).run(versionId, values.tenant, values.id, values.published ?? null);
  }
}

describe('consent statement usage', () => {
  it('finds statement ids at any depth and refuses documents too deep to walk', () => {
    expect([
      ...statementIdsInFlowDocument({
        ui: { steps: [{ config: { statements: [{ statement_id: 'a' }, { statement_id: 'b' }] } }] },
      }),
    ]).toEqual(['a', 'b']);
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 80; i++) deep = { child: deep };
    expect(() => statementIdsInFlowDocument(deep)).toThrow();
  });

  it('lists flows (draft and published) and services of the current tenant only', async () => {
    const store = openCoreStore();
    stores.push(store);
    state.metadata = store.adapter;
    expect(
      findAdminRouteAccessRule('GET', '/api/admin/consent-statements/usage')?.permissions
    ).toEqual(['admin:settings:read']);

    insertFlow(store.db, {
      id: 'flow-1',
      tenant: 'tenant-a',
      name: 'Sign-in',
      draft: consentGraph(['tos', 'news']),
      published: consentGraph(['tos']),
    });
    insertFlow(store.db, { id: 'flow-2', tenant: 'tenant-a', name: 'Broken', draft: '{not json' });
    insertFlow(store.db, {
      id: 'flow-3',
      tenant: 'tenant-a',
      name: 'Deleted',
      draft: consentGraph(['tos']),
      deleted: true,
    });
    insertFlow(store.db, {
      id: 'flow-4',
      tenant: 'tenant-b',
      name: 'Other tenant',
      draft: consentGraph(['tos']),
    });
    store.db
      .prepare(
        `INSERT INTO oauth_clients (client_id, tenant_id, client_name, redirect_uris, grant_types,
           response_types, information_release_consent, created_at, updated_at)
         VALUES ('rp-1', 'tenant-a', 'Portal', '[]', '[]', '[]', ?, 1, 1)`
      )
      .run(
        JSON.stringify({
          enabled: true,
          ask: 'once',
          show_values: true,
          purpose_statement_id: 'privacy',
        })
      );
    store.db
      .prepare(
        `INSERT INTO identity_providers (id, tenant_id, name, provider_type, config_json, created_at, updated_at)
         VALUES ('sp-1', 'tenant-a', 'Library', 'saml_sp', ?, 1, 1)`
      )
      .run(
        JSON.stringify({
          entityId: 'https://sp.example',
          informationReleaseConsent: {
            enabled: true,
            ask: 'once',
            show_values: false,
            purpose_statement_id: 'privacy',
          },
        })
      );

    const response = await adminConsentStatementUsageHandler(context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      usages: [
        {
          statement_id: 'news',
          flows: [
            { flow_id: 'flow-1', name: 'Sign-in', kind: 'login', draft: true, published: false },
          ],
          services: [],
        },
        {
          statement_id: 'privacy',
          flows: [],
          services: [
            { protocol: 'saml', id: 'sp-1', name: 'Library' },
            { protocol: 'oidc', id: 'rp-1', name: 'Portal' },
          ],
        },
        {
          statement_id: 'tos',
          flows: [
            { flow_id: 'flow-1', name: 'Sign-in', kind: 'login', draft: true, published: true },
          ],
          services: [],
        },
      ],
      usages_complete: false,
    });

    state.tenantId = 'tenant-b';
    const other = await (
      await adminConsentStatementUsageHandler(context())
    ).json<{
      usages: { statement_id: string }[];
      usages_complete: boolean;
    }>();
    expect(other.usages.map((u) => u.statement_id)).toEqual(['tos']);
    expect(other.usages_complete).toBe(true);
  });

  it('marks the result incomplete when a service setting cannot be read', async () => {
    const store = openCoreStore();
    stores.push(store);
    state.metadata = store.adapter;
    store.db
      .prepare(
        `INSERT INTO identity_providers (id, tenant_id, name, provider_type, config_json, created_at, updated_at)
         VALUES ('sp-bad', 'tenant-a', 'Broken', 'saml_sp', '{not json', 1, 1)`
      )
      .run();
    const body = await (
      await adminConsentStatementUsageHandler(context())
    ).json<{
      usages: unknown[];
      usages_complete: boolean;
    }>();
    expect(body).toEqual({ usages: [], usages_complete: false });
  });

  it('answers 500 when the store cannot be read', async () => {
    state.metadata = { query: vi.fn().mockRejectedValue(new Error('down')) } as never;
    const response = await adminConsentStatementUsageHandler(context());
    expect(response.status).toBe(500);
  });
});
