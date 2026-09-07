import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core/types/admin-user';
import { sealAgentToolDefinitions, type AgentToolDefinition, type JsonObject } from '../../core';

const ID = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._~-]+$' };
const RESOURCE_VERSION = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9._~-]+$',
};
const HIGH_RISK_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const STANDARD_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const SNAPSHOT_OUTPUT_SCHEMA = objectSchema(
  { snapshot: { type: 'object', additionalProperties: true } },
  ['snapshot']
);

function objectSchema(properties: JsonObject, required: string[] = []): JsonObject {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

export const ADMIN_WRITE_TOOL_DEFINITIONS: readonly AgentToolDefinition[] =
  sealAgentToolDefinitions([
    {
      id: 'admin.write.clients.metadata',
      name: 'update_client_metadata',
      title: 'Update OAuth client display metadata',
      description:
        'Update non-credential OAuth client display metadata through a fixed idempotent owner API.',
      contractVersion: '1',
      requiredPermissions: [ADMIN_PERMISSIONS.CLIENTS_WRITE],
      requiredScope: 'agent:write',
      riskLevel: 'standard',
      schemaDigest: 'sha256:855fae1148b9949986c9cad7e1f63bc17e14ae20beb5128437f35d90c6d811c5',
      inputSchema: objectSchema(
        {
          client_id: ID,
          resource_version: {
            type: 'string',
            minLength: 16,
            maxLength: 128,
            pattern: '^[A-Za-z0-9_-]+$',
          },
          client_name: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string', maxLength: 1000 },
          logo_uri: { type: 'string', format: 'uri', maxLength: 2048 },
          client_uri: { type: 'string', format: 'uri', maxLength: 2048 },
        },
        ['client_id', 'resource_version']
      ),
      outputSchema: objectSchema(
        {
          client: {
            type: 'object',
            additionalProperties: false,
            properties: {
              client_id: ID,
              client_name: { type: 'string', maxLength: 200 },
              description: { type: 'string', maxLength: 1000 },
              logo_uri: { type: 'string', format: 'uri', maxLength: 2048 },
              client_uri: { type: 'string', format: 'uri', maxLength: 2048 },
              updated_at: { type: 'integer' },
            },
            required: ['client_id'],
          },
        },
        ['client']
      ),
      annotations: STANDARD_WRITE_ANNOTATIONS,
      publicClientStandardOptInEligible: true,
      protocolMetadata: { 'com.authrim/planStepAllowed': true },
      taskSupport: 'forbidden',
    },
    {
      id: 'admin.write.users.suspend',
      name: 'suspend_user',
      title: 'Suspend user',
      description:
        'Suspend one tenant user and invalidate access through account status. Requires operation-bound human approval.',
      contractVersion: '1',
      requiredPermissions: [ADMIN_PERMISSIONS.USERS_SUSPEND],
      requiredScope: 'agent:write',
      riskLevel: 'high',
      schemaDigest: 'sha256:7b90c4db7f9d89e7e96eafb2e2d76b7ebd18ee986932f977c9aebf9867479263',
      inputSchema: objectSchema(
        {
          user_id: ID,
          reason_code: {
            type: 'string',
            enum: [
              'policy_violation',
              'security_incident',
              'account_abuse',
              'payment_issue',
              'user_request',
              'admin_action',
              'investigation',
              'compliance',
              'other',
            ],
          },
          duration_hours: { type: 'integer', minimum: 1, maximum: 8760 },
          revoke_tokens: { type: 'boolean', default: true },
          revoke_sessions: { type: 'boolean', default: true },
          notify_user: { type: 'boolean', default: false },
        },
        ['user_id', 'reason_code']
      ),
      outputSchema: objectSchema(
        {
          user_id: ID,
          status: { type: 'string', const: 'suspended' },
          previous_status: { type: 'string' },
          effective_at: { type: 'string', format: 'date-time' },
          expires_at: { type: 'string', format: 'date-time' },
          reason_code: { type: 'string' },
          revoked: { type: 'object' },
        },
        ['user_id', 'status', 'previous_status', 'effective_at', 'reason_code', 'revoked']
      ),
      annotations: HIGH_RISK_ANNOTATIONS,
      taskSupport: 'forbidden',
    },
    {
      id: 'admin.write.assurance.update',
      name: 'update_assurance_settings',
      title: 'Update authentication assurance settings',
      description:
        'Update AAL, FAL, IAL, token-claim, DPoP, and PAR assurance policy through the fixed owner API. Requires operation-bound human approval.',
      contractVersion: '1',
      requiredPermissions: [ADMIN_PERMISSIONS.SETTINGS_ASSURANCE_UPDATE],
      requiredScope: 'agent:write',
      riskLevel: 'high',
      schemaDigest: 'sha256:3017561b5f274bf9182b2e877d1b6f896413b7f40f2ba74c3b2d34881b7f9347',
      inputSchema: {
        ...objectSchema(
          {
            resource_version: RESOURCE_VERSION,
            enabled: { type: 'boolean' },
            defaultAAL: { type: 'string', enum: ['AAL1', 'AAL2', 'AAL3'] },
            defaultFAL: { type: 'string', enum: ['FAL1', 'FAL2', 'FAL3'] },
            defaultIAL: { type: 'string', enum: ['IAL1', 'IAL2', 'IAL3'] },
            scopeAALRequirements: {
              type: 'object',
              maxProperties: 100,
              propertyNames: { type: 'string', minLength: 1, maxLength: 200 },
              additionalProperties: { type: 'string', enum: ['AAL1', 'AAL2', 'AAL3'] },
            },
            includeInIdToken: { type: 'boolean' },
            includeInAccessToken: { type: 'boolean' },
            fal2RequiresDPoP: { type: 'boolean' },
            fal3RequiresPAR: { type: 'boolean' },
          },
          ['resource_version']
        ),
        minProperties: 2,
      },
      outputSchema: SNAPSHOT_OUTPUT_SCHEMA,
      annotations: HIGH_RISK_ANNOTATIONS,
      taskSupport: 'forbidden',
    },
    {
      id: 'admin.write.protocol-security.update',
      name: 'update_protocol_security_settings',
      title: 'Update tenant FAPI security settings',
      description:
        'Update tenant-scoped FAPI enforcement, DPoP policy, and public-client policy through the versioned settings API. Requires operation-bound human approval.',
      contractVersion: '1',
      requiredPermissions: [ADMIN_PERMISSIONS.SETTINGS_SECURITY_UPDATE],
      requiredScope: 'agent:write',
      riskLevel: 'high',
      schemaDigest: 'sha256:a9a0173e2e8df1a5eb366a94c18995e5107ee1d1e2d4e6ad101e326ea4f8a2eb',
      inputSchema: {
        ...objectSchema(
          {
            resource_version: RESOURCE_VERSION,
            fapi: {
              type: 'object',
              additionalProperties: false,
              minProperties: 1,
              properties: {
                enabled: { type: 'boolean' },
                strictDPoP: { type: 'boolean' },
                allowPublicClients: { type: 'boolean' },
              },
            },
          },
          ['resource_version', 'fapi']
        ),
      },
      outputSchema: SNAPSHOT_OUTPUT_SCHEMA,
      annotations: HIGH_RISK_ANNOTATIONS,
      taskSupport: 'forbidden',
    },
    {
      id: 'admin.write.token-exchange.update',
      name: 'update_token_exchange_settings',
      title: 'Update OAuth token exchange settings',
      description:
        'Update tenant-scoped RFC 8693 enablement and delegation/impersonation policy through the versioned settings API. Requires operation-bound human approval.',
      contractVersion: '1',
      requiredPermissions: [ADMIN_PERMISSIONS.SETTINGS_TOKEN_EXCHANGE_UPDATE],
      requiredScope: 'agent:write',
      riskLevel: 'high',
      schemaDigest: 'sha256:c0ebcd7441e81e5543171321eef1dcb1bf199b430a3e36b7822a5e68fd1fed26',
      inputSchema: {
        ...objectSchema(
          {
            resource_version: RESOURCE_VERSION,
            enabled: { type: 'boolean' },
            delegationEnabled: { type: 'boolean' },
            impersonationEnabled: { type: 'boolean' },
          },
          ['resource_version']
        ),
        minProperties: 2,
      },
      outputSchema: SNAPSHOT_OUTPUT_SCHEMA,
      annotations: HIGH_RISK_ANNOTATIONS,
      taskSupport: 'forbidden',
    },
    {
      id: 'admin.write.oauth.update',
      name: 'update_oauth_settings',
      title: 'Update OAuth lifetime and behavior settings',
      description:
        'Update bounded OAuth token/code lifetimes and core behavior. Requires operation-bound human approval.',
      contractVersion: '1',
      requiredPermissions: [ADMIN_PERMISSIONS.SETTINGS_OAUTH_UPDATE],
      requiredScope: 'agent:write',
      riskLevel: 'high',
      schemaDigest: 'sha256:177014740b30e2f9b0af3066d40b37236856f788f5118b11b53b9a97e4603263',
      inputSchema: {
        ...objectSchema(
          {
            resource_version: RESOURCE_VERSION,
            accessTokenExpiry: { type: 'integer', minimum: 60, maximum: 86400 },
            idTokenExpiry: { type: 'integer', minimum: 60, maximum: 86400 },
            authCodeTtl: { type: 'integer', minimum: 10, maximum: 86400 },
            stateRequired: { type: 'boolean' },
            refreshTokenRotation: { type: 'boolean' },
            offlineAccessRequired: { type: 'boolean' },
            jarmEnabled: { type: 'boolean' },
          },
          ['resource_version']
        ),
        minProperties: 2,
      },
      outputSchema: SNAPSHOT_OUTPUT_SCHEMA,
      annotations: HIGH_RISK_ANNOTATIONS,
      taskSupport: 'forbidden',
    },
    {
      id: 'admin.write.session.update',
      name: 'update_session_settings',
      title: 'Update session and logout settings',
      description:
        'Update bounded session lifetimes, refresh behavior, and back-channel logout policy. Requires operation-bound human approval.',
      contractVersion: '1',
      requiredPermissions: [ADMIN_PERMISSIONS.SETTINGS_SESSION_UPDATE],
      requiredScope: 'agent:write',
      riskLevel: 'high',
      schemaDigest: 'sha256:a5299abb43e78ffdb177a9c4d73fb77c20bd5d0b7cc6b6a14b0603f370f7a706',
      inputSchema: {
        ...objectSchema(
          {
            resource_version: RESOURCE_VERSION,
            defaultTtl: { type: 'integer', minimum: 60000, maximum: 604800000 },
            maxTtl: { type: 'integer', minimum: 86400000, maximum: 2592000000 },
            refreshDefault: { type: 'boolean' },
            backchannelLogoutTokenExp: { type: 'integer', minimum: 30, maximum: 600 },
            backchannelOnFailure: { type: 'string', enum: ['ignore', 'log', 'error'] },
          },
          ['resource_version']
        ),
        minProperties: 2,
      },
      outputSchema: SNAPSHOT_OUTPUT_SCHEMA,
      annotations: HIGH_RISK_ANNOTATIONS,
      taskSupport: 'forbidden',
    },
    {
      id: 'admin.write.login-ui.update',
      name: 'update_login_ui_branding',
      title: 'Update Login UI branding',
      description:
        'Update bounded Login UI brand text, logo URL, and supported locales through a versioned owner API.',
      contractVersion: '1',
      requiredPermissions: [ADMIN_PERMISSIONS.SETTINGS_LOGIN_UI_UPDATE],
      requiredScope: 'agent:write',
      riskLevel: 'standard',
      schemaDigest: 'sha256:2597c9387616264fe4dc7df2a9c80fa2de14d05a92cb8fe1edb9715123318675',
      inputSchema: {
        ...objectSchema(
          {
            resource_version: RESOURCE_VERSION,
            brandName: { type: 'string', minLength: 1, maxLength: 100 },
            logoUrl: { type: 'string', format: 'uri', maxLength: 2048 },
            supportedLocales: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              uniqueItems: true,
              items: { type: 'string', pattern: '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$' },
            },
          },
          ['resource_version']
        ),
        minProperties: 2,
      },
      outputSchema: SNAPSHOT_OUTPUT_SCHEMA,
      annotations: STANDARD_WRITE_ANNOTATIONS,
      protocolMetadata: { 'com.authrim/planStepAllowed': true },
      taskSupport: 'forbidden',
    },
    {
      id: 'admin.write.clients.protocol-security',
      name: 'update_client_protocol_security',
      title: 'Update OAuth client protocol security',
      description:
        'Update one client redirect allowlist and PKCE requirement. Requires operation-bound human approval.',
      contractVersion: '1',
      requiredPermissions: [ADMIN_PERMISSIONS.CLIENTS_UPDATE],
      requiredScope: 'agent:write',
      riskLevel: 'high',
      schemaDigest: 'sha256:8cd194eefc5209ffe9d8e99c8d5af34c2361adfd13e82aead669e6ffb68289ce',
      inputSchema: {
        ...objectSchema(
          {
            client_id: ID,
            resource_version: RESOURCE_VERSION,
            redirect_uris: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              uniqueItems: true,
              items: { type: 'string', format: 'uri', maxLength: 2048 },
            },
            allowed_redirect_origins: {
              type: 'array',
              maxItems: 20,
              uniqueItems: true,
              items: { type: 'string', format: 'uri', maxLength: 2048 },
            },
            require_pkce: { type: 'boolean' },
          },
          ['client_id', 'resource_version']
        ),
        minProperties: 3,
      },
      outputSchema: objectSchema({ client: { type: 'object', additionalProperties: true } }, [
        'client',
      ]),
      annotations: HIGH_RISK_ANNOTATIONS,
      taskSupport: 'forbidden',
    },
    {
      id: 'admin.write.clients.public-create',
      name: 'create_public_oauth_client',
      title: 'Create a public OAuth client',
      description:
        'Create a PKCE-only SPA or native OAuth client without returning credential material. Requires operation-bound human approval.',
      contractVersion: '1',
      requiredPermissions: [ADMIN_PERMISSIONS.CLIENTS_CREATE],
      requiredScope: 'agent:write',
      riskLevel: 'high',
      schemaDigest: 'sha256:3ceca251f9c26a06c31d3b55af34d1eb6cd87466457c0f07e95480dd11b6fb84',
      inputSchema: objectSchema(
        {
          client_name: { type: 'string', minLength: 1, maxLength: 200 },
          application_type: { type: 'string', enum: ['spa', 'native'] },
          redirect_uris: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            uniqueItems: true,
            items: { type: 'string', format: 'uri', maxLength: 2048 },
          },
          allowed_redirect_origins: {
            type: 'array',
            maxItems: 20,
            uniqueItems: true,
            items: { type: 'string', format: 'uri', maxLength: 2048 },
          },
          scope: { type: 'string', minLength: 1, maxLength: 1000 },
        },
        ['client_name', 'application_type', 'redirect_uris']
      ),
      outputSchema: objectSchema({ client: { type: 'object', additionalProperties: true } }, [
        'client',
      ]),
      annotations: HIGH_RISK_ANNOTATIONS,
      taskSupport: 'forbidden',
    },
  ]);
