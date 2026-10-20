/**
 * Whether a version of a Mapping Set, with an activation of a given scope, can take the place of
 * the one in use, for the places that name the set.
 *
 * Naming a set was accepted because the set, as it was, met what that place needs of it (see
 * `validateOidcMappingSetReference`). Putting another version or another activation in its place
 * is what could break that silently, so it is judged again on what would be in use:
 * - the places that pin a version (an app's or a SAML provider's own choice, a published credential
 *   profile with the snapshot it was published with) keep the version and snapshot they pin;
 * - the activation's scope must still apply to the context each place runs the mapping in (the
 *   same rule the runtime ranks activations by);
 * - the version must meet what each kind of place needs of its Destination Profile: a mapping
 *   released to an app or to a SAML service provider is held to exactly one active profile of the
 *   protocol's kind, while the mappings that read what comes in (SAML identity providers, SCIM)
 *   and the credential ones write to canonical attributes with none;
 * - what a SAML service provider saved about the profile it releases into (a release policy for
 *   each field of the profile, attribute names that are the fields') still holds for the new
 *   profile, by the rules that save the provider's configuration;
 * - for the platform's sets, it holds only what a platform set may hold;
 * - it has an active compiled snapshot.
 */
import type { DatabaseAdapter } from '../db/adapter';
import { loadDestinationProfileConsentDescriptor } from './destination-profile-consent';
import { PLATFORM_MAPPING_TENANT_ID } from './identity-mapping-owner';
import {
  activationScopeApplies,
  loadRuntimeMappingGraph,
  runtimeDestinationProfileIds,
  type RuntimeIdentityMappingResolutionContext,
} from './identity-mapping-runtime-resolver';
import {
  findRenamedOutputAttributes,
  samlDestinationPolicyCoversProfile,
} from './saml-destination-policy';
import { platformSetViolation } from './identity-mapping-set-reference';
import type { MappingSetReference } from './identity-mapping-set-references';

export type MappingVersionSwapViolationCode =
  | 'destination_profile_invalid'
  | 'platform_set_unsafe'
  | 'snapshot_inactive'
  | 'pinned_version_replaced'
  | 'activation_scope_mismatch'
  | 'saml_destination_policy_mismatch'
  | 'saml_attribute_descriptor_renames_field';

export interface MappingVersionSwapViolation {
  code: MappingVersionSwapViolationCode;
  /** Fit to show the admin who asked for the change. */
  message: string;
}

export interface MappingSwapRequirements {
  /** The version must release into exactly one active Destination Profile. */
  exactlyOneProfile: boolean;
  /** The kinds that profile must be of (every one of them: two kinds cannot both be met). */
  profileTypes: ReadonlySet<'oidc' | 'saml'>;
}

/**
 * What the references need of a version's Destination Profile, by the kind and direction of each:
 * OIDC issuance and SAML issuance to a service provider need one profile of their protocol; SAML
 * inbound (an identity provider, a trust source's identity providers), SCIM and credentials need none.
 */
export function swapRequirementsOf(
  references: readonly MappingSetReference[]
): MappingSwapRequirements {
  const profileTypes = new Set<'oidc' | 'saml'>();
  for (const reference of references) {
    if (
      reference.kind === 'platform_default' ||
      reference.kind === 'tenant_default' ||
      reference.kind === 'client'
    ) {
      profileTypes.add('oidc');
    } else if (
      (reference.kind === 'saml_provider' && reference.providerType !== 'saml_idp') ||
      (reference.kind === 'federation_trust_source' && reference.federationRole === 'saml_sp')
    ) {
      profileTypes.add('saml');
    }
  }
  return { exactlyOneProfile: profileTypes.size > 0, profileTypes };
}

/**
 * The contexts a reference runs the mapping in, as far as they are known from the reference. A
 * field not known (the entity ID of Authrim itself, the partner of a trust source's entities) is
 * left out, so an activation scoped by it does not apply: it cannot be shown to.
 */
export function executionContextsOf(
  reference: MappingSetReference,
  fallbackTenantId: string
): RuntimeIdentityMappingResolutionContext[] {
  const tenantId = reference.tenantId ?? fallbackTenantId;
  switch (reference.kind) {
    case 'platform_default':
    case 'tenant_default':
      // Every app that names no set of its own: no app in particular.
      return [{ tenantId, protocol: 'oidc', role: 'op' }];
    case 'client':
      return [
        {
          tenantId,
          protocol: 'oidc',
          role: 'op',
          clientId: reference.clientId,
          partnerEntityId: reference.clientId,
        },
      ];
    case 'saml_provider':
      return [
        {
          tenantId,
          protocol: 'saml',
          role: reference.providerType === 'saml_idp' ? 'sp' : 'idp',
          partnerEntityId: reference.entityId,
        },
      ];
    case 'federation_trust_source':
      return [
        {
          tenantId,
          protocol: 'saml',
          role: reference.federationRole === 'saml_idp' ? 'sp' : 'idp',
        },
      ];
    case 'credential_profile':
      return [
        {
          tenantId,
          protocol: 'vc',
          role: reference.role === 'verification' ? 'verifier' : 'issuer',
          direction: reference.role === 'verification' ? 'verification' : 'issuance',
          credentialProfileId: reference.profileId,
          credentialConfigurationId: reference.credentialConfigurationId,
        },
      ];
    case 'scim':
      return [{ tenantId, protocol: 'scim', role: 'receiver' }];
  }
}

