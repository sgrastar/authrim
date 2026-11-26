/**
 * Status list routes: exact payloads, ETags, headers and error bodies (the signer is a fake that
 * records what it is asked to sign).
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../types';

const h = vi.hoisted(() => {
  const logger = { module: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  logger.module.mockReturnValue(logger);
  return {
    logger,
    getLogger: vi.fn(),
    resolveTenantMetadataContext: vi.fn(),
    ensureDatabaseAdapter: vi.fn(),
    loadWalletAllowlist: vi.fn(),
    ensureVcSigningCertificate: vi.fn(),
    queryOne: vi.fn(),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: h.getLogger,
    getTenantIdFromContext: () => 'tenant1',
    resolveTenantMetadataContext: h.resolveTenantMetadataContext,
    ensureDatabaseAdapter: h.ensureDatabaseAdapter,
    loadWalletAllowlist: h.loadWalletAllowlist,
  };
});
vi.mock('../../services/issuer-ca', () => ({
  ensureVcSigningCertificate: h.ensureVcSigningCertificate,
}));
vi.mock('../../../request-identifiers', () => ({
  getRequestIssuerUrl: () => 'https://tenant1.issuer.example.com',
}));

import { statusListJsonRoute, statusListRoute } from '../status-list';

const ISSUER = 'https://tenant1.issuer.example.com';
const NOW_MS = 1_800_000_123_000;
const NOW = NOW_MS / 1000;
const ALIGNED = Math.floor(NOW / 300) * 300;

const tslList = {
  id: 'sl_tsl',
  tenant_id: 'tenant1',
  purpose: 'revocation' as const,
  encoded_list: 'eJzTBwAAAQAB',
  updated_at: '2024-01-01T00:00:00.000Z',
  format: 'ietf_tsl_v1',
  bits: 2,
  version: 7,
};
const legacyList = { ...tslList, id: 'sl_legacy', format: 'w3c_bitstring_v1', bits: 1, version: 0 };

const sign = vi.fn();
const idFromName = vi.fn((name: string) => `id:${name}`);
const keyManagerGet = vi.fn(() => ({ signStatusListCredentialRpc: sign }));
const env = {
  KEY_MANAGER: { idFromName, get: keyManagerGet },
} as unknown as Env;

function app() {
  const a = new Hono<{ Bindings: Env }>();
  a.get('/lists/:listId', statusListRoute);
  a.get('/lists/:listId/json', statusListJsonRoute);
  a.get('/nolist', statusListRoute);
  a.get('/nolist/json', statusListJsonRoute);
  return a;
}
const get = (path: string, headers: Record<string, string> = {}) =>
  app().request(path, { headers }, env);

async function etagFor(text: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  );
  const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `"${hex.slice(0, 16)}"`;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  vi.clearAllMocks();
  h.logger.module.mockReturnValue(h.logger);
  h.getLogger.mockReturnValue(h.logger);
  h.resolveTenantMetadataContext.mockResolvedValue({ coreDb: 'core-db' });
  h.ensureDatabaseAdapter.mockReturnValue({ queryOne: h.queryOne });
  h.queryOne.mockResolvedValue(tslList);
  h.loadWalletAllowlist.mockResolvedValue({ entries: [] });
  h.ensureVcSigningCertificate.mockResolvedValue(undefined);
  sign.mockResolvedValue({ token: 'signed.jwt.token' });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('statusListRoute: lookup and errors', () => {
  it('asks the tenant database for the list of that tenant by its public id', async () => {
    await get('/lists/sl_tsl');
    expect(h.getLogger).toHaveBeenCalled();
    expect(h.logger.module).toHaveBeenCalledWith('VC-ISSUER');
    expect(h.resolveTenantMetadataContext).toHaveBeenCalledWith(env, 'tenant1');
    expect(h.ensureDatabaseAdapter).toHaveBeenCalledWith('core-db', 'vc-status-list');
    expect(h.queryOne).toHaveBeenCalledWith(expect.stringContaining('FROM status_lists'), [
      'tenant1',
      'sl_tsl',
    ]);
  });

  it('rejects a request without a list id', async () => {
    const response = await get('/nolist');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Missing list ID',
    });
    expect(h.queryOne).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown list without echoing the id', async () => {
    h.queryOne.mockResolvedValue(null);
    const response = await get('/lists/sl_missing');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'not_found',
      error_description: 'Status list not found',
    });
  });

  it('answers 424 for a missing x5c chain, even inside a longer message', async () => {
    sign.mockRejectedValue(new Error('signing refused: x5c_required for this key'));
    const response = await get('/lists/sl_tsl');
    expect(response.status).toBe(424);
    expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
    expect(h.logger.error).toHaveBeenCalledWith(
      'Failed to generate status list credential',
      {},
      expect.any(Error)
    );
  });

  it('answers 500 for other failures, including a bare x5c_required string', async () => {
    for (const failure of [new Error('boom'), 'x5c_required']) {
      sign.mockRejectedValue(failure);
      const response = await get('/lists/sl_tsl');
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: 'server_error',
        error_description: 'Failed to generate status list credential',
      });
    }
  });
});

describe('statusListRoute: Token Status List', () => {
  it('signs the draft-14 payload with the issuer, list URI and aligned iat', async () => {
    const response = await get('/lists/sl_tsl');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('signed.jwt.token');
    expect(idFromName).toHaveBeenCalledWith('tenant1-v3');
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith({
      iss: ISSUER,
      sub: `${ISSUER}/vci/status-lists/sl_tsl`,
      iat: ALIGNED,
      exp: ALIGNED + 86400,
      ttl: 300,
      status_list: { bits: 2, lst: 'eJzTBwAAAQAB' },
    });
  });

  it('gives the signing key its certificate before signing, with the token expiry', async () => {
    await get('/lists/sl_tsl');
    expect(h.ensureVcSigningCertificate).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ signStatusListCredentialRpc: sign }),
      ISSUER,
      'tenant1',
      NOW_MS,
      (ALIGNED + 86400) * 1000
    );
    expect(keyManagerGet).toHaveBeenCalledTimes(2);
    expect(keyManagerGet).toHaveBeenCalledWith('id:tenant1-v3');
  });

  it('serves the token with its media type, cache window and ETag', async () => {
    const response = await get('/lists/sl_tsl');
    const etag = await etagFor(`sl_tsl:v7:${ALIGNED}`);
    expect(response.headers.get('Content-Type')).toContain('application/statuslist+jwt');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(response.headers.get('ETag')).toBe(etag);
  });

  it('keeps the ETag within a window and changes it in the next one', async () => {
    const first = (await get('/lists/sl_tsl')).headers.get('ETag');
    vi.setSystemTime((ALIGNED + 299) * 1000);
    expect((await get('/lists/sl_tsl')).headers.get('ETag')).toBe(first);
    vi.setSystemTime((ALIGNED + 300) * 1000);
    const next = (await get('/lists/sl_tsl')).headers.get('ETag');
    expect(next).toBe(await etagFor(`sl_tsl:v7:${ALIGNED + 300}`));
    expect(next).not.toBe(first);
  });

  it('answers 304 to a matching If-None-Match and signs nothing', async () => {
    const etag = await etagFor(`sl_tsl:v7:${ALIGNED}`);
    const response = await get('/lists/sl_tsl', { 'If-None-Match': etag });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe('');
    expect(response.headers.get('ETag')).toBe(etag);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(sign).not.toHaveBeenCalled();
    expect((await get('/lists/sl_tsl', { 'If-None-Match': '"other"' })).status).toBe(200);
  });

  it('pads small bytes of the digest with zeros in the ETag', async () => {
    // Find a list id whose digest has a byte below 0x10 among the first eight.
    let id = '';
    for (let index = 0; index < 400 && !id; index += 1) {
      const text = `sl_${index}:v7:${ALIGNED}`;
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
      );
      if (digest.slice(0, 8).some((byte) => byte < 16)) id = `sl_${index}`;
    }
    expect(id).not.toBe('');
    h.queryOne.mockResolvedValue({ ...tslList, id });
    const etag = (await get(`/lists/${id}`)).headers.get('ETag');
    expect(etag).toBe(await etagFor(`${id}:v7:${ALIGNED}`));
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
  });

  describe('x5c requirement', () => {
    const entry = (overrides: Record<string, unknown>) => ({
      enabled: true,
      keyAttestationRoots: ['root'],
      ...overrides,
    });
    const payload = expect.objectContaining({ iss: ISSUER });

    it('requires x5c when a wallet entry is enabled and has attestation roots', async () => {
      h.loadWalletAllowlist.mockResolvedValue({ entries: [entry({})] });
      await get('/lists/sl_tsl');
      expect(h.loadWalletAllowlist).toHaveBeenCalledWith(env, 'tenant1');
      expect(sign).toHaveBeenCalledWith(payload, { requireX5c: true });
    });

    it.each([
      ['a disabled entry', { entries: [entry({ enabled: false })] }],
      ['an entry without roots', { entries: [entry({ keyAttestationRoots: [] })] }],
      ['no entries', { entries: [] }],
    ])('does not require x5c for %s', async (_name, allowlist) => {
      h.loadWalletAllowlist.mockResolvedValue(allowlist);
      await get('/lists/sl_tsl');
      expect(sign).toHaveBeenCalledTimes(1);
      expect(sign.mock.calls[0]).toHaveLength(1);
    });

    it('answers 503, logs and signs nothing when the allowlist read fails', async () => {
      h.loadWalletAllowlist.mockRejectedValue(new Error('kv down'));
      const response = await get('/lists/sl_tsl');
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(h.logger.error).toHaveBeenCalledWith(
        'Failed to generate status list credential: wallet allowlist unreadable',
        { cause_name: 'Error' },
        expect.any(Error)
      );
      expect(h.ensureVcSigningCertificate).not.toHaveBeenCalled();
      expect(sign).not.toHaveBeenCalled();
    });

    it('does not read the allowlist for legacy lists, so a read failure does not affect them', async () => {
      h.queryOne.mockResolvedValue(legacyList);
      h.loadWalletAllowlist.mockRejectedValue(new Error('kv down'));
      expect((await get('/lists/sl_legacy')).status).toBe(200);
      expect(h.loadWalletAllowlist).not.toHaveBeenCalled();
    });
  });
});

describe('statusListRoute: legacy Bitstring Status List', () => {
  beforeEach(() => {
    h.queryOne.mockResolvedValue(legacyList);
  });

  it('signs the W3C credential payload for the issuer DID', async () => {
    const response = await get('/lists/sl_legacy');
    expect(response.status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith('tenant1-v3');
    expect(sign).toHaveBeenCalledWith({
      iss: 'did:web:tenant1.issuer.example.com',
      iat: NOW,
      exp: NOW + 86400,
      sub: `${ISSUER}/vci/status-lists/sl_legacy`,
      vc: {
        '@context': [
          'https://www.w3.org/2018/credentials/v1',
          'https://w3id.org/vc/status-list/2021/v1',
        ],
        type: ['VerifiableCredential', 'BitstringStatusListCredential'],
        credentialSubject: {
          id: `${ISSUER}/vci/status-lists/sl_legacy#list`,
          type: 'BitstringStatusList',
          statusPurpose: 'revocation',
          encodedList: 'eJzTBwAAAQAB',
        },
      },
    });
    expect(h.ensureVcSigningCertificate).not.toHaveBeenCalled();
  });

  it('keys the ETag on the encoded list and its update time', async () => {
    const response = await get('/lists/sl_legacy');
    expect(response.headers.get('ETag')).toBe(
      await etagFor('sl_legacy:eJzTBwAAAQAB:2024-01-01T00:00:00.000Z')
    );
    expect(response.headers.get('Content-Type')).toContain('application/statuslist+jwt');
  });

  it('answers 304 for its own ETag', async () => {
    const etag = await etagFor('sl_legacy:eJzTBwAAAQAB:2024-01-01T00:00:00.000Z');
    expect((await get('/lists/sl_legacy', { 'If-None-Match': etag })).status).toBe(304);
  });
});

describe('statusListJsonRoute', () => {
  it('returns the stored list fields', async () => {
    const response = await get('/lists/sl_tsl/json');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: 'sl_tsl',
      tenant_id: 'tenant1',
      purpose: 'revocation',
      format: 'ietf_tsl_v1',
      bits: 2,
      version: 7,
      encoded_list: 'eJzTBwAAAQAB',
      updated_at: '2024-01-01T00:00:00.000Z',
    });
    expect(h.queryOne).toHaveBeenCalledWith(expect.any(String), ['tenant1', 'sl_tsl']);
  });

  it('rejects a missing list id', async () => {
    const response = await get('/nolist/json');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Missing list ID',
    });
  });

  it('answers 404 for an unknown list', async () => {
    h.queryOne.mockResolvedValue(null);
    const response = await get('/lists/sl_missing/json');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'not_found',
      error_description: 'Status list not found',
    });
  });
});
