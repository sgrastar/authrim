/** Preflight only the explicitly imported SPs exposed by a limited IdP runtime. */

import {
  assertRuntimeIdentityMappingReleaseSafety,
  resolveAuthCorePersistenceAdapterFromEnv,
  type Env,
} from '@authrim/ar-lib-core';
import { getSPConfig } from './admin/providers';
import { buildSAMLIdPSigningContext, getSAMLIdPSigningMaterial } from './common/idp-signing';
import { getSAMLLocalEntityIds, getSAMLPublicSettings } from './common/entity-id';
import { getSAMLMetadataSigningCertificates } from './common/saml-signing-keys';
import { resolveSAMLIdentityMappingFieldMappingBinding } from './idp/attributes';
import { resolveSAMLRuntimeIdentityMapping } from './idp/runtime-identity-mapping';

export async function assertSAMLIdPProviderReadiness(input: {
  env: Env;
  tenantId: string;
  spEntityIds: readonly string[];
}): Promise<void> {
  const { env, tenantId, spEntityIds } = input;
  if (!env.SAML_RUNTIME_PORTS || spEntityIds.length === 0) {
    throw new Error('saml_idp_runtime_provider_inventory_unavailable');
  }
  const [settings, entityIds] = await Promise.all([
    getSAMLPublicSettings(env, tenantId),
    getSAMLLocalEntityIds(env, tenantId),
  ]);
  const metadataSigning = buildSAMLIdPSigningContext({ tenantId, settings, entityIds });
  const metadataCertificates = await getSAMLMetadataSigningCertificates(env, metadataSigning);
  if (metadataCertificates.length === 0) {
    throw new Error('saml_idp_runtime_metadata_signing_unavailable');
  }

  for (const spEntityId of spEntityIds) {
    if (!env.SAML_RUNTIME_PORTS.serviceProviders.isAllowed({ tenantId, entityId: spEntityId })) {
      throw new Error('saml_idp_runtime_provider_not_allowed');
    }
    const config = await getSPConfig(env, tenantId, spEntityId);
    if (!config || config.entityId !== spEntityId) {
      throw new Error('saml_idp_runtime_provider_unavailable');
    }
    if (config.attributeReleaseConsent?.enabled) {
      // The first alternate runtime has no consent UI.
      throw new Error('saml_idp_runtime_provider_policy_unsupported');
    }
    const mapping = await resolveSAMLRuntimeIdentityMapping(
      env,
      tenantId,
      entityIds.idpEntityId,
      config
    );
    const release = env.SAML_RUNTIME_PORTS.serviceProviders.getRelease({
      tenantId,
      entityId: spEntityId,
    });
    if (!mapping || !release) throw new Error('saml_idp_runtime_imported_release_unavailable');
    const binding = resolveSAMLIdentityMappingFieldMappingBinding(mapping, {
      role: 'idp',
      tenantId,
      localEntityId: entityIds.idpEntityId,
      partnerEntityId: spEntityId,
    });
    assertRuntimeIdentityMappingReleaseSafety(binding, release.destinationProfile.fields, false, {
      requireKnownSources: true,
    });
    const availableFields = new Set(release.destinationProfile.fields.map((field) => field.key));
    if (
      Object.keys(mapping.destinationFieldPolicies ?? {}).some((name) => !availableFields.has(name))
    ) {
      throw new Error('saml_idp_runtime_destination_policy_invalid');
    }
    const core = await resolveAuthCorePersistenceAdapterFromEnv(env, 'saml-idp-readiness', {
      tenantId,
    });
    // The current PostgreSQL Core subset has no tenant_consent_requirements table.
    // Requiring source trust explicitly prevents a missing policy table from being read as
    // absence of a consent requirement by the unchanged protocol handler.
    const trust = await core.queryOne<{
      trusted: number;
      skip_authorization_consent: number;
    }>(
      `SELECT trusted, skip_authorization_consent FROM client_trust_policies
       WHERE tenant_id = ? AND target_type = 'saml_sp' AND target_id = ?
         AND is_active = 1 LIMIT 1`,
      [tenantId, spEntityId]
    );
    if (!trust || (!Number(trust.trusted) && !Number(trust.skip_authorization_consent))) {
      throw new Error('saml_idp_runtime_consent_policy_unsupported');
    }
    // Resolve the exact active key policy used for this SP. An imported default key is
    // insufficient when the provider has a dedicated signing key reference.
    await getSAMLIdPSigningMaterial(env, {
      tenantId,
      counterpartyEntityId: spEntityId,
      providerPolicy: config.signingKeyPolicy,
    });
  }
}
