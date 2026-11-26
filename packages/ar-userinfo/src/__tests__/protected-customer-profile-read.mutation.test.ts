import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntrospectionResponse } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  getClientCached: vi.fn(),
  getPublicKeyByKid: vi.fn(),
  verifyToken: vi.fn(),
  findById: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    getClientCached: mocks.getClientCached,
    getPublicKeyByKid: mocks.getPublicKeyByKid,
    verifyToken: mocks.verifyToken,
    resolveAccountDataContextFromHono: async () => ({ tenantId: 'tenant-a' }),
    createAccountAuthContextFromHono: () => ({ coreAdapter: {} }),
    createPIIContextFromHono: () => ({ defaultPiiAdapter: {} }),
    CanonicalRuntimeUserStore: class {
      findById = mocks.findById;
    },
  };
});

import {
  fromBase64Url,
  grantPayload,
  grantToken,
  profilesApp,
  profilesEnv,
  projection,
} from './helpers/customer-profile-grants';

async function read(
  token: string,
  options: { path?: string; introspection?: boolean } = {}
): Promise<Response> {
  return profilesApp().request(
    `http://localhost/profiles/${options.path ?? 'user-1'}`,
    { headers: { Authorization: `Bearer ${token}` } },
    profilesEnv(options.introspection)
  );
}

async function profileOf(response: Response): Promise<Record<string, unknown>> {
  expect(response.status).toBe(200);
  const body = await response.json<{ profile: Record<string, unknown> }>();
  return body.profile;
}

