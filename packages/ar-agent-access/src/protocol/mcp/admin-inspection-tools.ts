import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core/types/admin-user';
import type { AgentToolDefinition, JsonObject } from '../../core';

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const INPUT_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: {},
};

const OUTPUT_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: { snapshot: { type: 'object' } },
  required: ['snapshot'],
};

function inspection(
  id: string,
  name: string,
  title: string,
  description: string,
  permission: string,
  schemaDigest: string
): AgentToolDefinition {
  return {
    id,
    name,
    title,
    description,
    contractVersion: '1',
    requiredPermissions: [permission],
    requiredScope: 'agent:read',
    riskLevel: 'low',
    schemaDigest,
    inputSchema: INPUT_SCHEMA,
    outputSchema: OUTPUT_SCHEMA,
    annotations: READ_ANNOTATIONS,
    taskSupport: 'forbidden',
  };
}

function validation(
  id: string,
  name: string,
  title: string,
  description: string,
  permission: string,
  inputSchema: JsonObject,
  schemaDigest: string
): AgentToolDefinition {
  return {
    ...inspection(id, name, title, description, permission, schemaDigest),
    inputSchema,
  };
}

const RESOURCE_ID_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['resource_id'],
  properties: {
    resource_id: { type: 'string', pattern: '^[A-Za-z0-9._~-]{1,128}$' },
  },
};

const POLICY_SIMULATION_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'resource', 'action'],
  properties: {
    subject: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'roles'],
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 128 },
        user_type: { type: 'string', maxLength: 64 },
        org_id: { type: 'string', maxLength: 128 },
        roles: {
          type: 'array',
          maxItems: 50,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'scope'],
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 128 },
              scope: { type: 'string', minLength: 1, maxLength: 64 },
              scope_target: { type: 'string', maxLength: 256 },
              expires_at: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
    },
    resource: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: {
        type: { type: 'string', minLength: 1, maxLength: 128 },
        id: { type: 'string', minLength: 1, maxLength: 128 },
        owner_id: { type: 'string', maxLength: 128 },
        org_id: { type: 'string', maxLength: 128 },
      },
    },
    action: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 128 },
        operation: { type: 'string', maxLength: 128 },
      },
    },
  },
};

