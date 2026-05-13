import type {
  SAMLMetadataCertificatePublication,
  SAMLSigningKeyPolicy,
  SAMLSigningKeyReference,
  SAMLSigningRole,
} from '@authrim/ar-lib-core';
import { assertSAMLKeyRefTenantBound, buildSAMLSigningKeyRef } from '../common/saml-signing-keys';
import { requireSAMLTenantId } from '../common/tenant';

export interface SAMLSigningRolloverContext {
  tenantId: string;
  role: SAMLSigningRole;
  counterpartyEntityId?: string;
}

export interface PublishSAMLNextSigningCertificateInput extends SAMLSigningRolloverContext {
  keyRef?: string;
  kid?: string;
  certificate: string;
  metadataPublishFrom?: number;
  plannedActivationAt?: number;
  metadataCertificatePublication?: Extract<
    SAMLMetadataCertificatePublication,
    'active_next' | 'active_next_backup'
  >;
}

export interface PromoteSAMLNextSigningCertificateInput extends SAMLSigningRolloverContext {
  promotedAt?: number;
  keepPreviousAsBackup?: boolean;
}

export function publishSAMLNextSigningCertificate(
  policy: SAMLSigningKeyPolicy | undefined,
  input: PublishSAMLNextSigningCertificateInput
): SAMLSigningKeyPolicy {
  const tenantId = requireSAMLTenantId(input.tenantId, 'SAML signing rollover tenant');
  const keyRef =
    input.keyRef ??
    buildSAMLSigningKeyRef({
      tenantId,
      role: input.role,
      counterpartyEntityId: input.counterpartyEntityId,
      policy,
    });
  assertSAMLKeyRefTenantBound(keyRef, tenantId);

  const next: SAMLSigningKeyReference = {
    slot: 'next',
    keyRef,
    kid: input.kid,
    certificate: input.certificate,
    state: 'published_next',
    metadataPublishFrom: input.metadataPublishFrom,
    plannedActivationAt: input.plannedActivationAt,
  };

  return {
    ...policy,
    metadataCertificatePublication:
      input.metadataCertificatePublication ??
      policy?.metadataCertificatePublication ??
      'active_next',
    next,
  };
}

export function promoteSAMLNextSigningCertificate(
  policy: SAMLSigningKeyPolicy,
  input: PromoteSAMLNextSigningCertificateInput
): SAMLSigningKeyPolicy {
  const tenantId = requireSAMLTenantId(input.tenantId, 'SAML signing rollover tenant');
  if (!policy.next?.keyRef && !policy.next?.certificate) {
    throw new Error('Cannot promote SAML signing certificate without a next certificate');
  }
  if (policy.next.keyRef) {
    assertSAMLKeyRefTenantBound(policy.next.keyRef, tenantId);
  }
  if (policy.active?.keyRef) {
    assertSAMLKeyRefTenantBound(policy.active.keyRef, tenantId);
  }

  const promotedAt = input.promotedAt ?? Date.now();
  const active: SAMLSigningKeyReference = {
    ...policy.next,
    slot: 'active',
    state: 'active',
    metadataPublishFrom: undefined,
    plannedActivationAt: promotedAt,
  };
  const previousActive = policy.active
    ? ({
        ...policy.active,
        slot: 'backup',
        state: 'overlap',
      } satisfies SAMLSigningKeyReference)
    : undefined;
  const keepPreviousAsBackup = input.keepPreviousAsBackup ?? true;

  return {
    ...policy,
    active,
    next: undefined,
    backup: keepPreviousAsBackup ? previousActive ?? policy.backup : policy.backup,
    metadataCertificatePublication:
      keepPreviousAsBackup && (previousActive || policy.backup) ? 'active_next_backup' : 'active_only',
  };
}

export function retireSAMLBackupSigningCertificate(
  policy: SAMLSigningKeyPolicy | undefined
): SAMLSigningKeyPolicy {
  return {
    ...policy,
    backup: undefined,
    metadataCertificatePublication: policy?.next ? 'active_next' : 'active_only',
  };
}
