import { ensureDatabaseAdapter } from '@authrim/ar-lib-core';
import type { Env } from '@authrim/ar-lib-core/types/env';
import { resolveRuntimeIdentityMappingBinding } from '@authrim/ar-lib-core/services/identity-mapping-runtime-resolver';
import type {
  FieldCatalogBundle,
  FieldCatalogEntry,
  MappingRuleEdge,
  SourceValueEnvelope,
} from '@authrim/ar-lib-field-mapping/contract';
import { executeRuntimeMapping } from '@authrim/ar-lib-field-mapping/runtime';
import {
  selectPrimaryScimObject,
  selectPrimaryScimValue,
  type InternalUser,
  type ScimUser,
} from '@authrim/ar-lib-scim';
import { getScimInboundSettings } from './scim-settings';

const CANONICAL_NAMESPACES = new Set(['authrim.profile', 'authrim.canonical']);
const SCIM_SOURCE_NAMESPACE = 'scim.attribute';
const ENTERPRISE_USER_SCHEMA = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const NON_WRITABLE_TARGETS = new Set([
  'account_id',
  'subject_id',
  'lifecycle_state',
  'created_at',
  'updated_at',
]);

export class ScimIdentityMappingError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'mapping_not_configured'
      | 'mapping_binding_not_found'
      | 'mapping_failed'
      | 'mapping_required_output_missing'
  ) {
    super(message);
  }
}

export async function applyScimInboundIdentityMapping(input: {
  env: Env;
  tenantId: string;
  user: Partial<ScimUser>;
}): Promise<Partial<InternalUser>> {
  const settings = await getScimInboundSettings(input.env, input.tenantId);
  if (!settings.mappingSetId) {
    throw new ScimIdentityMappingError(
      'No SCIM inbound Mapping Set is configured for this tenant',
      'mapping_not_configured'
    );
  }

  const binding = await resolveRuntimeIdentityMappingBinding(
    ensureDatabaseAdapter(input.env.DB_ADMIN, 'scim-identity-mapping'),
    {
      tenantId: input.tenantId,
      protocol: 'scim',
      role: 'receiver',
      fieldMappingSetId: settings.mappingSetId,
    }
  );
  if (!binding) {
    throw new ScimIdentityMappingError(
      'The configured SCIM inbound Mapping Set has no active compiled version',
      'mapping_binding_not_found'
    );
  }

  const prepared = prepareRuntimeInput(
    binding.catalog,
    binding.edges,
    scimSourceValues(input.user as Record<string, unknown>)
  );
  const runtimeResult = executeRuntimeMapping({
    catalog: prepared.catalog,
    sourceValues: prepared.sourceValues,
    edges: prepared.edges,
    transforms: binding.transforms,
    validationRules: binding.validationRules,
    fieldMappingSet: binding.fieldMappingSet,
  });
  if (runtimeResult.status === 'failed') {
    throw new ScimIdentityMappingError('SCIM inbound identity mapping failed', 'mapping_failed');
  }

  const projection = mappedValuesToInternalUser(runtimeResult.values);
  if (!projection.email) {
    throw new ScimIdentityMappingError(
      'SCIM Mapping Set must produce authrim.profile.email',
      'mapping_required_output_missing'
    );
  }
  return projection;
}

function scimSourceValues(user: Record<string, unknown>): SourceValueEnvelope[] {
  const enterprise = readRecord(user[ENTERPRISE_USER_SCHEMA]);
  return [
    scimSourceValue('userName', user.userName),
    scimSourceValue('externalId', user.externalId),
    scimSourceValue('active', user.active),
    scimSourceValue('displayName', user.displayName),
    scimSourceValue('nickName', user.nickName),
    scimSourceValue('profileUrl', user.profileUrl),
    scimSourceValue('title', user.title),
    scimSourceValue('userType', user.userType),
    scimSourceValue('preferredLanguage', user.preferredLanguage),
    scimSourceValue('locale', user.locale),
    scimSourceValue('timezone', user.timezone),
    scimSourceValue('name.formatted', readPath(user, ['name', 'formatted'])),
    scimSourceValue('name.givenName', readPath(user, ['name', 'givenName'])),
    scimSourceValue('name.familyName', readPath(user, ['name', 'familyName'])),
    scimSourceValue('name.middleName', readPath(user, ['name', 'middleName'])),
    scimSourceValue('name.honorificPrefix', readPath(user, ['name', 'honorificPrefix'])),
    scimSourceValue('name.honorificSuffix', readPath(user, ['name', 'honorificSuffix'])),
    scimSourceValue('emails', user.emails),
    scimSourceValue('emails.value', selectPrimaryScimValue(user.emails)),
    scimSourceValue('phoneNumbers', user.phoneNumbers),
    scimSourceValue('phoneNumbers.value', selectPrimaryScimValue(user.phoneNumbers)),
    scimSourceValue('addresses', user.addresses),
    scimSourceValue('addresses.primary', selectPrimaryScimObject(user.addresses)),
    scimSourceValue('groups', user.groups),
    scimSourceValue('enterprise.employeeNumber', enterprise?.employeeNumber),
    scimSourceValue('enterprise.costCenter', enterprise?.costCenter),
    scimSourceValue('enterprise.organization', enterprise?.organization),
    scimSourceValue('enterprise.division', enterprise?.division),
    scimSourceValue('enterprise.department', enterprise?.department),
    scimSourceValue('enterprise.manager.value', readPath(enterprise, ['manager', 'value'])),
  ];
}

