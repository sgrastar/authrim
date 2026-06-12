import type {
  Env,
  SAMLIdPConfig,
  SAMLMetadataCertificatePublication,
  SAMLSigningKeyPolicy,
  SAMLSigningKeyReference,
  SAMLSigningRole,
  SAMLSPConfig,
} from '@authrim/ar-lib-core';
import {
  getSigningCertificate,
  getSigningKey,
  type SAMLSigningCertificateCreationOptions,
  type SAMLSigningCertificateSubjectAlternativeNames,
  type SAMLSigningCertificateSubject,
} from './key-utils';
import {
  buildSAMLSigningCertificateSubjectAlternativeNames,
  getSAMLLocalEntityIds,
  getSAMLPublicSettings,
} from './entity-id';
import { requireSAMLTenantId } from './tenant';

export interface SAMLSigningKeyContext {
  tenantId: string;
  role: SAMLSigningRole;
  counterpartyEntityId?: string;
  policy?: SAMLSigningKeyPolicy;
  certificateSubject?: SAMLSigningCertificateSubject;
  certificateSubjectAlternativeNames?: SAMLSigningCertificateSubjectAlternativeNames;
}

export interface SAMLSigningMaterial {
  keyRef: string;
  kid: string;
  privateKeyPem: string;
  certificate: string;
}

export interface SAMLMetadataSigningCertificate {
  slot: 'active' | 'next' | 'backup';
  keyRef?: string;
  kid?: string;
  certificate: string;
}

const DEFAULT_METADATA_CERTIFICATE_PUBLICATION: SAMLMetadataCertificatePublication = 'active_only';

export function buildSAMLSigningKeyRef(context: SAMLSigningKeyContext): string {
  const tenantId = requireSAMLTenantId(context.tenantId, 'SAML signing key tenant');
  const scope = context.policy?.scope ?? 'tenant_role';

  if (scope === 'provider' && context.counterpartyEntityId) {
    return `tenant:${tenantId}:saml:${context.role}:provider:${encodeURIComponent(
      context.counterpartyEntityId
    )}:signing`;
  }

  return `tenant:${tenantId}:saml:${context.role}:signing`;
}

export function resolveSAMLSigningKeyRef(context: SAMLSigningKeyContext): string {
  const tenantId = requireSAMLTenantId(context.tenantId, 'SAML signing key tenant');
  const keyRef = context.policy?.active?.keyRef || buildSAMLSigningKeyRef(context);
  assertSAMLKeyRefTenantBound(keyRef, tenantId);
  return keyRef;
}

export async function getSAMLSigningMaterial(
  env: Env,
  context: SAMLSigningKeyContext
): Promise<SAMLSigningMaterial> {
  const keyRef = resolveSAMLSigningKeyRef(context);
  const certificateOptions = await resolveSAMLSigningCertificateOptions(env, context);
  const [key, certificate] = await Promise.all([
    getSigningKey(env, context.tenantId, {
      keyRef,
      certificateOptions,
    }),
    getSigningCertificate(env, context.tenantId, {
      keyRef,
      certificateSubject: context.certificateSubject,
      certificateOptions,
    }),
  ]);

  return {
    keyRef,
    kid: key.kid,
    privateKeyPem: key.privateKeyPem,
    certificate,
  };
}

export async function getSAMLMetadataSigningCertificates(
  env: Env,
  context: SAMLSigningKeyContext
): Promise<SAMLMetadataSigningCertificate[]> {
  const active = await getSAMLSigningMaterial(env, context);
  const certificates: SAMLMetadataSigningCertificate[] = [
    {
      slot: 'active',
      keyRef: active.keyRef,
      kid: active.kid,
      certificate: active.certificate,
    },
  ];

  const publication =
    context.policy?.metadataCertificatePublication ?? DEFAULT_METADATA_CERTIFICATE_PUBLICATION;

  if (publication === 'active_next' || publication === 'active_next_backup') {
    for (const nextReference of getNextSigningCertificateReferences(context.policy)) {
      const next = await resolvePublishedCertificate(env, context, nextReference);
      if (next) {
        certificates.push(next);
      }
    }
  }

  if (publication === 'active_next_backup') {
    const backup = await resolvePublishedCertificate(env, context, context.policy?.backup);
    if (backup) {
      certificates.push(backup);
    }
  }

  return certificates;
}

