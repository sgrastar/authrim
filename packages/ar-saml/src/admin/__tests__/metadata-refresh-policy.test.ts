/**
 * Metadata refresh policy edge cases: due-ness, interval clamping, failure back-off and the
 * critical-field extraction corner cases.
 */

import { describe, expect, it } from 'vitest';
import type { SAMLMetadataRefreshPolicy } from '@authrim/ar-lib-core';
import {
  DEFAULT_SAML_METADATA_REFRESH_INTERVAL_SECONDS,
  MAX_SAML_METADATA_REFRESH_INTERVAL_SECONDS,
  MIN_SAML_METADATA_REFRESH_INTERVAL_SECONDS,
  analyzeSAMLMetadata,
  buildSAMLMetadataDiffSummary,
  buildSAMLMetadataRefreshStatus,
  isSAMLMetadataRefreshDue,
  markSAMLMetadataRefreshFailure,
  markSAMLMetadataRefreshSuccess,
  normalizeSAMLMetadataRefreshPolicy,
} from '../metadata-refresh';

/** Partial policies are what the normalizer is for; the type demands mode/interval up front */
const asPolicy = (value: Partial<SAMLMetadataRefreshPolicy>) => value as SAMLMetadataRefreshPolicy;
const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const URL = 'https://idp.example.test/metadata';
const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const metadata = (body: string, attrs = ' entityID="https://idp.example.test"') =>
  `<md:EntityDescriptor xmlns:md="${MD}" xmlns:ds="${DS}"${attrs}>${body}</md:EntityDescriptor>`;

describe('isSAMLMetadataRefreshDue', () => {
  it('should never be due without a metadata URL or in manual mode', () => {
    expect(
      isSAMLMetadataRefreshDue(asPolicy({ mode: 'automatic', nextRefreshAt: 0 }), undefined, NOW)
    ).toBe(false);
    expect(isSAMLMetadataRefreshDue(asPolicy({ mode: 'manual', nextRefreshAt: 0 }), URL, NOW)).toBe(
      false
    );
  });

  it('should be due immediately when no next refresh is scheduled', () => {
    expect(isSAMLMetadataRefreshDue(undefined, URL, NOW)).toBe(true);
    expect(isSAMLMetadataRefreshDue(asPolicy({ mode: 'automatic' }), URL, NOW)).toBe(true);
  });

  it('should be due once the scheduled time has been reached', () => {
    expect(
      isSAMLMetadataRefreshDue(asPolicy({ mode: 'automatic', nextRefreshAt: NOW }), URL, NOW)
    ).toBe(true);
    expect(
      isSAMLMetadataRefreshDue(asPolicy({ mode: 'automatic', nextRefreshAt: NOW - 1 }), URL, NOW)
    ).toBe(true);
    expect(
      isSAMLMetadataRefreshDue(asPolicy({ mode: 'automatic', nextRefreshAt: NOW + 1 }), URL, NOW)
    ).toBe(false);
  });
});

describe('normalizeSAMLMetadataRefreshPolicy', () => {
  it('should clamp and floor the interval', () => {
    expect(
      normalizeSAMLMetadataRefreshPolicy(asPolicy({ intervalSeconds: 1 }), URL, NOW).intervalSeconds
    ).toBe(MIN_SAML_METADATA_REFRESH_INTERVAL_SECONDS);
    expect(
      normalizeSAMLMetadataRefreshPolicy(asPolicy({ intervalSeconds: 1e9 }), URL, NOW)
        .intervalSeconds
    ).toBe(MAX_SAML_METADATA_REFRESH_INTERVAL_SECONDS);
    expect(
      normalizeSAMLMetadataRefreshPolicy(asPolicy({ intervalSeconds: 3600.9 }), URL, NOW)
        .intervalSeconds
    ).toBe(3600);
    expect(
      normalizeSAMLMetadataRefreshPolicy(asPolicy({ intervalSeconds: Number.NaN }), URL, NOW)
        .intervalSeconds
    ).toBe(DEFAULT_SAML_METADATA_REFRESH_INTERVAL_SECONDS);
  });

  it('should be manual and stale without a URL, keeping validators only for the same source', () => {
    const policy = normalizeSAMLMetadataRefreshPolicy(
      asPolicy({
        mode: 'automatic',
        etag: 'e',
        lastModified: 'l',
        validatorSourceUrl: URL,
        acceptedValidUntil: 'v',
      }),
      undefined,
      NOW
    );
    expect(policy).toMatchObject({
      mode: 'manual',
      sourceState: 'stale',
      nextRefreshAt: undefined,
    });
    expect(policy.etag).toBeUndefined();
    expect(policy.lastModified).toBeUndefined();
    expect(policy.validatorSourceUrl).toBeUndefined();
    expect(policy.acceptedValidUntil).toBeUndefined();

    const same = normalizeSAMLMetadataRefreshPolicy(
      asPolicy({
        etag: 'e',
        lastModified: 'l',
        validatorSourceUrl: URL,
        acceptedValidUntil: 'v',
        consecutiveFailures: 3,
        sourceState: 'error',
        nextRefreshAt: 42,
      }),
      URL,
      NOW
    );
    expect(same).toMatchObject({
      mode: 'automatic',
      etag: 'e',
      lastModified: 'l',
      validatorSourceUrl: URL,
      acceptedValidUntil: 'v',
      consecutiveFailures: 3,
      sourceState: 'error',
      nextRefreshAt: 42,
    });
  });
});

