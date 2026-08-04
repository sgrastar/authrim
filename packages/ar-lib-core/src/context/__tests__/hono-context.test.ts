import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import {
  createAccountAuthContextFromHono,
  createAuthContextFromHono,
  createPIIContextFromHono,
  hasPIIDatabase,
  resolveOptionalCoreAdapterFromHono,
} from '../hono-context';

function adapter(name: string): DatabaseAdapter {
  return {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn().mockReturnValue(name),
    close: vi.fn(),
  };
}

function context(values: Record<string, unknown>) {
  return {
    env: {},
    get(key: string) {
      return values[key];
    },
  } as unknown as Parameters<typeof createPIIContextFromHono>[0];
}

describe('hono-context Control Plane sources', () => {
  it('uses the resolved tenant metadata source for an auth context', () => {
    const core = adapter('tenant-metadata');
    const c = context({
      tenantId: 'tenant-a',
      tenantMetadataContext: { tenantId: 'tenant-a', coreDb: core },
    });

    const auth = createAuthContextFromHono(c);

    expect(auth.tenantId).toBe('tenant-a');
    expect(auth.coreAdapter).toBe(core);
  });

  it('rejects auth context creation without tenant identity or metadata', () => {
    expect(() => createAuthContextFromHono(context({}))).toThrow('requires tenant context');
    expect(() => createAuthContextFromHono(context({ tenantId: 'tenant-a' }))).toThrow(
      'tenant_metadata_context_required'
    );
  });

  it('rejects tenant metadata from another tenant', () => {
    const c = context({
      tenantId: 'tenant-a',
      tenantMetadataContext: { tenantId: 'tenant-b', coreDb: adapter('wrong-tenant') },
    });

    expect(() => createAuthContextFromHono(c)).toThrow('tenant_metadata_context_conflict');
  });

  it('resolves an optional core adapter only from tenant metadata', () => {
    const core = adapter('tenant-metadata');
    const c = context({ tenantMetadataContext: { tenantId: 'tenant-a', coreDb: core } });

    expect(resolveOptionalCoreAdapterFromHono(c, 'policy')).toBe(core);
    expect(resolveOptionalCoreAdapterFromHono(context({}), 'policy')).toBeNull();
  });

  it('uses one explicit account route for core and PII access', () => {
    const accountCore = adapter('account-core');
    const accountPii = adapter('account-pii');
    const c = context({
      tenantId: 'tenant-a',
      tenantMetadataContext: { tenantId: 'tenant-a', coreDb: adapter('tenant-metadata') },
      accountDataContext: {
        tenantId: 'tenant-a',
        accountId: 'account:user-a',
        coreDb: accountCore,
        piiDb: accountPii,
        userCacheScope: {
          routeGeneration: 3,
          bindingGeneration: 'core:8:pii:9',
          schemaGeneration: 'core:1:pii:1',
        },
        piiCacheMode: 'no_cross_request_pii',
      },
    });

    const pii = createPIIContextFromHono(c);

    expect(pii.coreAdapter).toBe(accountCore);
    expect(pii.defaultPiiAdapter).toBe(accountPii);
    expect(pii.userCacheScope).toEqual({
      routeGeneration: 3,
      bindingGeneration: 'core:8:pii:9',
      schemaGeneration: 'core:1:pii:1',
    });
    expect(pii.piiCacheMode).toBe('no_cross_request_pii');
    expect(hasPIIDatabase(c)).toBe(true);
  });

  it('fails closed instead of using environment bindings without an account route', () => {
    const c = context({
      tenantId: 'tenant-a',
      tenantMetadataContext: { tenantId: 'tenant-a', coreDb: adapter('tenant-metadata') },
    });

    expect(() => createPIIContextFromHono(c)).toThrow('account_data_context_required');
    expect(hasPIIDatabase(c)).toBe(false);
  });

  it('rejects an account route from another tenant', () => {
    const c = context({
      tenantId: 'tenant-a',
      accountDataContext: {
        tenantId: 'tenant-b',
        coreDb: adapter('account-core'),
        piiDb: adapter('account-pii'),
      },
    });

    expect(() => createPIIContextFromHono(c)).toThrow('account_data_context_conflict');
  });

  it('uses the account core source for account-scoped auth', () => {
    const metadataCore = adapter('tenant-metadata');
    const accountCore = adapter('account-core');
    const c = context({
      tenantId: 'tenant-a',
      tenantMetadataContext: { tenantId: 'tenant-a', coreDb: metadataCore },
      accountDataContext: { tenantId: 'tenant-a', coreDb: accountCore },
    });

    expect(createAuthContextFromHono(c).coreAdapter).toBe(metadataCore);
    expect(createAccountAuthContextFromHono(c).coreAdapter).toBe(accountCore);
  });

  it('requires an account route for account-scoped auth', () => {
    const c = context({
      tenantId: 'tenant-a',
      tenantMetadataContext: { tenantId: 'tenant-a', coreDb: adapter('tenant-metadata') },
    });

    expect(() => createAccountAuthContextFromHono(c)).toThrow('account_data_context_required');
  });
});
