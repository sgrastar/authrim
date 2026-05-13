import type {
  Env,
  SAMLIdPConfig,
  SAMLMetadataCertificatePublication,
  SAMLSigningKeyPolicy,
  SAMLSigningKeyReference,
  SAMLSigningRole,
  SAMLSPConfig,
} from '@authrim/ar-lib-core';
import { getSigningCertificate, getSigningKey } from './key-utils';
import { requireSAMLTenantId } from './tenant';

export interface SAMLSigningKeyContext {
  tenantId: string;
  role: SAMLSigningRole;
  counterpartyEntityId?: string;
  policy?: SAMLSigningKeyPolicy;
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
  const [key, certificate] = await Promise.all([
    getSigningKey(env, context.tenantId, { keyRef }),
    getSigningCertificate(env, context.tenantId, { keyRef }),
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
    const next = await resolvePublishedCertificate(env, context, context.policy?.next);
    if (next) {
      certificates.push(next);
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
  });

  return {
    slot: reference.slot,
    keyRef: reference.keyRef,
    kid: reference.kid,
    certificate,
  };
}

export function assertSAMLKeyRefTenantBound(keyRef: string, tenantId: string): void {
  const resolvedTenantId = requireSAMLTenantId(tenantId, 'SAML signing key tenant');
  if (!keyRef.startsWith(`tenant:${resolvedTenantId}:`)) {
    throw new Error('SAML signing key reference must be tenant-scoped');
  }
}