describe('markSAMLMetadataRefreshFailure', () => {
  it('should back off exponentially from the minimum interval, capped at the interval', () => {
    let current = normalizeSAMLMetadataRefreshPolicy(asPolicy({ intervalSeconds: 7200 }), URL, NOW);
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      current = markSAMLMetadataRefreshFailure(current, URL, 'fetch_failed', 'error', NOW);
      delays.push(((current.nextRefreshAt ?? 0) - NOW) / 1000);
    }
    expect(delays).toEqual([900, 1800, 3600, 7200, 7200, 7200, 7200]);
    expect(current.consecutiveFailures).toBe(7);
    expect(current).toMatchObject({
      lastAttemptAt: NOW,
      lastErrorCode: 'fetch_failed',
      sourceState: 'error',
    });
  });

  it('should default the source state to error and accept an explicit one', () => {
    expect(markSAMLMetadataRefreshFailure(undefined, URL, 'x').sourceState).toBe('error');
    expect(markSAMLMetadataRefreshFailure(undefined, URL, 'x', 'stale').sourceState).toBe('stale');
  });

  it('should not schedule a retry in manual mode', () => {
    const failed = markSAMLMetadataRefreshFailure(
      asPolicy({ mode: 'manual' }),
      URL,
      'x',
      'error',
      NOW
    );
    expect(failed.nextRefreshAt).toBeUndefined();
    expect(failed.consecutiveFailures).toBe(1);
    const succeeded = markSAMLMetadataRefreshSuccess(
      asPolicy({ mode: 'manual', suspendedByMetadataSync: true }),
      URL,
      NOW
    );
    expect(succeeded.nextRefreshAt).toBeUndefined();
    expect(succeeded.suspendedByMetadataSync).toBeUndefined();
  });
});

describe('analyzeSAMLMetadata', () => {
  it('should reject metadata without an EntityDescriptor or entityID', () => {
    expect(() => analyzeSAMLMetadata(`<md:EntitiesDescriptor xmlns:md="${MD}"/>`)).toThrow(
      new Error('Invalid metadata: missing EntityDescriptor')
    );
    expect(() => analyzeSAMLMetadata(metadata('', ''))).toThrow(
      new Error('Invalid metadata: missing entityID')
    );
  });

  it('should normalize, de-duplicate and sort certificates', () => {
    const body = `<md:IDPSSODescriptor><md:KeyDescriptor><ds:KeyInfo><ds:X509Data><ds:X509Certificate> ZZ\n ZZ </ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:KeyDescriptor><ds:KeyInfo><ds:X509Data><ds:X509Certificate>AAAA</ds:X509Certificate><ds:X509Certificate>ZZZZ</ds:X509Certificate><ds:X509Certificate></ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor></md:IDPSSODescriptor>`;
    expect(analyzeSAMLMetadata(metadata(body)).criticalFields.certificates).toEqual([
      'AAAA',
      'ZZZZ',
    ]);
  });

  it('should extract endpoints with optional ResponseLocation and index, skipping incomplete ones', () => {
    const body = `<md:IDPSSODescriptor><md:SingleSignOnService Binding="post" Location="https://e/sso" ResponseLocation="https://e/sso-r"/><md:SingleSignOnService Binding="redirect"/><md:SingleLogoutService Location="https://e/slo"/></md:IDPSSODescriptor><md:SPSSODescriptor><md:AssertionConsumerService Binding="post" Location="https://e/acs" index="1"/><md:AssertionConsumerService Binding="post" Location="https://e/acs0" index="0"/><md:AssertionConsumerService Binding="post" Location="https://e/acs-x" index="x"/><md:AssertionConsumerService Binding="post" Location="https://e/acs-big" index="99999999999999999999"/></md:SPSSODescriptor>`;
    const endpoints = analyzeSAMLMetadata(metadata(body)).criticalFields.endpoints;
    // Endpoints without Binding or Location are dropped; the order is a stable sort by type/binding/location
    expect(endpoints).toHaveLength(5);
    expect(endpoints.map((e) => e.type)).toEqual(['acs', 'acs', 'acs', 'acs', 'sso']);
    const byLocation = Object.fromEntries(endpoints.map((e) => [e.location, e]));
    expect(byLocation).toEqual({
      'https://e/acs': {
        type: 'acs',
        binding: 'post',
        location: 'https://e/acs',
        responseLocation: undefined,
        index: 1,
      },
      'https://e/acs0': {
        type: 'acs',
        binding: 'post',
        location: 'https://e/acs0',
        responseLocation: undefined,
        index: 0,
      },
      'https://e/acs-x': {
        type: 'acs',
        binding: 'post',
        location: 'https://e/acs-x',
        responseLocation: undefined,
        index: undefined,
      },
      'https://e/acs-big': {
        type: 'acs',
        binding: 'post',
        location: 'https://e/acs-big',
        responseLocation: undefined,
        index: undefined,
      },
      'https://e/sso': {
        type: 'sso',
        binding: 'post',
        location: 'https://e/sso',
        responseLocation: 'https://e/sso-r',
        index: undefined,
      },
    });
  });

  it('should hash with runs of whitespace collapsed and the document trimmed', () => {
    const a = analyzeSAMLMetadata(metadata(' <md:IDPSSODescriptor/> '));
    const b = analyzeSAMLMetadata(`\n\t${metadata('\n\n<md:IDPSSODescriptor/>\t')}  `);
    expect(a.hash).toBe(b.hash);
    // Whitespace is normalized, not removed: presence vs. absence still differs
    expect(a.hash).not.toBe(analyzeSAMLMetadata(metadata('<md:IDPSSODescriptor/>')).hash);
    expect(a.hash).not.toBe(analyzeSAMLMetadata(metadata(' <md:SPSSODescriptor/> ')).hash);
  });
});