describe('protected customer profile read route (exact behaviour)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.getClientCached.mockResolvedValue({ client_id: 'service-client', enabled: true });
    mocks.getPublicKeyByKid.mockResolvedValue({ type: 'public' });
    mocks.verifyToken.mockImplementation(async (value: string) => {
      const [, payload] = value.split('.');
      return JSON.parse(fromBase64Url(payload ?? '')) as unknown;
    });
    mocks.findById.mockResolvedValue(projection());
  });

  describe('token key lookup', () => {
    it('decodes a JOSE header whose base64url form uses - and _', async () => {
      const kid = 'k>?>?>?';
      const header = { alg: 'RS256', kid };
      const token = grantToken(grantPayload(), header);
      const encodedHeader = token.split('.')[0] ?? '';
      expect(encodedHeader).toContain('-');
      expect(encodedHeader).toContain('_');

      expect((await read(token)).status).toBe(200);
      expect(mocks.getPublicKeyByKid).toHaveBeenCalledWith(expect.anything(), 'tenant-a', kid);
    });

    it.each([
      ['an empty header segment', `.${grantToken().split('.')[1]}.sig`],
      ['a header that is not base64 JSON', `!!!.${grantToken().split('.')[1]}.sig`],
      ['a header without a kid', grantToken(grantPayload(), { alg: 'RS256' })],
    ])('refuses a token with %s without looking up a key', async (_label, token) => {
      const response = await read(token);
      expect(response.status).toBe(403);
      expect(mocks.getPublicKeyByKid).not.toHaveBeenCalled();
      expect(mocks.findById).not.toHaveBeenCalled();
    });
  });

  describe('token client', () => {
    it('looks the client up including disabled ones', async () => {
      await read(grantToken());
      expect(mocks.getClientCached).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'service-client',
        { includeDisabled: true }
      );
    });

    it('serves a token whose client has no registration (a JWT bearer issuer)', async () => {
      mocks.getClientCached.mockResolvedValue(null);
      expect((await read(grantToken())).status).toBe(200);
    });

    it('falls back to azp for the client id', async () => {
      mocks.verifyToken.mockResolvedValue({
        ...grantPayload(),
        client_id: undefined,
        azp: 'azp-client',
      });
      expect((await read(grantToken())).status).toBe(200);
      expect(mocks.getClientCached).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'azp-client',
        { includeDisabled: true }
      );
    });

    it('refuses a token with neither client_id nor azp', async () => {
      mocks.verifyToken.mockResolvedValue({ ...grantPayload(), client_id: undefined });
      expect((await read(grantToken())).status).toBe(403);
      expect(mocks.findById).not.toHaveBeenCalled();
    });
  });

  describe('authorization of the grant against the loaded profile', () => {
    it('refuses a grant whose resource ids do not name the requested profile', async () => {
      const response = await read(grantToken(grantPayload({ resourceIds: ['user-2'] })));
      expect(response.status).toBe(403);
    });

    it('refuses a grant whose detail classes lack profile_export', async () => {
      const response = await read(grantToken(grantPayload({ detailClasses: ['other_class'] })));
      expect(response.status).toBe(403);
    });

    it('refuses a grant for another subject than the loaded profile', async () => {
      mocks.findById.mockResolvedValue(projection({ id: 'user-other' }));
      const response = await read(grantToken(grantPayload({ targetSubjectId: 'user-1' })));
      expect(response.status).toBe(403);
    });

    it('refuses a grant whose target is the loaded profile but not the requested id', async () => {
      mocks.findById.mockResolvedValue(projection({ id: 'user-other' }));
      const response = await read(grantToken(grantPayload({ targetSubjectId: 'user-other' })));
      expect(response.status).toBe(403);
    });
  });

  describe('online introspection of a raw grant', () => {
    const rawPayload = grantPayload({ redaction: 'raw' });
    const active = {
      active: true,
      authorization_details: rawPayload.authorization_details,
      act: rawPayload.act,
    } as unknown as IntrospectionResponse;

    it('posts the token to the issuer introspection endpoint with the client credentials', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(active));
      const response = await read(grantToken(rawPayload), { introspection: true });
      expect(response.status).toBe(200);

      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe('https://tenant.example.com/introspect');
      const request = init as RequestInit;
      expect(request.method).toBe('POST');
      expect(request.headers).toEqual({
        Authorization: `Basic ${btoa('userinfo-service:service-secret')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      });
      const rawBody = request.body;
      if (typeof rawBody !== 'string') throw new Error('expected a string body');
      const body = new URLSearchParams(rawBody);
      expect(body.get('token')).toBe(grantToken(rawPayload));
      expect(body.get('token_type_hint')).toBe('access_token');
      expect(request.signal).toBeInstanceOf(AbortSignal);
    });

    it('does not use the answer of a failed introspection call', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(active, { status: 503 }));
      const response = await read(grantToken(rawPayload), { introspection: true });
      expect(response.status).toBe(403);
      expect(mocks.findById).not.toHaveBeenCalled();
    });
  });

  describe('masked and summary views', () => {
    it('masks names, e-mail and phone number to their documented shape', async () => {
      mocks.findById.mockResolvedValue(
        projection({
          name: 'Alice',
          given_name: 'Ab',
          family_name: ' Bob ',
          preferred_username: 'x',
          email: 'ab@example.com',
          phone_number: ' +819012345678 ',
        })
      );
      const profile = await profileOf(await read(grantToken()));
      expect(profile).toMatchObject({
        name: 'A****',
        given_name: 'A*',
        family_name: 'B**',
        preferred_username: '*',
        email: 'ab*@example.com',
        phone_number: '*********5678',
      });
    });

    it('masks short phone numbers completely, ignoring surrounding spaces', async () => {
      mocks.findById.mockResolvedValue(projection({ phone_number: ' 12 ' }));
      expect(await profileOf(await read(grantToken()))).toMatchObject({ phone_number: '**' });
    });

    it('masks a single-character local part with one star', async () => {
      mocks.findById.mockResolvedValue(projection({ email: 'a@example.com' }));
      expect(await profileOf(await read(grantToken()))).toMatchObject({ email: 'a*@example.com' });
    });

    it('masks an e-mail without a domain as three stars', async () => {
      mocks.findById.mockResolvedValue(projection({ email: 'not-an-email' }));
      expect(await profileOf(await read(grantToken()))).toMatchObject({ email: '***' });
    });

    it('keeps updated_at as a millisecond timestamp and the verification flags', async () => {
      const profile = await profileOf(await read(grantToken()));
      expect(profile).toMatchObject({
        sub: 'user-1',
        tenant_id: 'tenant-a',
        email_verified: true,
        phone_number_verified: true,
        updated_at: Date.parse('2026-01-02T00:00:00.000Z'),
        locale: 'ja-JP',
        zoneinfo: 'Asia/Tokyo',
      });
    });

    it('returns only the summary fields for a summary_only grant', async () => {
      const profile = await profileOf(
        await read(grantToken(grantPayload({ redaction: 'summary_only' })))
      );
      expect(Object.keys(profile).sort()).toEqual([
        'email_verified',
        'phone_number_verified',
        'sub',
        'tenant_id',
        'updated_at',
      ]);
    });
  });

  describe('raw view', () => {
    it('returns every stored field unmasked after the online check', async () => {
      const payload = grantPayload({ redaction: 'raw' });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({
          active: true,
          authorization_details: payload.authorization_details,
          act: payload.act,
        })
      );
      const response = await read(grantToken(payload), { introspection: true });
      const profile = await profileOf(response);
      expect(profile).toEqual({
        sub: 'user-1',
        tenant_id: 'tenant-a',
        email_verified: true,
        phone_number_verified: true,
        updated_at: Date.parse('2026-01-02T00:00:00.000Z'),
        name: 'Example User',
        family_name: 'User',
        given_name: 'Example',
        middle_name: 'Middle',
        nickname: 'EU',
        preferred_username: 'example',
        picture: 'https://example.com/picture.png',
        profile: 'https://example.com/profile',
        website: 'https://example.com',
        gender: 'unspecified',
        birthdate: '2000-01-01',
        zoneinfo: 'Asia/Tokyo',
        locale: 'ja-JP',
        email: 'user@example.com',
        phone_number: '+819012345678',
        address: {
          formatted: '1 Test Street',
          street_address: '1 Test Street',
          locality: 'Tokyo',
          region: 'Tokyo',
          postal_code: '100-0001',
          country: 'JP',
        },
      });
    });

    it('keeps only the string members of the stored address', async () => {
      const payload = grantPayload({ redaction: 'raw' });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({
          active: true,
          authorization_details: payload.authorization_details,
          act: payload.act,
        })
      );
      mocks.findById.mockResolvedValue(
        projection({ address_json: JSON.stringify({ locality: 'Osaka', region: 5 }) })
      );
      const profile = await profileOf(await read(grantToken(payload), { introspection: true }));
      expect(profile.address).toEqual({
        formatted: null,
        street_address: null,
        locality: 'Osaka',
        region: null,
        postal_code: null,
        country: null,
      });
    });
  });
});
