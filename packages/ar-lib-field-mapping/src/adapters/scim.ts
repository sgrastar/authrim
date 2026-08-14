import type { AdapterResult, MappingInput, SourceValueEnvelope } from '../core/types';

export interface ScimUserPreviewAdapterInput {
  user: Record<string, unknown>;
  catalog: MappingInput['catalog'];
  edges: MappingInput['edges'];
}

export const SCIM_SOURCE_NAMESPACE = 'scim.attribute';

const ENTERPRISE_USER_SCHEMA = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';

export function adaptScimUser(input: ScimUserPreviewAdapterInput): AdapterResult<MappingInput> {
  const enterprise = readRecord(input.user[ENTERPRISE_USER_SCHEMA]);
  const sourceValues: SourceValueEnvelope[] = [
    envelope('userName', input.user.userName),
    envelope('externalId', input.user.externalId),
    envelope('active', input.user.active),
    envelope('displayName', input.user.displayName),
    envelope('nickName', input.user.nickName),
    envelope('profileUrl', input.user.profileUrl),
    envelope('title', input.user.title),
    envelope('userType', input.user.userType),
    envelope('preferredLanguage', input.user.preferredLanguage),
    envelope('locale', input.user.locale),
    envelope('timezone', input.user.timezone),
    envelope('name.formatted', readPath(input.user, ['name', 'formatted'])),
    envelope('name.givenName', readPath(input.user, ['name', 'givenName'])),
    envelope('name.familyName', readPath(input.user, ['name', 'familyName'])),
    envelope('name.middleName', readPath(input.user, ['name', 'middleName'])),
    envelope('name.honorificPrefix', readPath(input.user, ['name', 'honorificPrefix'])),
    envelope('name.honorificSuffix', readPath(input.user, ['name', 'honorificSuffix'])),
    envelope('emails', input.user.emails),
    envelope('emails.value', primaryMultiValue(input.user.emails)),
    envelope('phoneNumbers', input.user.phoneNumbers),
    envelope('phoneNumbers.value', primaryMultiValue(input.user.phoneNumbers)),
    envelope('addresses', input.user.addresses),
    envelope('addresses.primary', primaryObject(input.user.addresses)),
    envelope('groups', input.user.groups),
    envelope('enterprise.employeeNumber', enterprise?.employeeNumber),
    envelope('enterprise.costCenter', enterprise?.costCenter),
    envelope('enterprise.organization', enterprise?.organization),
    envelope('enterprise.division', enterprise?.division),
    envelope('enterprise.department', enterprise?.department),
    envelope('enterprise.manager.value', readPath(enterprise, ['manager', 'value'])),
  ];

  return {
    status: 'success',
    input: {
      catalog: input.catalog,
      edges: input.edges,
      sourceValues,
    },
    reasons: [],
  };
}

export const adaptScimUserPreview = adaptScimUser;

function envelope(path: string, value: unknown): SourceValueEnvelope {
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

function primaryObject(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  const records = value.map(readRecord).filter((item): item is Record<string, unknown> => !!item);
  return records.find((item) => item.primary === true) ?? records[0];
}

function primaryMultiValue(value: unknown): unknown {
  return primaryObject(value)?.value;
}
