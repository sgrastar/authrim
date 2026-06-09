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
  validFrom?: number;
  validTo?: number;
  publicKeyAlgorithm?: 'RSA';
  publicKeySizeBits?: number;
  subjectAlternativeNames?: {
    dnsNames: string[];
  };
  metadataCertificatePublication?: Extract<
    SAMLMetadataCertificatePublication,
    'active_next' | 'active_next_backup'
  >;
}

export interface PromoteSAMLNextSigningCertificateInput extends SAMLSigningRolloverContext {
  promotedAt?: number;
  keepPreviousAsBackup?: boolean;
  targetKid?: string;
  targetKeyRef?: string;
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
    id: crypto.randomUUID(),
    keyRef,
    kid: input.kid,
    certificate: input.certificate,
    state: 'published_next',
    metadataPublishFrom: input.metadataPublishFrom,
    plannedActivationAt: input.plannedActivationAt,
    validFrom: input.validFrom,
    validTo: input.validTo,
    publicKeyAlgorithm: input.publicKeyAlgorithm,
    publicKeySizeBits: input.publicKeySizeBits,
    subjectAlternativeNames: input.subjectAlternativeNames,
  };

  return {
    ...policy,
    metadataCertificatePublication:
      input.metadataCertificatePublication ??
      policy?.metadataCertificatePublication ??
      'active_next',
    next: undefined,
    nextCandidates: [...getSAMLNextSigningCertificates(policy), next],
  };
}

export function promoteSAMLNextSigningCertificate(
  policy: SAMLSigningKeyPolicy,
  input: PromoteSAMLNextSigningCertificateInput
): SAMLSigningKeyPolicy {
  const tenantId = requireSAMLTenantId(input.tenantId, 'SAML signing rollover tenant');
  const nextCandidates = getSAMLNextSigningCertificates(policy);
  const selectedNext = selectSAMLNextSigningCertificate(nextCandidates, input);
  if (!selectedNext?.keyRef && !selectedNext?.certificate) {
    throw new Error('Cannot promote SAML signing certificate without a next certificate');
  }
  if (selectedNext.keyRef) {
    assertSAMLKeyRefTenantBound(selectedNext.keyRef, tenantId);
  }
  if (policy.active?.keyRef) {
    assertSAMLKeyRefTenantBound(policy.active.keyRef, tenantId);
  }

  const promotedAt = input.promotedAt ?? Date.now();
  const active: SAMLSigningKeyReference = {
    ...selectedNext,
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
  const remainingNext = nextCandidates.filter(
    (candidate) => !isSameSigningReference(candidate, selectedNext)
  );

  return {
    ...policy,
    active,
    next: undefined,
    nextCandidates: remainingNext.length ? remainingNext : undefined,
    backup: keepPreviousAsBackup ? (previousActive ?? policy.backup) : policy.backup,
    metadataCertificatePublication: remainingNext.length
      ? keepPreviousAsBackup && (previousActive || policy.backup)
        ? 'active_next_backup'
        : 'active_next'
      : keepPreviousAsBackup && (previousActive || policy.backup)
        ? 'active_next_backup'
        : 'active_only',
  };
}

export function retireSAMLBackupSigningCertificate(
  policy: SAMLSigningKeyPolicy | undefined
): SAMLSigningKeyPolicy {
  return {
    ...policy,
    backup: undefined,
    metadataCertificatePublication: getSAMLNextSigningCertificates(policy).length
      ? 'active_next'
      : 'active_only',
  };
}

export function deleteSAMLNextSigningCertificate(
  policy: SAMLSigningKeyPolicy | undefined,
  input: { targetKid?: string; targetKeyRef?: string } = {}
): SAMLSigningKeyPolicy {
  const nextCandidates = getSAMLNextSigningCertificates(policy);
  const selectedNext = selectSAMLNextSigningCertificate(nextCandidates, input);
  if ((input.targetKid || input.targetKeyRef) && !selectedNext) {
    throw new Error('Cannot delete SAML signing certificate without a matching next certificate');
  }
  const remainingNext = selectedNext
    ? nextCandidates.filter((candidate) => !isSameSigningReference(candidate, selectedNext))
    : nextCandidates.slice(1);

  return {
    ...policy,
    next: undefined,
    nextCandidates: remainingNext.length ? remainingNext : undefined,
    metadataCertificatePublication: remainingNext.length
      ? policy?.backup
        ? 'active_next_backup'
        : 'active_next'
      : policy?.backup
        ? 'active_next_backup'
        : 'active_only',
  };
}

export function getSAMLNextSigningCertificates(
  policy: SAMLSigningKeyPolicy | undefined
): SAMLSigningKeyReference[] {
  const candidates = [policy?.next, ...(policy?.nextCandidates ?? [])].filter(
    (candidate): candidate is SAMLSigningKeyReference => !!candidate
  );
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.kid ?? candidate.keyRef ?? candidate.certificate ?? candidate.id;
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectSAMLNextSigningCertificate(
  candidates: SAMLSigningKeyReference[],
  input: { targetKid?: string; targetKeyRef?: string }
): SAMLSigningKeyReference | undefined {
  if (input.targetKid) {
    return candidates.find((candidate) => candidate.kid === input.targetKid);
  }
  if (input.targetKeyRef) {
    return candidates.find((candidate) => candidate.keyRef === input.targetKeyRef);
  }
  return candidates[0];
}

function isSameSigningReference(
  left: SAMLSigningKeyReference,
  right: SAMLSigningKeyReference
): boolean {
  if (left.kid && right.kid) return left.kid === right.kid;
  if (left.keyRef && right.keyRef) return left.keyRef === right.keyRef;
  if (left.id && right.id) return left.id === right.id;
  return left.certificate === right.certificate;
}
