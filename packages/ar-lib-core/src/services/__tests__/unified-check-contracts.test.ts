/**
 * Unified Check Service: the server and self contracts, server-side resource context resolution,
 * and the ReBAC feature gate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUnifiedCheckService } from '../unified-check-service';
import {
  createResourceContextResolverRegistry,
  NO_RESOURCE_CONTEXT_RESOLVER,
} from '../resource-context-resolver';
import type {
  CheckApiRequest,
  PolicyEvaluationContext,
  TenantPolicySettings,
} from '../../types/check-api';

// A database where the subject has no role, no ID-level grant and nothing else.
const mockD1 = {
  prepare: vi.fn(() => {
    const statement = {
      bind: () => statement,
      all: async () => ({ results: [] }),
      first: async () => null,
      run: async () => ({ success: true, meta: { changes: 0 } }),
    };
    return statement;
  }),
};

const OWNER_REQUEST: CheckApiRequest = {
  subject_id: 'user_1',
  permission: 'documents:doc_1:read',
  tenant_id: 'tenant_a',
};

function policy(overrides: Partial<TenantPolicySettings> = {}): TenantPolicySettings {
  return { abac: false, verifiedAttributes: false, logDecisions: false, ...overrides };
}

describe('UnifiedCheckService contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('server contract', () => {
    it('takes resource_context from the request (owner shortcut)', async () => {
      const service = createUnifiedCheckService({ db: mockD1 as never });
      const result = await service.check({
        ...OWNER_REQUEST,
        resource_context: { owner_id: 'user_1' },
      });
      expect(result.allowed).toBe(true);
      expect(result.resolved_via).toEqual(['computed']);
    });

    it('is the default contract', async () => {
      const service = createUnifiedCheckService({ db: mockD1 as never });
      const result = await service.check(
        { ...OWNER_REQUEST, resource_context: { owner_id: 'user_1' } },
        { contract: 'server' }
      );
      expect(result.allowed).toBe(true);
    });

    it('never consults the resource context resolver', async () => {
      const resolver = { resolve: vi.fn(async () => ({ owner_id: 'user_1' })) };
      const service = createUnifiedCheckService({
        db: mockD1 as never,
        resourceContextResolver: resolver,
      });
      const result = await service.check(OWNER_REQUEST);
      expect(result.allowed).toBe(false);
      expect(resolver.resolve).not.toHaveBeenCalled();
    });
  });

  describe('self contract', () => {
    it('refuses a request that carries resource_context', async () => {
      const service = createUnifiedCheckService({ db: mockD1 as never });
      const result = await service.check(
        { ...OWNER_REQUEST, resource_context: { owner_id: 'user_1' } },
        { contract: 'self' }
      );
      expect(result).toMatchObject({ allowed: false, reason: 'contract_violation' });
    });

    it('refuses a request that carries rebac, without asking the ReBAC service', async () => {
      const rebacService = { check: vi.fn(async () => ({ allowed: true })) };
      const service = createUnifiedCheckService({
        db: mockD1 as never,
        rebacService: rebacService as never,
        enableRebac: true,
      });
      const result = await service.check(
        { ...OWNER_REQUEST, rebac: { relation: 'viewer', object: 'document:doc_1' } },
        { contract: 'self' }
      );
      expect(result).toMatchObject({ allowed: false, reason: 'contract_violation' });
      expect(rebacService.check).not.toHaveBeenCalled();
    });

    it('resolves nothing by default: no ownership grant without a resolver', async () => {
      const service = createUnifiedCheckService({ db: mockD1 as never });
      const result = await service.check(OWNER_REQUEST, { contract: 'self' });
      expect(result.allowed).toBe(false);
      expect(await NO_RESOURCE_CONTEXT_RESOLVER.resolve({} as never)).toBeNull();
    });

    it('never grants on ownership alone: the owner is material for the tenant rules', async () => {
      const registry = createResourceContextResolverRegistry();
      const resolve = vi.fn(async ({ resourceId }: { resourceId?: string }) =>
        resourceId === 'doc_1' ? { owner_id: 'user_1' } : { owner_id: 'someone_else' }
      );
      registry.register('tenant_a', 'documents', resolve);

      // Without rules, the resolved owner grants nothing (no owner shortcut).
      const noRules = createUnifiedCheckService({
        db: mockD1 as never,
        resourceContextResolver: registry,
      });
      expect((await noRules.check(OWNER_REQUEST, { contract: 'self' })).allowed).toBe(false);

      // A rule: owners may read (only read).
      const evaluate = vi.fn((context: PolicyEvaluationContext) => ({
        allowed: context.resourceOwnerId === context.subjectId && context.action === 'read',
        decidedBy: 'owners_read',
      }));
      const withRules = createUnifiedCheckService({
        db: mockD1 as never,
        resourceContextResolver: registry,
        tenantPolicy: async () => policy({ abac: true, evaluator: { evaluate } }),
      });
      const read = await withRules.check(OWNER_REQUEST, { contract: 'self', clientId: 'app_1' });
      const remove = await withRules.check(
        { ...OWNER_REQUEST, permission: 'documents:doc_1:delete' },
        { contract: 'self' }
      );
      const other = await withRules.check(
        { ...OWNER_REQUEST, permission: 'documents:doc_2:read' },
        { contract: 'self' }
      );

      expect(read).toMatchObject({ allowed: true, resolved_via: ['computed'] });
      expect(remove.allowed).toBe(false);
      expect(other.allowed).toBe(false);
      expect(resolve).toHaveBeenCalledWith({
        tenantId: 'tenant_a',
        resourceType: 'documents',
        resourceId: 'doc_1',
        action: 'read',
        subjectId: 'user_1',
        clientId: 'app_1',
      });
    });

    describe('relationship named by the resolver', () => {
      function relationshipDb(hasTuple: boolean) {
        const binds: unknown[][] = [];
        const db = {
          prepare: vi.fn((sql: string) => {
            const statement = {
              bind: (...params: unknown[]) => {
                if (sql.includes('FROM relationships')) binds.push(params);
                return statement;
              },
              all: async () => ({ results: [] }),
              first: async () =>
                sql.includes('FROM relationships') && hasTuple ? { id: 't1' } : null,
              run: async () => ({ success: true, meta: { changes: 0 } }),
            };
            return statement;
          }),
        };
        return { db, binds };
      }
      const resolver = {
        resolve: async () => ({
          rebac: { relation: 'viewer', object_type: 'document', object_id: 'doc_1' },
        }),
      };

      it('grants through a direct subject tuple when the tenant enables ReBAC', async () => {
        const { db, binds } = relationshipDb(true);
        const service = createUnifiedCheckService({
          db: db as never,
          resourceContextResolver: resolver,
          tenantPolicy: async () => policy({ rebac: true }),
        });
        expect(await service.check(OWNER_REQUEST, { contract: 'self' })).toMatchObject({
          allowed: true,
          resolved_via: ['rebac'],
        });
        expect(binds[0]?.slice(0, 5)).toEqual([
          'tenant_a',
          'user_1',
          'document',
          'doc_1',
          'viewer',
        ]);
        const sql = (db.prepare.mock.calls as unknown as string[][])
          .map((call) => call[0])
          .find((text) => text.includes('FROM relationships'));
        expect(sql).toContain("from_type = 'subject'");
      });

      it('denies without the tuple, and while ReBAC is off', async () => {
        const without = createUnifiedCheckService({
          db: relationshipDb(false).db as never,
          resourceContextResolver: resolver,
          tenantPolicy: async () => policy({ rebac: true }),
        });
        expect((await without.check(OWNER_REQUEST, { contract: 'self' })).allowed).toBe(false);

        const off = relationshipDb(true);
        const disabled = createUnifiedCheckService({
          db: off.db as never,
          resourceContextResolver: resolver,
          tenantPolicy: async () => policy(),
        });
        expect((await disabled.check(OWNER_REQUEST, { contract: 'self' })).allowed).toBe(false);
        expect(off.binds).toEqual([]);
      });

      it('lets the resolver name a relation per action (single and batch)', async () => {
        const perAction = {
          resolve: async ({ action }: { action: string }) =>
            action === 'read'
              ? { rebac: { relation: 'viewer', object_type: 'document', object_id: 'doc_1' } }
              : null,
        };
        const service = createUnifiedCheckService({
          db: relationshipDb(true).db as never,
          resourceContextResolver: perAction,
          tenantPolicy: async () => policy({ rebac: true }),
        });
        const remove = { ...OWNER_REQUEST, permission: 'documents:doc_1:delete' };
        expect((await service.check(OWNER_REQUEST, { contract: 'self' })).allowed).toBe(true);
        expect((await service.check(remove, { contract: 'self' })).allowed).toBe(false);
        const batch = await service.batchCheck(
          { checks: [OWNER_REQUEST, remove] },
          { contract: 'self' }
        );
        expect(batch.results.map((result) => result.allowed)).toEqual([true, false]);
      });

      it('evaluates no relationship with the default resolver', async () => {
        const { db, binds } = relationshipDb(true);
        const service = createUnifiedCheckService({
          db: db as never,
          tenantPolicy: async () => policy({ rebac: true }),
        });
        expect((await service.check(OWNER_REQUEST, { contract: 'self' })).allowed).toBe(false);
        expect(binds).toEqual([]);
      });
    });

    it('does not use a resolver registered for another tenant', async () => {
      const registry = createResourceContextResolverRegistry();
      registry.register('tenant_b', 'documents', async () => ({ owner_id: 'user_1' }));
      const service = createUnifiedCheckService({
        db: mockD1 as never,
        resourceContextResolver: registry,
      });
      expect((await service.check(OWNER_REQUEST, { contract: 'self' })).allowed).toBe(false);
    });

    it('treats a failing resolver as knowing nothing', async () => {
      const service = createUnifiedCheckService({
        db: mockD1 as never,
        resourceContextResolver: {
          resolve: async () => {
            throw new Error('resource registry down');
          },
        },
      });
      const result = await service.check(OWNER_REQUEST, { contract: 'self' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('no_matching_permission');
    });

    it('applies the contract to every check of a batch', async () => {
      const service = createUnifiedCheckService({ db: mockD1 as never });
      const result = await service.batchCheck(
        {
          checks: [OWNER_REQUEST, { ...OWNER_REQUEST, resource_context: { owner_id: 'user_1' } }],
        },
        { contract: 'self' }
      );
      expect(result.results.map((r) => r.reason)).toEqual([
        'no_matching_permission',
        'contract_violation',
      ]);
    });
  });

  describe('ReBAC gate (feature.enable_rebac)', () => {
    const rebacRequest: CheckApiRequest = {
      ...OWNER_REQUEST,
      rebac: { relation: 'viewer', object: 'document:doc_1' },
    };

    it('does not evaluate rebac when ReBAC is off (default)', async () => {
      const rebacService = { check: vi.fn(async () => ({ allowed: true })) };
      const service = createUnifiedCheckService({
        db: mockD1 as never,
        rebacService: rebacService as never,
      });
      expect((await service.check(rebacRequest)).allowed).toBe(false);
      expect(rebacService.check).not.toHaveBeenCalled();
    });

    it('evaluates rebac when the tenant enables ReBAC', async () => {
      const rebacService = { check: vi.fn(async () => ({ allowed: true })) };
      const service = createUnifiedCheckService({
        db: mockD1 as never,
        rebacService: rebacService as never,
        tenantPolicy: async () => policy({ rebac: true }),
      });
      const result = await service.check(rebacRequest);
      expect(result).toMatchObject({ allowed: true, resolved_via: ['rebac'] });
      expect(rebacService.check).toHaveBeenCalledTimes(1);
    });

    it('follows the tenant, not the constructor default, when tenantPolicy is given', async () => {
      const rebacService = { check: vi.fn(async () => ({ allowed: true })) };
      const service = createUnifiedCheckService({
        db: mockD1 as never,
        rebacService: rebacService as never,
        enableRebac: true,
        tenantPolicy: async () => policy(),
      });
      expect((await service.check(rebacRequest)).allowed).toBe(false);
      expect(rebacService.check).not.toHaveBeenCalled();
    });

    it('is off when the tenant policy cannot be read', async () => {
      const rebacService = { check: vi.fn(async () => ({ allowed: true })) };
      const service = createUnifiedCheckService({
        db: mockD1 as never,
        rebacService: rebacService as never,
        tenantPolicy: async () => {
          throw new Error('settings unavailable');
        },
      });
      expect((await service.check(rebacRequest)).allowed).toBe(false);
      expect(rebacService.check).not.toHaveBeenCalled();
    });
  });
});

describe('ResourceContextResolverRegistry', () => {
  it('registers, replaces and removes resolvers per tenant and type', async () => {
    const registry = createResourceContextResolverRegistry();
    const lookup = {
      tenantId: 'tenant_a',
      resourceType: 'documents',
      resourceId: 'doc_1',
      action: 'read',
      subjectId: 'user_1',
    };
    expect(await registry.resolve(lookup)).toBeNull();

    registry.register('tenant_a', 'documents', async () => ({ owner_id: 'a' }));
    registry.register('tenant_a', 'documents', async () => ({ owner_id: 'b' }));
    expect(registry.has('tenant_a', 'documents')).toBe(true);
    expect(await registry.resolve(lookup)).toEqual({ owner_id: 'b' });

    registry.unregister('tenant_a', 'documents');
    expect(await registry.resolve(lookup)).toBeNull();
  });

  it('refuses a registration without a tenant or a type', () => {
    const registry = createResourceContextResolverRegistry();
    expect(() => registry.register(' ', 'documents', async () => null)).toThrow();
    expect(() => registry.register('tenant_a', '', async () => null)).toThrow();
  });
});
