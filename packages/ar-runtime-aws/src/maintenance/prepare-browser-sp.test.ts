import { createHash, X509Certificate } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { sourceSigningBundle } from '../rehearsal/synthetic-fixture';
import { prepareBrowserSp } from './prepare-browser-sp';

const issuer = 'https://abcdefghij.execute-api.ap-northeast-1.amazonaws.com';
const host = 'browser-test.abc.ap-northeast-1.rds.amazonaws.com';
let certificate: X509Certificate;
beforeAll(async () => {
  certificate = new X509Certificate((await sourceSigningBundle()).certificate);
});
function input() {
  return {
    databasePrefix: 'authrim_dr_browser',
    environmentName: 'aws-browser-rehearsal',
    tenantId: 'tenant-a',
    issuer,
    spEntityIds: [`${issuer}/test-sp/metadata`],
    host,
    stateDatabaseUrl: `postgresql://authrim_dr_browser_state:synthetic-test-password@${host}:5432/authrim_dr_browser_state?sslmode=verify-full`,
    seed: {
      browserSp: {
        syntheticOnly: true,
        origin: issuer,
        certificateDerSha256: createHash('sha256').update(certificate.raw).digest('hex'),
      },
    },
    metadata: vi.fn(
      async () =>
        new Response(
          `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${issuer}/saml/idp/metadata"><ds:Signature><ds:X509Certificate>${btoa(String.fromCharCode(...certificate.raw))}</ds:X509Certificate></ds:Signature><md:IDPSSODescriptor><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${btoa(String.fromCharCode(...certificate.raw))}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor></md:IDPSSODescriptor></md:EntityDescriptor>`
        )
    ),
    currentSecret: vi.fn(async () => JSON.stringify({ formatVersion: 1, uninitialized: true })),
    saveSecret: vi.fn(async (_value: string) => undefined),
  };
}
describe('private browser SP preparation', () => {
  it('copies only the state connection and pinned public certificate and supports exact retries', async () => {
    const source = input();
    const result = await prepareBrowserSp(source);
    expect(result).toEqual({
      syntheticOnly: true,
      origin: issuer,
      certificateDerSha256: source.seed.browserSp.certificateDerSha256,
    });
    const written = source.saveSecret.mock.calls[0][0];
    expect(Object.keys(JSON.parse(written) as Record<string, unknown>).sort()).toEqual([
      'certificateDerSha256',
      'certificatePem',
      'environmentName',
      'formatVersion',
      'origin',
      'stateDatabaseUrl',
      'syntheticOnly',
      'tenantId',
    ]);
    expect(written).not.toMatch(/PRIVATE KEY|coreDatabaseUrl|piiDatabaseUrl|backupPassphrase/u);
    expect(JSON.stringify(result)).not.toContain('synthetic-test-password');
    source.currentSecret.mockResolvedValue(written);
    await prepareBrowserSp(source);
    expect(source.saveSecret.mock.calls[1][0]).toBe(written);
  });
  it.each([
    'database',
    'environment',
    'tenant',
    'issuer',
    'sp',
    'pin',
    'host',
    'existing',
  ] as const)('rejects altered %s without writing', async (kind) => {
    const source = input();
    if (kind === 'database') source.databasePrefix = 'authrim_dr_rehearsal';
    if (kind === 'environment') source.environmentName = 'production';
    if (kind === 'tenant') source.tenantId = 'customer';
    if (kind === 'issuer') source.issuer = 'https://customer.example.com';
    if (kind === 'sp') source.spEntityIds = ['https://publisher.example.com'];
    if (kind === 'pin') source.seed.browserSp.certificateDerSha256 = '0'.repeat(64);
    if (kind === 'host') source.host = 'other.rds.amazonaws.com';
    if (kind === 'existing') source.currentSecret.mockResolvedValue('{"already":"initialized"}');
    await expect(prepareBrowserSp(source)).rejects.toThrow();
    expect(source.saveSecret).not.toHaveBeenCalled();
  });
});
