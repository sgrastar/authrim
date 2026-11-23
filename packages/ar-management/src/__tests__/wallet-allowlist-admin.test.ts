import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  stepUp: vi.fn(async (_c: unknown, _descriptor: unknown): Promise<Response | null> => null),
  load: vi.fn(),
  save: vi.fn(),
  auth: vi.fn(() => ({ userId: 'admin-1' }) as { userId?: string } | undefined),
}));

vi.mock('../admin-step-up-gate', () => ({ requireAdminStepUp: mocks.stepUp }));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: () => 'tenant-1',
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
    loadWalletAllowlist: mocks.load,
    saveWalletAllowlist: mocks.save,
  };
});

import {
  adminWalletAllowlistGetHandler,
  adminWalletAllowlistPutHandler,
} from '../wallet-allowlist-admin';

const ENTRY = {
  clientId: 'keyring-wallet',
  label: 'Keyring',
  enabled: false,
  attestationRoots: [],
  keyAttestationRoots: [],
  redirectUris: ['https://wallet.example.com/cb'],
};

function app() {
  const hono = new Hono<{ Bindings: Env }>();
  hono.use('*', async (c, next) => {
    (c as unknown as { set: (k: string, v: unknown) => void }).set('adminAuth', mocks.auth());
    await next();
  });
  hono.get('/w', adminWalletAllowlistGetHandler);
  hono.put('/w', adminWalletAllowlistPutHandler as never);
  return hono;
}

const put = (body: unknown) =>
  app().request('/w', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockReturnValue({ userId: 'admin-1' });
  mocks.stepUp.mockResolvedValue(null);
  mocks.load.mockResolvedValue({ version: 1, updatedAt: 5, revision: 3, entries: [] });
  mocks.save.mockImplementation(
    async (_env: unknown, input: { allowlist: { entries: unknown[] } }) => ({
      version: 1,
      updatedAt: 6,
      revision: 4,
      entries: input.allowlist.entries,
    })
  );
});

describe('GET', () => {
  it('shows roots by hash and label only', async () => {
    mocks.load.mockResolvedValue({
      version: 1,
      updatedAt: 5,
      revision: 3,
      entries: [
        {
          ...ENTRY,
          attestationRoots: [{ certificate: 'SECRETISH', sha256: 'a'.repeat(64), label: 'Root' }],
        },
      ],
    });
    const response = await app().request('/w');
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain('SECRETISH');
    expect(JSON.parse(text).entries[0].attestation_roots).toEqual([
      { sha256: 'a'.repeat(64), label: 'Root' },
    ]);
  });

  it('answers 500 when the stored list is unreadable', async () => {
    mocks.load.mockRejectedValue(new Error('corrupt'));
    expect((await app().request('/w')).status).toBe(500);
  });
});

describe('PUT', () => {
  it('saves behind the step-up gate, bound to the digest and the revision', async () => {
    const response = await put({ expected_revision: 3, entries: [ENTRY] });
    expect(response.status).toBe(200);
    const descriptor = mocks.stepUp.mock.calls[0][1] as Record<string, unknown>;
    expect(descriptor).toMatchObject({
      operation: 'wallet_allowlist.update',
      targetTenantId: 'tenant-1',
      targetIds: ['tenant-1'],
      resourceVersion: 3,
    });
    expect((descriptor.params as { entries_sha256: string }).entries_sha256).toMatch(/^[\w-]{43}$/);
    expect(mocks.save.mock.calls[0][1]).toMatchObject({
      tenantId: 'tenant-1',
      actorId: 'admin-1',
      expectedRevision: 3,
      gate: 'admin_step_up',
    });
  });

  it('saves nothing when the step-up refuses', async () => {
    mocks.stepUp.mockResolvedValue(
      new Response(JSON.stringify({ error: 'step_up_required' }), { status: 403 })
    );
    expect((await put({ expected_revision: 3, entries: [ENTRY] })).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('refuses a stale revision before spending the step-up, and a conflict at save time', async () => {
    expect((await put({ expected_revision: 2, entries: [ENTRY] })).status).toBe(409);
    expect(mocks.stepUp).not.toHaveBeenCalled();
    mocks.save.mockRejectedValue(new Error('wallet_allowlist_revision_conflict'));
    expect((await put({ expected_revision: 3, entries: [ENTRY] })).status).toBe(409);
  });

  it('refuses malformed input before anything else', async () => {
    for (const body of [
      { entries: [ENTRY] },
      { expected_revision: -1, entries: [ENTRY] },
      { expected_revision: 3, entries: [{ ...ENTRY, redirectUris: ['http://x.example.com'] }] },
      { expected_revision: 3, entries: 'nope' },
    ]) {
      expect((await put(body)).status).toBe(400);
    }
    expect(mocks.stepUp).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('refuses a caller without an admin identity', async () => {
    mocks.auth.mockReturnValue(undefined);
    expect((await put({ expected_revision: 3, entries: [ENTRY] })).status).toBe(401);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