function scimSourceValue(path: string, value: unknown): SourceValueEnvelope {
  return {
    value,
    sourceRef: { side: 'source', namespace: SCIM_SOURCE_NAMESPACE, path },
    metadata: { sourceType: 'scim', scimPath: path, fieldPath: path },
  };
}

function readPath(source: Record<string, unknown> | undefined, path: string[]): unknown {
  let current: unknown = source;
  for (const part of path) {
    if (typeof current !== 'object' || current === null || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function prepareRuntimeInput(
  catalog: FieldCatalogBundle,
  edges: MappingRuleEdge[],
  sourceValues: SourceValueEnvelope[]
): {
  catalog: FieldCatalogBundle;
  edges: MappingRuleEdge[];
  sourceValues: SourceValueEnvelope[];
} {
  const entries = new Map(catalog.entries.map((entry) => [entry.id, entry]));
  const preparedEdges = edges.map((edge) => {
    const catalogEntryId =
      edge.targetRef.catalogEntryId ??
      edge.sourceRef.catalogEntryId ??
      `field.canonical.${edge.targetRef.path}`;
    const existing = entries.get(catalogEntryId);
    if (!existing) {
      entries.set(catalogEntryId, catalogEntryForEdge(edge, catalogEntryId, sourceValues));
    }
    return {
      ...edge,
      sourceRef: { ...edge.sourceRef, catalogEntryId },
      targetRef: { ...edge.targetRef, catalogEntryId },
    };
  });

  const preparedSourceValues = preparedEdges.flatMap((edge) => {
    const source = sourceValues.find(
      (value) =>
        value.sourceRef.namespace === edge.sourceRef.namespace &&
        value.sourceRef.path === edge.sourceRef.path
    );
    return source
      ? [
          {
            ...source,
            sourceRef: { ...source.sourceRef, catalogEntryId: edge.sourceRef.catalogEntryId },
          },
        ]
      : [];
  });

  return {
    catalog: { ...catalog, entries: [...entries.values()] },
    edges: preparedEdges,
    sourceValues: preparedSourceValues,
  };
}

function catalogEntryForEdge(
  edge: MappingRuleEdge,
  id: string,
  sourceValues: SourceValueEnvelope[]
): FieldCatalogEntry {
  const sourceValue = sourceValues.find(
    (value) =>
      value.sourceRef.namespace === edge.sourceRef.namespace &&
      value.sourceRef.path === edge.sourceRef.path
  )?.value;
  return {
    id,
    namespace: edge.targetRef.namespace,
    path: edge.targetRef.path,
    aliases: [{ namespace: edge.sourceRef.namespace, path: edge.sourceRef.path }],
    targetType: 'canonical',
    valueType: valueType(sourceValue),
    cardinality: Array.isArray(sourceValue) ? 'multi' : 'single',
    classification: 'internal',
  };
}

function valueType(value: unknown): FieldCatalogEntry['valueType'] {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (value !== null && typeof value === 'object') return 'json';
  return 'string';
}

function mappedValuesToInternalUser(values: SourceValueEnvelope[]): Partial<InternalUser> {
  const user: Partial<InternalUser> = {};
  const customAttributes: Record<string, unknown> = {};
  for (const value of values) {
    const ref = value.sourceRef;
    if (ref.side !== 'destination' || !CANONICAL_NAMESPACES.has(ref.namespace)) continue;
    const path = canonicalPath(ref.path);
    if (NON_WRITABLE_TARGETS.has(path) || value.value === undefined) continue;
    if (assignKnownField(user, path, value.value)) continue;
    customAttributes[path] = value.value;
  }
  if (Object.keys(customAttributes).length > 0) {
    user.custom_attributes_json = JSON.stringify(customAttributes);
  }
  return user;
}

function canonicalPath(path: string): string {
  return path.startsWith('field.canonical.') ? path.slice('field.canonical.'.length) : path;
}

function assignKnownField(user: Partial<InternalUser>, path: string, value: unknown): boolean {
  switch (path) {
    case 'active':
    case 'scim_active':
      user.active = value === false || value === 0 ? 0 : 1;
      return true;
    case 'email_verified':
      user.email_verified = value === true || value === 1 ? 1 : 0;
      return true;
    case 'phone_number_verified':
      user.phone_number_verified = value === true || value === 1 ? 1 : 0;
      return true;
    case 'address':
    case 'address_json':
      user.address_json = typeof value === 'string' ? value : JSON.stringify(value);
      return true;
    case 'external_id':
    case 'scim_external_id':
      user.external_id = stringValue(value);
      return true;
    case 'display_name':
      user.name = stringValue(value);
      return true;
    case 'email':
    case 'phone_number':
    case 'name':
    case 'given_name':
    case 'family_name':
    case 'middle_name':
    case 'nickname':
    case 'preferred_username':
    case 'profile':
    case 'picture':
    case 'website':
    case 'gender':
    case 'birthdate':
    case 'zoneinfo':
    case 'locale':
      user[path] = stringValue(value);
      return true;
    default:
      return false;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : value == null ? undefined : String(value);
}
