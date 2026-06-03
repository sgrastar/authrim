import type { AdapterResult, MappingInput, SourceValueEnvelope } from '../core/types';

export interface ScimUserPreviewAdapterInput {
  user: Record<string, unknown>;
  catalog: MappingInput['catalog'];
  edges: MappingInput['edges'];
}

export function adaptScimUserPreview(
  input: ScimUserPreviewAdapterInput
): AdapterResult<MappingInput> {
  const sourceValues: SourceValueEnvelope[] = [
    envelope('userName', input.user.userName),
    envelope('externalId', input.user.externalId),
    envelope('active', input.user.active),
    envelope('name.givenName', readPath(input.user, ['name', 'givenName'])),
    envelope('name.familyName', readPath(input.user, ['name', 'familyName'])),
    envelope('emails', input.user.emails),
    envelope('groups', input.user.groups),
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

function envelope(path: string, value: unknown): SourceValueEnvelope {
  return {
    value,
    sourceRef: { side: 'inbound', namespace: 'scim.user', path },
    metadata: { sourceType: 'scim', scimPath: path, fieldPath: path },
  };
}

function readPath(source: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = source;
  for (const part of path) {
    if (typeof current !== 'object' || current === null || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
