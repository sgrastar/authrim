import { Hono } from 'hono';
import { derivePluginInstallationId, type Env } from '@authrim/ar-lib-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  verifyHumanVerificationForAction,
  type HumanVerificationAction,
} from '../human-verification';

function kv(values: Record<string, string>): KVNamespace {
  return {
    get: vi.fn(async (key: string) => values[key] ?? null),
  } as unknown as KVNamespace;
}

function application() {
  const app = new Hono<{ Bindings: Env; Variables: { tenantId: string } }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-a');
    await next();
  });
  app.post('/:action', async (c) => {
    const response = await verifyHumanVerificationForAction(
      c,
      c.req.param('action') as HumanVerificationAction,
      c.req.header('X-Human-Verification')
    );
    return response ?? c.text('ok');
  });
  return app;
}

describe('verifyHumanVerificationForAction Runner cutover', () => {
  let runHumanVerification: ReturnType<typeof vi.fn>;
  let env: Env;

  beforeEach(() => {
    runHumanVerification = vi.fn(async () => ({
      decision: 'allow' as const,
      reasonCode: 'verification_succeeded',
    }));
    env = {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      SETTINGS: kv({
        'settings:tenant:tenant-a:authentication-methods': JSON.stringify({
          'authentication-methods.human_verification.provider':
            'human-verification-cloudflare-turnstile',
          'authentication-methods.human_verification.login_enabled': true,
        }),
        'plugins:enabled:human-verification-cloudflare-turnstile:tenant:tenant-a': 'true',
      }),
      PLUGIN_RUNNER: { runHumanVerification } as unknown as Env['PLUGIN_RUNNER'],
    } as Env;
  });

  it('calls only the deterministic tenant installation and accepts an allow decision', async () => {
    const response = await application().request(
      '/login',
      {
        method: 'POST',
        headers: {
          'X-Human-Verification': 'browser-token',
          'CF-Connecting-IP': '203.0.113.7',
        },
      },
      env
    );

    expect(response.status).toBe(200);
    expect(runHumanVerification).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      pluginInstallationId: await derivePluginInstallationId({
        environmentId: 'test',
        tenantId: 'tenant-a',
        pluginId: 'human-verification-cloudflare-turnstile',
        purpose: 'human-verification',
      }),
      requestId: expect.any(String),
      action: 'login',
      responseToken: 'browser-token',
      remoteIp: '203.0.113.7',
    });
  });

  it('does not call Runner when the action is disabled', async () => {
    const response = await application().request(
      '/signup',
      { method: 'POST', headers: { 'X-Human-Verification': 'browser-token' } },
      env
    );
    expect(response.status).toBe(200);
    expect(runHumanVerification).not.toHaveBeenCalled();
  });

  it.each(['deny', 'missing_runner', 'disabled_provider', 'malformed_settings'])(
    'fails with the same public validation contract for %s',
    async (failure) => {
      if (failure === 'deny') {
        runHumanVerification.mockResolvedValueOnce({
          decision: 'deny',
          reasonCode: 'verification_failed',
        });
      } else if (failure === 'missing_runner') {
        env.PLUGIN_RUNNER = undefined;
      } else if (failure === 'disabled_provider') {
        env.SETTINGS = kv({
          'settings:tenant:tenant-a:authentication-methods': JSON.stringify({
            'authentication-methods.human_verification.login_enabled': true,
          }),
          'plugins:enabled:human-verification-cloudflare-turnstile:tenant:tenant-a': 'false',
        });
      } else {
        env.SETTINGS = kv({
          'settings:tenant:tenant-a:authentication-methods': '{invalid',
        });
      }
      const response = await application().request(
        '/login',
        { method: 'POST', headers: { 'X-Human-Verification': 'browser-token' } },
        env
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ error: 'invalid_request' });
    }
  );
});
