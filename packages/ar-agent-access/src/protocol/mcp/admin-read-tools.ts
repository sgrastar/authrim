import {
  PHASE_ONE_ADMIN_READ_PERMISSIONS,
  createAgentToolCatalog,
  type AgentToolDefinition,
  type JsonObject,
} from '../../core';

const CURSOR = { type: 'string', minLength: 1, maxLength: 512, pattern: '^[A-Za-z0-9_-]+$' };
const PAGE_SIZE = { type: 'integer', minimum: 1, maximum: 50, default: 20 };
const ID = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._~-]+$' };
const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function objectSchema(properties: JsonObject, required: string[] = []): JsonObject {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

export const ADMIN_READ_TOOL_DEFINITIONS: readonly AgentToolDefinition[] = [
  {
    id: 'admin.read.users.search',
    name: 'search_users',
    title: 'Search users',
    description: 'Search tenant users with an allowlisted filter set. PII is masked.',
    contractVersion: '1',
    requiredPermissions: [PHASE_ONE_ADMIN_READ_PERMISSIONS.users],
    requiredScope: 'agent:user-data:read',
    riskLevel: 'low',
    schemaDigest: 'sha256:68c3fb777050bbcc79daa5d9cd38232d312a98c25c43955f752e843b3f35c1af',
    inputSchema: objectSchema({
      query: { type: 'string', maxLength: 200 },
      verified: { type: 'boolean' },
      lifecycle_state: { type: 'string', enum: ['active', 'deactivated', 'deleted'] },
      page_size: PAGE_SIZE,
      cursor: CURSOR,
    }),
    outputSchema: objectSchema(
      {
        users: { type: 'array', maxItems: 50, items: { type: 'object' } },
        next_cursor: { type: ['string', 'null'] },
        total: { type: 'integer', minimum: 0 },
      },
      ['users', 'next_cursor', 'total']
    ),
    annotations: READ_ANNOTATIONS,
    taskSupport: 'forbidden',
  },
  {
    id: 'admin.read.users.get',
    name: 'get_user',
    title: 'Get user',
    description: 'Get one tenant user by stable ID. PII and credential identifiers are omitted.',
    contractVersion: '1',
    requiredPermissions: [PHASE_ONE_ADMIN_READ_PERMISSIONS.users],
    requiredScope: 'agent:user-data:read',
    riskLevel: 'low',
    schemaDigest: 'sha256:e15df1967ae3ab6422291d692b43621cfe0a9162ee062fad053a618065d7e457',
    inputSchema: objectSchema({ user_id: ID }, ['user_id']),
    outputSchema: objectSchema(
      {
        user: { type: 'object' },
        authentication_factors: { type: 'object' },
        missing_required_fields: { type: 'array', items: { type: 'object' } },
      },
      ['user', 'authentication_factors', 'missing_required_fields']
    ),
    annotations: READ_ANNOTATIONS,
    taskSupport: 'forbidden',
  },
  {
    id: 'admin.read.clients.list',
    name: 'list_clients',
    title: 'List OAuth clients',
    description: 'List OAuth/OIDC clients without secrets, credentials, or contact PII.',
    contractVersion: '1',
    requiredPermissions: [PHASE_ONE_ADMIN_READ_PERMISSIONS.clients],
    requiredScope: 'agent:read',
    riskLevel: 'low',
    schemaDigest: 'sha256:7c71b47f3bb0888e7d0ada32216a7f8f750f3e3b6e059d34cd679964bf014a98',
    inputSchema: objectSchema({
      query: { type: 'string', maxLength: 200 },
      page_size: PAGE_SIZE,
      cursor: CURSOR,
    }),
    outputSchema: objectSchema(
      {
        clients: { type: 'array', maxItems: 50, items: { type: 'object' } },
        next_cursor: { type: ['string', 'null'] },
        total: { type: 'integer', minimum: 0 },
      },
      ['clients', 'next_cursor', 'total']
    ),
    annotations: READ_ANNOTATIONS,
    taskSupport: 'forbidden',
  },
  {
    id: 'admin.read.clients.get',
    name: 'get_client',
    title: 'Get OAuth client',
    description: 'Get one OAuth/OIDC client without secrets, credentials, or contact PII.',
    contractVersion: '1',
    requiredPermissions: [PHASE_ONE_ADMIN_READ_PERMISSIONS.clients],
    requiredScope: 'agent:read',
    riskLevel: 'low',
    schemaDigest: 'sha256:1b8dc01b3c7aa0f33a60a76eeb05caabf5e3fe03d04a31055c26730568e8f7a1',
    inputSchema: objectSchema({ client_id: ID }, ['client_id']),
    outputSchema: objectSchema(
      {
        client: { type: 'object' },
        resource_version: { type: 'string', minLength: 43, maxLength: 43 },
      },
      ['client', 'resource_version']
    ),
    annotations: READ_ANNOTATIONS,
    taskSupport: 'forbidden',
  },
  {
    id: 'admin.read.audit.search',
    name: 'search_audit_logs',
    title: 'Search Admin audit logs',
    description:
      'Search Admin audit events using fixed filters. Detail payloads and PII are omitted.',
    contractVersion: '1',
    requiredPermissions: [PHASE_ONE_ADMIN_READ_PERMISSIONS.audit],
    requiredScope: 'agent:read',
    riskLevel: 'low',
    schemaDigest: 'sha256:aae626154aa09b2b1c725d662a6bd064c813306504e591283302a733d84dad66',
    inputSchema: objectSchema({
      actor_id: ID,
      action: { type: 'string', maxLength: 128 },
      resource_type: { type: 'string', maxLength: 128 },
      result: { type: 'string', enum: ['success', 'failure'] },
      severity: { type: 'string', enum: ['debug', 'info', 'warn', 'error', 'critical'] },
      start_date: { type: 'string', format: 'date' },
      end_date: { type: 'string', format: 'date' },
      page_size: PAGE_SIZE,
      cursor: CURSOR,
    }),
    outputSchema: objectSchema(
      {
        items: { type: 'array', maxItems: 50, items: { type: 'object' } },
        next_cursor: { type: ['string', 'null'] },
        total: { type: 'integer', minimum: 0 },
      },
      ['items', 'next_cursor', 'total']
    ),
    annotations: READ_ANNOTATIONS,
    taskSupport: 'forbidden',
  },
  {
    id: 'admin.read.agent-settings.get',
    name: 'get_agent_settings',
    title: 'Get Agent Access settings',
    description: 'Get effective Agent Access policy settings for the delegated tenant.',
    contractVersion: '1',
    requiredPermissions: [PHASE_ONE_ADMIN_READ_PERMISSIONS.settings],
    requiredScope: 'agent:read',
    riskLevel: 'low',
    schemaDigest: 'sha256:71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892',
    inputSchema: objectSchema({}),
    outputSchema: objectSchema({ settings: { type: 'object' } }, ['settings']),
    annotations: READ_ANNOTATIONS,
    taskSupport: 'forbidden',
  },
];

export function createAdminReadToolCatalog() {
  return createAgentToolCatalog('admin-read-v1', ADMIN_READ_TOOL_DEFINITIONS);
}
