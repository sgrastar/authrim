import type { DatabaseAdapter } from '../db/adapter';
import { STANDARD_CLAIMS } from '../constants';
import {
  assertRuntimeIdentityMappingReleaseSafety,
  type RuntimeIdentityMappingBinding,
} from './identity-mapping-runtime-resolver';

export type DestinationProfileConsentType = 'oidc' | 'saml' | 'resource_server';
export type DestinationFieldReleaseMode = 'required' | 'optional' | 'hidden';
export type DestinationFieldReleasePolicies = Record<string, DestinationFieldReleaseMode>;

export interface DestinationProfileConsentField {
  key: string;
  label: string;
  required: boolean;
  nullable: boolean;
  classification: string;
  surfaces: string[];
  requiredScopes: string[];
  valueType: string | null;
  valueMultiplicity: 'single' | 'multi' | null;
  allowedValues: string[];
}

export interface DestinationProfileConsentDescriptor {
  profileId: string;
  profileVersionId: string;
  destinationType: DestinationProfileConsentType;
  fields: DestinationProfileConsentField[];
}

interface DestinationProfileRow {
  profile_id: string;
  destination_type: string;
  version_id: string;
  schema_json: string;
  matching_profile_count?: number;
}

interface DestinationFieldConsentRow {
  id: string;
  released_claims_json: unknown;
  released_attributes_json: unknown;
  evidence_json: unknown;
  created_at: number;
}

interface SelectedDestinationFields {
  recordId: string;
  fields: Set<string>;
  evidence: Record<string, unknown>;
  createdAt: number;
}

export const OIDC_PROTOCOL_ENVELOPE_CLAIMS = new Set([
  'iss',
  'aud',
  'exp',
  'iat',
  'nbf',
  'jti',
  'azp',
  'nonce',
  'auth_time',
  'acr',
  'amr',
  'sid',
  'at_hash',
  'c_hash',
  's_hash',
  'cnf',
  'ds_hash',
]);

const OIDC_STANDARD_CLAIMS = new Set<string>(Object.values(STANDARD_CLAIMS));

export const INTROSPECTION_PROTOCOL_ENVELOPE_CLAIMS = new Set([
  'active',
  'scope',
  'client_id',
  'username',
  'token_type',
  'exp',
  'iat',
  'nbf',
  'sub',
  'aud',
  'iss',
  'jti',
  'cnf',
  'act',
  'resource',
  'authorization_details',
]);

/**
 * Claims whose value is owned by the authorization server and must not be supplied by identity
 * mapping output. OIDC `sub` is intentionally absent because pairwise and persistent subject
 * mapping is a supported feature. Introspection `sub` has the same identifier-mapping exception.
 */
export function isProtectedIdentityMappingDestinationClaim(
  namespace: string,
  path: string
): boolean {
  if (namespace === 'introspection.claim') {
    return path !== 'sub' && INTROSPECTION_PROTOCOL_ENVELOPE_CLAIMS.has(path);
  }
  // Runtime mapping flattens the destination value to a top-level OIDC claim key.
  // A tenant-configured namespace must not make the key less protected than the
  // namespace-independent consent filter that runs afterwards.
  return OIDC_PROTOCOL_ENVELOPE_CLAIMS.has(path);
}

export function filterOidcClaimsWithoutDestinationProfile(
  claims: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(claims).filter(
      ([key]) =>
        OIDC_PROTOCOL_ENVELOPE_CLAIMS.has(key) ||
        OIDC_STANDARD_CLAIMS.has(key) ||
        key.startsWith('::')
    )
  );
}

export function filterIntrospectionProtocolEnvelopeClaims(
  claims: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(claims).filter(([key]) => INTROSPECTION_PROTOCOL_ENVELOPE_CLAIMS.has(key))
  );
}

export class DestinationProfileReleaseValidationError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'destination_profile_unavailable'
      | 'destination_profile_type_mismatch'
      | 'destination_profile_ambiguous'
      | 'required_field_missing'
      | 'non_nullable_field_null'
      | 'invalid_field_value',
    readonly field?: string
  ) {
    super(message);
    this.name = 'DestinationProfileReleaseValidationError';
  }
}

