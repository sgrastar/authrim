/**
 * A tenant in lite mode starts external sign-in only from the lite Login UI: the public start
 * endpoint refuses it before anything else is done (no link intent spent, no OAuth state made).
 */
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(
  (): {
    mode: 'off' | 'always' | 'unknown';
    verifyHumanVerification: ReturnType<typeof vi.fn>;
    consumeLinkIntent: ReturnType<typeof vi.fn>;
    storeAuthState: ReturnType<typeof vi.fn>;
  } => ({
    mode: 'always',
    verifyHumanVerification: vi.fn(),
    consumeLinkIntent: vi.fn(),
    storeAuthState: vi.fn(),
  })
);

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    readLiteModeState: vi.fn(async () => mocks.mode),
    verifyHumanVerificationWithRunner: mocks.verifyHumanVerification,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createDiagnosticLoggerFromContext: vi.fn().mockResolvedValue(null),
  };
});
vi.mock('../services/link-intent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/link-intent')>();
  return { ...actual, consumeLinkIntent: mocks.consumeLinkIntent };
});
vi.mock('../utils/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/state')>();
  return { ...actual, storeAuthState: mocks.storeAuthState };
});

import { handleExternalStart } from '../handlers/start';

function start(query: string) {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/auth/external/:provider/start', (c) => handleExternalStart(c));
  return app.request(
    `/auth/external/google/start?${query}`,
    {},
    {
      SETTINGS: { get: async () => null, put: async () => undefined },
    }
  );
}

describe('external start for a tenant in lite mode', () => {
  it.each(['always', 'unknown'] as const)('refuses it when the mode is %s', async (mode) => {
    mocks.mode = mode;
    const response = await start('link_intent=abc&human_verification_response=x');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'lite_mode_endpoint_unavailable' });
    expect(mocks.verifyHumanVerification).not.toHaveBeenCalled();
    expect(mocks.consumeLinkIntent).not.toHaveBeenCalled();
    expect(mocks.storeAuthState).not.toHaveBeenCalled();
  });
});