export interface FindMappingVersionSwapViolationInput {
  adapter: DatabaseAdapter;
  /** The tenant ID that owns the set (the platform's, or a tenant's). */
  ownerTenantId: string;
  /** The tenant the request is made for, for the references that belong to none. */
  contextTenantId: string;
  versionId: string;
  /** The compiled snapshot the version would be used with. */
  snapshot: { catalogVersionId: string | null; willBeActive: boolean; snapshotHash: string | null };
  /**
   * The scope of the activation that would be in use. Not given: the scope is not judged (the
   * platform's sets are always written with an empty one).
   */
  activationScope?: unknown;
  references: readonly MappingSetReference[];
}

function parseObject(json: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = json ? JSON.parse(json) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The first condition the version would not meet, or null. A database failure is thrown. */
export async function findMappingVersionSwapViolation(
  input: FindMappingVersionSwapViolationInput
): Promise<MappingVersionSwapViolation | null> {
  const { adapter, ownerTenantId, versionId, snapshot, references } = input;
  if (!snapshot.willBeActive || !snapshot.catalogVersionId) {
    return {
      code: 'snapshot_inactive',
      message: 'The version would have no active compiled snapshot',
    };
  }

  if (
    references.some(
      (reference) =>
        (reference.pinnedVersionId !== undefined && reference.pinnedVersionId !== versionId) ||
        (reference.pinnedSnapshotHash !== undefined &&
          reference.pinnedSnapshotHash !== snapshot.snapshotHash)
    )
  ) {
    return {
      code: 'pinned_version_replaced',
      message: 'Something that uses the set is bound to the version now in use',
    };
  }

  const scope = parseObject(
    input.activationScope === undefined
      ? null
      : typeof input.activationScope === 'string'
        ? input.activationScope
        : JSON.stringify(input.activationScope)
  );
  if (input.activationScope !== undefined) {
    const outside = references.some((reference) =>
      executionContextsOf(reference, input.contextTenantId).some(
        (context) => !activationScopeApplies(scope, context)
      )
    );
    if (outside) {
      return {
        code: 'activation_scope_mismatch',
        message: 'The scope of the activation would leave out something that uses the set',
      };
    }
  }

  const needs = swapRequirementsOf(references);
  if (needs.exactlyOneProfile) {
    const edges = await adapter.query<{ target_ref_json: string }>(
      `SELECT e.target_ref_json
         FROM mapping_rules r
         JOIN mapping_rule_edges e ON e.tenant_id = r.tenant_id AND e.rule_id = r.id
        WHERE r.tenant_id = ? AND r.field_mapping_version_id = ?`,
      [ownerTenantId, versionId]
    );
    const targetRefs = edges.map((edge) => parseObject(edge.target_ref_json));
    // The set the runtime counts: the profiles the edges name and the one the scope names.
    const profileIds = runtimeDestinationProfileIds(targetRefs, scope);
    if (profileIds.length !== 1) {
      return {
        code: 'destination_profile_invalid',
        message:
          'The version, with the scope of the activation, must release into exactly one Destination Profile',
      };
    }
    const descriptor = await loadDestinationProfileConsentDescriptor(
      adapter,
      ownerTenantId,
      profileIds[0]
    );
    if (
      !descriptor ||
      [...needs.profileTypes].some((type) => descriptor.destinationType !== type)
    ) {
      return {
        code: 'destination_profile_invalid',
        message: 'The Destination Profile of the version must be active and of the kind in use',
      };
    }
    let graph: Awaited<ReturnType<typeof loadRuntimeMappingGraph>> | undefined;
    for (const reference of references) {
      const saved = reference.swapInputs;
      if (!saved || saved.policyKeys.length === 0) continue;
      if (
        !samlDestinationPolicyCoversProfile(
          saved.policyKeys,
          descriptor.fields.map((field) => field.key)
        )
      ) {
        return {
          code: 'saml_destination_policy_mismatch',
          message:
            'The release policy a SAML provider saved does not match the fields of the new Destination Profile',
        };
      }
      const namespace =
        saved.destinationNamespace ??
        (typeof scope.destinationNamespace === 'string' ? scope.destinationNamespace : undefined) ??
        'saml.attribute';
      // The cut of the version the provider's attributes come from, read as the runtime reads it.
      graph ??= await loadRuntimeMappingGraph(adapter, ownerTenantId, versionId);
      if (findRenamedOutputAttributes(graph, namespace, saved.attributeDescriptors).length > 0) {
        return {
          code: 'saml_attribute_descriptor_renames_field',
          message:
            'An attribute name a SAML provider saved would rename a field of the new version',
        };
      }
    }
  }
  if (ownerTenantId === PLATFORM_MAPPING_TENANT_ID) {
    const violation = await platformSetViolation(adapter, versionId, snapshot.catalogVersionId);
    if (violation) return { code: 'platform_set_unsafe', message: violation };
  }
  return null;
}
