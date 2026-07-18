import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  clientUpdate: vi.fn((c: { get(key: string): unknown; json(value: unknown): Response }) =>
    c.json({
      client: { client_id: 'client-1' },
      expected_updated_at: c.get('agentExpectedClientUpdatedAt'),
    })
  ),
  clientCreate: vi.fn(
    (c: {
      header(name: string, value: string): void;
      json(value: unknown, status?: number): Response;
    }) => {
      c.header('content-length', '9999');
      return c.json(
        {
          client: {
            client_id: 'client-created',
            client_name: 'Created',
            client_secret: 'must-not-leave-owner',
            clientSecret: 'alternate-spelling-must-not-leave-owner',
            recovery_token: 'must-not-leave-owner',
            token_endpoint_auth_method: 'none',
          },
        },
        201
      );
    }
  ),
  userSuspend: vi.fn(),
  snapshot: vi.fn(),
}));

vi.mock('../admin', () => ({
  adminClientCreateHandler: mocks.clientCreate,
  adminClientUpdateHandler: mocks.clientUpdate,
  adminUserSuspendHandler: mocks.userSuspend,
}));

vi.mock('../agent-elevated-execution', () => ({
  agentElevatedExecutionMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../routes/admin-management/agent-read-operations', () => ({
  loadAgentSafeClientSnapshot: mocks.snapshot,
}));

import { agentWriteOperationsRouter } from '../routes/admin-management/agent-write-operations';

function app() {
  const result = new Hono<{ Bindings: Env }>();
  result.route('/api/admin/agent-write', agentWriteOperationsRouter);
  return result;
}

function update(body: Record<string, unknown>, resourceVersion = 'resource-version-1') {
  return app().request('/api/admin/agent-write/clients/client-1/metadata', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'if-match': resourceVersion },
    body: JSON.stringify(body),
  });
}

function updateProtocol(body: Record<string, unknown>, resourceVersion = 'resource-version-1') {
  return app().request('/api/admin/agent-write/clients/client-1/protocol-security', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'if-match': resourceVersion },
    body: JSON.stringify(body),
  });
}

describe('Agent write owner projections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.snapshot.mockResolvedValue({
      status: 200,
      client: { client_id: 'client-1', updated_at: 1234 },
      resourceVersion: 'resource-version-1',
      updatedAt: 1234,
    });
  });

  it('allows only the fixed client display metadata fields', async () => {
    const response = await update({ client_name: 'Updated', description: 'Safe text' });
    expect(response.status).toBe(200);
    expect(mocks.clientUpdate).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({ expected_updated_at: 1234 });
  });

  it('requires a resource precondition', async () => {
    const response = await update({ client_name: 'Updated' }, '');
    expect(response.status).toBe(428);
    expect(mocks.clientUpdate).not.toHaveBeenCalled();
  });

  it('rejects a stale resource precondition', async () => {
    const response = await update({ client_name: 'Updated' }, 'stale-resource-version');
    expect(response.status).toBe(412);
    expect(mocks.clientUpdate).not.toHaveBeenCalled();
  });

  it('rejects direct attempts to mutate redirect or credential configuration', async () => {
    const response = await update({ redirect_uris: ['https://attacker.example/callback'] });
    expect(response.status).toBe(400);
    expect(mocks.clientUpdate).not.toHaveBeenCalled();
  });

  it('rejects empty updates', async () => {
    const response = await update({});
    expect(response.status).toBe(400);
    expect(mocks.clientUpdate).not.toHaveBeenCalled();
  });

  it('allows only the fixed protocol security fields behind the owner elevation fence', async () => {
    const response = await updateProtocol({
      redirect_uris: ['https://client.example/callback'],
      require_pkce: true,
    });
    expect(response.status).toBe(200);
    expect(mocks.clientUpdate).toHaveBeenCalledOnce();

    const denied = await updateProtocol({ client_secret: 'never' });
    expect(denied.status).toBe(400);
    expect(mocks.clientUpdate).toHaveBeenCalledOnce();
  });

  it('creates only the fixed public-client profile and strips the generated secret', async () => {
    const response = await app().request('/api/admin/agent-write/clients/public', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Created',
        application_type: 'spa',
        redirect_uris: ['https://client.example/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        require_pkce: true,
        client_credentials_allowed: false,
        token_exchange_allowed: false,
        is_trusted: false,
        skip_consent: false,
      }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('content-length')).toBeNull();
    expect(await response.json()).toEqual({
      client: {
        client_id: 'client-created',
        client_name: 'Created',
        token_endpoint_auth_method: 'none',
      },
    });
    expect(mocks.clientCreate).toHaveBeenCalledOnce();
  });
});
