import type { SAMLSPConfig } from '@authrim/ar-lib-core';
import { describe, expect, it } from 'vitest';
import { NAMEID_FORMATS } from '../../common/constants';
import { buildSAMLDRBundle } from '../dr-bundle';
import {
  buildSAMLDRBundleWatermark,
  createSAMLDRBundleArtifacts,
  createSAMLDRBundleDownloadPayload,
  writeSAMLDRBundleSnapshot,
} from '../dr-bundle-snapshot';

describe('SAML DR bundle snapshots', () => {
  it('creates versioned artifacts with sequence watermarks for R2 and webhooks', async () => {
    const bundle = buildBundle();
    const artifacts = await createSAMLDRBundleArtifacts({
      bundle,
      trigger: 'scheduled',
      sequence: 42,
    });

    expect(artifacts.manifest).toMatchObject({
      kind: 'authrim.dr_bundle_manifest.v1',
      objectClass: 'dr_bundle',
      bundleId: 'drb_library_a_001',
      tenantId: 'library-a',
      snapshotVersion: '1',
      trigger: 'scheduled',
      sequence: 42,
      watermark: '1770000000000-000000000042',
    });
    expect(artifacts.manifest.objects).toHaveLength(1);
    expect(artifacts.manifest.objects[0]).toMatchObject({
      name: 'bundle',
      key: 'exports/library-a/dr-bundles/drb_library_a_001/bundle.json',
      contentType: 'application/vnd.authrim.dr-bundle+json;version=1',
    });
    expect(artifacts.checksums.checksums.bundle).toMatch(/^[a-f0-9]{64}$/);
    expect(artifacts.checksums.checksums.manifest).toMatch(/^[a-f0-9]{64}$/);
    expect(artifacts.webhookEvent).toMatchObject({
      eventType: 'dr_bundle.available',
      objectClass: 'dr_bundle',
      sequence: 42,
      storage: {
        primary: 'r2',
        bucketBinding: 'EXPORT_ARTIFACTS',
      },
    });
    expect(artifacts.webhookEvent.storage.objects.map((object) => object.name)).toEqual([
      'bundle',
      'manifest',
      'checksums',
    ]);
  });

  it('writes snapshot artifacts to R2 and external sinks', async () => {
    const bucket = createMockBucket();
    const sinkWrites: string[] = [];
    const artifacts = await createSAMLDRBundleArtifacts({
      bundle: buildBundle(),
      trigger: 'manual',
      sequence: 1,
      storagePrefix: '/custom//exports/',
    });

    const result = await writeSAMLDRBundleSnapshot({
      bucket,
      artifacts,
      externalSinks: [
        {
          id: 'local-export-test',
          async write(input) {
            sinkWrites.push(input.bundle.bundleId);
          },
        },
      ],
    });

    expect(result.destinations).toEqual([
      { kind: 'r2', id: 'EXPORT_ARTIFACTS' },
      { kind: 'external_sink', id: 'local-export-test' },
    ]);
    expect(sinkWrites).toEqual(['drb_library_a_001']);
    expect(Array.from(bucket.objects.keys())).toEqual([
      'custom/exports/library-a/dr-bundles/drb_library_a_001/bundle.json',
      'custom/exports/library-a/dr-bundles/drb_library_a_001/manifest.json',
      'custom/exports/library-a/dr-bundles/drb_library_a_001/checksums.json',
    ]);
    expect(
      bucket.objects.get(artifacts.webhookEvent.storage.objects[0]!.key)?.options
    ).toMatchObject({
      httpMetadata: {
        contentType: 'application/vnd.authrim.dr-bundle+json;version=1',
      },
      customMetadata: {
        objectClass: 'dr_bundle',
      },
    });
  });

  it('builds a download payload for local/export flows', async () => {
    const payload = await createSAMLDRBundleDownloadPayload(buildBundle());

    expect(payload.filename).toBe('library-a-drb_library_a_001.dr-bundle.json');
    expect(payload.contentType).toBe('application/vnd.authrim.dr-bundle+json;version=1');
    expect(payload.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(payload.body)).toMatchObject({
      kind: 'authrim.dr_bundle.v1',
      bundleId: 'drb_library_a_001',
    });
  });

  it('rejects invalid snapshot sequences', () => {
    expect(() => buildSAMLDRBundleWatermark(1770000000000, 0)).toThrow(
      'SAML DR bundle sequence must be a positive safe integer'
    );
  });
});

function buildBundle() {
  return buildSAMLDRBundle({
    bundleId: 'drb_library_a_001',
    tenantId: 'library-a',
    issuer: 'https://library-a.example.org',
    generatedAt: 1770000000000,
    idpEntityId: 'https://library-a.example.org/saml/idp',
    idpSsoUrl: 'https://library-a.example.org/saml/idp/sso',
    idpSigningCertificates: [
      {
        slot: 'active',
        keyRef: 'tenant:library-a:saml:idp:signing',
        kid: 'key-active',
        certificate: '-----BEGIN CERTIFICATE-----\nPUBLIC\n-----END CERTIFICATE-----',
      },
    ],
    serviceProviders: [spConfig()],
  });
}

function spConfig(): SAMLSPConfig {
  return {
    entityId: 'https://publisher.example.test/saml/sp',
    acsUrl: 'https://publisher.example.test/saml/acs',
    acsUrls: ['https://publisher.example.test/saml/acs'],
    certificate: '-----BEGIN CERTIFICATE-----\nSPCERT\n-----END CERTIFICATE-----',
    nameIdFormat: NAMEID_FORMATS.PERSISTENT,
    attributeMapping: {},
    attributeReleasePolicy: {
      attributes: [
        {
          name: 'urn:oid:0.9.2342.19200300.100.1.3',
          friendlyName: 'mail',
          source: 'claim',
          claim: 'email',
          required: true,
        },
      ],
    },
    signAssertions: true,
    signResponses: true,
    allowedBindings: ['post'],
  };
}

function createMockBucket(): R2Bucket & {
  objects: Map<string, { body: string; options: R2PutOptions | undefined }>;
} {
  const objects = new Map<string, { body: string; options: R2PutOptions | undefined }>();

  return {
    objects,
    async put(key: string, body: string, options?: R2PutOptions) {
      objects.set(key, { body, options });
      return {} as R2Object;
    },
  } as unknown as R2Bucket & {
    objects: Map<string, { body: string; options: R2PutOptions | undefined }>;
  };
}
