import { X509Certificate } from 'node:crypto';
import { SAML_NAMESPACES as NS } from '../../../ar-saml/src/common/constants';
import { parseSAMLXml } from '../../../ar-saml/src/common/xml-utils';
import { canonicalRestoreJson } from '../import/restore-evidence';
import { parseSyntheticBrowserSpSecret } from '../rehearsal/browser-sp-lambda';

/** Private job only. Never copies Core/PII credentials or signing keys to the synthetic SP. */
export async function prepareBrowserSp(input: {
  databasePrefix: string;
  environmentName: string;
  tenantId: string;
  issuer: string;
  spEntityIds: string[];
  host: string;
  stateDatabaseUrl: string;
  seed: unknown;
  metadata: () => Promise<Response>;
  currentSecret: () => Promise<string>;
  saveSecret: (value: string) => Promise<void>;
  onStage?: (
    stage: 'metadata' | 'certificate' | 'configuration' | 'current_secret' | 'save_secret'
  ) => void;
}) {
  const fail = (): never => {
    throw new Error('aws_browser_sp_preparation_invalid');
  };
  const seed = input.seed as {
    browserSp?: { syntheticOnly?: unknown; origin?: unknown; certificateDerSha256?: unknown };
  } | null;
  const pin = seed?.browserSp;
  if (
    input.databasePrefix !== 'authrim_dr_browser' ||
    input.environmentName !== 'aws-browser-rehearsal' ||
    input.tenantId !== 'tenant-a' ||
    !/^https:\/\/[a-z0-9]{10}\.execute-api\.ap-northeast-1\.amazonaws\.com$/u.test(input.issuer) ||
    input.spEntityIds.length !== 1 ||
    input.spEntityIds[0] !== `${input.issuer}/test-sp/metadata` ||
    !pin ||
    Object.keys(pin).sort().join(',') !== 'certificateDerSha256,origin,syntheticOnly' ||
    pin.syntheticOnly !== true ||
    pin.origin !== input.issuer ||
    typeof pin.certificateDerSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(pin.certificateDerSha256)
  )
    fail();
  input.onStage?.('metadata');
  const response = await input.metadata();
  if (response.status !== 200) fail();
  const xml = await response.text();
  if (xml.length > 64 * 1024) fail();
  input.onStage?.('certificate');
  const root = parseSAMLXml(xml).documentElement;
  if (
    !root ||
    root.namespaceURI !== NS.MD ||
    root.localName !== 'EntityDescriptor' ||
    root.getAttribute('entityID') !== `${input.issuer}/saml/idp/metadata`
  )
    fail();
  // Signed metadata also embeds its signing certificate in ds:Signature. The SP trusts the
  // advertised IdP signing descriptor, pinned independently by the fixture summary.
  const descriptors = root.getElementsByTagNameNS(NS.MD, 'IDPSSODescriptor');
  if (descriptors.length !== 1) fail();
  const signing = Array.from(descriptors[0].getElementsByTagNameNS(NS.MD, 'KeyDescriptor')).filter(
    (descriptor) => descriptor.getAttribute('use') === 'signing'
  );
  if (signing.length !== 1) fail();
  const certificates = signing[0].getElementsByTagNameNS(NS.DS, 'X509Certificate');
  if (certificates.length !== 1) fail();
  const certificate = new X509Certificate(
    Uint8Array.from(atob((certificates[0].textContent ?? '').replace(/\s/gu, '')), (character) =>
      character.charCodeAt(0)
    )
  );
  input.onStage?.('configuration');
  const value = parseSyntheticBrowserSpSecret(
    {
      formatVersion: 1,
      syntheticOnly: true,
      environmentName: input.environmentName,
      origin: input.issuer,
      tenantId: input.tenantId,
      stateDatabaseUrl: input.stateDatabaseUrl,
      certificatePem: certificate.toString(),
      certificateDerSha256: pin?.certificateDerSha256,
    },
    input.issuer,
    input.host
  );
  const serialized = canonicalRestoreJson(value);
  input.onStage?.('current_secret');
  const existing = JSON.parse(await input.currentSecret()) as unknown;
  const placeholder = canonicalRestoreJson({ formatVersion: 1, uninitialized: true });
  if (
    canonicalRestoreJson(existing) !== placeholder &&
    canonicalRestoreJson(existing) !== serialized
  )
    fail();
  input.onStage?.('save_secret');
  await input.saveSecret(serialized);
  return {
    syntheticOnly: true,
    origin: input.issuer,
    certificateDerSha256: value.certificateDerSha256,
  };
}
