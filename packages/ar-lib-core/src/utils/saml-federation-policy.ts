/**
 * SAML federation source policy: the parts of a trust source's `protocol_payload_json` that decide
 * whether an entity of its verified aggregate may take part at runtime, and how a user picks one
 * of its IdPs. Shared by ar-saml (resolution, login start, inventory) and ar-management (admin
 * reads, the login screen's sign-in options) so every reader applies the same rules.
 *
 * Deny wins: an entity on the exception list is refused before any registration-authority or
 * entity-category rule is looked at.
 */
import type {
  SAMLAttributePresetId,
  SAMLFederationExceptions,
  SAMLFederationIdPSelection,
  SAMLFederationRuntimeResolutionPolicy,
} from '../types/saml';
import {
  SAML_FEDERATION_DEFAULT_IDP_SELECTION,
  SAML_FEDERATION_MAX_ENTITY_ID_LENGTH,
  SAML_FEDERATION_MAX_EXCLUDED_ENTITY_IDS,
} from '../types/saml';

export type SAMLFederationRuntimeRole = 'saml_idp' | 'saml_sp';

export interface SAMLFederationPolicyEvaluation {
  allowed: boolean;
  /** Why the entity was refused; absent when allowed. */
  reason?: 'excluded' | 'registration_authority' | 'entity_category' | 'preset_conflict';
  attributePresetId?: SAMLAttributePresetId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parsePayload(
  protocolPayloadJson: string | null | undefined
): Record<string, unknown> | null {
  if (!protocolPayloadJson) return null;
  try {
    const payload = JSON.parse(protocolPayloadJson) as unknown;
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

export function isSAMLAttributePresetId(value: unknown): value is SAMLAttributePresetId {
  return (
    value === 'basic.v1' ||
    value === 'academic_publisher.v1' ||
    value === 'enterprise_saas.v1' ||
    value === 'research_federation.v1'
  );
}

/**
 * The exception list of a payload, normalised (trimmed, de-duplicated, capped). Entries that are
 * not strings or are too long are dropped rather than failing the whole policy: an unreadable
 * exception must never widen what the source resolves, and the valid ones still apply.
 */
export function parseFederationExceptions(
  payload: Record<string, unknown> | string | null | undefined
): SAMLFederationExceptions {
  const record = typeof payload === 'string' ? parsePayload(payload) : (payload ?? null);
  const exceptions = record?.exceptions;
  if (!isRecord(exceptions) || !Array.isArray(exceptions.excludedEntityIds)) {
    return { excludedEntityIds: [] };
  }
  const seen = new Set<string>();
  for (const item of exceptions.excludedEntityIds) {
    if (typeof item !== 'string') continue;
    const entityId = item.trim();
    if (!entityId || entityId.length > SAML_FEDERATION_MAX_ENTITY_ID_LENGTH) continue;
    seen.add(entityId);
    if (seen.size >= SAML_FEDERATION_MAX_EXCLUDED_ENTITY_IDS) break;
  }
  return { excludedEntityIds: [...seen] };
}

export function isFederationEntityExcluded(
  policy: Pick<SAMLFederationRuntimeResolutionPolicy, 'excludedEntityIds'>,
  entityId: string
): boolean {
  return policy.excludedEntityIds?.includes(entityId) ?? false;
}

/** The IdP selection mode of a payload; the default (Authrim's own search) when absent or unreadable. */
export function parseFederationIdPSelection(
  payload: Record<string, unknown> | string | null | undefined
): SAMLFederationIdPSelection {
  const record = typeof payload === 'string' ? parsePayload(payload) : (payload ?? null);
  const selection = record?.idpSelection;
  if (!isRecord(selection)) return { ...SAML_FEDERATION_DEFAULT_IDP_SELECTION };
  if (selection.mode === 'external_ds') {
    const url =
      typeof selection.discoveryServiceUrl === 'string' ? selection.discoveryServiceUrl : '';
    // A Discovery Service without an address cannot be used; fall back to the search rather than
    // sending users nowhere.
    if (!/^https:\/\//iu.test(url)) return { ...SAML_FEDERATION_DEFAULT_IDP_SELECTION };
    return { mode: 'external_ds', discoveryServiceUrl: url };
  }
  return { ...SAML_FEDERATION_DEFAULT_IDP_SELECTION };
}

function parseFederationEntityCategoryPolicy(
  input: unknown
): SAMLFederationRuntimeResolutionPolicy['entityCategoryPolicy'] | null | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) return null;
  if (input.defaultDecision !== 'allow' && input.defaultDecision !== 'deny') return null;
  if (!Array.isArray(input.rules)) return null;
  const rules: NonNullable<SAMLFederationRuntimeResolutionPolicy['entityCategoryPolicy']>['rules'] =
    [];
  const seenCategories = new Set<string>();
  for (const item of input.rules) {
    if (!isRecord(item)) return null;
    if (
      typeof item.entityCategory !== 'string' ||
      !item.entityCategory ||
      (item.decision !== 'allow' && item.decision !== 'deny') ||
      (item.attributePresetId !== undefined && !isSAMLAttributePresetId(item.attributePresetId))
    ) {
      return null;
    }
    if (seenCategories.has(item.entityCategory)) return null;
    seenCategories.add(item.entityCategory);
    const decision: 'allow' | 'deny' = item.decision;
    rules.push({
      entityCategory: item.entityCategory,
      decision,
      ...(isSAMLAttributePresetId(item.attributePresetId)
        ? { attributePresetId: item.attributePresetId }
        : {}),
    });
  }
  return { defaultDecision: input.defaultDecision, rules };
}

/**
 * The runtime policy of a source, or null when the source must not resolve anything: the payload
 * is unreadable, the polling state says the aggregate expired, or `acceptedValidUntil` has passed.
 * The exception list is merged in from `payload.exceptions`.
 */
export function parseFederationRuntimeResolutionPolicy(
  protocolPayloadJson: string | null | undefined,
  now: number = Date.now()
): SAMLFederationRuntimeResolutionPolicy | null {
  const payload = parsePayload(protocolPayloadJson);
  if (!payload) return null;
  const polling = payload.polling;
  if (isRecord(polling)) {
    if (polling.sourceState === 'expired') return null;
    const acceptedValidUntil = polling.acceptedValidUntil;
    if (acceptedValidUntil !== undefined) {
      const expiresAt =
        typeof acceptedValidUntil === 'string' ? Date.parse(acceptedValidUntil) : NaN;
      if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
    }
  }
  const value = payload.runtimeResolution;
  if (!isRecord(value)) return null;
  if (
    !Array.isArray(value.roles) ||
    value.roles.some((item) => item !== 'saml_idp' && item !== 'saml_sp') ||
    new Set(value.roles).size !== value.roles.length
  ) {
    return null;
  }
  const roles = value.roles as SAMLFederationRuntimeRole[];
  const mode = value.mode === 'automatic' ? 'automatic' : 'inventory_only';
  const entityCategoryPolicy = parseFederationEntityCategoryPolicy(value.entityCategoryPolicy);
  if (entityCategoryPolicy === null) return null;
  if (
    value.registrationAuthorities !== undefined &&
    (!Array.isArray(value.registrationAuthorities) ||
      value.registrationAuthorities.some((item) => typeof item !== 'string' || item.length === 0))
  ) {
    return null;
  }
  const { excludedEntityIds } = parseFederationExceptions(payload);
  return {
    mode,
    roles,
    ...(typeof value.priority === 'number' && Number.isInteger(value.priority)
      ? { priority: value.priority }
      : {}),
    ...(typeof value.idpFieldMappingSetId === 'string' && value.idpFieldMappingSetId
      ? { idpFieldMappingSetId: value.idpFieldMappingSetId }
      : {}),
    ...(typeof value.spFieldMappingSetId === 'string' && value.spFieldMappingSetId
      ? { spFieldMappingSetId: value.spFieldMappingSetId }
      : {}),
    ...(isSAMLAttributePresetId(value.defaultAttributePresetId)
      ? { defaultAttributePresetId: value.defaultAttributePresetId }
      : {}),
    ...(Array.isArray(value.registrationAuthorities)
      ? {
          registrationAuthorities: value.registrationAuthorities.filter(
            (item): item is string => typeof item === 'string' && item.length > 0
          ),
        }
      : {}),
    ...(entityCategoryPolicy ? { entityCategoryPolicy } : {}),
    ...(excludedEntityIds.length > 0 ? { excludedEntityIds } : {}),
  };
}

/**
 * Whether one entity of a source may take part under the policy. Order: the exception list, then
 * the registration-authority allow-list, then entity-category rules (any deny refuses; allow rules
 * that disagree on the attribute preset refuse; otherwise the default decision).
 */
export function evaluateFederationRuntimePolicy(
  policy: SAMLFederationRuntimeResolutionPolicy,
  categories: string[],
  registrationAuthority: string | null,
  entityId: string
): SAMLFederationPolicyEvaluation {
  if (isFederationEntityExcluded(policy, entityId)) {
    return { allowed: false, reason: 'excluded' };
  }
  if (
    policy.registrationAuthorities?.length &&
    (!registrationAuthority || !policy.registrationAuthorities.includes(registrationAuthority))
  ) {
    return { allowed: false, reason: 'registration_authority' };
  }
  const categoryPolicy = policy.entityCategoryPolicy;
  if (!categoryPolicy) {
    return {
      allowed: true,
      ...(policy.defaultAttributePresetId
        ? { attributePresetId: policy.defaultAttributePresetId }
        : {}),
    };
  }
  const matching = categoryPolicy.rules.filter((rule) => categories.includes(rule.entityCategory));
  if (matching.some((rule) => rule.decision === 'deny')) {
    return { allowed: false, reason: 'entity_category' };
  }
  const allow = matching.filter((rule) => rule.decision === 'allow');
  const effectivePresets = new Set(
    allow
      .map((rule) => rule.attributePresetId ?? policy.defaultAttributePresetId)
      .filter((preset): preset is SAMLAttributePresetId => Boolean(preset))
  );
  if (effectivePresets.size > 1) return { allowed: false, reason: 'preset_conflict' };
  const allowed = allow.length > 0 || categoryPolicy.defaultDecision === 'allow';
  if (!allowed) return { allowed: false, reason: 'entity_category' };
  const attributePresetId = effectivePresets.values().next().value;
  return {
    allowed: true,
    ...(attributePresetId
      ? { attributePresetId }
      : policy.defaultAttributePresetId
        ? { attributePresetId: policy.defaultAttributePresetId }
        : {}),
  };
}

/**
 * Whether a source can serve a role right now: active runtime policy in automatic mode that names
 * the role and carries that role's mapping set. Lifecycle state and the active document are the
 * caller's SQL filters; this covers only what lives in the payload.
 */
export function isFederationSourceServable(
  protocolPayloadJson: string | null | undefined,
  role: SAMLFederationRuntimeRole,
  now: number = Date.now()
): boolean {
  const policy = parseFederationRuntimeResolutionPolicy(protocolPayloadJson, now);
  if (!policy || policy.mode !== 'automatic' || !policy.roles.includes(role)) return false;
  return Boolean(role === 'saml_idp' ? policy.idpFieldMappingSetId : policy.spFieldMappingSetId);
}
