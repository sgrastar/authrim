/** The sign-in methods a method selector step takes from the external IdP service. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearLoginRuntimeFlowVersionCacheForTests } from '../login-runtime-flow';
import { resetHarness } from './helpers/mut-runtime1-harness';
import { handlesOf, none, providersIdp } from './helpers/mut-runtime1-handles';

vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).libCoreMock(await importOriginal())
);
vi.mock('@authrim/ar-lib-core/services/log-iceberg-emitter', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).icebergMock(await importOriginal())
);
vi.mock('../direct-auth', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).directAuthMock(await importOriginal())
);

beforeEach(() => {
  resetHarness();
  clearLoginRuntimeFlowVersionCacheForTests();
});

describe('the providers of the external IdP service', () => {
  it.each([
    ['no saved usage', undefined],
    ['usage that is not JSON', 'not-json'],
    ['usage that is not a list', '{"id":"x"}'],
  ])('are asked for with %s (a legacy tenant)', async (_label, usage) => {
    const idp = providersIdp([{ id: 'p1', slug: 'acme' }]);
    const handles = await handlesOf({
      methods: { ...none, 'authentication-methods.external_provider_usage': usage },
      externalIdp: idp,
    });
    expect(handles).toEqual(['acme']);
    expect(idp.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an empty list', []],
    ['empty text', '  '],
    ['only SAML providers', [{ id: 'saml:corp' }]],
    ['only providers turned off', [{ id: 'acme', loginEnabled: false }]],
  ])('are not asked for when the saved usage has %s', async (_label, usage) => {
    const idp = providersIdp([{ id: 'p1', slug: 'other' }]);
    await handlesOf({
      methods: { ...none, 'authentication-methods.external_provider_usage': usage },
      externalIdp: idp,
    });
    expect(idp.fetch).not.toHaveBeenCalled();
  });

  it('are asked for when a saved provider other than SAML is on, and both are offered', async () => {
    const idp = providersIdp([{ id: 'p1', slug: 'acme' }]);
    const handles = await handlesOf({
      methods: {
        ...none,
        'authentication-methods.external_provider_usage': [{ id: 'saml:corp' }, { id: 'line' }],
      },
      externalIdp: idp,
    });
    expect(handles).toEqual(['saml_corp', 'line', 'acme']);
  });

  it('offers the enabled providers by slug, else id, and drops what their usage turns off', async () => {
    const idp = providersIdp([
      { id: 'p-disabled', slug: 'disabled', enabled: false },
      { id: 'Provider One' },
      { id: 'p2', slug: 'Second IdP' },
      { id: 'p3', slug: 'by-id' },
      { id: 'Normal Id', slug: 'by-normalized-id' },
      { id: 'p5', slug: 'by-slug' },
      { id: 'p6', slug: 'By Normalized Slug' },
      { name: 'no id or slug' },
      { id: '   ', slug: 7 },
    ]);
    const handles = await handlesOf({
      externalIdp: idp,
      methods: {
        ...none,
        'authentication-methods.external_provider_usage': 'not-json',
      },
    });
    expect(handles).toEqual([
      'provider_one',
      'second_idp',
      'by-id',
      'by-normalized-id',
      'by-slug',
      'by_normalized_slug',
    ]);
  });

  it('drops a provider whose saved usage, found by id, slug or their handles, turns it off', async () => {
    const idp = providersIdp([
      { id: 'p3', slug: 'by-id' },
      { id: 'Normal Id', slug: 'by-normalized-id' },
      { id: 'p5', slug: 'by-slug' },
      { id: 'p6', slug: 'By Normalized Slug' },
      { id: 'p7', slug: 'kept' },
    ]);
    const handles = await handlesOf({
      externalIdp: idp,
      methods: {
        ...none,
        'authentication-methods.external_provider_usage': [
          { id: 'p3', loginEnabled: false },
          { id: 'normal_id', loginEnabled: false },
          { id: 'by-slug', loginEnabled: false },
          { id: 'by_normalized_slug', loginEnabled: false },
          { id: 'p7', loginEnabled: true },
        ],
      },
    });
    expect(handles).toEqual(['p7', 'kept']);
  });

  it.each([
    ['an answer that is not OK', providersIdp([{ id: 'p1' }], { status: 503 })],
    ['providers that are not a list', providersIdp({ id: 'p1' })],
    ['a failure', { fetch: vi.fn(async () => Promise.reject(new Error('down'))) }],
  ])('offers none of its providers on %s', async (_label, idp) => {
    expect(await handlesOf({ externalIdp: idp })).toEqual(['mail_otp', 'passkey']);
    expect(idp.fetch).toHaveBeenCalledTimes(1);
  });

  it('is asked with the tenant and the host the request came to', async () => {
    const idp = providersIdp([]);
    await handlesOf({
      externalIdp: idp,
      headers: { Host: 'login.example.test', 'X-Forwarded-Proto': 'http, https' },
    });
    expect(idp.fetch).toHaveBeenCalledWith('https://external-idp/api/external/providers', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Tenant-Id': 'tenant_test',
        'X-Authrim-Forwarded-Host': 'login.example.test',
        'X-Forwarded-Host': 'login.example.test',
        'X-Forwarded-Proto': 'http',
      },
    });
  });

  it.each([
    [
      'the Authrim forwarded host before the forwarded host',
      { 'X-Authrim-Forwarded-Host': ' a.example.test , b', 'X-Forwarded-Host': 'c.example.test' },
      'https://first.test.authrim.com/x',
      'a.example.test',
      'https',
    ],
    [
      'the forwarded host, with the scheme of the URL',
      { Host: ' ', 'X-Forwarded-Host': 'c.example.test', 'X-Forwarded-Proto': 'gopher' },
      'http://first.test.authrim.com/x',
      'c.example.test',
      'http',
    ],
    [
      'the host of the URL, and https for a scheme that is neither',
      {},
      'ftp://files.example.test/x',
      'files.example.test',
      'https',
    ],
  ])('reads %s', async (_label, headers, url, host, proto) => {
    const idp = providersIdp([]);
    await handlesOf({ externalIdp: idp, headers, url });
    expect(idp.fetch.mock.calls[0]?.[1].headers).toMatchObject({
      'X-Authrim-Forwarded-Host': host,
      'X-Forwarded-Host': host,
      'X-Forwarded-Proto': proto,
    });
  });
});
