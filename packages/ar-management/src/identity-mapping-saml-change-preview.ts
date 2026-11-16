import {
  createAuthContextFromHono,
  getTenantIdFromContext,
  resolveAuthCorePersistenceAdapterFromEnv,
  type MappingSetReferenceScan,
} from '@authrim/ar-lib-core';
import { releasePoints, type ClaimChange } from './identity-mapping-content-diff';
import { isRecord, type AdminContext } from './identity-mapping-control-plane';

/** Shared-set references are authoritative; policies decide which changed outputs an SP sees. */
export async function samlChangePreview(
  c: AdminContext,
  scan: MappingSetReferenceScan,
  changes: ClaimChange[],
  tenantId: string | undefined
) {
  const requestCache = new Map();
  const providers = scan.references.filter(
    (reference) =>
      reference.kind === 'saml_provider' &&
      reference.providerType === 'saml_sp' &&
      (tenantId === undefined || reference.tenantId === tenantId)
  );
  // Federation sources can resolve SPs that have no persisted identity_providers row. Until
  // those entities can be enumerated, their reference is explicit and usage is incomplete.
  const unresolvedSpReferences = scan.references
    .filter(
      (reference) =>
        reference.kind === 'federation_trust_source' &&
        reference.federationRole === 'saml_sp' &&
        (tenantId === undefined || reference.tenantId === tenantId)
    )
    .map((reference) => ({
      tenant_id: reference.tenantId ?? null,
      trust_source_id: reference.trustSourceId ?? null,
      reason: 'federation_entities_not_enumerated',
    }));
  const sps: Array<{
    tenant_id: string;
    provider_id: string;
    sp_entity_id: string | null;
    name: string;
    changes: ClaimChange[];
    held_back: Array<{ attribute: string; reason: string }>;
    pinned_version_id: string | null;
  }> = [];
  for (const reference of providers) {
    if (!reference.tenantId || !reference.providerId) continue;
    const core =
      reference.tenantId === getTenantIdFromContext(c)
        ? createAuthContextFromHono(c, reference.tenantId).coreAdapter
        : await resolveAuthCorePersistenceAdapterFromEnv(c.env, 'saml-change-preview', {
            tenantId: reference.tenantId,
            requestCache,
            sideEffects: 'none',
          });
    const row = await core.queryOne<{ name: string; config_json: string }>(
      'SELECT name, config_json FROM identity_providers WHERE tenant_id = ? AND id = ? AND provider_type = ?',
      [reference.tenantId, reference.providerId, 'saml_sp']
    );
    if (!row) throw new Error('saml_reference_changed');
    const config: unknown = JSON.parse(row.config_json);
    const mapping =
      isRecord(config) && isRecord(config.identityMapping) ? config.identityMapping : {};
    const policies = isRecord(mapping.destinationFieldPolicies)
      ? mapping.destinationFieldPolicies
      : {};
    const visible: ClaimChange[] = [];
    const heldBack: Array<{ attribute: string; reason: string }> = [];
    for (const change of changes) {
      if (reference.pinnedVersionId) {
        heldBack.push({ attribute: change.claim, reason: 'pinned_version' });
        continue;
      }
      if (change.kind === 'validation_changed') {
        if (change.validation_effect === 'may_reject') visible.push(change);
        continue;
      }
      const points = releasePoints(change);
      const reaches = [points.before, points.after].some(
        (point) =>
          point &&
          (point.namespace === 'saml.nameid' ||
            (point.namespace === (mapping.destinationNamespace ?? 'saml.attribute') &&
              Object.hasOwn(policies, point.claim) &&
              policies[point.claim] !== 'hidden'))
      );
      if (reaches) visible.push(change);
      else heldBack.push({ attribute: change.claim, reason: 'hidden_or_not_listed' });
    }
    sps.push({
      tenant_id: reference.tenantId,
      provider_id: reference.providerId,
      sp_entity_id: reference.entityId ?? null,
      name: row.name,
      changes: visible,
      held_back: heldBack,
      pinned_version_id: reference.pinnedVersionId ?? null,
    });
  }
  return {
    sps,
    sps_truncated: scan.truncated,
    unresolved_sp_references: unresolvedSpReferences,
    usage_complete:
      scan.unscanned.length === 0 && !scan.truncated && unresolvedSpReferences.length === 0,
    tenants:
      tenantId === undefined
        ? [...new Set(sps.map((sp) => sp.tenant_id))].map((id) => ({
            tenant_id: id,
            sps_using: sps.filter((sp) => sp.tenant_id === id).length,
            sps_changed: sps.filter((sp) => sp.tenant_id === id && sp.changes.length > 0).length,
          }))
        : [],
  };
}
