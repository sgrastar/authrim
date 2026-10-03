import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { handleSPLogin } from '../login';

const {
  mockGetIdPConfig,
  mockListIdPConfigs,
  mockSignRedirectBinding,
  mockGetSigningKey,
  mockChallengeKind,
  mockReauthPolicy,
} = vi.hoisted(() => ({
  mockGetIdPConfig: vi.fn(),
  mockListIdPConfigs: vi.fn(),
  mockSignRedirectBinding: vi.fn(),
  mockGetSigningKey: vi.fn(),
  mockChallengeKind: vi.fn(),
  mockReauthPolicy: vi.fn(),
}));

vi.mock('../../admin/providers', () => ({
  getIdPConfig: (...args: unknown[]): unknown => mockGetIdPConfig(...args),
  listIdPConfigs: (...args: unknown[]): unknown => mockListIdPConfigs(...args),
}));

vi.mock('../../common/signature', () => ({
  signRedirectBinding: (...args: unknown[]): unknown => mockSignRedirectBinding(...args),
}));

vi.mock('../../common/key-utils', () => ({
  DEFAULT_SAML_SIGNING_CERTIFICATE_SUBJECT: {
    countryName: '',
    stateOrProvinceName: '',
    localityName: '',
    organizationName: 'Authrim',
    organizationalUnitName: '',
    commonName: 'Authrim SAML Signing',
  },
  getSigningKey: (...args: unknown[]): unknown => mockGetSigningKey(...args),
  getSigningCertificate: vi.fn().mockResolvedValue('mock-certificate'),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    readAuthorizationChallengeKind: mockChallengeKind,
    readExternalProviderReauthPolicy: mockReauthPolicy,
    getLogger: () => ({
      module: () => ({
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    }),
  };
});

describe('SP login tenant signing boundary', () => {
  let mockEnv: Partial<Env>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSigningKey.mockResolvedValue({
      kid: 'mock-kid',
      privateKeyPem: 'mock-private-key',
    });
    mockSignRedirectBinding.mockResolvedValue({
      signedUrl: 'SAMLRequest=request&RelayState=state&SigAlg=alg&Signature=sig',
      signature: 'sig',
      sigAlg: 'alg',
    });
    mockEnv = {
      ISSUER_URL: 'https://auth.example.com',
      SAML_REQUEST_STORE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({
          fetch: vi.fn().mockResolvedValue(new Response('OK', { status: 200 })),
        })),
      } as unknown as Env['SAML_REQUEST_STORE'],
    };
  });

  it('fails closed when SP-initiated redirect signing keyRef belongs to another tenant', async () => {
    mockGetIdPConfig.mockResolvedValue({
      entityId: 'https://idp.example.com',
      ssoUrl: 'https://idp.example.com/sso',
      certificate: 'mock-certificate',
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      attributeMapping: {},
      allowedBindings: ['redirect'],
      signingKeyPolicy: {
        active: {
          slot: 'active',
          keyRef: 'tenant:tenant-b:saml:sp:signing',
        },
      },
    });

    const { context, redirect } = createLoginContext(mockEnv, 'tenant-a');
    const res = await handleSPLogin(context);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(redirect).not.toHaveBeenCalled();
    expect(mockGetSigningKey).not.toHaveBeenCalled();
    expect(mockSignRedirectBinding).not.toHaveBeenCalled();
  });

  it('redirects with a signature when SP signing keyRef is tenant-bound', async () => {
    mockGetIdPConfig.mockResolvedValue({
      entityId: 'https://idp.example.com',
      ssoUrl: 'https://idp.example.com/sso',
      certificate: 'mock-certificate',
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      attributeMapping: {},
      allowedBindings: ['redirect'],
      signingKeyPolicy: {
        active: {
          slot: 'active',
          keyRef: 'tenant:tenant-a:saml:sp:signing',
        },
      },
    });

    const { context, redirect } = createLoginContext(mockEnv, 'tenant-a');
    const res = await handleSPLogin(context);

    expect(res.status).toBe(302);
    expect(redirect).toHaveBeenCalledWith(
      'https://idp.example.com/sso?SAMLRequest=request&RelayState=state&SigAlg=alg&Signature=sig'
    );
    expect(mockGetSigningKey).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      expect.objectContaining({
        keyRef: 'tenant:tenant-a:saml:sp:signing',
      })
    );
    expect(mockSignRedirectBinding).toHaveBeenCalled();
    expect(res.headers.get('Set-Cookie')).toMatch(
      /__Host-authrim_saml_request__\w+=1; Path=\/; HttpOnly; Secure; SameSite=None; Max-Age=300/
    );
  });

  it('uses the Redirect SSO endpoint when a Shibboleth POST endpoint is configured with redirect enabled', async () => {
    mockGetIdPConfig.mockResolvedValue({
      entityId: 'https://test-idp1.gakunin.nii.ac.jp/idp/shibboleth',
      ssoUrl: 'https://test-idp1.gakunin.nii.ac.jp/idp/profile/SAML2/POST/SSO',
      certificate: 'mock-certificate',
      nameIdFormat: 'urn:mace:shibboleth:1.0:nameIdentifier',
      attributeMapping: {},
      allowedBindings: ['post', 'redirect'],
      signingKeyPolicy: {
        active: {
          slot: 'active',
          keyRef: 'tenant:tenant-a:saml:sp:signing',
        },
      },
    });

    const { context, redirect } = createLoginContext(mockEnv, 'tenant-a');
    const res = await handleSPLogin(context);

    expect(res.status).toBe(302);
    expect(redirect).toHaveBeenCalledWith(
      'https://test-idp1.gakunin.nii.ac.jp/idp/profile/SAML2/Redirect/SSO?SAMLRequest=request&RelayState=state&SigAlg=alg&Signature=sig'
    );
    expect(mockSignRedirectBinding).toHaveBeenCalled();
  });

  it('adds ProviderName to AuthnRequest for IdP display', async () => {
    mockGetIdPConfig.mockResolvedValue({
      providerName: 'Authrim Test SP',
      entityId: 'https://idp.example.com',
      ssoUrl: 'https://idp.example.com/sso',
      certificate: 'mock-certificate',
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      attributeMapping: {},
      allowedBindings: ['post'],
    });

    const { context } = createLoginContext(mockEnv, 'tenant-a');
    const res = await handleSPLogin(context);
    const html = await res.text();
    const requestValue = html.match(/name="SAMLRequest" value="([^"]+)"/)?.[1];
    expect(requestValue).toBeTruthy();
    const xml = atob(requestValue!);

    expect(xml).toContain('ProviderName="Authrim Test SP"');
    expect(res.headers.get('Set-Cookie')).toContain('__Host-authrim_saml_request_');
  });
});

