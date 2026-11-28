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
      const rebacService = { checkResolved: vi.fn(async () => ({ allowed: true })) };
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
      expect(rebacService.checkResolved).not.toHaveBeenCalled();
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
      // The ReBAC service the self contract asks (usersets, definitions and exclusion are its
      // own; see rebac/__tests__/self-contract-rebac.test.ts for them on real SQL).
      function rebac(allowed: boolean) {
        return {
          checkResolved: vi.fn(async () => ({ allowed, resolved_via: 'direct' as const })),
        };
      }
      const resolver = {
        resolve: async () => ({
          rebac: { relation: 'viewer', object_type: 'document', object_id: 'doc_1' },
        }),
      };

      it('asks the ReBAC service for the bound subject when the tenant enables ReBAC', async () => {
        const rebacService = rebac(true);
        const service = createUnifiedCheckService({
          db: mockD1 as never,
          rebacService: rebacService as never,
          resourceContextResolver: resolver,
          tenantPolicy: async () => policy({ rebac: true }),
        });
        expect(await service.check(OWNER_REQUEST, { contract: 'self' })).toMatchObject({
          allowed: true,
          resolved_via: ['rebac'],
        });
        const [request, options] = rebacService.checkResolved.mock.calls[0] as unknown as [
          unknown,
          { subjectGroups?: unknown },
        ];
        // The bound subject's resolved id, verbatim.
        expect(request).toEqual({
          tenantId: 'tenant_a',
          subjectId: 'user_1',
          relation: 'viewer',
          objectType: 'document',
          objectId: 'doc_1',
        });
        // The subject's groups as the role check read them, for group usersets.
        expect(typeof options.subjectGroups).toBe('function');
      });

      it('denies when the ReBAC service denies, while ReBAC is off, and without the service', async () => {
        const denying = createUnifiedCheckService({
          db: mockD1 as never,
          rebacService: rebac(false) as never,
          resourceContextResolver: resolver,
          tenantPolicy: async () => policy({ rebac: true }),
        });
        expect((await denying.check(OWNER_REQUEST, { contract: 'self' })).allowed).toBe(false);

        const off = rebac(true);
        const disabled = createUnifiedCheckService({
          db: mockD1 as never,
          rebacService: off as never,
          resourceContextResolver: resolver,
          tenantPolicy: async () => policy(),
        });
        expect((await disabled.check(OWNER_REQUEST, { contract: 'self' })).allowed).toBe(false);
        expect(off.checkResolved).not.toHaveBeenCalled();

        const without = createUnifiedCheckService({
          db: mockD1 as never,
          resourceContextResolver: resolver,
          tenantPolicy: async () => policy({ rebac: true }),
        });
        expect((await without.check(OWNER_REQUEST, { contract: 'self' })).allowed).toBe(false);
      });

      it('treats a failing ReBAC service as a deny', async () => {
        const service = createUnifiedCheckService({
          db: mockD1 as never,
          rebacService: {
            checkResolved: vi.fn(async () => {
              throw new Error('database unavailable');
            }),
          } as never,
          resourceContextResolver: resolver,
          tenantPolicy: async () => policy({ rebac: true }),
        });
        expect((await service.check(OWNER_REQUEST, { contract: 'self' })).allowed).toBe(false);
      });

      it('lets the resolver name a relation per action (single and batch)', async () => {
        const perAction = {
          resolve: async ({ action }: { action: string }) =>
            action === 'read'
              ? { rebac: { relation: 'viewer', object_type: 'document', object_id: 'doc_1' } }
              : null,
        };
        const service = createUnifiedCheckService({
          db: mockD1 as never,
          rebacService: rebac(true) as never,
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
        const rebacService = rebac(true);
        const service = createUnifiedCheckService({
          db: mockD1 as never,
          rebacService: rebacService as never,
          tenantPolicy: async () => policy({ rebac: true }),
        });
        expect((await service.check(OWNER_REQUEST, { contract: 'self' })).allowed).toBe(false);
        expect(rebacService.checkResolved).not.toHaveBeenCalled();
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
      const rebacService = { checkResolved: vi.fn(async () => ({ allowed: true })) };
      const service = createUnifiedCheckService({
        db: mockD1 as never,
        rebacService: rebacService as never,
      });
      expect((await service.check(rebacRequest)).allowed).toBe(false);
      expect(rebacService.checkResolved).not.toHaveBeenCalled();
    });

    it('evaluates rebac when the tenant enables ReBAC', async () => {
      const rebacService = { checkResolved: vi.fn(async () => ({ allowed: true })) };
      const service = createUnifiedCheckService({
        db: mockD1 as never,
        rebacService: rebacService as never,
        tenantPolicy: async () => policy({ rebac: true }),
      });
      const result = await service.check(rebacRequest);
      expect(result).toMatchObject({ allowed: true, resolved_via: ['rebac'] });
      expect(rebacService.checkResolved).toHaveBeenCalledTimes(1);
    });

    it('passes the resolved subject verbatim and parses only the typed object', async () => {
      const rebacService = { checkResolved: vi.fn(async () => ({ allowed: true })) };
      const service = createUnifiedCheckService({
        db: mockD1 as never,
        rebacService: rebacService as never,
        tenantPolicy: async () => policy({ rebac: true }),
      });
      await service.check({ ...rebacRequest, subject_id: 'team:alice' });
      expect(rebacService.checkResolved.mock.calls[0]?.[0]).toMatchObject({
        subjectId: 'team:alice',
        objectType: 'document',
        objectId: 'doc_1',
      });
    });

    it('reads a contextual tuple subject as the API boundary does, against the stored id only', async () => {
      const rebacService = { checkResolved: vi.fn(async () => ({ allowed: false })) };
      const service = createUnifiedCheckService({
        db: mockD1 as never,
        rebacService: rebacService as never,
        tenantPolicy: async () => policy({ rebac: true }),
      });
      const tuple = (user_id: string) => ({
        ...rebacRequest,
        subject_id: 'user:alice',
        rebac: {
          relation: 'viewer',
          object: 'document:doc_1',
          contextual_tuples: [{ user_id, relation: 'viewer', object: 'document:doc_1' }],
        },
      });
      // External `user:alice` is the stored `alice`: not the stored `user:alice`.
      await service.check(tuple('user:alice'));
      expect(rebacService.checkResolved.mock.calls[0]?.[0]).toMatchObject({
        subjectId: 'user:alice',
        contextualTuples: [],
      });
      // External `user:user:alice` is the stored `user:alice`.
      await service.check(tuple('user:user:alice'));
      expect(rebacService.checkResolved.mock.calls[1]?.[0]).toMatchObject({
        contextualTuples: [{ relation: 'viewer', objectType: 'document', objectId: 'doc_1' }],
      });
    });

    it('denies without evaluating ReBAC when the subject account cannot be resolved', async () => {
      const rebacService = { checkResolved: vi.fn(async () => ({ allowed: true })) };
      const service = createUnifiedCheckService({
        db: mockD1 as never,
        rebacService: rebacService as never,
        tenantPolicy: async () => policy({ rebac: true }),
        subjectAccount: async () => {
          throw new Error('account not found');
        },
      });
      const result = await service.check({
        ...rebacRequest,
        subject_id: 'raw-id',
        rebac: {
          relation: 'viewer',
          object: 'document:doc_1',
          contextual_tuples: [{ user_id: 'raw-id', relation: 'viewer', object: 'document:doc_1' }],
        },
      });
      expect(result).toMatchObject({ allowed: false, reason: 'no_matching_permission' });
      expect(rebacService.checkResolved).not.toHaveBeenCalled();
    });

    it('carries unknown_membership to the result, single and batch', async () => {
      const rebacService = {
        checkResolved: vi.fn(async () => ({
          allowed: false,
          resolved_via: 'unknown_membership' as const,
        })),
      };
      const service = createUnifiedCheckService({
        db: mockD1 as never,
        rebacService: rebacService as never,
        tenantPolicy: async () => policy({ rebac: true }),
      });
      expect(await service.check(rebacRequest)).toMatchObject({
        allowed: false,
        reason: 'unknown_membership',
      });
      const batch = await service.batchCheck({ checks: [rebacRequest, OWNER_REQUEST] });
      expect(batch.results.map((result) => result.reason)).toEqual([
        'unknown_membership',
        'no_matching_permission',
      ]);
    });

    it('follows the tenant, not the constructor default, when tenantPolicy is given', async () => {
      const rebacService = { checkResolved: vi.fn(async () => ({ allowed: true })) };
      const service = createUnifiedCheckService({
        db: mockD1 as never,
        rebacService: rebacService as never,
        enableRebac: true,
        tenantPolicy: async () => policy(),
      });
      expect((await service.check(rebacRequest)).allowed).toBe(false);
      expect(rebacService.checkResolved).not.toHaveBeenCalled();
    });

    it('is off when the tenant policy cannot be read', async () => {
      const rebacService = { checkResolved: vi.fn(async () => ({ allowed: true })) };
      const service = createUnifiedCheckService({
        db: mockD1 as never,
        rebacService: rebacService as never,
        tenantPolicy: async () => {
          throw new Error('settings unavailable');
        },
      });
      expect((await service.check(rebacRequest)).allowed).toBe(false);
      expect(rebacService.checkResolved).not.toHaveBeenCalled();
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