describe('diff summary and refresh status', () => {
  const analysis = (
    overrides: Partial<ReturnType<typeof analyzeSAMLMetadata>['criticalFields']> = {},
    hash = 'h1'
  ) => ({
    hash,
    criticalFields: {
      entityId: 'https://e',
      validUntil: undefined,
      certificates: [],
      endpoints: [],
      ...overrides,
    },
  });

  it('should leave expiry undefined for an unparseable validUntil and flag expired ones', () => {
    expect(
      buildSAMLMetadataDiffSummary(undefined, analysis({ validUntil: 'soon' }), NOW)
    ).toMatchObject({ expiresInSeconds: undefined, expired: false, validUntil: 'soon' });
    expect(
      buildSAMLMetadataDiffSummary(
        undefined,
        analysis({ validUntil: new Date(NOW - 1000).toISOString() }),
        NOW
      )
    ).toMatchObject({ expiresInSeconds: -1, expired: true });
    expect(
      buildSAMLMetadataDiffSummary(
        undefined,
        analysis({ validUntil: new Date(NOW + 90_000).toISOString() }),
        NOW
      )
    ).toMatchObject({ expiresInSeconds: 90, expired: false });
  });

  it('should report an unchanged document as unchanged and omit lastChangedAt', () => {
    const current = analysis({ certificates: ['A'] });
    const diff = buildSAMLMetadataDiffSummary(analysis({ certificates: ['A'] }), current, NOW);
    expect(diff).toMatchObject({
      changed: false,
      certificatesAdded: [],
      certificatesRemoved: [],
      endpointsAdded: [],
      endpointsRemoved: [],
      entityIdChanged: false,
      validUntilChanged: false,
      previousHash: 'h1',
    });
    expect(
      buildSAMLMetadataRefreshStatus(analysis({ certificates: ['A'] }), current, NOW)
    ).toMatchObject({
      lastCheckedAt: NOW,
      lastChangedAt: undefined,
      previousHash: 'h1',
      currentHash: 'h1',
    });
  });

  it('should treat a hash change alone as a change and detect an entityID change', () => {
    expect(buildSAMLMetadataDiffSummary(analysis({}, 'h0'), analysis({}, 'h1'), NOW).changed).toBe(
      true
    );
    const diff = buildSAMLMetadataDiffSummary(
      analysis({ entityId: 'https://old' }),
      analysis({}),
      NOW
    );
    expect(diff).toMatchObject({ changed: true, entityIdChanged: true });
    expect(
      buildSAMLMetadataRefreshStatus(analysis({ entityId: 'https://old' }), analysis({}), NOW)
        .lastChangedAt
    ).toBe(NOW);
  });
});
