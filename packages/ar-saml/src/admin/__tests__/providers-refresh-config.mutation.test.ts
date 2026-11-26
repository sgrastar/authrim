/**
 * refreshSAMLProviderConfigFromMetadata: applying one fetched EntityDescriptor to a stored
 * provider (entityID guard, expiry handling, policy bookkeeping, preserved local settings).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SAMLIdPConfig } from '@authrim/ar-lib-core';
import { refreshSAMLProviderConfigFromMetadata } from '../providers';
import { dig } from './helpers/provider-handler-harness';

const MD = 'xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"';
const DS = 'xmlns:ds="http://www.w3.org/2000/09/xmldsig#"';
const PROTO = 'protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"';
const POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
const URL = 'https://idp.example.test/metadata.xml';
const NOW = Date.parse('2026-06-01T00:00:00Z');

beforeEach(() => {
  // Metadata expiry and certificate validation read the wall clock; pin it to NOW.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function metadata(options: { entityId?: string; validUntil?: string; sso?: string } = {}): string {
  const until = options.validUntil ? ` validUntil="${options.validUntil}"` : '';
  return `<md:EntityDescriptor ${MD} ${DS} entityID="${options.entityId ?? 'https://idp.example.test'}"${until}><md:IDPSSODescriptor ${PROTO}><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>VEVTVA==</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleSignOnService Binding="${POST}" Location="${options.sso ?? 'https://idp.example.test/sso'}"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
}

const existing = {
  entityId: 'https://idp.example.test',
  ssoUrl: 'https://old.example.test/sso',
  certificate: 'OLD',
  nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  attributeMapping: { mail: 'email' },
  metadataRefreshPolicy: { mode: 'automatic', intervalSeconds: 3600, consecutiveFailures: 2 },
} as unknown as SAMLIdPConfig;

function refresh(overrides: Partial<Parameters<typeof refreshSAMLProviderConfigFromMetadata>[0]>) {
  return refreshSAMLProviderConfigFromMetadata({
    providerType: 'saml_idp',
    existingConfig: existing,
    metadataXml: metadata(),
    metadataUrl: URL,
    now: NOW,
    ...overrides,
  });
}

describe('entityID guard', () => {
  it('refuses a changed entityID unless the caller explicitly allows it', async () => {
    await expect(
      refresh({ metadataXml: metadata({ entityId: 'https://other.example.test' }) })
    ).rejects.toThrow('Metadata entityID changed and requires manual approval.');
    await expect(
      refresh({
        metadataXml: metadata({ entityId: 'https://other.example.test' }),
        allowEntityIdChange: false,
      })
    ).rejects.toThrow('requires manual approval');

    const allowed = await refresh({
      metadataXml: metadata({ entityId: 'https://other.example.test' }),
      allowEntityIdChange: true,
    });
    expect(allowed.config.entityId).toBe('https://other.example.test');
  });

  it('accepts any entityID for a config that has none yet', async () => {
    const result = await refresh({
      existingConfig: { ...existing, entityId: '' },
      metadataXml: metadata({ entityId: 'https://other.example.test' }),
    });

    expect(result.config.entityId).toBe('https://other.example.test');
  });
});

describe('successful refresh', () => {
  it('replaces the endpoint and certificate, records the fetch and policy bookkeeping', async () => {
    const result = await refresh({});

    expect(result.expired).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.config).toMatchObject({
      entityId: 'https://idp.example.test',
      ssoUrl: 'https://idp.example.test/sso',
      metadataUrl: URL,
      metadataLastFetched: NOW,
    });
    expect(result.config.metadataXml).toBe(metadata());
    expect(result.config.metadataHash).toBe(result.metadataRefreshStatus.currentHash);
    expect(result.config.metadataCriticalFields?.entityId).toBe('https://idp.example.test');
    expect(result.config.metadataRefreshStatus).toEqual(result.metadataRefreshStatus);
    expect(result.config.metadataRefreshPolicy).toMatchObject({
      mode: 'automatic',
      intervalSeconds: 3600,
      lastAttemptAt: NOW,
      lastSuccessAt: NOW,
      nextRefreshAt: NOW + 3600 * 1000,
      consecutiveFailures: 0,
      sourceState: 'healthy',
    });
  });

  it('reports no change when the same metadata is applied twice', async () => {
    const first = await refresh({});
    const second = await refresh({ existingConfig: first.config });

    expect(second.changed).toBe(false);
    expect(second.config.metadataHash).toBe(first.config.metadataHash);
  });

  it('keeps an aggregate import snapshot only when one is passed', async () => {
    const aggregateImport = {
      aggregateEntityId: 'https://idp.example.test',
      verification: { status: 'verified' },
      importedAt: 1,
    } as unknown as NonNullable<SAMLIdPConfig['aggregateImport']>;

    const withSnapshot = await refresh({ aggregateImport });
    const without = await refresh({});

    expect(withSnapshot.config.aggregateImport).toEqual(aggregateImport);
    expect(without.config.aggregateImport).toBeUndefined();
  });

  it('adds the certificate validation summary for the stored certificate', async () => {
    const result = await refresh({});

    expect(result.config.certificateValidation?.certificates.length).toBeGreaterThan(0);
    expect(result.config.certificateValidation?.checkedAt).toBe(NOW);
  });
});

describe('expired metadata', () => {
  const expired = metadata({
    validUntil: '2020-01-01T00:00:00Z',
    sso: 'https://evil.example.test/sso',
  });

  it('keeps the stored endpoint and records the expiry as a failure', async () => {
    const result = await refresh({ metadataXml: expired });

    expect(result.expired).toBe(true);
    expect(dig(result.config, 'ssoUrl')).toBe('https://old.example.test/sso');
    expect(result.config.metadataXml).toBeUndefined();
    expect(result.config.metadataRefreshStatus).toEqual(result.metadataRefreshStatus);
    expect(result.metadataRefreshStatus.diff.expired).toBe(true);
    expect(result.config.metadataRefreshPolicy).toMatchObject({
      sourceState: 'expired',
      lastErrorCode: 'metadata_expired',
      consecutiveFailures: 3,
      lastAttemptAt: NOW,
    });
  });

  it('treats metadata with a far-future validUntil as current', async () => {
    const result = await refresh({
      metadataXml: metadata({ validUntil: '2099-01-01T00:00:00Z' }),
    });

    expect(result.expired).toBe(false);
  });

  it('still refuses an entityID change before looking at expiry', async () => {
    await expect(
      refresh({
        metadataXml: metadata({
          entityId: 'https://other.example.test',
          validUntil: '2020-01-01T00:00:00Z',
        }),
      })
    ).rejects.toThrow('requires manual approval');
  });
});
