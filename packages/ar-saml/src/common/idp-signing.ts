import type { Env, SAMLSigningKeyPolicy } from '@authrim/ar-lib-core';
import {
  buildSAMLSigningCertificateSubjectAlternativeNames,
  getSAMLLocalEntityIds,
  getSAMLPublicSettings,
  type SAMLLocalEntityIds,
  type SAMLPublicSettings,
} from './entity-id';
import {
  getSAMLSigningMaterial,
  type SAMLSigningKeyContext,
  type SAMLSigningMaterial,
} from './saml-signing-keys';

export interface SAMLIdPSigningOptions {
  tenantId: string;
  counterpartyEntityId?: string;
  providerPolicy?: SAMLSigningKeyPolicy;
}

export function resolveSAMLIdPMessageSigningPolicy(
  providerPolicy: SAMLSigningKeyPolicy | undefined,
  tenantPolicy: SAMLSigningKeyPolicy | undefined
): SAMLSigningKeyPolicy {
  if (providerPolicy?.scope === 'provider' || providerPolicy?.active?.keyRef) {
    return providerPolicy;
  }
  return tenantPolicy ?? providerPolicy ?? {};
}

export function buildSAMLIdPSigningContext(
  options: SAMLIdPSigningOptions & {
    settings: SAMLPublicSettings;
    entityIds: SAMLLocalEntityIds;
  }
): SAMLSigningKeyContext {
  return {
    tenantId: options.tenantId,
    role: 'idp',
    counterpartyEntityId: options.counterpartyEntityId,
    policy: resolveSAMLIdPMessageSigningPolicy(
      options.providerPolicy,
      options.settings.signingKeyPolicies.idp
    ),
    certificateSubject: options.settings.certificateSubject,
    certificateSubjectAlternativeNames: buildSAMLSigningCertificateSubjectAlternativeNames(
      options.entityIds,
      'idp',
      options.settings.certificateSubjectAlternativeNames
    ),
  };
}

export async function getSAMLIdPSigningMaterial(
  env: Env,
  options: SAMLIdPSigningOptions
): Promise<SAMLSigningMaterial> {
  const [settings, entityIds] = await Promise.all([
    getSAMLPublicSettings(env, options.tenantId),
    getSAMLLocalEntityIds(env, options.tenantId),
  ]);
  return getSAMLSigningMaterial(
    env,
    buildSAMLIdPSigningContext({
      ...options,
      settings,
      entityIds,
    })
  );
}
