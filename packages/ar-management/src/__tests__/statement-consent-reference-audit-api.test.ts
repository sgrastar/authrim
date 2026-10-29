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
  adminConsentReferenceAuditHandler,
  auditStatementConsentPage,
} from '../statement-consent-reference-audit';
import { findAdminRouteAccessRule } from '../admin-route-access';
const stores: ReturnType<typeof openCoreStore>[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.db.close();
  state.tenantId = 'tenant-a';
});
const context = () =>
  ({ json: (value: unknown, status = 200) => Response.json(value, { status }) }) as never;
describe('tenant consent reference audit API', () => {
  it('returns only the current tenant report, hides physical inventory, and requires settings read', async () => {
    const store = openCoreStore();
    stores.push(store);
    state.metadata = store.adapter;
    const rule = findAdminRouteAccessRule('GET', '/api/admin/consent-statements/reference-audit');
    expect(rule?.permissions).toEqual(['admin:settings:read']);
    const initial = await adminConsentReferenceAuditHandler(context());
    expect(await initial.json()).toEqual({
      status: 'not_started',
      current: null,
      last_completed: null,
    });
    await auditStatementConsentPage(
      store.adapter,
      'tenant-a',
      [{ bindingRef: 'default', adapter: store.adapter, identity: 'internal-route' }],
      { rowPageSize: 1, shardPageSize: 1, sampleLimit: 1 }
    );
    const response = await adminConsentReferenceAuditHandler(context());
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      status: 'completed',
      last_completed: { scanned: 0, unresolved: 0 },
    });
    expect(JSON.stringify(body)).not.toContain('internal-route');
    state.tenantId = 'tenant-b';
    expect(await (await adminConsentReferenceAuditHandler(context())).json()).toEqual({
      status: 'not_started',
      current: null,
      last_completed: null,
    });
    state.metadata = {
      ...store.adapter,
      queryOne: vi.fn().mockRejectedValue(new Error('unavailable')),
    };
    expect((await adminConsentReferenceAuditHandler(context())).status).toBe(500);
  });
});