/** Broad Phase 2 inspect surface. Owner responses are projected and redacted by the platform route. */
export const ADMIN_CONFIGURATION_INSPECTION_TOOL_DEFINITIONS: readonly AgentToolDefinition[] = [
  {
    ...inspection(
      'admin.read.runtime.diagnostics',
      'diagnose_runtime_metadata',
      'Diagnose issuer metadata and runtime health',
      'Compare the tenant issuer, discovery document, public signing-key metadata, and Management service health.',
      ADMIN_PERMISSIONS.SETTINGS_READ,
      'sha256:71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892'
    ),
    executionTarget: 'runtime_diagnostics',
  },
  inspection(
    'admin.read.identity-providers.inspect',
    'inspect_identity_providers',
    'Inspect OIDC and SAML identity providers',
    'Inspect configured external identity providers without credentials or raw metadata.',
    ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_READ,
    'sha256:71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892'
  ),
  inspection(
    'admin.read.authorization.organizations',
    'inspect_organizations',
    'Inspect organizations',
    'Inspect organization and membership-model configuration without member PII.',
    ADMIN_PERMISSIONS.ROLES_READ,
    'sha256:71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892'
  ),
  inspection(
    'admin.read.authorization.roles',
    'inspect_roles',
    'Inspect roles',
    'Inspect tenant role definitions and permission names.',
    ADMIN_PERMISSIONS.ROLES_READ,
    'sha256:71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892'
  ),
  inspection(
    'admin.read.authorization.policies',
    'inspect_authorization_policies',
    'Inspect authorization policies',
    'Inspect policy definitions used for authorization design and simulation planning.',
    ADMIN_PERMISSIONS.ROLES_READ,
    'sha256:71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892'
  ),
  inspection(
    'admin.read.flows.inspect',
    'inspect_authentication_flows',
    'Inspect authentication flows',
    'Inspect versioned authentication flow definitions and publication state.',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    'sha256:71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892'
  ),
  inspection(
    'admin.read.consent.inspect',
    'inspect_consent_policies',
    'Inspect consent policies',
    'Inspect consent policy structure without end-user consent records.',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    'sha256:71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892'
  ),
  inspection(
    'admin.read.sessions.inspect',
    'inspect_sessions',
    'Inspect active session posture',
    'Inspect aggregate active-session posture without user, session, device, network, or token identifiers.',
    ADMIN_PERMISSIONS.SESSIONS_READ,
    'sha256:71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892'
  ),
  inspection(
    'admin.read.assurance.inspect',
    'inspect_assurance_settings',
    'Inspect assurance settings',
    'Inspect effective AAL, FAL, and IAL policy with source metadata.',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    'sha256:71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892'
  ),
  inspection(
    'admin.read.protocol-security.inspect',
    'inspect_protocol_security',
    'Inspect FAPI and sender-constraining settings',
    'Inspect effective FAPI, DPoP, PAR, JAR, and public-client security posture.',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    'sha256:71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892'
  ),
  inspection(
    'admin.read.oauth.inspect',
    'inspect_oauth_settings',
    'Inspect OAuth settings',
    'Inspect effective OAuth configuration values, defaults, and sources.',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    'sha256:71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892'
  ),
  inspection(
    'admin.read.token-exchange.inspect',
    'inspect_token_exchange_settings',
    'Inspect Token Exchange settings',
    'Inspect RFC 8693 and downstream delegation policy without token material.',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    'sha256:71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892'
  ),
  inspection(
    'admin.read.logout.inspect',
    'inspect_logout_settings',
    'Inspect logout settings',
    'Inspect RP-initiated, back-channel, and webhook logout configuration.',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    'sha256:71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892'
  ),
  inspection(
    'admin.read.webhooks.inspect',
    'inspect_webhooks',
    'Inspect webhook configuration',
    'Inspect webhook event subscriptions and status without endpoint credentials or payloads.',
    ADMIN_PERMISSIONS.WEBHOOKS_READ,
    'sha256:71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892'
  ),
  inspection(
    'admin.read.login-ui.inspect',
    'inspect_login_ui_settings',
    'Inspect Login UI settings',
    'Inspect effective branding and Login UI behavior without uploaded asset contents.',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    'sha256:71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892'
  ),
  inspection(
    'admin.read.conformance.inspect',
    'inspect_conformance_settings',
    'Inspect conformance settings',
    'Inspect certification and protocol conformance toggles with their effective sources.',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    'sha256:71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892'
  ),
  validation(
    'admin.read.flows.validate',
    'validate_authentication_flow',
    'Validate an authentication Flow',
    'Validate the stored draft for one Flow without publishing or changing it.',
    ADMIN_PERMISSIONS.FLOWS_VALIDATE,
    RESOURCE_ID_SCHEMA,
    'sha256:8617a5d6ada8279d9d20ee1b70f6c323fd686925ee9654e5872fbe838433b7c1'
  ),
  validation(
    'admin.read.authorization.simulate',
    'simulate_authorization_policy',
    'Simulate authorization policy',
    'Evaluate enabled policy rules against a bounded synthetic context without saving history.',
    ADMIN_PERMISSIONS.POLICY_SIMULATE,
    POLICY_SIMULATION_SCHEMA,
    'sha256:b03f94c1489987634e9d354a0c6f7b9e449c7d5f68e6883abfa9fe5d43f4b35a'
  ),
  inspection(
    'admin.read.tenant-policy.validate',
    'validate_tenant_policy',
    'Validate tenant policy',
    'Validate the effective tenant policy and report structural or reference errors.',
    ADMIN_PERMISSIONS.POLICY_SIMULATE,
    'sha256:71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892'
  ),
  validation(
    'admin.read.clients.profile-validate',
    'validate_client_profile',
    'Validate a client profile',
    'Validate one client policy profile without changing the client.',
    ADMIN_PERMISSIONS.CLIENTS_READ,
    RESOURCE_ID_SCHEMA,
    'sha256:8617a5d6ada8279d9d20ee1b70f6c323fd686925ee9654e5872fbe838433b7c1'
  ),
];
