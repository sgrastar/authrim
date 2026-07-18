import type { JsonObject, JsonValue } from '../../core';
import type { ManagementOperationRoute } from './service-binding';

function stringValue(input: JsonObject, key: string): string | undefined {
  return typeof input[key] === 'string' ? input[key] : undefined;
}

function pageSize(input: JsonObject): number {
  const value = input.page_size;
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 50
    ? (value as number)
    : 20;
}

function page(input: JsonObject): number {
  const cursor = stringValue(input, 'cursor');
  if (!cursor) return 1;
  try {
    const padded = cursor
      .replace(/-/gu, '+')
      .replace(/_/gu, '/')
      .padEnd(Math.ceil(cursor.length / 4) * 4, '=');
    const decoded: unknown = JSON.parse(atob(padded));
    if (
      decoded &&
      typeof decoded === 'object' &&
      !Array.isArray(decoded) &&
      (decoded as Record<string, unknown>).v === 1 &&
      Number.isSafeInteger((decoded as Record<string, unknown>).p) &&
      ((decoded as Record<string, unknown>).p as number) >= 1
    ) {
      return (decoded as Record<string, unknown>).p as number;
    }
  } catch {
    // The schema only proves shape; semantic cursor validation remains fail closed here.
  }
  throw new TypeError('Invalid Agent read cursor');
}

function queryPath(
  path: string,
  input: JsonObject,
  mapping: Readonly<Record<string, string>>
): string {
  const query = new URLSearchParams({ page: String(page(input)), limit: String(pageSize(input)) });
  for (const [inputKey, queryKey] of Object.entries(mapping)) {
    const value = input[inputKey];
    if (typeof value === 'string' || typeof value === 'boolean') query.set(queryKey, String(value));
  }
  return `${path}?${query.toString()}`;
}

function requiredId(input: JsonObject, key: string): string {
  const value = stringValue(input, key);
  if (!value || !/^[A-Za-z0-9._~-]{1,128}$/u.test(value)) throw new TypeError(`Invalid ${key}`);
  return encodeURIComponent(value);
}

function tenantSettingsPath(tenantId: string, category: string): string {
  return `/api/admin/tenants/${requiredId({ tenant_id: tenantId }, 'tenant_id')}/settings/${category}`;
}

const PRIVATE_KEY =
  /(?:^|_)(?:secret|password|credential|private_key|private_jwk|key_material|api_key|access_token|refresh_token|id_token|bearer_token|client_assertion|authorization|cookie)(?:_|$)/iu;
const PII_KEY = /(?:^|_)(?:email|phone|contact|address)(?:_|$)/iu;

function normalizedKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[^A-Za-z0-9]+/gu, '_')
    .toLowerCase();
}

function isPrivateInspectionKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return PRIVATE_KEY.test(normalized) || PII_KEY.test(normalized);
}

function safeString(value: string): string {
  const truncated = value.slice(0, 4096);
  try {
    const relative = truncated.startsWith('/');
    const url = relative ? new URL(truncated, 'https://redaction.invalid') : new URL(truncated);
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return relative ? url.pathname : url.toString();
    }
  } catch {
    // Non-URL strings are retained within the bounded inspection payload.
  }
  return truncated;
}

function sanitizeInspection(value: JsonValue, depth = 0): JsonValue {
  if (depth > 8) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return safeString(value);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeInspection(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isPrivateInspectionKey(key))
      .slice(0, 100)
      .map(([key, item]) => [key, sanitizeInspection(item, depth + 1)])
  );
}

export function projectAgentInspectionResponse(body: JsonValue): JsonValue {
  return { snapshot: sanitizeInspection(body) };
}

