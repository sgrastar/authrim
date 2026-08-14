import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import {
  createAuditLogFromContext,
  ensureDatabaseAdapter,
  getLogger,
  getTenantIdFromContext,
} from '@authrim/ar-lib-core';
import { resolveRuntimeIdentityMappingBinding } from '@authrim/ar-lib-core/services/identity-mapping-runtime-resolver';

export const SCIM_SETTINGS_CATEGORY = 'scim';
export const DEFAULT_SCIM_BULK_MAX_OPERATIONS = 100;
export const DEFAULT_SCIM_BULK_MAX_PAYLOAD_SIZE = 1_048_576;

export interface ScimInboundSettings {
  enabled: boolean;
  usersEnabled: boolean;
  groupsEnabled: boolean;
  bulkEnabled: boolean;
  mappingSetId: string | null;
  bulkMaxOperations: number;
  bulkMaxPayloadSize: number;
}

const DEFAULT_SCIM_INBOUND_SETTINGS: ScimInboundSettings = {
  enabled: false,
  usersEnabled: true,
  groupsEnabled: true,
  bulkEnabled: true,
  mappingSetId: null,
  bulkMaxOperations: DEFAULT_SCIM_BULK_MAX_OPERATIONS,
  bulkMaxPayloadSize: DEFAULT_SCIM_BULK_MAX_PAYLOAD_SIZE,
};

export function scimSettingsKey(tenantId: string): string {
  return `settings:tenant:${tenantId}:${SCIM_SETTINGS_CATEGORY}`;
}

export async function getScimInboundSettings(
  env: Pick<Env, 'SETTINGS'>,
  tenantId: string
): Promise<ScimInboundSettings> {
  const raw = await env.SETTINGS?.get(scimSettingsKey(tenantId));
  if (!raw) return { ...DEFAULT_SCIM_INBOUND_SETTINGS };

  try {
    return normalizeScimInboundSettings(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_SCIM_INBOUND_SETTINGS };
  }
}

function normalizeScimInboundSettings(value: unknown): ScimInboundSettings {
  const record = isRecord(value) ? value : {};
  return {
    enabled: readBoolean(record.enabled, DEFAULT_SCIM_INBOUND_SETTINGS.enabled),
    usersEnabled: readBoolean(record.usersEnabled, DEFAULT_SCIM_INBOUND_SETTINGS.usersEnabled),
    groupsEnabled: readBoolean(record.groupsEnabled, DEFAULT_SCIM_INBOUND_SETTINGS.groupsEnabled),
    bulkEnabled: readBoolean(record.bulkEnabled, DEFAULT_SCIM_INBOUND_SETTINGS.bulkEnabled),
    mappingSetId: readNullableId(record.mappingSetId),
    bulkMaxOperations: readInteger(
      record.bulkMaxOperations,
      1,
      1_000,
      DEFAULT_SCIM_INBOUND_SETTINGS.bulkMaxOperations
    ),
    bulkMaxPayloadSize: readInteger(
      record.bulkMaxPayloadSize,
      1_024,
      10_485_760,
      DEFAULT_SCIM_INBOUND_SETTINGS.bulkMaxPayloadSize
    ),
  };
}

export async function adminScimSettingsGetHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  return c.json({ settings: await getScimInboundSettings(c.env, tenantId) });
}

export async function adminScimSettingsUpdateHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('SCIM-SETTINGS');
  try {
    if (!c.env.SETTINGS) {
      return c.json({ error: 'settings_store_unavailable' }, 503);
    }
    const tenantId = getTenantIdFromContext(c);
    const body = await c.req.json<unknown>();
    if (!isRecord(body)) {
      return c.json({ error: 'invalid_request', message: 'Request body must be an object' }, 400);
    }
    const settings = normalizeScimInboundSettings(body);
    if (settings.enabled && !settings.mappingSetId) {
      return c.json(
        {
          error: 'invalid_request',
          message: 'mappingSetId is required when SCIM inbound provisioning is enabled',
        },
        400
      );
    }
    if (settings.enabled && settings.mappingSetId) {
      const binding = await resolveRuntimeIdentityMappingBinding(
        ensureDatabaseAdapter(c.env.DB_ADMIN, 'scim-settings-mapping-validation'),
        {
          tenantId,
          protocol: 'scim',
          role: 'receiver',
          fieldMappingSetId: settings.mappingSetId,
        }
      );
      if (!binding) {
        return c.json(
          {
            error: 'invalid_request',
            message: 'Selected Mapping Set must have an active compiled version',
          },
          400
        );
      }
    }
    await c.env.SETTINGS.put(scimSettingsKey(tenantId), JSON.stringify(settings));
    await createAuditLogFromContext(c, 'scim.settings.update', 'scim_settings', tenantId, {
      enabled: settings.enabled,
      usersEnabled: settings.usersEnabled,
      groupsEnabled: settings.groupsEnabled,
      bulkEnabled: settings.bulkEnabled,
      mappingSetId: settings.mappingSetId,
    });
    return c.json({ settings });
  } catch (error) {
    log.error('Failed to update SCIM settings', {}, error as Error);
    return c.json({ error: 'internal_error' }, 500);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readNullableId(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128 ? normalized : null;
}

function readInteger(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}
