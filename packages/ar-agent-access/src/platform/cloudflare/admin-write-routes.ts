import { canonicalizeJson, type JsonObject, type JsonValue } from '../../core';
import { projectAgentInspectionResponse } from './admin-read-routes';
import type { ManagementOperationRoute } from './service-binding';

function requiredId(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/u.test(value)) {
    throw new TypeError(`Invalid ${key}`);
  }
  return encodeURIComponent(value);
}

function tenantSettingsPath(tenantId: string, category: string): string {
  return `/api/admin/tenants/${requiredId({ tenant_id: tenantId }, 'tenant_id')}/settings/${category}`;
}

function resourceVersion(input: JsonObject): string {
  const value = input.resource_version;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/u.test(value)) {
    throw new TypeError('Invalid resource_version');
  }
  return value;
}

function settingsPatch(
  input: JsonObject,
  fields: readonly (readonly [string, string, ((value: JsonValue) => JsonValue)?])[]
): JsonObject {
  const set: JsonObject = {};
  for (const [inputKey, settingKey, transform] of fields) {
    const value = input[inputKey];
    if (value !== undefined) set[settingKey] = transform ? transform(value) : value;
  }
  return { ifMatch: resourceVersion(input), set };
}

function projectClientMetadataWriteResponse(body: JsonValue): JsonValue {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const client = body.client;
  if (!client || typeof client !== 'object' || Array.isArray(client)) return body;
  const clientId = client.client_id;
  if (typeof clientId !== 'string') return body;
  const projected: JsonObject = { client_id: clientId };
  for (const field of ['client_name', 'description', 'logo_uri', 'client_uri'] as const) {
    const value = client[field];
    if (typeof value === 'string') projected[field] = value;
  }
  if (typeof client.updated_at === 'number' && Number.isSafeInteger(client.updated_at)) {
    projected.updated_at = client.updated_at;
  }
  return { client: projected };
}

export const CLOUDFLARE_ADMIN_WRITE_ROUTES: Readonly<Record<string, ManagementOperationRoute>> = {
  'admin.write.clients.metadata': {
    method: 'PUT',
    path: (input) => `/api/admin/agent-write/clients/${requiredId(input, 'client_id')}/metadata`,
    body: ({ client_id: _clientId, resource_version: _resourceVersion, ...body }) => body,
    headers: (input) => {
      const value = input.resource_version;
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(value)) {
        throw new TypeError('Invalid resource_version');
      }
      return { 'if-match': value };
    },
    response: projectClientMetadataWriteResponse,
  },
  'admin.write.users.suspend': {
    method: 'POST',
    path: (input) => `/api/admin/agent-write/users/${requiredId(input, 'user_id')}/suspend`,
    body: ({ user_id: _userId, ...body }) => body,
  },
  'admin.write.assurance.update': {
    method: 'PATCH',
    path: (_input, context) => tenantSettingsPath(context.tenantId, 'assurance'),
    body: (input) =>
      settingsPatch(input, [
        ['enabled', 'assurance.enabled'],
        ['defaultAAL', 'assurance.default_aal'],
        ['defaultFAL', 'assurance.default_fal'],
        ['defaultIAL', 'assurance.default_ial'],
        [
          'scopeAALRequirements',
          'assurance.scope_aal_requirements',
          (value) => canonicalizeJson(value),
        ],
        ['includeInIdToken', 'assurance.include_in_id_token'],
        ['includeInAccessToken', 'assurance.include_in_access_token'],
        ['fal2RequiresDPoP', 'assurance.fal2_requires_dpop'],
        ['fal3RequiresPAR', 'assurance.fal3_requires_par'],
      ]),
    response: projectAgentInspectionResponse,
  },
  'admin.write.protocol-security.update': {
    method: 'PATCH',
    path: (_input, context) => tenantSettingsPath(context.tenantId, 'security'),
    body: (input) => {
      const fapi = input.fapi;
      if (!fapi || Array.isArray(fapi) || typeof fapi !== 'object') {
        throw new TypeError('Invalid fapi settings');
      }
      return settingsPatch({ resource_version: input.resource_version, ...fapi }, [
        ['enabled', 'security.fapi_enabled'],
        ['strictDPoP', 'security.fapi_strict_dpop'],
        ['allowPublicClients', 'security.fapi_allow_public_clients'],
      ]);
    },
    response: projectAgentInspectionResponse,
  },
  'admin.write.token-exchange.update': {
    method: 'PATCH',
    path: (_input, context) => tenantSettingsPath(context.tenantId, 'tokens'),
    body: (input) =>
      settingsPatch(input, [
        ['enabled', 'tokens.exchange_enabled'],
        ['delegationEnabled', 'tokens.exchange_delegation_enabled'],
        ['impersonationEnabled', 'tokens.exchange_impersonation_enabled'],
      ]),
    response: projectAgentInspectionResponse,
  },
  'admin.write.oauth.update': {
    method: 'PATCH',
    path: (_input, context) => tenantSettingsPath(context.tenantId, 'oauth'),
    body: (input) =>
      settingsPatch(input, [
        ['accessTokenExpiry', 'oauth.access_token_expiry'],
        ['idTokenExpiry', 'oauth.id_token_expiry'],
        ['authCodeTtl', 'oauth.auth_code_ttl'],
        ['stateRequired', 'oauth.state_required'],
        ['refreshTokenRotation', 'oauth.refresh_token_rotation'],
        ['offlineAccessRequired', 'oauth.offline_access_required'],
        ['jarmEnabled', 'oauth.jarm_enabled'],
      ]),
    response: projectAgentInspectionResponse,
  },
  'admin.write.session.update': {
    method: 'PATCH',
    path: (_input, context) => tenantSettingsPath(context.tenantId, 'session'),
    body: (input) =>
      settingsPatch(input, [
        ['defaultTtl', 'session.default_ttl'],
        ['maxTtl', 'session.max_ttl'],
        ['refreshDefault', 'session.refresh_default'],
        ['backchannelLogoutTokenExp', 'session.backchannel_logout_token_exp'],
        ['backchannelOnFailure', 'session.backchannel_on_failure'],
      ]),
    response: projectAgentInspectionResponse,
  },
  'admin.write.login-ui.update': {
    method: 'PATCH',
    path: (_input, context) => tenantSettingsPath(context.tenantId, 'login-ui'),
    body: (input) =>
      settingsPatch(input, [
        ['brandName', 'login-ui.brand_name'],
        ['logoUrl', 'login-ui.logo_url'],
        [
          'supportedLocales',
          'login-ui.supported_locales',
          (value) => (Array.isArray(value) ? value.join(',') : value),
        ],
      ]),
    response: projectAgentInspectionResponse,
  },
  'admin.write.clients.protocol-security': {
    method: 'PUT',
    path: (input) =>
      `/api/admin/agent-write/clients/${requiredId(input, 'client_id')}/protocol-security`,
    body: ({ client_id: _clientId, resource_version: _resourceVersion, ...body }) => body,
    headers: (input) => ({ 'if-match': resourceVersion(input) }),
  },
  'admin.write.clients.public-create': {
    method: 'POST',
    path: '/api/admin/agent-write/clients/public',
    body: (input) => ({
      ...input,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      require_pkce: true,
      client_credentials_allowed: false,
      token_exchange_allowed: false,
      is_trusted: false,
      skip_consent: false,
    }),
  },
};
