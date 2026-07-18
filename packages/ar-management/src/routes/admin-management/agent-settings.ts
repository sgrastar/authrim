import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  AGENT_ACCESS_SETTING_KEYS,
  isPublicClientStandardOptInEligibleTool,
  parseAgentAccessSettings,
  type AgentAccessSettings,
  type AgentElevationMode,
} from '@authrim/ar-agent-access/core';
import { createAdminToolCatalog } from '@authrim/ar-agent-access/protocol/mcp';
import {
  ADMIN_PERMISSIONS,
  adminAuthMiddleware,
  hasAdminPermission,
  type AdminAuthContext,
  type Env,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';

type AgentSettingsEnv = Env & { ENABLE_AGENT_MCP?: string };
type AgentSettingsContext = Context<{
  Bindings: AgentSettingsEnv;
  Variables: { adminAuth?: AdminAuthContext };
}>;

interface AgentSettingsBody {
  enabled?: unknown;
  maxTokenTtlSeconds?: unknown;
  elevationMode?: unknown;
  elevationTtlSeconds?: unknown;
  rateLimitPerMinute?: unknown;
  publicClientStandardRateLimitPerMinute?: unknown;
  highRiskPermissionsAdditional?: unknown;
  publicClientStandardToolIds?: unknown;
  bulkCanaryProtected?: unknown;
}

const SETTINGS_FIELDS = new Set([
  'enabled',
  'maxTokenTtlSeconds',
  'elevationMode',
  'elevationTtlSeconds',
  'rateLimitPerMinute',
  'publicClientStandardRateLimitPerMinute',
  'highRiskPermissionsAdditional',
  'publicClientStandardToolIds',
  'bulkCanaryProtected',
]);
const ELEVATION_MODES = new Set<AgentElevationMode>(['self_reauth', 'approval', 'both']);
const KNOWN_ADMIN_PERMISSIONS = new Set<string>(Object.values(ADMIN_PERMISSIONS));
const PUBLIC_CLIENT_STANDARD_TOOL_IDS = new Set(
  createAdminToolCatalog()
    .list()
    .filter(isPublicClientStandardOptInEligibleTool)
    .map((tool) => tool.id)
);

export const agentSettingsRouter = new Hono<{
  Bindings: AgentSettingsEnv;
  Variables: { adminAuth?: AdminAuthContext };
}>();

agentSettingsRouter.use('*', adminAuthMiddleware());

function settingsStore(env: AgentSettingsEnv): KVNamespace | null {
  return env.SETTINGS ?? env.AUTHRIM_CONFIG ?? null;
}

function settingsKey(tenantId: string): string {
  return `settings:tenant:${tenantId}:agent-access`;
}

function tenantId(auth: AdminAuthContext, env: AgentSettingsEnv): string {
  return auth.tenantId ?? env.DEFAULT_TENANT_ID ?? 'default';
}

function error(c: AgentSettingsContext, status: 400 | 403 | 503, code: string) {
  return c.json({ error: code, error_description: code }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value: unknown, minimum: number, maximum: number): number | null {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? (value as number)
    : null;
}

function parseBody(value: unknown): AgentAccessSettings | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !SETTINGS_FIELDS.has(key))) return null;
  const body = value as AgentSettingsBody;
  const maxTokenTtlSeconds = integer(body.maxTokenTtlSeconds, 60, 900);
  const elevationTtlSeconds = integer(body.elevationTtlSeconds, 60, 300);
  const rateLimitPerMinute = integer(body.rateLimitPerMinute, 1, 1_000);
  const publicClientStandardRateLimitPerMinute = integer(
    body.publicClientStandardRateLimitPerMinute,
    1,
    60
  );
  if (
    typeof body.enabled !== 'boolean' ||
    typeof body.elevationMode !== 'string' ||
    !ELEVATION_MODES.has(body.elevationMode as AgentElevationMode) ||
    maxTokenTtlSeconds === null ||
    elevationTtlSeconds === null ||
    rateLimitPerMinute === null ||
    publicClientStandardRateLimitPerMinute === null ||
    publicClientStandardRateLimitPerMinute > rateLimitPerMinute ||
    typeof body.bulkCanaryProtected !== 'boolean' ||
    !Array.isArray(body.highRiskPermissionsAdditional) ||
    body.highRiskPermissionsAdditional.length > 256 ||
    !Array.isArray(body.publicClientStandardToolIds) ||
    body.publicClientStandardToolIds.length > PUBLIC_CLIENT_STANDARD_TOOL_IDS.size
  ) {
    return null;
  }
  const additional = body.highRiskPermissionsAdditional;
  const standardTools = body.publicClientStandardToolIds;
  if (
    additional.some(
      (permission) =>
        typeof permission !== 'string' ||
        !KNOWN_ADMIN_PERMISSIONS.has(permission) ||
        permission.length > 256
    )
  ) {
    return null;
  }
  if (
    standardTools.some(
      (toolId) => typeof toolId !== 'string' || !PUBLIC_CLIENT_STANDARD_TOOL_IDS.has(toolId)
    )
  ) {
    return null;
  }
  return {
    enabled: body.enabled,
    maxTokenTtlSeconds,
    elevationMode: body.elevationMode as AgentElevationMode,
    elevationTtlSeconds,
    rateLimitPerMinute,
    publicClientStandardRateLimitPerMinute,
    highRiskPermissionsAdditional: [...new Set(additional as string[])].sort(),
    publicClientStandardToolIds: [...new Set(standardTools as string[])].sort(),
    bulkCanaryProtected: body.bulkCanaryProtected,
  };
}

