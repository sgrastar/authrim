import type { DatabaseAdapter } from '../db/adapter';

export type DestinationProfileConsentType = 'oidc' | 'saml';
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

const OIDC_PROTOCOL_ENVELOPE_CLAIMS = new Set([
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

export class DestinationProfileReleaseValidationError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'destination_profile_unavailable'
      | 'destination_profile_type_mismatch'
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
  for (const field of applicableFields) {
    const hasValue = Object.prototype.hasOwnProperty.call(filtered, field.key);
    if (field.required && !hasValue) {
      throw new DestinationProfileReleaseValidationError(
        `Required OIDC destination claim is missing: ${field.key}`,
        'required_field_missing',
        field.key
      );
    }
    if (hasValue && !field.nullable && filtered[field.key] == null) {
      throw new DestinationProfileReleaseValidationError(
        `OIDC destination claim must not be null: ${field.key}`,
        'non_nullable_field_null',
        field.key
      );
    }
  }

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

export async function filterSamlAttributesByDestinationConsent<T extends { name: string }>(input: {
  coreAdapter: DatabaseAdapter;
  adminAdapter: DatabaseAdapter;
  tenantId: string;
  subjectId: string;
  samlSpId: string;
  profileId: string;
  fieldPolicies?: DestinationFieldReleasePolicies;
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

  const profileFields = new Set(descriptor.fields.map((field) => field.key));
  const visibleAttributes = input.attributes.filter(
    (attribute) =>
      profileFields.has(attribute.name) && input.fieldPolicies?.[attribute.name] !== 'hidden'
  );
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
