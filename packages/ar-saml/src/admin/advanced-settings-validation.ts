import { NameIDFormats, validateWebhookUrl } from '@authrim/ar-lib-core';
import { previewTrustCertificate } from './certificate-preview';
import { importRsaOaepPublicKey, resolveXmlEncryptionAlgorithms } from '../idp/encryption';
import {
  MIN_SAML_METADATA_REFRESH_INTERVAL_SECONDS,
  MAX_SAML_METADATA_REFRESH_INTERVAL_SECONDS,
} from './metadata-refresh';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}
const ENUMS: Record<string, readonly string[]> = {
  sloBinding: ['post', 'redirect'],
  samlProfile: ['baseline', 'strict', 'academic_publisher', 'legacy'],
  authnRequestSignaturePolicy: ['required', 'optional', 'disabled'],
  logoutRequestSignaturePolicy: ['required', 'optional', 'disabled'],
  logoutResponseSignaturePolicy: ['required', 'optional', 'disabled'],
  authnRequestLegacyAlgorithmPolicy: ['disabled', 'explicit_opt_in'],
  logoutRequestLegacyAlgorithmPolicy: ['disabled', 'explicit_opt_in'],
  encryptionAlgorithmPolicy: ['modern', 'legacy_opt_in'],
  assertionEncryptionAlgorithm: ['aes256-gcm', 'aes256-cbc'],
  keyEncryptionAlgorithm: ['rsa-oaep-256', 'rsa-oaep-sha1'],
};
/** Validate supplied fields and, when enabled, the resulting SP encryption configuration. */
export async function samlAdvancedSettingsProblem(
  input: unknown,
  enabledSPConfig?: unknown
): Promise<string | undefined> {
  const patch = record(input);
  for (const [key, options] of Object.entries(ENUMS)) {
    if (
      patch[key] !== undefined &&
      (typeof patch[key] !== 'string' || !options.includes(patch[key]))
    )
      return key;
  }
  for (const key of [
    'signResponses',
    'signAssertions',
    'encryptAssertions',
    'encryptNameID',
    'allowSyntheticEmailFallback',
  ]) {
    if (patch[key] !== undefined && typeof patch[key] !== 'boolean') return key;
  }
  for (const key of [
    'acsUrls',
    'allowedBindings',
    'acceptedAuthnRequestSignatureAlgorithms',
    'acceptedAuthnRequestDigestAlgorithms',
    'acceptedLogoutRequestSignatureAlgorithms',
    'acceptedLogoutRequestDigestAlgorithms',
  ]) {
    const value = patch[key];
    if (value === undefined) continue;
    if (
      !Array.isArray(value) ||
      value.length > 30 ||
      value.some((item) => typeof item !== 'string' || item.length > 2048)
    )
      return key;
    if (
      key === 'allowedBindings' &&
      (!value.length ||
        value.some(
          (item: unknown) =>
            typeof item !== 'string' || !['post', 'redirect', 'artifact'].includes(item)
        ))
    )
      return key;
    if (
      key === 'acsUrls' &&
      value.some((item: unknown) => typeof item !== 'string' || !validateWebhookUrl(item).valid)
    )
      return key;
  }
  for (const key of ['sloUrl']) {
    const value = patch[key];
    if (
      value !== undefined &&
      (typeof value !== 'string' ||
        value.length > 2048 ||
        (value !== '' && !validateWebhookUrl(value).valid))
    )
      return key;
  }
  if (
    patch.providerName !== undefined &&
    (typeof patch.providerName !== 'string' || patch.providerName.length > 256)
  )
    return 'providerName';
  if (
    patch.nameIdFormat !== undefined &&
    !Object.values(NameIDFormats).some((format) => format === patch.nameIdFormat)
  )
    return 'nameIdFormat';
  const lifetime = patch.assertionValiditySeconds;
  if (
    lifetime !== undefined &&
    (typeof lifetime !== 'number' ||
      !Number.isInteger(lifetime) ||
      lifetime < 60 ||
      lifetime > 86400)
  )
    return 'assertionValiditySeconds';
  if (patch.metadataRefreshPolicy !== undefined) {
    if (
      !patch.metadataRefreshPolicy ||
      typeof patch.metadataRefreshPolicy !== 'object' ||
      Array.isArray(patch.metadataRefreshPolicy)
    )
      return 'metadataRefreshPolicy';
    const policy = record(patch.metadataRefreshPolicy);
    if (policy.mode !== undefined && policy.mode !== 'manual' && policy.mode !== 'automatic')
      return 'metadataRefreshPolicy.mode';
    if (
      policy.intervalSeconds !== undefined &&
      (typeof policy.intervalSeconds !== 'number' ||
        !Number.isInteger(policy.intervalSeconds) ||
        policy.intervalSeconds < MIN_SAML_METADATA_REFRESH_INTERVAL_SECONDS ||
        policy.intervalSeconds > MAX_SAML_METADATA_REFRESH_INTERVAL_SECONDS)
    )
      return 'metadataRefreshPolicy.intervalSeconds';
  }
  if (patch.authnContextPolicy !== undefined) {
    const policy = record(patch.authnContextPolicy);
    if (policy.mode !== 'observe' && policy.mode !== 'require_any')
      return 'authnContextPolicy.mode';
    if (
      policy.allowedClassRefs !== undefined &&
      (!Array.isArray(policy.allowedClassRefs) ||
        policy.allowedClassRefs.length > 30 ||
        policy.allowedClassRefs.some(
          (item) => typeof item !== 'string' || !item.trim() || item.length > 2048
        ))
    )
      return 'authnContextPolicy.allowedClassRefs';
    if (
      policy.mode === 'require_any' &&
      (!Array.isArray(policy.allowedClassRefs) || !policy.allowedClassRefs.length)
    )
      return 'authnContextPolicy.allowedClassRefs';
  }
  if (
    patch.encryptionCertificates !== undefined &&
    (!Array.isArray(patch.encryptionCertificates) || patch.encryptionCertificates.length > 30)
  )
    return 'encryptionCertificates';
  for (const [field, certificates] of [
    ['encryptionCertificate', [patch.encryptionCertificate]],
    ['encryptionCertificates', patch.encryptionCertificates ?? []],
  ]) {
    if (!Array.isArray(certificates)) continue;
    for (const certificate of certificates) {
      if (field === 'encryptionCertificate' && (certificate === undefined || certificate === ''))
        continue;
      if (typeof certificate !== 'string' || !certificate || certificate.length > 16384)
        return String(field);
      try {
        await previewTrustCertificate(certificate, 'pem');
        await importRsaOaepPublicKey(certificate, 'SHA-256');
      } catch {
        return String(field);
      }
    }
  }
  const effective = record(enabledSPConfig);
  if (effective.encryptAssertions || effective.encryptNameID) {
    const encryptionAlgorithmPolicy = effective.encryptionAlgorithmPolicy;
    const assertionEncryptionAlgorithm = effective.assertionEncryptionAlgorithm;
    const keyEncryptionAlgorithm = effective.keyEncryptionAlgorithm;
    if (
      encryptionAlgorithmPolicy !== undefined &&
      encryptionAlgorithmPolicy !== 'modern' &&
      encryptionAlgorithmPolicy !== 'legacy_opt_in'
    )
      return 'encryptionAlgorithmPolicy';
    if (
      assertionEncryptionAlgorithm !== undefined &&
      assertionEncryptionAlgorithm !== 'aes256-gcm' &&
      assertionEncryptionAlgorithm !== 'aes256-cbc'
    )
      return 'assertionEncryptionAlgorithm';
    if (
      keyEncryptionAlgorithm !== undefined &&
      keyEncryptionAlgorithm !== 'rsa-oaep-256' &&
      keyEncryptionAlgorithm !== 'rsa-oaep-sha1'
    )
      return 'keyEncryptionAlgorithm';
    let keyHash: 'SHA-1' | 'SHA-256';
    try {
      keyHash = resolveXmlEncryptionAlgorithms({
        encryptionAlgorithmPolicy,
        assertionEncryptionAlgorithm,
        keyEncryptionAlgorithm,
      }).keyHash;
    } catch {
      return 'encryptionAlgorithmPolicy';
    }
    // Match the runtime's single-certificate precedence, including imported array sources.
    const certificate: unknown =
      effective.encryptionCertificate ||
      (Array.isArray(effective.encryptionCertificates)
        ? effective.encryptionCertificates[0]
        : undefined);
    if (typeof certificate !== 'string' || !certificate || certificate.length > 16384)
      return 'encryptionCertificate';
    try {
      await importRsaOaepPublicKey(certificate, keyHash);
    } catch {
      return 'encryptionCertificate';
    }
  }
  return undefined;
}