describe('SP login answering a re-authentication', () => {
  let storeBodies: Array<Record<string, unknown>>;
  let mockEnv: Partial<Env>;

  beforeEach(() => {
    vi.clearAllMocks();
    storeBodies = [];
    mockGetIdPConfig.mockResolvedValue({
      entityId: 'https://idp.example.com',
      ssoUrl: 'https://idp.example.com/sso',
      certificate: 'mock-certificate',
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      attributeMapping: {},
      allowedBindings: ['post'],
    });
    mockChallengeKind.mockResolvedValue('reauth');
    mockReauthPolicy.mockResolvedValue({ reauthEnabled: true, acceptWithoutAuthTime: false });
    mockEnv = {
      ISSUER_URL: 'https://auth.example.com',
      SAML_REQUEST_STORE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({
          fetch: vi.fn(async (_url: string, init: RequestInit) => {
            storeBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
            return new Response('OK', { status: 200 });
          }),
        })),
      } as unknown as Env['SAML_REQUEST_STORE'],
    };
  });

  function authnRequestXml(html: string): string {
    const encoded = /name="SAMLRequest" value="([^"]+)"/.exec(html)?.[1] ?? '';
    return Buffer.from(encoded, 'base64').toString('utf8');
  }

  it('asks the IdP for a new login and keeps when it asked for the response', async () => {
    const before = Date.now();
    const { context } = createLoginContext(mockEnv, 'tenant-a', {
      authorization_challenge_id: 'reauth_1',
    });

    const res = await handleSPLogin(context);

    expect(res.status).toBe(200);
    expect(authnRequestXml(await res.text())).toContain('ForceAuthn="true"');
    expect(mockReauthPolicy).toHaveBeenCalledWith(mockEnv, 'tenant-a', {
      providerId: 'idp-1',
      ids: ['saml:idp-1', 'idp-1'],
    });
    const reauth = (storeBodies[0]?.context as { spReauthentication?: Record<string, unknown> })
      ?.spReauthentication;
    expect(reauth).toMatchObject({
      authorizationChallengeId: 'reauth_1',
      providerId: 'idp-1',
      providerIds: ['saml:idp-1', 'idp-1'],
    });
    expect(reauth?.requestedAt).toBeGreaterThanOrEqual(before);
  });

  it('keeps the challenge on the IdP choice, so the choice still answers it', async () => {
    mockListIdPConfigs.mockResolvedValue([
      { id: 'idp-1', name: 'Campus', entityId: 'https://idp.example.com' },
    ]);
    const { context } = createLoginContext(mockEnv, 'tenant-a', {
      authorization_challenge_id: 'reauth_1',
    });
    (context.req.query as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'authorization_challenge_id' ? 'reauth_1' : undefined
    );

    const res = await handleSPLogin(context);

    expect(await res.text()).toContain('idp=idp-1&return_url=');
    expect(mockListIdPConfigs).toHaveBeenCalled();
    expect((context.html as ReturnType<typeof vi.fn>).mock.calls[0][0] as string).toContain(
      '&authorization_challenge_id=reauth_1'
    );
  });

  it('leaves a sign-in for a login challenge without ForceAuthn', async () => {
    mockChallengeKind.mockResolvedValue('login');
    const { context } = createLoginContext(mockEnv, 'tenant-a', {
      authorization_challenge_id: 'login_1',
    });

    const res = await handleSPLogin(context);

    expect(authnRequestXml(await res.text())).not.toContain('ForceAuthn');
    expect(storeBodies[0]?.context).toBeUndefined();
  });

  it.each([
    ['a challenge that is not one', null, true],
    ['an IdP the tenant does not let re-authenticate', 'reauth', false],
  ] as const)('refuses %s', async (_label, kind, reauthEnabled) => {
    mockChallengeKind.mockResolvedValue(kind);
    mockReauthPolicy.mockResolvedValue({ reauthEnabled, acceptWithoutAuthTime: false });
    const { context } = createLoginContext(mockEnv, 'tenant-a', {
      authorization_challenge_id: 'reauth_1',
    });

    const res = await handleSPLogin(context);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(storeBodies).toHaveLength(0);
  });
});

function createLoginContext(
  env: Partial<Env>,
  tenantId: string,
  extraQuery: Record<string, string> = {}
): {
  context: Parameters<typeof handleSPLogin>[0];
  redirect: ReturnType<typeof vi.fn>;
} {
  const redirect = vi.fn(
    (url: string) => new Response(null, { status: 302, headers: { Location: url } })
  );
  const context = {
    env,
    req: {
      query: vi.fn((name: string) => {
        if (name === 'idp') {
          return 'idp-1';
        }
        if (name === 'return_url') {
          return 'https://app.example.com/';
        }
        return extraQuery[name];
      }),
      header: vi.fn().mockReturnValue(undefined),
    },
    get: vi.fn((key: string) => (key === 'tenantId' ? tenantId : undefined)),
    redirect,
    json: vi.fn((data: unknown, status: number) => new Response(JSON.stringify(data), { status })),
    html: vi.fn((html: string) => new Response(html, { status: 200 })),
  } as unknown as Parameters<typeof handleSPLogin>[0];

  return { context, redirect };
}
