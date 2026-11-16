import {
  mappingDestinationProfileIds,
  mappingReferenceProfileId,
  normalizeDestinationProfileReference,
  type MappingSetReferenceSummary,
} from '@authrim/ar-lib-core';
import {
  badRequest,
  IdentityMappingControlPlaneError,
  type IdentityMappingControlPlaneRepository,
} from './identity-mapping-control-plane';
import type { MappingSetContent } from './identity-mapping-set-facade-content';

export interface MappingSetDestination {
  protocol: 'oidc' | 'saml';
  destination_profile_id: string;
}

function targets(content: MappingSetContent) {
  return content.rules.flatMap((rule) => [
    ...(rule.targetRef ? [rule.targetRef] : []),
    ...(rule.edges ?? []).map((edge) => edge.targetRef),
    ...(rule.transforms ?? []).flatMap((step) => (step.targetRef ? [step.targetRef] : [])),
  ]);
}

/** The profile is the authority for the protocol; a request never duplicates that choice. */
export async function mappingSetDestination(
  repository: IdentityMappingControlPlaneRepository,
  ownerTenantId: string,
  content: MappingSetContent
): Promise<MappingSetDestination> {
  const outputTargets = targets(content);
  const profileIds = mappingDestinationProfileIds(outputTargets);
  if (profileIds.length !== 1) {
    throw new IdentityMappingControlPlaneError(
      'The content must release into exactly one OIDC or SAML Destination Profile',
      400,
      profileIds.length === 0 ? 'unsupported_destination' : 'invalid_request'
    );
  }
  const profileId = profileIds[0];
  const types = await repository.findDestinationProfileTypes(ownerTenantId, profileIds);
  const protocol = types.get(profileId);
  if (protocol !== 'oidc' && protocol !== 'saml') {
    throw new IdentityMappingControlPlaneError(
      'The Destination Profile must be an accessible OIDC or SAML profile',
      400,
      'unsupported_destination'
    );
  }
  for (const target of outputTargets) {
    const targetProfile = mappingReferenceProfileId(target);
    const aliasProfile =
      typeof target.profile_id === 'string' ? target.profile_id.trim() : undefined;
    if (
      (aliasProfile && normalizeDestinationProfileReference(aliasProfile) !== profileId) ||
      !targetProfile ||
      normalizeDestinationProfileReference(targetProfile) !== profileId ||
      target.side !== 'destination' ||
      (protocol === 'oidc'
        ? target.namespace !== 'oidc.claim'
        : target.namespace !== 'saml.attribute' && target.namespace !== 'saml.nameid')
    ) {
      throw badRequest("Every target must be inside the set's Destination Profile and protocol");
    }
  }
  if (
    content.rules.filter((rule) =>
      targets({ ...content, rules: [rule] }).some((target) => target.namespace === 'saml.nameid')
    ).length > 1
  ) {
    throw badRequest('A Mapping Set can contain only one NameID rule');
  }
  return { protocol, destination_profile_id: profileId };
}

export function mappingSetActivationScope(destination: MappingSetDestination) {
  return destination.protocol === 'saml'
    ? { protocol: 'saml', role: 'idp' }
    : { protocol: 'oidc', role: 'op' };
}

/** A confirmation allows content changes, never a change of a shared set's identity. */
export async function assertMappingSetDestinationUnchanged(
  repository: IdentityMappingControlPlaneRepository,
  ownerTenantId: string,
  current: MappingSetContent | null,
  draft: MappingSetContent,
  references: MappingSetReferenceSummary | null
) {
  if (!current || !references || (references.count === 0 && references.scanComplete)) return;
  const before = await mappingSetDestination(repository, ownerTenantId, current);
  const after = await mappingSetDestination(repository, ownerTenantId, draft);
  if (
    before.protocol !== after.protocol ||
    before.destination_profile_id !== after.destination_profile_id
  ) {
    throw new IdentityMappingControlPlaneError(
      'A referenced Mapping Set cannot change protocol or Destination Profile',
      409,
      'conflict',
      { references }
    );
  }
}

/** Legacy or incomplete low-level sets remain readable through the facade. */
export async function readableMappingSetDestination(
  repository: IdentityMappingControlPlaneRepository,
  ownerTenantId: string,
  content: MappingSetContent | null
): Promise<MappingSetDestination | null> {
  if (!content) return null;
  try {
    return await mappingSetDestination(repository, ownerTenantId, content);
  } catch (error) {
    if (error instanceof IdentityMappingControlPlaneError && error.status === 400) return null;
    throw error;
  }
}
