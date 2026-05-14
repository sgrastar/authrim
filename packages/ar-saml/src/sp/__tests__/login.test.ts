import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { handleSPLogin } from '../login';

const { mockGetIdPConfig, mockListIdPConfigs, mockSignRedirectBinding, mockGetSigningKey } =
  vi.hoisted(() => ({
    mockGetIdPConfig: vi.fn(),
    mockListIdPConfigs: vi.fn(),
    mockSignRedirectBinding: vi.fn(),
    mockGetSigningKey: vi.fn(),
  }));

vi.mock('../../admin/providers', () => ({
  getIdPConfig: (...args: unknown[]): unknown => mockGetIdPConfig(...args),
  listIdPConfigs: (...args: unknown[]): unknown => mockListIdPConfigs(...args),
}));

vi.mock('../../common/signature', () => ({
  signRedirectBinding: (...args: unknown[]): unknown => mockSignRedirectBinding(...args),
}));

vi.mock('../../common/key-utils', () => ({
  getSigningKey: (...args: unknown[]): unknown => mockGetSigningKey(...args),
  getSigningCertificate: vi.fn().mockResolvedValue('mock-certificate'),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
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
  });
});

function createLoginContext(
  env: Partial<Env>,
  tenantId: string
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
        return undefined;
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