async function readStoredRecord(
  store: KVNamespace,
  key: string
): Promise<{
  raw: string | null;
  record: Record<string, unknown>;
}> {
  const raw = await store.get(key);
  if (!raw) return { raw: null, record: {} };
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error('invalid_agent_settings_record');
  return { raw, record: parsed };
}

agentSettingsRouter.get('/', async (c) => {
  const auth = c.get('adminAuth') as AdminAuthContext;
  if (!hasAdminPermission(auth.permissions ?? [], ADMIN_PERMISSIONS.AGENT_SETTINGS_READ)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const store = settingsStore(c.env);
  if (!store) return error(c, 503, 'AGENT_SETTINGS_STORE_UNAVAILABLE');
  try {
    const { record } = await readStoredRecord(store, settingsKey(tenantId(auth, c.env)));
    if (record[AGENT_ACCESS_SETTING_KEYS.enabled] === undefined && c.env.ENABLE_AGENT_MCP) {
      record[AGENT_ACCESS_SETTING_KEYS.enabled] =
        c.env.ENABLE_AGENT_MCP.trim().toLowerCase() === 'true';
    }
    return c.json({ settings: parseAgentAccessSettings(record) });
  } catch {
    return error(c, 503, 'AGENT_SETTINGS_UNAVAILABLE');
  }
});

agentSettingsRouter.put('/', async (c) => {
  const auth = c.get('adminAuth') as AdminAuthContext;
  if (!hasAdminPermission(auth.permissions ?? [], ADMIN_PERMISSIONS.AGENT_SETTINGS_WRITE)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  if (auth.actorType && auth.actorType !== 'human') {
    return error(c, 403, 'AGENT_SETTINGS_HUMAN_ACTOR_REQUIRED');
  }
  const store = settingsStore(c.env);
  if (!store) return error(c, 503, 'AGENT_SETTINGS_STORE_UNAVAILABLE');
  let requested: AgentAccessSettings | null;
  try {
    requested = parseBody(await c.req.json());
  } catch {
    requested = null;
  }
  if (!requested) return error(c, 400, 'AGENT_SETTINGS_INVALID_REQUEST');

  const tenant = tenantId(auth, c.env);
  const key = settingsKey(tenant);
  try {
    const { raw: previousRaw, record } = await readStoredRecord(store, key);
    const before = parseAgentAccessSettings(record);
    const now = Date.now();
    const previousVersion = Number.isSafeInteger(record[AGENT_ACCESS_SETTING_KEYS.version])
      ? (record[AGENT_ACCESS_SETTING_KEYS.version] as number)
      : 0;
    const nextRecord: Record<string, unknown> = {
      ...record,
      [AGENT_ACCESS_SETTING_KEYS.enabled]: requested.enabled,
      [AGENT_ACCESS_SETTING_KEYS.maxTokenTtlSeconds]: requested.maxTokenTtlSeconds,
      [AGENT_ACCESS_SETTING_KEYS.elevationMode]: requested.elevationMode,
      [AGENT_ACCESS_SETTING_KEYS.elevationTtlSeconds]: requested.elevationTtlSeconds,
      [AGENT_ACCESS_SETTING_KEYS.rateLimitPerMinute]: requested.rateLimitPerMinute,
      [AGENT_ACCESS_SETTING_KEYS.publicClientStandardRateLimitPerMinute]:
        requested.publicClientStandardRateLimitPerMinute,
      [AGENT_ACCESS_SETTING_KEYS.highRiskPermissionsAdditional]:
        requested.highRiskPermissionsAdditional,
      [AGENT_ACCESS_SETTING_KEYS.publicClientStandardToolIds]:
        requested.publicClientStandardToolIds,
      [AGENT_ACCESS_SETTING_KEYS.bulkCanaryProtected]: requested.bulkCanaryProtected,
      [AGENT_ACCESS_SETTING_KEYS.version]: previousVersion + 1,
      [AGENT_ACCESS_SETTING_KEYS.updatedAt]: now,
      [AGENT_ACCESS_SETTING_KEYS.updatedBy]: auth.userId,
    };
    await store.put(key, JSON.stringify(nextRecord));
    const auditId = await writeAdminAuditLog(c, {
      action: 'agent.settings.updated',
      resourceType: 'agent_settings',
      resourceId: tenant,
      result: 'success',
      before: { ...before },
      after: { ...requested },
      metadata: { settings_version: previousVersion + 1 },
    });
    if (!auditId) {
      if (previousRaw === null) await store.delete(key);
      else await store.put(key, previousRaw);
      return error(c, 503, 'AGENT_SETTINGS_AUDIT_UNAVAILABLE');
    }
    return c.json({ settings: requested, version: previousVersion + 1 });
  } catch {
    return error(c, 503, 'AGENT_SETTINGS_UPDATE_FAILED');
  }
});
