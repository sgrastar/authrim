/**
 * SAML Admin step-up gate: digest encoding and the operation/level each request is held to.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdminStepUp: vi.fn(async (..._args: unknown[]): Promise<Response | null> => null),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return { ...actual, requireAdminStepUp: mocks.requireAdminStepUp };
});

import { requireSAMLTrustStepUp, sha256Digest } from '../step-up';

const sha256Hex = async (text: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sha256Digest', () => {
  it('hashes a string as it is', async () => {
    expect(await sha256Digest('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('hashes any other value by its JSON form', async () => {
    expect(await sha256Digest({ a: 1 })).toBe(await sha256Hex('{"a":1}'));
    expect(await sha256Digest([1, 'x'])).toBe(await sha256Hex('[1,"x"]'));
    expect(await sha256Digest(5)).toBe(await sha256Hex('5'));
  });

  it('hashes undefined, null and unserialisable values as the JSON null', async () => {
    const nullDigest = await sha256Hex('null');

    expect(await sha256Digest(undefined)).toBe(nullDigest);
    expect(await sha256Digest(null)).toBe(nullDigest);
    expect(await sha256Digest(() => 1)).toBe(nullDigest);
  });

  it('distinguishes a string from its JSON encoding', async () => {
    expect(await sha256Digest('"x"')).not.toBe(await sha256Digest('x'));
  });
});

describe('requireSAMLTrustStepUp', () => {
  const context = { marker: 'context' };

  it('lets a draft (L0) through without asking', async () => {
    const result = await requireSAMLTrustStepUp(context, { tenantId: 'tenant-a', level: 'L0' });

    expect(result).toBeNull();
    expect(mocks.requireAdminStepUp).not.toHaveBeenCalled();
  });

  it('holds an L1 request to the disable operation', async () => {
    await requireSAMLTrustStepUp(context, { tenantId: 'tenant-a', level: 'L1' });

    expect(mocks.requireAdminStepUp).toHaveBeenCalledWith(context, {
      operation: 'federation.trust.disable',
      targetTenantId: 'tenant-a',
    });
  });

  it.each(['L2', undefined] as const)(
    'holds a %s request to the activate operation',
    async (level) => {
      await requireSAMLTrustStepUp(context, { tenantId: 'tenant-a', level });

      expect(mocks.requireAdminStepUp).toHaveBeenCalledWith(context, {
        operation: 'federation.trust.activate',
        targetTenantId: 'tenant-a',
      });
    }
  );

  it('binds target ids and params only when given', async () => {
    await requireSAMLTrustStepUp(context, {
      tenantId: 'tenant-a',
      targetIds: ['p-1'],
      params: { action: 'x' },
    });
    await requireSAMLTrustStepUp(context, { tenantId: 'tenant-a', targetIds: [], params: {} });

    expect(mocks.requireAdminStepUp.mock.calls[0]?.[1]).toEqual({
      operation: 'federation.trust.activate',
      targetTenantId: 'tenant-a',
      targetIds: ['p-1'],
      params: { action: 'x' },
    });
    expect(mocks.requireAdminStepUp.mock.calls[1]?.[1]).toEqual({
      operation: 'federation.trust.activate',
      targetTenantId: 'tenant-a',
      targetIds: [],
      params: {},
    });
  });

  it('returns the refusal of the gate', async () => {
    const refusal = new Response('refused', { status: 428 });
    mocks.requireAdminStepUp.mockResolvedValueOnce(refusal);

    expect(await requireSAMLTrustStepUp(context, { tenantId: 'tenant-a' })).toBe(refusal);
  });
});
