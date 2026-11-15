import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '../../types/env';

const mocks = vi.hoisted(() => ({ introspect: vi.fn(), client: vi.fn() }));
vi.mock('../../utils/token-introspection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/token-introspection')>()),
  introspectTokenFromContext: mocks.introspect,
  // The token's client (the real read needs a request cache).
  introspectedTokenClient: mocks.client,
}));

import {
  createActiveAccessTokenProtectedResourceMiddleware,
  getActiveAccessTokenProtectedResourceContext,
} from '../active-access-token-protected-resource';

function context() {
  const values = new Map<string, unknown>();
  return {
    header: vi.fn(),
    json: (body: unknown, status = 200) => Response.json(body, { status }),
    set: (key: string, value: unknown) => values.set(key, value),
    get: (key: string) => values.get(key),
  } as unknown as Context<{ Bindings: Env }>;
}

describe('active access-token protected-resource middleware', () => {
  beforeEach(() => {
    mocks.introspect.mockReset();
    mocks.client.mockReset().mockResolvedValue({ subject_type: 'public' });
  });

  it('binds a signature-verified active subject with exact audience and scope', async () => {
    mocks.introspect.mockResolvedValue({
      valid: true,
      claims: {
        sub: 'user-1',
        tenant_id: 'tenant-1',
        aud: 'svc://op-vc/attribute-elevation',
        scope: 'openid vc.attribute',
      },
    });
    const c = context();
    const next = vi.fn();
    await createActiveAccessTokenProtectedResourceMiddleware({
      audience: 'svc://op-vc/attribute-elevation',
      requiredScopes: ['vc.attribute'],
    })(c, next);
    expect(mocks.introspect).toHaveBeenCalledWith(c, {
      audience: 'svc://op-vc/attribute-elevation',
      allowSubjectReference: true,
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(getActiveAccessTokenProtectedResourceContext(c)).toMatchObject({
      subject: 'user-1',
      tenantId: 'tenant-1',
    });
  });

  it('binds the account a pairwise app’s token is for, never the sub it was given', async () => {
    mocks.introspect.mockResolvedValue({
      valid: true,
      claims: {
        sub: 'sub-the-app-was-given',
        authrim_subject_ref: 'sr1.a.b',
        tenant_id: 'tenant-1',
        aud: 'svc://op-vc/attribute-elevation',
        scope: 'vc.attribute',
      },
      accountUserId: 'user-real',
    });
    const c = context();
    await createActiveAccessTokenProtectedResourceMiddleware({
      audience: 'svc://op-vc/attribute-elevation',
      requiredScopes: ['vc.attribute'],
    })(c as never, async () => undefined);
    expect(getActiveAccessTokenProtectedResourceContext(c)).toMatchObject({ subject: 'user-real' });
  });

  it('refuses a pairwise app’s token that carries no account reference', async () => {
    mocks.client.mockResolvedValue({ subject_type: 'pairwise' });
    mocks.introspect.mockResolvedValue({
      valid: true,
      claims: {
        sub: 'user-1',
        token_use: 'access',
        jti: 'jti-1',
        client_id: 'old-pairwise-app',
        tenant_id: 'tenant-1',
        aud: 'svc://op-vc/attribute-elevation',
        scope: 'vc.attribute',
      },
    });
    const c = context();
    const next = vi.fn();
    const response = await createActiveAccessTokenProtectedResourceMiddleware({
      audience: 'svc://op-vc/attribute-elevation',
      requiredScopes: ['vc.attribute'],
    })(c as never, next as never);
    expect(response?.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed for a wrong audience even when introspection otherwise succeeds', async () => {
    mocks.introspect.mockResolvedValue({
      valid: true,
      claims: {
        sub: 'user-1',
        tenant_id: 'tenant-1',
        aud: 'another-service',
        scope: 'vc.attribute',
      },
    });
    const c = context();
    const next = vi.fn();
    const response = await createActiveAccessTokenProtectedResourceMiddleware({
      audience: 'svc://op-vc/attribute-elevation',
      requiredScopes: ['vc.attribute'],
    })(c, next);
    expect(response?.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns insufficient_scope without invoking the protected handler', async () => {
    mocks.introspect.mockResolvedValue({
      valid: true,
      claims: {
        sub: 'user-1',
        tenant_id: 'tenant-1',
        aud: 'svc://op-vc/attribute-elevation',
        scope: 'openid',
      },
    });
    const c = context();
    const next = vi.fn();
    const response = await createActiveAccessTokenProtectedResourceMiddleware({
      audience: 'svc://op-vc/attribute-elevation',
      requiredScopes: ['vc.attribute'],
    })(c, next);
    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({ error: 'insufficient_scope' });
    expect(c.header).toHaveBeenCalledWith(
      'WWW-Authenticate',
      'Bearer error="insufficient_scope", scope="vc.attribute"'
    );
    expect(next).not.toHaveBeenCalled();
  });
});
