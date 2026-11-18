import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../types';
const mocks = vi.hoisted(() => ({ client: vi.fn(), store: vi.fn() }));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: () => 'tenant-a',
  resolveAuthCorePersistenceAdapterFromEnv: async () => ({}),
  ClientRepository: class {
    findByClientId = mocks.client;
  },
}));
vi.mock('../utils/vp-request-sharding', () => ({ getVPRequestStoreForNewRequest: mocks.store }));
import { vpAuthorizeRoute } from '../verifier/routes/authorize';
beforeEach(() => vi.clearAllMocks());
describe('pre-registered VP clients', () => {
  it.each([null, { client_id: 'app', enabled: false }])(
    'refuses unavailable client %j without creating a presentation request',
    async (client) => {
      mocks.client.mockResolvedValue(client);
      const app = new Hono<{ Bindings: Env }>();
      app.post('/vp/authorize', vpAuthorizeRoute);
      const response = await app.request(
        '/vp/authorize',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            client_id: 'app',
            presentation_definition: { id: 'definition', input_descriptors: [] },
          }),
        },
        {} as Env
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(mocks.store).not.toHaveBeenCalled();
    }
  );
});
