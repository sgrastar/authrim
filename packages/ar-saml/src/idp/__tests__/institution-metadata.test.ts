/**
 * GET /saml/idp/metadata for a tenant that has registered its institution: the response a service
 * provider would fetch (and cache) carries the scopes and the names, signed like the rest of the
 * metadata, and a tenant whose settings cannot be read gets no metadata rather than metadata
 * without its scopes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SAML_NAMESPACES } from '../../common/constants';
import { findElement, getTextContent, parseXml } from '../../common/xml-utils';

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  settingsError: null as Error | null,
  requested: [] as Array<{ category: string; tenantId: string }>,
  sign: false,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
    resolveEffectiveSettings: vi.fn(
      async (_env: unknown, category: string, target: { tenantId: string }) => {
        mocks.requested.push({ category, tenantId: target.tenantId });
        if (mocks.settingsError) throw mocks.settingsError;
        return mocks.settings;
      }
    ),
  };
});
vi.mock('../../common/entity-id', () => ({
  getSAMLLocalEntityIds: vi.fn(async () => ({
    issuerUrl: 'https://idp.example.com',
    idpEntityId: 'https://idp.example.com/saml/idp',
  })),
  getSAMLPublicSettings: vi.fn(async () => ({})),
}));
vi.mock('../../common/idp-signing', () => ({
  buildSAMLIdPSigningContext: vi.fn(() => ({})),
}));
vi.mock('../../common/saml-signing-keys', () => ({
  getSAMLMetadataSigningCertificates: vi.fn(async () => [
    {
      slot: 'active',
      keyRef: 'tenant:tenant-a:saml:idp:signing',
      certificate: '-----BEGIN CERTIFICATE-----\nACTIVECERT\n-----END CERTIFICATE-----',
    },
  ]),
}));
vi.mock('../../common/metadata-signing', () => ({
  shouldSignSAMLMetadata: vi.fn(() => mocks.sign),
  getSAMLMetadataSigningMaterial: vi.fn(async () => ({
    privateKeyPem: 'key',
    certificate: 'cert',
  })),
  // The signature covers the whole document, so what the signer receives is what is signed.
  signSAMLMetadata: vi.fn((xml: string) => `${xml}<!-- signed -->`),
}));

import { handleIdPMetadata } from '../metadata';

function fetchMetadata(ifNoneMatch?: string) {
  const context = {
    env: {},
    req: {
      header: vi.fn((name: string) => (name === 'If-None-Match' ? ifNoneMatch : undefined)),
    },
    get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-a' : undefined)),
    json: vi.fn((body: unknown, status = 200) => new Response(JSON.stringify(body), { status })),
  };
  return handleIdPMetadata(context as never);
}

const scopesIn = (xml: string) =>
  Array.from(parseXml(xml).getElementsByTagNameNS(SAML_NAMESPACES.SHIBMD, 'Scope'), (scope) =>
    getTextContent(scope)
  );

describe('the IdP metadata of a tenant', () => {
  beforeEach(() => {
    mocks.settings = {};
    mocks.settingsError = null;
    mocks.requested = [];
    mocks.sign = false;
  });

  it('carries the scopes and the names the tenant registered', async () => {
    mocks.settings = {
      'institution.scopes': 'example.ac.jp, med.example.ac.jp',
      'institution.display_names': JSON.stringify({ ja: '例大学', en: 'Example University' }),
    };
    const response = await fetchMetadata();
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(mocks.requested).toEqual([{ category: 'institution', tenantId: 'tenant-a' }]);
    expect(scopesIn(xml)).toEqual(['example.ac.jp', 'med.example.ac.jp']);
    const organization = findElement(parseXml(xml), SAML_NAMESPACES.MD, 'Organization')!;
    expect(
      Array.from(
        organization.getElementsByTagNameNS(SAML_NAMESPACES.MD, 'OrganizationName'),
        (name) => getTextContent(name)
      )
    ).toEqual(['例大学', 'Example University']);
  });

  it('is signed with the scopes in it when metadata is signed', async () => {
    mocks.sign = true;
    mocks.settings = { 'institution.scopes': 'example.ac.jp' };
    const xml = await (await fetchMetadata()).text();

    expect(xml.endsWith('<!-- signed -->')).toBe(true);
    expect(scopesIn(xml.replace('<!-- signed -->', ''))).toEqual(['example.ac.jp']);
  });

  it('changes its ETag with the scopes, so a cache holding the earlier metadata revalidates', async () => {
    const before = await fetchMetadata();
    mocks.settings = { 'institution.scopes': 'example.ac.jp' };
    const after = await fetchMetadata();

    expect(after.headers.get('ETag')).not.toBe(before.headers.get('ETag'));
    expect((await fetchMetadata(before.headers.get('ETag') ?? '')).status).toBe(200);
    expect((await fetchMetadata(after.headers.get('ETag') ?? '')).status).toBe(304);
  });

  it('is the metadata it always was for a tenant that registered nothing', async () => {
    const xml = await (await fetchMetadata()).text();

    expect(xml).not.toContain('shibmd');
    expect(xml).toContain('Authrim Identity Provider');
  });

  it('names the organization as it always did, and still lists the scopes, when the saved names are not valid', async () => {
    mocks.settings = {
      'institution.scopes': 'example.ac.jp',
      'institution.display_names': 'broken',
    };
    const response = await fetchMetadata();
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(scopesIn(xml)).toEqual(['example.ac.jp']);
    expect(xml).toContain('Authrim Identity Provider');
    expect(xml).not.toContain('broken');
  });

  it('is not served, rather than served without the scopes, when the settings cannot be read', async () => {
    mocks.settingsError = new Error('kv down');
    const response = await fetchMetadata();

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control') ?? '').not.toContain('max-age');
    expect(response.headers.get('ETag')).toBeNull();
  });
});