export const CLOUDFLARE_ADMIN_READ_ROUTES: Readonly<Record<string, ManagementOperationRoute>> = {
  'admin.read.users.search': {
    method: 'GET',
    path: (input) =>
      queryPath('/api/admin/agent-read/users', input, {
        query: 'search',
        verified: 'verified',
        lifecycle_state: 'lifecycle_state',
      }),
  },
  'admin.read.users.get': {
    method: 'GET',
    path: (input) => `/api/admin/agent-read/users/${requiredId(input, 'user_id')}`,
  },
  'admin.read.clients.list': {
    method: 'GET',
    path: (input) => queryPath('/api/admin/agent-read/clients', input, { query: 'search' }),
  },
  'admin.read.clients.get': {
    method: 'GET',
    path: (input) => `/api/admin/agent-read/clients/${requiredId(input, 'client_id')}`,
  },
  'admin.read.audit.search': {
    method: 'GET',
    path: (input) =>
      queryPath('/api/admin/agent-read/admin-audit-log', input, {
        actor_id: 'admin_user_id',
        action: 'action',
        resource_type: 'resource_type',
        result: 'result',
        severity: 'severity',
        start_date: 'start_date',
        end_date: 'end_date',
      }),
  },
  'admin.read.agent-settings.get': {
    method: 'GET',
    path: '/api/admin/settings/agent',
  },
  'admin.read.identity-providers.inspect': {
    method: 'GET',
    path: '/api/admin/external-providers',
    response: projectAgentInspectionResponse,
  },
  'admin.read.authorization.organizations': {
    method: 'GET',
    path: '/api/admin/organizations?page=1&limit=50',
    response: projectAgentInspectionResponse,
  },
  'admin.read.authorization.roles': {
    method: 'GET',
    path: '/api/admin/roles?page=1&limit=50',
    response: projectAgentInspectionResponse,
  },
  'admin.read.authorization.policies': {
    method: 'GET',
    path: '/api/admin/policies?page=1&limit=50',
    response: projectAgentInspectionResponse,
  },
  'admin.read.flows.inspect': {
    method: 'GET',
    path: '/api/admin/flows?page=1&limit=50',
    response: projectAgentInspectionResponse,
  },
  'admin.read.consent.inspect': {
    method: 'GET',
    path: '/api/admin/consent-policies?page=1&limit=50',
    response: projectAgentInspectionResponse,
  },
  'admin.read.sessions.inspect': {
    method: 'GET',
    path: '/api/admin/sessions?page=1&limit=50',
    response: projectAgentInspectionResponse,
  },
  'admin.read.assurance.inspect': {
    method: 'GET',
    path: (_input, context) => tenantSettingsPath(context.tenantId, 'assurance'),
    response: projectAgentInspectionResponse,
  },
  'admin.read.protocol-security.inspect': {
    method: 'GET',
    path: (_input, context) => tenantSettingsPath(context.tenantId, 'security'),
    response: projectAgentInspectionResponse,
  },
  'admin.read.oauth.inspect': {
    method: 'GET',
    path: (_input, context) => tenantSettingsPath(context.tenantId, 'oauth'),
    response: projectAgentInspectionResponse,
  },
  'admin.read.token-exchange.inspect': {
    method: 'GET',
    path: (_input, context) => tenantSettingsPath(context.tenantId, 'tokens'),
    response: projectAgentInspectionResponse,
  },
  'admin.read.logout.inspect': {
    method: 'GET',
    path: (_input, context) => tenantSettingsPath(context.tenantId, 'session'),
    response: projectAgentInspectionResponse,
  },
  'admin.read.webhooks.inspect': {
    method: 'GET',
    path: '/api/admin/webhooks?page=1&limit=50',
    response: projectAgentInspectionResponse,
  },
  'admin.read.login-ui.inspect': {
    method: 'GET',
    path: (_input, context) => tenantSettingsPath(context.tenantId, 'login-ui'),
    response: projectAgentInspectionResponse,
  },
  'admin.read.conformance.inspect': {
    method: 'GET',
    path: '/api/admin/settings/conformance',
    response: projectAgentInspectionResponse,
  },
  'admin.read.flows.validate': {
    method: 'POST',
    path: (input) => `/api/admin/flows/${requiredId(input, 'resource_id')}/validate`,
    body: () => ({}),
    response: projectAgentInspectionResponse,
  },
  'admin.read.authorization.simulate': {
    method: 'POST',
    path: '/api/admin/policies/simulate',
    body: (input) => ({
      context: {
        subject: input.subject,
        resource: input.resource,
        action: input.action,
        timestamp: Date.now(),
      },
      save_history: false,
    }),
    response: projectAgentInspectionResponse,
  },
  'admin.read.tenant-policy.validate': {
    method: 'GET',
    path: '/api/admin/tenant-policy/validate',
    response: projectAgentInspectionResponse,
  },
  'admin.read.clients.profile-validate': {
    method: 'GET',
    path: (input) => `/api/admin/clients/${requiredId(input, 'resource_id')}/profile/validate`,
    response: projectAgentInspectionResponse,
  },
};