export function getSAMLSigningPolicy(config?: SAMLSPConfig | SAMLIdPConfig): SAMLSigningKeyPolicy {
  return config?.signingKeyPolicy ?? {};
}

export async function resolveSAMLIdPSigningPolicy(
  env: Env,
  tenantId: string,
  spConfig?: SAMLSPConfig
): Promise<SAMLSigningKeyPolicy> {
  const spPolicy = getSAMLSigningPolicy(spConfig);
  if (hasExplicitSAMLSigningPolicy(spPolicy)) {
    return spPolicy;
  }

  const settings = await getSAMLPublicSettings(env, tenantId);
  return settings.signingKeyPolicies.idp ?? {};
}

function hasExplicitSAMLSigningPolicy(policy: SAMLSigningKeyPolicy): boolean {
  return Boolean(
    policy.scope ||
    policy.metadataCertificatePublication ||
    policy.active ||
    policy.next ||
    policy.nextCandidates?.length ||
    policy.backup
  );
}

async function resolvePublishedCertificate(
  env: Env,
  context: SAMLSigningKeyContext,
  reference: SAMLSigningKeyReference | undefined
): Promise<SAMLMetadataSigningCertificate | null> {
  if (!reference) {
    return null;
  }

  if (reference.metadataPublishFrom && Date.now() < reference.metadataPublishFrom) {
    return null;
  }

  if (reference.certificate) {
    return {
      slot: reference.slot,
      keyRef: reference.keyRef,
      kid: reference.kid,
      certificate: reference.certificate,
    };
  }

  if (!reference.keyRef) {
    return null;
  }
  assertSAMLKeyRefTenantBound(reference.keyRef, context.tenantId);

  const certificate = await getSigningCertificate(env, context.tenantId, {
    keyRef: reference.keyRef,
    certificateSubject: context.certificateSubject,
    certificateOptions: await resolveSAMLSigningCertificateOptions(env, context),
  });

  return {
    slot: reference.slot,
    keyRef: reference.keyRef,
    kid: reference.kid,
    certificate,
  };
}

async function resolveSAMLSigningCertificateOptions(
  env: Env,
  context: SAMLSigningKeyContext
): Promise<SAMLSigningCertificateCreationOptions> {
  if (context.certificateSubjectAlternativeNames) {
    return {
      subjectAlternativeNames: context.certificateSubjectAlternativeNames,
    };
  }
  const [entityIds, settings] = await Promise.all([
    getSAMLLocalEntityIds(env, context.tenantId),
    getSAMLPublicSettings(env, context.tenantId),
  ]);
  return {
    subjectAlternativeNames: buildSAMLSigningCertificateSubjectAlternativeNames(
      entityIds,
      context.role,
      settings.certificateSubjectAlternativeNames
    ),
  };
}

function getNextSigningCertificateReferences(
  policy: SAMLSigningKeyPolicy | undefined
): SAMLSigningKeyReference[] {
  const references = [policy?.next, ...(policy?.nextCandidates ?? [])].filter(
    (reference): reference is SAMLSigningKeyReference => !!reference
  );
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = reference.kid ?? reference.keyRef ?? reference.certificate;
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function assertSAMLKeyRefTenantBound(keyRef: string, tenantId: string): void {
  const resolvedTenantId = requireSAMLTenantId(tenantId, 'SAML signing key tenant');
  if (!keyRef.startsWith(`tenant:${resolvedTenantId}:`)) {
    throw new Error('SAML signing key reference must be tenant-scoped');
  }
}
