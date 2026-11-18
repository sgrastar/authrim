import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AdminAuthContext } from '../../types/admin';
import type { Env } from '../../types/env';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { idempotencyMiddleware } from '../../middleware/idempotency';
import type { DatabaseAdapter } from '../../db/adapter';
const seams = vi.hoisted(() => ({
  challenges: new Map<string, Record<string, unknown>>(),
  overrides: {},
  adapter: null as DatabaseAdapter | null,
}));
vi.mock('../../context/hono-context', () => ({
  createAuthContextFromHono: () => ({ coreAdapter: seams.adapter }),
}));
vi.mock('../effective-settings', () => ({
  resolveEffectiveSettings: async () => ({ 'security.admin_step_up_overrides': seams.overrides }),
}));
vi.mock('../admin-database-adapter', () => ({
  requireDedicatedAdminDatabaseAdapter: () => ({}),
}));
vi.mock('../../repositories/admin/admin-second-factor', () => ({
  AdminSecondFactorRepository: class {
    isActive = async () => true;
  },
}));
vi.mock('../../utils/challenge-sharding', () => ({
  getChallengeStoreByChallengeId: async () => ({
    storeChallengeRpc: async (request: Record<string, unknown>) => {
      seams.challenges.set(String(request.id), { ...request, expiresAt: Date.now() + 300000 });
      return { success: true };
    },
    getChallengeRpc: async (id: string) => seams.challenges.get(id) ?? null,
    consumeChallengeRpc: async ({
      id,
      tenantId,
      type,
    }: {
      id: string;
      tenantId: string;
      type: string;
    }) => {
      const record = seams.challenges.get(id);
      if (!record || record.tenantId !== tenantId || record.type !== type)
        throw new Error('missing');
      seams.challenges.delete(id);
      return record;
    },
  }),
}));
import { requireAdminStepUp } from '../admin-step-up-gate';
import { issueAdminStepUpReceipt, type AdminStepUpOperationDescriptor } from '../admin-step-up';

const human = (): AdminAuthContext => ({
  userId: 'admin',
  actorType: 'human',
  authMethod: 'session',
  tenantId: 'tenant-a',
  sessionTenantId: 'default',
  sessionId: 'session',
  roles: [],
  mfaVerified: true,
  authenticationTimeMs: Date.now(),
  secondFactorId: 'factor',
  secondFactorVerifiedAtMs: Date.now(),
});
let store: ReturnType<typeof sqliteAdapter>;
let auth: AdminAuthContext;
let version: number;
let writes: number;
let descriptor: AdminStepUpOperationDescriptor;
let app: Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;
beforeEach(() => {
  store = sqliteAdapter();
  store.db
    .prepare(
      "INSERT INTO tenants (id,tenant_code,tenant_key,name,created_at,updated_at) VALUES ('tenant-a','TA','key-a','Tenant A',1,1)"
    )
    .run();
  seams.adapter = store.adapter;
  seams.challenges.clear();
  seams.overrides = {};
  auth = human();
  version = 1;
  writes = 0;
  descriptor = {
    operation: 'client.trust.activate',
    targetTenantId: 'tenant-a',
    targetIds: ['app'],
    params: { action: 'client.update', trust_sha256: 'digest' },
  };
  app = new Hono();
  app.use('/write', async (c, next) => {
    (c as unknown as { set(key: string, value: unknown): void }).set('tenantId', 'tenant-a');
    c.set('adminAuth', auth);
    await next();
  });
  app.use(
    '/write',
    idempotencyMiddleware({ reserveBeforeExecution: true, failClosedOnStorageError: true })
  );
  app.post('/write', async (c) => {
    c.set('adminAuth', auth);
    const refused = await requireAdminStepUp(c, { ...descriptor, resourceVersion: version });
    if (refused) return refused;
    writes++;
    version++;
    return c.json({ success: true });
  });
});
afterEach(() => store.db.close());
const post = (receipt?: string, key = 'client-trust-operation') =>
  app.request(
    '/write',
    {
      method: 'POST',
      headers: {
        'Idempotency-Key': key,
        ...(receipt ? { 'authrim-step-up-receipt': receipt } : {}),
      },
    },
    {}
  );
async function receipt() {
  const first = await post();
  expect(first.status).toBe(403);
  expect(writes).toBe(0);
  const { step_up_id } = await first.json<{ step_up_id: string }>();
  return (
    await issueAdminStepUpReceipt({} as Env, {
      auth,
      stepUpId: step_up_id,
      isSecondFactorActive: async () => true,
    })
  ).receipt;
}
describe('client operations through the real gate and single-use receipts', () => {
  it('accepts an approved retry once', async () => {
    const proof = await receipt();
    expect((await post(proof)).status).toBe(200);
    expect(writes).toBe(1);
    expect((await post(proof)).status).toBe(200);
    expect(writes).toBe(1);
    expect((await post(proof, 'different-operation')).status).toBe(403);
    expect(writes).toBe(1);
  });
  it('rejects a receipt after the resource version changes, even without a caller precondition', async () => {
    const proof = await receipt();
    version++;
    expect((await post(proof)).status).toBe(403);
    expect(writes).toBe(0);
  });
  it('rejects a receipt for altered effective trust settings', async () => {
    const proof = await receipt();
    descriptor.params = { action: 'client.update', trust_sha256: 'different' };
    expect((await post(proof)).status).toBe(403);
    expect(writes).toBe(0);
  });
  it.each(['client.trust.activate', 'client.trust.disable'] as const)(
    'requires the exact machine exemption for %s',
    async (operation) => {
      descriptor.operation = operation;
      auth = {
        ...human(),
        authMethod: 'machine_access_token',
        actorType: 'machine',
        permissions: [],
      };
      expect((await post()).status).toBe(403);
      auth.permissions = [`admin:step_up_exempt:${operation}`];
      expect((await post()).status).toBe(200);
    }
  );
  it('a disable/delete operation raised to L2 needs a receipt', async () => {
    descriptor.operation = 'client.trust.disable';
    seams.overrides = { 'client.trust.disable': 'L2' };
    const proof = await receipt();
    expect((await post(proof)).status).toBe(200);
  });
  it('rotation also covering activation raises the real gate to L2', async () => {
    descriptor.operation = 'client.secret.rotate';
    descriptor.alsoCovers = ['client.trust.activate'];
    const proof = await receipt();
    expect((await post(proof)).status).toBe(200);
  });
});