export async function loadDestinationProfileConsentDescriptor(
  adminAdapter: DatabaseAdapter,
  tenantId: string,
  profileId: string
): Promise<DestinationProfileConsentDescriptor | null> {
  const row = await adminAdapter.queryOne<DestinationProfileRow>(
    `SELECT p.id AS profile_id, p.destination_type, v.id AS version_id, v.schema_json
       FROM destination_profiles p
       JOIN destination_profile_versions v
         ON v.id = p.active_version_id
        AND v.profile_id = p.id
        AND v.tenant_id = p.tenant_id
      WHERE p.id = ?
        AND p.tenant_id IN (?, 'platform')
        AND p.lifecycle_state = 'active'
        AND v.lifecycle_state = 'active'
      LIMIT 1`,
    [profileId, tenantId]
  );
  if (!row || (row.destination_type !== 'oidc' && row.destination_type !== 'saml')) {
    return null;
  }

  const schema = parseJsonRecord(row.schema_json);
  const fields =
    row.destination_type === 'oidc' ? readOidcConsentFields(schema) : readSamlConsentFields(schema);
  return {
    profileId: row.profile_id,
    profileVersionId: row.version_id,
    destinationType: row.destination_type,
    fields,
  };
}

export async function filterOidcClaimsByDestinationConsent(input: {
  coreAdapter: DatabaseAdapter;
  adminAdapter: DatabaseAdapter;
  tenantId: string;
  subjectId: string;
  clientId: string;
  profileId: string;
  surface?: 'id_token' | 'userinfo';
  grantedScopes?: string[];
  claims: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const descriptor = await loadDestinationProfileConsentDescriptor(
    input.adminAdapter,
    input.tenantId,
    input.profileId
  );
  if (!descriptor) {
    throw new DestinationProfileReleaseValidationError(
      'OIDC destination profile is unavailable',
      'destination_profile_unavailable'
    );
  }
  if (descriptor.destinationType !== 'oidc') {
    throw new DestinationProfileReleaseValidationError(
      'Destination profile is not an OIDC profile',
      'destination_profile_type_mismatch'
    );
  }

  const grantedScopes = input.grantedScopes ? new Set(input.grantedScopes) : null;
  const applicableFields = descriptor.fields.filter((field) => {
    // `sub` is an OIDC protocol invariant. Legacy profiles may still carry narrower
    // surface or scope metadata, but runtime release must never make it conditional.
    if (field.key === 'sub') return true;
    if (input.surface && field.surfaces.length > 0 && !field.surfaces.includes(input.surface)) {
      return false;
    }
    return (
      grantedScopes === null ||
      field.requiredScopes.length === 0 ||
      field.requiredScopes.some((scope) => grantedScopes.has(scope))
    );
  });
  const profileFields = new Map(applicableFields.map((field) => [field.key, field]));
  const filtered = Object.fromEntries(
    Object.entries(input.claims).filter(
      ([key]) => OIDC_PROTOCOL_ENVELOPE_CLAIMS.has(key) || profileFields.has(key)
    )
  );
  if (typeof filtered.sub !== 'string' || filtered.sub.length === 0) {
    throw new DestinationProfileReleaseValidationError(
      'OIDC destination subject claim must be a non-empty string',
      Object.prototype.hasOwnProperty.call(filtered, 'sub')
        ? 'invalid_field_value'
        : 'required_field_missing',
      'sub'
    );
  }
  validateReleasedDestinationFields(applicableFields, filtered, 'OIDC');

  const selected = await loadSelectedDestinationFields({
    coreAdapter: input.coreAdapter,
    tenantId: input.tenantId,
    subjectId: input.subjectId,
    protocol: 'oidc',
    recipientType: 'oidc_client',
    recipientId: input.clientId,
    profileId: descriptor.profileId,
    profileVersionId: descriptor.profileVersionId,
    jsonColumn: 'released_claims_json',
  });
  if (!selected) {
    for (const field of applicableFields) {
      if (!field.required) delete filtered[field.key];
    }
    return filtered;
  }

  for (const field of applicableFields) {
    if (!field.required && !selected.fields.has(field.key)) {
      delete filtered[field.key];
    }
  }
  return filtered;
}

/**
 * Apply the active profile owned by the authenticated Resource Server.
 * Protocol envelope fields stay available; any mapped extension claim is fail-closed
 * unless the client has an active profile that explicitly lists it.
 */
export async function filterIntrospectionClaimsByResourceServerProfile(input: {
  adminAdapter: DatabaseAdapter;
  tenantId: string;
  resourceServerId: string;
  profileId?: string;
  grantedScopes: string[];
  claims: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const descriptor = await loadResourceServerDestinationProfileDescriptor(
    input.adminAdapter,
    input.tenantId,
    input.resourceServerId,
    input.profileId
  );
  const envelope = filterIntrospectionProtocolEnvelopeClaims(input.claims);
  if (!descriptor) return envelope;

  const fields = descriptor.fields;
  const grantedScopes = new Set(input.grantedScopes);
  const allowed = new Map(
    fields
      .filter(
        (field) =>
          field.key === 'active' ||
          field.requiredScopes.length === 0 ||
          field.requiredScopes.some((scope) => grantedScopes.has(scope))
      )
      .map((field) => [field.key, field])
  );
  const filtered = Object.fromEntries(
    Object.entries(input.claims).filter(
      ([key]) => INTROSPECTION_PROTOCOL_ENVELOPE_CLAIMS.has(key) || allowed.has(key)
    )
  );
  if (filtered.active !== true) {
    throw new DestinationProfileReleaseValidationError(
      'Introspection active claim must remain true for an active token',
      'invalid_field_value',
      'active'
    );
  }
  validateReleasedDestinationFields(allowed.values(), filtered, 'Resource Server');
  return filtered;
}

export async function loadResourceServerDestinationProfileDescriptor(
  adminAdapter: DatabaseAdapter,
  tenantId: string,
  resourceServerId: string,
  profileId?: string
): Promise<DestinationProfileConsentDescriptor | null> {
  const profileIds = profileId ? destinationProfileReferenceCandidates(profileId) : [];
  const profileFilter =
    profileIds.length > 0 ? `AND p.id IN (${profileIds.map(() => '?').join(', ')})` : '';
  const row = await adminAdapter.queryOne<DestinationProfileRow>(
    `SELECT p.id AS profile_id, p.destination_type, v.id AS version_id, v.schema_json,
            COUNT(*) OVER () AS matching_profile_count
       FROM destination_profiles p
       JOIN destination_profile_versions v
         ON v.id = p.active_version_id
        AND v.profile_id = p.id
        AND v.tenant_id = p.tenant_id
      WHERE p.tenant_id = ?
        AND p.destination_type = 'resource_server'
        AND p.owner_scope_type = 'client'
        AND p.owner_scope_id = ?
        ${profileFilter}
        AND p.lifecycle_state = 'active'
        AND v.lifecycle_state = 'active'
      ORDER BY p.updated_at DESC
      LIMIT 1`,
    [tenantId, resourceServerId, ...profileIds]
  );
  if ((row?.matching_profile_count ?? 1) > 1) {
    throw new DestinationProfileReleaseValidationError(
      'Multiple active Resource Server destination profiles match the authenticated client',
      'destination_profile_ambiguous'
    );
  }
  if (!row || row.destination_type !== 'resource_server') return null;
  return {
    profileId: row.profile_id,
    profileVersionId: row.version_id,
    destinationType: 'resource_server',
    fields: readResourceServerFields(parseJsonRecord(row.schema_json)),
  };
}

export async function filterSamlAttributesByDestinationConsent<T extends { name: string }>(input: {
  coreAdapter: DatabaseAdapter;
  adminAdapter: DatabaseAdapter;
  tenantId: string;
  subjectId: string;
  samlSpId: string;
  profileId: string;
  fieldPolicies?: DestinationFieldReleasePolicies;
  releaseSafetyBinding?: Pick<RuntimeIdentityMappingBinding, 'catalog' | 'edges'>;
  attributes: T[];
}): Promise<T[]> {
  return (await filterSamlAttributesByDestinationConsentWithStatus(input)).attributes;
}

export async function filterSamlAttributesByDestinationConsentWithStatus<
  T extends { name: string },
>(input: {
  coreAdapter: DatabaseAdapter;
  adminAdapter: DatabaseAdapter;
  tenantId: string;
  subjectId: string;
  samlSpId: string;
  profileId: string;
  fieldPolicies?: DestinationFieldReleasePolicies;
  releaseSafetyBinding?: Pick<RuntimeIdentityMappingBinding, 'catalog' | 'edges'>;
  attributes: T[];
}): Promise<{
  attributes: T[];
  consentApplied: boolean;
  consentRecordId?: string;
  consentEvidence?: Record<string, unknown>;
  consentCreatedAt?: number;
}> {
  const descriptor = await loadDestinationProfileConsentDescriptor(
    input.adminAdapter,
    input.tenantId,
    input.profileId
  );
  if (!descriptor) {
    throw new DestinationProfileReleaseValidationError(
      'SAML destination profile is unavailable',
      'destination_profile_unavailable'
    );
  }
  if (descriptor.destinationType !== 'saml') {
    throw new DestinationProfileReleaseValidationError(
      'Destination profile is not a SAML profile',
      'destination_profile_type_mismatch'
    );
  }
  if (input.releaseSafetyBinding) {
    assertRuntimeIdentityMappingReleaseSafety(input.releaseSafetyBinding, descriptor.fields, false);
  }

  const profileFields = new Set(descriptor.fields.map((field) => field.key));
  const visibleAttributes = input.attributes.filter(
    (attribute) =>
      profileFields.has(attribute.name) && input.fieldPolicies?.[attribute.name] !== 'hidden'
  );
  validateReleasedSamlAttributes(descriptor.fields, visibleAttributes);
  const releasedAttributeNames = new Set(visibleAttributes.map((attribute) => attribute.name));
  const missingRequired = Object.entries(input.fieldPolicies ?? {}).find(
    ([name, mode]) => mode === 'required' && !releasedAttributeNames.has(name)
  );
  if (missingRequired) {
    throw new DestinationProfileReleaseValidationError(
      `Required SAML destination attribute is missing: ${missingRequired[0]}`,
      'required_field_missing',
      missingRequired[0]
    );
  }

  const selected = await loadSelectedDestinationFields({
    coreAdapter: input.coreAdapter,
    tenantId: input.tenantId,
    subjectId: input.subjectId,
    protocol: 'saml',
    recipientType: 'saml_sp',
    recipientId: input.samlSpId,
    profileId: descriptor.profileId,
    profileVersionId: descriptor.profileVersionId,
    consentVersion: resolveDestinationProfileConsentVersion(
      descriptor.profileVersionId,
      input.fieldPolicies
    ),
    jsonColumn: 'released_attributes_json',
  });
  const required = new Set(
    Object.entries(input.fieldPolicies ?? {})
      .filter(([, mode]) => mode === 'required')
      .map(([key]) => key)
  );
  if (!selected) {
    return {
      attributes: visibleAttributes.filter((attribute) => required.has(attribute.name)),
      consentApplied: false,
    };
  }
  return {
    attributes: visibleAttributes.filter(
      (attribute) => required.has(attribute.name) || selected.fields.has(attribute.name)
    ),
    consentApplied: true,
    consentRecordId: selected.recordId,
    consentEvidence: selected.evidence,
    consentCreatedAt: selected.createdAt,
  };
}

async function loadSelectedDestinationFields(input: {
  coreAdapter: DatabaseAdapter;
  tenantId: string;
  subjectId: string;
  protocol: DestinationProfileConsentType;
  recipientType: 'oidc_client' | 'saml_sp';
  recipientId: string;
  profileId: string;
  profileVersionId: string;
  consentVersion?: string;
  jsonColumn: 'released_claims_json' | 'released_attributes_json';
}): Promise<SelectedDestinationFields | null> {
  const row = await input.coreAdapter.queryOne<DestinationFieldConsentRow>(
    `SELECT id, released_claims_json, released_attributes_json, evidence_json, created_at
       FROM consent_records
      WHERE tenant_id = ?
        AND subject_user_id = ?
        AND protocol = ?
        AND recipient_type = ?
        AND recipient_id = ?
        AND binding_type = 'destination_field_mapping_set'
        AND binding_key = ?
        AND statement_id = ?
        AND statement_version = ?
        AND decision IN ('accepted', 'selected', 'once', 'always')
        AND status = 'active'
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC
      LIMIT 1`,
    [
      input.tenantId,
      input.subjectId,
      input.protocol,
      input.recipientType,
      input.recipientId,
      input.profileId,
      `destination_profile:${input.profileId}`,
      input.consentVersion ?? input.profileVersionId,
      Math.floor(Date.now() / 1000),
    ]
  );
  if (!row) return null;
  return {
    recordId: row.id,
    fields: new Set(parseJsonStringArray(row[input.jsonColumn])),
    evidence: parseJsonRecord(row.evidence_json),
    createdAt: row.created_at,
  };
}

function readOidcConsentFields(schema: Record<string, unknown>): DestinationProfileConsentField[] {
  if (!Array.isArray(schema.claims)) return [];
  return schema.claims.flatMap((value) => {
    if (!isRecord(value)) return [];
    const key = readString(value.claimName);
    if (!key) return [];
    return [
      {
        key,
        label: readString(value.label) ?? key,
        required: value.required === true || key === 'sub',
        nullable: value.nullable === true,
        classification: readString(value.classification) ?? 'internal',
        surfaces: readStringArray(value.surfaces),
        requiredScopes: readStringArray(value.requiredScopes),
        valueType: readString(value.valueType),
        valueMultiplicity: readValueMultiplicity(value.valueMultiplicity),
        allowedValues: readStringArray(value.allowedValues),
      },
    ];
  });
}

function readResourceServerFields(
  schema: Record<string, unknown>
): DestinationProfileConsentField[] {
  if (!Array.isArray(schema.claims)) return [];
  return schema.claims.flatMap((value) => {
    if (!isRecord(value)) return [];
    const key = readString(value.claimName);
    if (!key) return [];
    return [
      {
        key,
        label: readString(value.label) ?? key,
        required: value.required === true || key === 'active',
        nullable: value.nullable === true,
        classification: readString(value.classification) ?? 'internal',
        surfaces: ['introspection'],
        requiredScopes: readStringArray(value.requiredScopes),
        valueType: readString(value.valueType),
        valueMultiplicity: readValueMultiplicity(value.valueMultiplicity),
        allowedValues: readStringArray(value.allowedValues),
      },
    ];
  });
}

function readSamlConsentFields(schema: Record<string, unknown>): DestinationProfileConsentField[] {
  if (!Array.isArray(schema.attributes)) return [];
  return schema.attributes.flatMap((value) => {
    if (!isRecord(value)) return [];
    const key = readString(value.name);
    if (!key) return [];
    return [
      {
        key,
        label: readString(value.label) ?? readString(value.friendlyName) ?? key,
        required: false,
        nullable: value.nullable === true,
        classification: readString(value.classification) ?? 'internal',
        surfaces: ['saml_assertion'],
        requiredScopes: [],
        valueType: readString(value.valueType) ?? readString(value.type),
        valueMultiplicity: readValueMultiplicity(value.valueMultiplicity),
        allowedValues: readStringArray(value.allowedValues),
      },
    ];
  });
}

export function resolveDestinationProfileConsentVersion(
  profileVersionId: string,
  fieldPolicies?: DestinationFieldReleasePolicies
): string {
  const entries = Object.entries(fieldPolicies ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  if (entries.length === 0) return profileVersionId;
  const serialized = entries.map(([key, mode]) => `${key}\u0000${mode}`).join('\u0001');
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${profileVersionId}:sp-policy-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonStringArray(value: unknown): string[] {
  const parsed = (() => {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return [];
    try {
      const result: unknown = JSON.parse(value);
      return Array.isArray(result) ? result : [];
    } catch {
      return [];
    }
  })();
  return parsed
    .map(String)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readValueMultiplicity(value: unknown): 'single' | 'multi' | null {
  return value === 'single' || value === 'multi' ? value : null;
}

function validateReleasedDestinationFields(
  fields: Iterable<DestinationProfileConsentField>,
  claims: Record<string, unknown>,
  destinationLabel: string
): void {
  for (const field of fields) {
    const hasValue = Object.prototype.hasOwnProperty.call(claims, field.key);
    if (field.required && !hasValue) {
      throw new DestinationProfileReleaseValidationError(
        `Required ${destinationLabel} destination claim is missing: ${field.key}`,
        'required_field_missing',
        field.key
      );
    }
    if (!hasValue) continue;
    const value = claims[field.key];
    if (!field.nullable && value == null) {
      throw new DestinationProfileReleaseValidationError(
        `${destinationLabel} destination claim must not be null: ${field.key}`,
        'non_nullable_field_null',
        field.key
      );
    }
    if (value == null) continue;
    if (
      field.valueMultiplicity &&
      !matchesDestinationMultiplicity(field.valueMultiplicity, value)
    ) {
      throw invalidDestinationFieldValue(destinationLabel, field.key, 'multiplicity');
    }
    const values = field.valueMultiplicity === 'multi' ? (value as unknown[]) : [value];
    const valueType = field.valueType;
    if (valueType && values.some((item) => !matchesDestinationValueType(valueType, item))) {
      throw invalidDestinationFieldValue(destinationLabel, field.key, 'type');
    }
    if (
      field.allowedValues.length > 0 &&
      values.some((item) => !field.allowedValues.includes(String(item)))
    ) {
      throw invalidDestinationFieldValue(destinationLabel, field.key, 'allowed values');
    }
  }
}

function validateReleasedSamlAttributes<T extends { name: string }>(
  fields: DestinationProfileConsentField[],
  attributes: T[]
): void {
  const fieldByName = new Map(fields.map((field) => [field.key, field]));
  for (const attribute of attributes) {
    const field = fieldByName.get(attribute.name);
    if (!field || !isRecord(attribute)) continue;
    const attributeRecord: Record<string, unknown> = attribute;
    const rawValue = Array.isArray(attributeRecord.values)
      ? attributeRecord.values
      : Object.prototype.hasOwnProperty.call(attributeRecord, 'value')
        ? attributeRecord.value
        : undefined;
    if (rawValue === undefined) continue;
    const hasMultipleValueRepresentation = Array.isArray(rawValue);
    const logicalValues = hasMultipleValueRepresentation ? rawValue : [rawValue];
    if (field.valueMultiplicity === 'multi' && !hasMultipleValueRepresentation) {
      throw invalidDestinationFieldValue('SAML', field.key, 'multiplicity');
    }
    if (field.valueMultiplicity === 'single' && logicalValues.length > 1) {
      throw invalidDestinationFieldValue('SAML', field.key, 'multiplicity');
    }
    if (!field.nullable && logicalValues.some((value) => value == null)) {
      throw new DestinationProfileReleaseValidationError(
        `SAML destination attribute must not be null: ${field.key}`,
        'non_nullable_field_null',
        field.key
      );
    }
    const valueType = field.valueType;
    if (
      valueType &&
      logicalValues.some((value) => !matchesDestinationValueType(valueType, value))
    ) {
      throw invalidDestinationFieldValue('SAML', field.key, 'type');
    }
    if (
      field.allowedValues.length > 0 &&
      logicalValues.some((value) => !field.allowedValues.includes(String(value)))
    ) {
      throw invalidDestinationFieldValue('SAML', field.key, 'allowed values');
    }
  }
}

function matchesDestinationMultiplicity(multiplicity: 'single' | 'multi', value: unknown): boolean {
  return multiplicity === 'multi' ? Array.isArray(value) : !Array.isArray(value);
}

function matchesDestinationValueType(valueType: string, value: unknown): boolean {
  switch (valueType) {
    case 'string':
    case 'email':
    case 'phone':
    case 'uri':
    case 'url':
    case 'date':
    case 'datetime':
    case 'identifier':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'json':
      return isJsonValue(value);
    default:
      return true;
  }
}

function isJsonValue(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function invalidDestinationFieldValue(
  destinationLabel: string,
  field: string,
  constraint: string
): DestinationProfileReleaseValidationError {
  return new DestinationProfileReleaseValidationError(
    `${destinationLabel} destination claim violates configured ${constraint}: ${field}`,
    'invalid_field_value',
    field
  );
}

function destinationProfileReferenceCandidates(profileId: string): string[] {
  const candidates = new Set([profileId]);
  if (profileId.startsWith('destination-profile-')) {
    candidates.add(profileId.slice('destination-profile-'.length));
  }
  return [...candidates];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map(String)
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
