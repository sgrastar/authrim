/**
 * SAML local entityID helpers: settings storage and normalisation, local entity ids and the
 * DNS names embedded in generated signing certificates.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    buildIssuerUrl: vi.fn((_env: unknown, tenantId: string) => `https://${tenantId}.example.test`),
  };
});

import {
  buildSAMLEntityIdFromIssuerUrl,
  buildSAMLMetadataUrlFromIssuerUrl,
  buildSAMLSettingsKey,
  buildSAMLSigningCertificateSubjectAlternativeNames,
  getSAMLEntityIdStyle,
  getSAMLInteractiveLoginUrlPolicy,
  getSAMLLocalEntityIds,
  getSAMLPublicSettings,
  normalizeCertificateSubjectAlternativeNames,
  putSAMLLocalSigningSettings,
  putSAMLPublicSettings,
  type SAMLLocalEntityIds,
} from '../entity-id';

const KEY = 'settings:tenant:tenant-a:saml';

function kv(initial?: unknown) {
  const store = new Map<string, string>();
  if (initial !== undefined)
    store.set(KEY, typeof initial === 'string' ? initial : JSON.stringify(initial));
  return {
    store,
    binding: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
    },
  };
}

const envWith = (binding?: unknown, extra: Record<string, unknown> = {}) =>
  ({ ...(binding ? { SETTINGS: binding } : {}), ...extra }) as unknown as Env;

const NOW = Date.parse('2026-06-01T12:00:00Z');

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

describe('keys and URLs', () => {
  it('builds the tenant settings key and the metadata URL', () => {
    expect(buildSAMLSettingsKey('t1')).toBe('settings:tenant:t1:saml');
    expect(buildSAMLMetadataUrlFromIssuerUrl('https://i.example', 'idp')).toBe(
      'https://i.example/saml/idp/metadata'
    );
    expect(buildSAMLMetadataUrlFromIssuerUrl('https://i.example', 'sp')).toBe(
      'https://i.example/saml/sp/metadata'
    );
  });

  it('derives the local entity ids for the stored style', async () => {
    const ids = await getSAMLLocalEntityIds(
      envWith(kv({ entityIdStyle: 'role_url' }).binding),
      'tenant-a'
    );

    expect(ids).toEqual({
      issuerUrl: 'https://tenant-a.example.test',
      entityIdStyle: 'role_url',
      idpEntityId: 'https://tenant-a.example.test/saml/idp',
      spEntityId: 'https://tenant-a.example.test/saml/sp',
      idpMetadataUrl: 'https://tenant-a.example.test/saml/idp/metadata',
      spMetadataUrl: 'https://tenant-a.example.test/saml/sp/metadata',
    });
  });
});

describe('style and login policy resolution', () => {
  it('prefers a valid environment value over the stored one', async () => {
    const binding = kv({
      entityIdStyle: 'role_url',
      interactiveLoginUrlPolicy: 'tenant_host',
    }).binding;

    expect(
      await getSAMLEntityIdStyle(
        envWith(binding, { SAML_ENTITY_ID_STYLE: 'metadata_url' }),
        'tenant-a'
      )
    ).toBe('metadata_url');
    expect(
      await getSAMLInteractiveLoginUrlPolicy(
        envWith(binding, { SAML_INTERACTIVE_LOGIN_URL_POLICY: 'ui_base_url' }),
        'tenant-a'
      )
    ).toBe('ui_base_url');
    expect(binding.get).not.toHaveBeenCalled();
  });

  it('falls back to the stored value when the environment value is invalid', async () => {
    const binding = kv({
      entityIdStyle: 'role_url',
      interactiveLoginUrlPolicy: 'ui_base_url',
    }).binding;
    const env = envWith(binding, {
      SAML_ENTITY_ID_STYLE: 'nonsense',
      SAML_INTERACTIVE_LOGIN_URL_POLICY: 'nonsense',
    });

    expect(await getSAMLEntityIdStyle(env, 'tenant-a')).toBe('role_url');
    expect(await getSAMLInteractiveLoginUrlPolicy(env, 'tenant-a')).toBe('ui_base_url');
  });

  it('defaults without any stored settings', async () => {
    expect(await getSAMLEntityIdStyle(envWith(), 'tenant-a')).toBe('metadata_url');
    expect(await getSAMLInteractiveLoginUrlPolicy(envWith(), 'tenant-a')).toBe('tenant_host');
  });
});

describe('reading stored settings', () => {
  it('returns defaults for a missing, empty or unreadable document', async () => {
    const defaults = {
      entityIdStyle: 'metadata_url',
      interactiveLoginUrlPolicy: 'tenant_host',
      certificateSubject: {
        countryName: '',
        stateOrProvinceName: '',
        localityName: '',
        organizationName: 'Authrim',
        organizationalUnitName: '',
        commonName: 'Authrim SAML Signing',
      },
      certificateSubjectAlternativeNames: { includeGeneratedDnsNames: true, dnsNames: [] },
      signingKeyPolicies: {},
    };

    expect(await getSAMLPublicSettings(envWith(), 'tenant-a')).toEqual(defaults);
    expect(await getSAMLPublicSettings(envWith(kv().binding), 'tenant-a')).toEqual(defaults);
    expect(await getSAMLPublicSettings(envWith(kv('{not json').binding), 'tenant-a')).toEqual(
      defaults
    );
    const failing = { get: vi.fn(async () => Promise.reject(new Error('kv down'))), put: vi.fn() };
    expect(await getSAMLPublicSettings(envWith(failing), 'tenant-a')).toEqual(defaults);
  });

  it('reads camelCase and legacy snake_case keys, preferring camelCase', async () => {
    const legacy = await getSAMLPublicSettings(
      envWith(
        kv({
          entity_id_style: 'role_url',
          interactive_login_url_policy: 'ui_base_url',
          certificate_subject_alternative_names: { dnsNames: ['legacy.example.test'] },
        }).binding
      ),
      'tenant-a'
    );
    const both = await getSAMLPublicSettings(
      envWith(
        kv({
          entityIdStyle: 'metadata_url',
          entity_id_style: 'role_url',
          interactiveLoginUrlPolicy: 'tenant_host',
          interactive_login_url_policy: 'ui_base_url',
          certificateSubjectAlternativeNames: { dnsNames: ['camel.example.test'] },
          certificate_subject_alternative_names: { dnsNames: ['snake.example.test'] },
        }).binding
      ),
      'tenant-a'
    );

    expect(legacy).toMatchObject({
      entityIdStyle: 'role_url',
      interactiveLoginUrlPolicy: 'ui_base_url',
      certificateSubjectAlternativeNames: { dnsNames: ['legacy.example.test'] },
    });
    expect(both).toMatchObject({
      entityIdStyle: 'metadata_url',
      interactiveLoginUrlPolicy: 'tenant_host',
      certificateSubjectAlternativeNames: { dnsNames: ['camel.example.test'] },
    });
  });

  it('prefers valid environment overrides in the public settings', async () => {
    const settings = await getSAMLPublicSettings(
      envWith(kv({ entityIdStyle: 'role_url', interactiveLoginUrlPolicy: 'tenant_host' }).binding, {
        SAML_ENTITY_ID_STYLE: 'metadata_url',
        SAML_INTERACTIVE_LOGIN_URL_POLICY: 'ui_base_url',
      }),
      'tenant-a'
    );

    expect(settings).toMatchObject({
      entityIdStyle: 'metadata_url',
      interactiveLoginUrlPolicy: 'ui_base_url',
    });
  });

  it('sanitises the certificate subject: control characters, trimming, length and defaults', async () => {
    const settings = await getSAMLPublicSettings(
      envWith(
        kv({
          certificateSubject: {
            countryName: ' jpx ',
            stateOrProvinceName: `\u0000Tokyo\u001f${'x'.repeat(200)}`,
            localityName: 'Chiyoda\u007f',
            organizationName: '   ',
            organizationalUnitName: 'Unit',
            commonName: 'c'.repeat(300),
          },
        }).binding
      ),
      'tenant-a'
    );

    expect(settings.certificateSubject).toEqual({
      countryName: 'JP',
      stateOrProvinceName: `Tokyo${'x'.repeat(123)}`,
      localityName: 'Chiyoda',
      organizationName: 'Authrim',
      organizationalUnitName: 'Unit',
      commonName: 'c'.repeat(128),
    });
    const defaulted = await getSAMLPublicSettings(
      envWith(kv({ certificateSubject: 'bad' }).binding),
      'tenant-a'
    );
    expect(defaulted.certificateSubject).toMatchObject({
      countryName: '',
      organizationName: 'Authrim',
      commonName: 'Authrim SAML Signing',
    });
  });

  it('keeps per-role signing key policies that are objects and drops anything else', async () => {
    const policy = { active: { kid: 'k' } };

    expect(
      (
        await getSAMLPublicSettings(
          envWith(kv({ signingKeyPolicies: { idp: policy, sp: 'x' } }).binding),
          'tenant-a'
        )
      ).signingKeyPolicies
    ).toEqual({ idp: policy, sp: undefined });
    expect(
      (
        await getSAMLPublicSettings(
          envWith(kv({ signingKeyPolicies: { idp: null, sp: policy } }).binding),
          'tenant-a'
        )
      ).signingKeyPolicies
    ).toEqual({ idp: undefined, sp: policy });
    expect(
      (await getSAMLPublicSettings(envWith(kv({ signingKeyPolicies: 'x' }).binding), 'tenant-a'))
        .signingKeyPolicies
    ).toEqual({});
    expect(
      (await getSAMLPublicSettings(envWith(kv({ signingKeyPolicies: null }).binding), 'tenant-a'))
        .signingKeyPolicies
    ).toEqual({});
  });
});

describe('writing settings', () => {
  it('requires the SETTINGS binding', async () => {
    await expect(
      putSAMLPublicSettings(envWith(), 'tenant-a', {
        entityIdStyle: 'role_url',
        interactiveLoginUrlPolicy: 'tenant_host',
      })
    ).rejects.toThrow('SETTINGS KV binding is required to update SAML settings');
    await expect(
      putSAMLLocalSigningSettings(envWith(), 'tenant-a', {
        certificateSubject: {} as never,
        certificateSubjectAlternativeNames: {} as never,
        signingKeyPolicies: {},
      })
    ).rejects.toThrow('SETTINGS KV binding is required to update SAML signing settings');
  });

  it('stores the new style and policy and keeps the other stored parts when none are given', async () => {
    const policies = { idp: { active: { kid: 'k' } } };
    const store = kv({
      certificateSubject: { organizationName: 'Org', commonName: 'CN' },
      certificateSubjectAlternativeNames: {
        includeGeneratedDnsNames: false,
        dnsNames: ['a.example.test'],
      },
      signingKeyPolicies: policies,
    });

    await putSAMLPublicSettings(envWith(store.binding), 'tenant-a', {
      entityIdStyle: 'role_url',
      interactiveLoginUrlPolicy: 'ui_base_url',
    });

    const written = JSON.parse(String(store.store.get(KEY))) as Record<string, unknown>;
    expect(written).toMatchObject({
      entityIdStyle: 'role_url',
      interactiveLoginUrlPolicy: 'ui_base_url',
      certificateSubject: { organizationName: 'Org', commonName: 'CN' },
      certificateSubjectAlternativeNames: {
        includeGeneratedDnsNames: false,
        dnsNames: ['a.example.test'],
      },
      signingKeyPolicies: policies,
      updatedAt: NOW,
    });
  });

  it('overrides the stored parts with the ones given', async () => {
    const store = kv({ signingKeyPolicies: { idp: { active: { kid: 'old' } } } });
    const subject = {
      countryName: 'US',
      stateOrProvinceName: '',
      localityName: '',
      organizationName: 'New',
      organizationalUnitName: '',
      commonName: 'New CN',
    };

    await putSAMLPublicSettings(envWith(store.binding), 'tenant-a', {
      entityIdStyle: 'metadata_url',
      interactiveLoginUrlPolicy: 'tenant_host',
      certificateSubject: subject,
      certificateSubjectAlternativeNames: {
        includeGeneratedDnsNames: true,
        dnsNames: ['b.example.test'],
      },
      signingKeyPolicies: { sp: { active: { slot: 'active', kid: 'new' } } },
    } as never);

    const written = JSON.parse(String(store.store.get(KEY))) as Record<string, unknown>;
    expect(written).toMatchObject({
      certificateSubject: subject,
      certificateSubjectAlternativeNames: { dnsNames: ['b.example.test'] },
      signingKeyPolicies: { sp: { active: { kid: 'new' } } },
    });
  });

  it('writes local signing settings over the stored ones, keeping style and policy', async () => {
    const store = kv({ entityIdStyle: 'role_url', interactiveLoginUrlPolicy: 'ui_base_url' });
    const settings = {
      certificateSubject: {
        countryName: 'JP',
        stateOrProvinceName: '',
        localityName: '',
        organizationName: 'Org',
        organizationalUnitName: '',
        commonName: 'CN',
      },
      certificateSubjectAlternativeNames: {
        includeGeneratedDnsNames: false,
        dnsNames: ['c.example.test'],
      },
      signingKeyPolicies: { idp: { active: { slot: 'active', kid: 'k' } } },
    };

    const result = await putSAMLLocalSigningSettings(
      envWith(store.binding),
      'tenant-a',
      settings as never
    );

    expect(result).toMatchObject({
      entityIdStyle: 'role_url',
      interactiveLoginUrlPolicy: 'ui_base_url',
      ...settings,
    });
    expect(JSON.parse(String(store.store.get(KEY)))).toMatchObject({
      entityIdStyle: 'role_url',
      interactiveLoginUrlPolicy: 'ui_base_url',
      ...settings,
      updatedAt: NOW,
    });
  });
});

describe('certificate subject alternative names', () => {
  const ids: SAMLLocalEntityIds = {
    issuerUrl: 'https://tenant-a.example.test',
    entityIdStyle: 'metadata_url',
    idpEntityId: 'https://idp-id.example.test/saml/idp/metadata',
    spEntityId: 'https://sp-id.example.test/saml/sp/metadata',
    idpMetadataUrl: 'https://idp-meta.example.test/saml/idp/metadata',
    spMetadataUrl: 'https://sp-meta.example.test/saml/sp/metadata',
  };

  it('derives names from the IdP URLs, or the SP URLs, de-duplicated and before the configured ones', () => {
    expect(
      buildSAMLSigningCertificateSubjectAlternativeNames(ids, 'idp', {
        includeGeneratedDnsNames: true,
        dnsNames: ['extra.example.test', 'idp-id.example.test'],
      })
    ).toEqual({
      dnsNames: [
        'idp-id.example.test',
        'idp-meta.example.test',
        'tenant-a.example.test',
        'extra.example.test',
      ],
    });
    expect(
      buildSAMLSigningCertificateSubjectAlternativeNames(ids, 'sp', {
        includeGeneratedDnsNames: true,
        dnsNames: [],
      })
    ).toEqual({
      dnsNames: ['sp-id.example.test', 'sp-meta.example.test', 'tenant-a.example.test'],
    });
  });

  it('uses only the configured names when generated names are off', () => {
    expect(
      buildSAMLSigningCertificateSubjectAlternativeNames(ids, 'idp', {
        includeGeneratedDnsNames: false,
        dnsNames: ['only.example.test'],
      })
    ).toEqual({ dnsNames: ['only.example.test'] });
  });

  it('skips generated URLs that carry no usable host', () => {
    expect(
      buildSAMLSigningCertificateSubjectAlternativeNames(
        {
          ...ids,
          idpEntityId: 'https://192.168.0.1/x',
          idpMetadataUrl: 'not a url',
          issuerUrl: 'https://[::1]',
        },
        'idp',
        { includeGeneratedDnsNames: true, dnsNames: [] }
      )
    ).toEqual({ dnsNames: [] });
  });

  describe('normalizeCertificateSubjectAlternativeNames', () => {
    const names = (dnsNames: unknown[]) =>
      normalizeCertificateSubjectAlternativeNames({ dnsNames }).dnsNames;

    it('keeps valid, lower-cased, unique DNS names in order', () => {
      expect(
        names(['Example.TEST', 'example.test', 'a-b.example.test', '  spaced.example.test  '])
      ).toEqual(['example.test', 'a-b.example.test', 'spaced.example.test']);
    });

    it.each([
      ['an empty value', ''],
      ['a non-string', 7],
      ['a name with a port', 'host.example.test:443'],
      ['a name with a path', 'host.example.test/path'],
      ['an IPv4 address', '192.168.0.1'],
      ['a wildcard', '*.example.test'],
      ['an empty label', 'a..example.test'],
      ['a leading dot', '.example.test'],
      ['a label starting with a hyphen', '-a.example.test'],
      ['a label ending with a hyphen', 'a-.example.test'],
      ['a label with an underscore', 'a_b.example.test'],
      ['a label longer than 63 characters', `${'a'.repeat(64)}.example.test`],
    ])('drops %s', (_label, value) => {
      expect(names([value, 'keep.example.test'])).toEqual(['keep.example.test']);
    });

    it('keeps a label of exactly 63 characters, a single-label name and digits-only labels beyond IPv4', () => {
      const label = 'a'.repeat(63);
      expect(names([`${label}.example.test`, 'localhost', '1.2.3', '1.2.3.4.5'])).toEqual([
        `${label}.example.test`,
        'localhost',
        '1.2.3',
        '1.2.3.4.5',
      ]);
    });

    it('limits the list to 20 names', () => {
      const many = Array.from({ length: 30 }, (_, index) => `h${index}.example.test`);

      expect(names(many)).toEqual(many.slice(0, 20));
    });

    it('treats anything but a boolean as "include generated names"', () => {
      expect(
        normalizeCertificateSubjectAlternativeNames({ includeGeneratedDnsNames: false })
      ).toEqual({
        includeGeneratedDnsNames: false,
        dnsNames: [],
      });
      expect(
        normalizeCertificateSubjectAlternativeNames({ includeGeneratedDnsNames: 'no' })
      ).toEqual({
        includeGeneratedDnsNames: true,
        dnsNames: [],
      });
      expect(normalizeCertificateSubjectAlternativeNames(null)).toEqual({
        includeGeneratedDnsNames: true,
        dnsNames: [],
      });
      expect(normalizeCertificateSubjectAlternativeNames('x')).toEqual({
        includeGeneratedDnsNames: true,
        dnsNames: [],
      });
      expect(
        normalizeCertificateSubjectAlternativeNames({ dnsNames: 'a.example.test' }).dnsNames
      ).toEqual([]);
    });
  });
});

describe('entity id builders', () => {
  it('appends /metadata only for the metadata_url style', () => {
    expect(buildSAMLEntityIdFromIssuerUrl('https://i', 'idp', 'role_url')).toBe(
      'https://i/saml/idp'
    );
    expect(buildSAMLEntityIdFromIssuerUrl('https://i', 'sp', 'metadata_url')).toBe(
      'https://i/saml/sp/metadata'
    );
  });
});
