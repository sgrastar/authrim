import { z } from 'zod';
import type { Context } from 'hono';
import type {
  AuditProfile,
  Env,
  ResidencyProfile,
  RuntimeProfile,
  RuntimeProfileKind,
  StorageProfile,
} from '@authrim/ar-lib-core';
import {
  AUTH_CORE_STORAGE_SLICE,
  AUTH_CORE_STORAGE_SLICES,
  AR_ERROR_CODES,
  createErrorResponse,
  createRuntimeProfileRegistryFromEnv,
  createSettingsManager,
  getLogger,
  INFRASTRUCTURE_CATEGORY_META,
  STORAGE_SLICE_BOUNDARY_POLICIES,
  loadEnvironmentProfileDefaultsFromEnv,
  resolveTenantRuntimeProfilesFromEnv,
  validateTenantStorageProfileOverride,
} from '@authrim/ar-lib-core';
import { ensureSupportedTenantId } from './single-tenant-guard';

const VALID_KINDS = ['storage', 'audit', 'residency'] as const satisfies readonly RuntimeProfileKind[];
const QUERY_SCHEMA = z.object({
  kind: z.enum(VALID_KINDS).optional(),
  include_builtins: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value !== 'false'),
});

const VERSION_SCHEMA = z.number().int().positive().optional();
const METADATA_SCHEMA = z.record(z.string(), z.unknown()).optional();

const StorageTargetSchema = z
  .object({
    driver: z.enum(['d1', 'postgres', 'mysql']),
    bindingRef: z.string().min(1).optional(),
    connectionRef: z.string().min(1).optional(),
    role: z.enum(['core', 'pii', 'admin', 'custom']).optional(),
  })
  .refine((value) => Boolean(value.bindingRef || value.connectionRef), {
    message: 'Storage targets require bindingRef or connectionRef',
  });

const StorageProfileBodySchema = z
  .object({
    label: z.string().min(1),
    description: z.string().min(1).optional(),
    version: VERSION_SCHEMA,
    metadata: METADATA_SCHEMA,
    residencyProfileId: z.string().min(1).optional(),
    slices: z
      .object({
        users_core: StorageTargetSchema.optional(),
        users_pii: StorageTargetSchema.optional(),
        custom_claims: StorageTargetSchema.optional(),
        registration_fields: StorageTargetSchema.optional(),
        custom_pii: StorageTargetSchema.optional(),
      })
      .superRefine((value, ctx) => {
        if (
          !value.users_core &&
          !value.users_pii &&
          !value.custom_claims &&
          !value.registration_fields &&
          !value.custom_pii
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'At least one storage slice must be configured',
          });
        }
      }),
  })
  .strict();

const DatabaseAuditTargetSchema = z.object({
  type: z.enum(['d1', 'postgres', 'mysql']),
  bindingRef: z.string().min(1).optional(),
  connectionRef: z.string().min(1).optional(),
  dataset: z.string().min(1).optional(),
});

const AuditTargetSchema = z
  .union([
    DatabaseAuditTargetSchema,
    z.object({
      type: z.literal('r2'),
      bucketRef: z.string().min(1),
      prefix: z.string().min(1).optional(),
    }),
    z.object({
      type: z.literal('logpush'),
      destinationRef: z.string().min(1),
      dataset: z.string().min(1).optional(),
    }),
    z.object({
      type: z.literal('firehose'),
      streamRef: z.string().min(1),
    }),
    z.object({
      type: z.literal('http'),
      url: z.string().url().refine((value) => value.startsWith('https://'), {
        message: 'HTTP audit targets must use https URLs',
      }).optional(),
      urlRef: z.string().min(1).optional(),
      authTokenRef: z.string().min(1).optional(),
      method: z.literal('POST').optional(),
      headers: z.record(z.string(), z.string()).optional(),
      format: z.literal('json').optional(),
    }),
  ])
  .superRefine((value, ctx) => {
    if (
      (value.type === 'd1' || value.type === 'postgres' || value.type === 'mysql') &&
      !value.bindingRef &&
      !value.connectionRef
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Database audit targets require bindingRef or connectionRef',
      });
    }
    if (value.type === 'http' && !value.url && !value.urlRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'HTTP audit targets require url or urlRef',
      });
    }
  });

const AuditRetentionSchema = z
  .object({
    eventLogRetentionDays: z.number().int().positive().nullable().optional(),
    piiLogRetentionDays: z.number().int().positive().nullable().optional(),
    archiveBeforeDelete: z.boolean().optional(),
    minimumRetentionDays: z.number().int().positive().nullable().optional(),
    primaryDays: z.number().int().positive().nullable().optional(),
    archiveDays: z.number().int().positive().nullable().optional(),
  })
  .strict();

const AuditProfileBodySchema = z
  .object({
    label: z.string().min(1),
    description: z.string().min(1).optional(),
    version: VERSION_SCHEMA,
    metadata: METADATA_SCHEMA,
    primary: DatabaseAuditTargetSchema.nullable(),
    archive: z
      .union([
        DatabaseAuditTargetSchema,
        z.object({
          type: z.literal('r2'),
          bucketRef: z.string().min(1),
          prefix: z.string().min(1).optional(),
        }),
      ])
      .nullable()
      .optional(),
    sinks: z
      .array(
        z.union([
          z.object({
            type: z.literal('logpush'),
            destinationRef: z.string().min(1),
            dataset: z.string().min(1).optional(),
          }),
          z.object({
            type: z.literal('firehose'),
            streamRef: z.string().min(1),
          }),
          z.object({
            type: z.literal('http'),
            url: z.string().url().refine((value) => value.startsWith('https://'), {
              message: 'HTTP audit targets must use https URLs',
            }).optional(),
            urlRef: z.string().min(1).optional(),
            authTokenRef: z.string().min(1).optional(),
            method: z.literal('POST').optional(),
            headers: z.record(z.string(), z.string()).optional(),
            format: z.literal('json').optional(),
          }).superRefine((value, ctx) => {
            if (!value.url && !value.urlRef) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'HTTP audit targets require url or urlRef',
              });
            }
          }),
        ])
      )
      .default([]),
    retention: AuditRetentionSchema.optional(),
    archiveFailureMode: z.enum(['best_effort', 'gate_cleanup']).optional(),
    sinkFailureMode: z.enum(['best_effort', 'retry_until_ttl']).optional(),
  })
  .strict();

const ResidencyProfileBodySchema = z
  .object({
    label: z.string().min(1),
    description: z.string().min(1).optional(),
    version: VERSION_SCHEMA,
    metadata: METADATA_SCHEMA,
    locationHint: z.enum(['auto', 'wnam', 'enam', 'weur', 'eeur', 'apac', 'oc']),
    jurisdiction: z.enum(['none', 'eu', 'jp', 'us']),
    allowedRegions: z.array(z.string().min(1)).optional(),
  })
  .strict();

const RuntimeProfileDefaultsBodySchema = z
  .object({
    storageProfileId: z.string().min(1).optional(),
    auditProfileId: z.string().min(1).optional(),
    residencyProfileId: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.storageProfileId !== undefined ||
      value.auditProfileId !== undefined ||
      value.residencyProfileId !== undefined,
    {
      message: 'At least one default profile ID must be provided',
    }
  );

function isRuntimeProfileKind(value: string | undefined): value is RuntimeProfileKind {
  return value !== undefined && VALID_KINDS.includes(value as RuntimeProfileKind);
}

function getRegistryBackend(env: Env): string {
  return env.PROFILE_REGISTRY_BACKEND ?? 'kv';
}

function createInfrastructureSettingsManager(env: Env) {
  const manager = createSettingsManager({
    env: {
      DEFAULT_STORAGE_PROFILE_ID: env.DEFAULT_STORAGE_PROFILE_ID,
      DEFAULT_AUDIT_PROFILE_ID: env.DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID: env.DEFAULT_RESIDENCY_PROFILE_ID,
    },
    kv: env.SETTINGS ?? null,
    cacheTTL: 0,
  });
  manager.registerCategory(INFRASTRUCTURE_CATEGORY_META);
  return manager;
}

interface StorageProfileTenantOverridePolicy {
  authCoreSlice: typeof AUTH_CORE_STORAGE_SLICE;
  authCoreSlices: readonly string[];
  slicePolicies: typeof STORAGE_SLICE_BOUNDARY_POLICIES;
  environmentDefaultStorageProfileId: string;
  tenantOverrideAllowed: boolean;
  violationCode?: string;
  reason?: string;
}

interface StoragePolicyContext {
  defaultStorageProfileId: string;
  defaultStorageProfile: StorageProfile;
}

function buildStoragePolicyCatalog(context: StoragePolicyContext) {
  return {
    authCoreSlice: AUTH_CORE_STORAGE_SLICE,
    authCoreSlices: AUTH_CORE_STORAGE_SLICES,
    slicePolicies: STORAGE_SLICE_BOUNDARY_POLICIES,
    environmentDefaultStorageProfileId: context.defaultStorageProfileId,
  };
}

async function loadStoragePolicyContext(env: Env): Promise<StoragePolicyContext> {
  const defaults = await loadEnvironmentProfileDefaultsFromEnv(env);
  const registry = createRuntimeProfileRegistryFromEnv(env);
  const defaultStorageProfile = await registry.get<StorageProfile>('storage', defaults.storageProfileId);

  if (!defaultStorageProfile) {
    throw new Error(`storage_profile_not_found:${defaults.storageProfileId}`);
  }

  return {
    defaultStorageProfileId: defaults.storageProfileId,
    defaultStorageProfile,
  };
}

function describeStorageProfileTenantOverridePolicy(
  context: StoragePolicyContext,
  profile: StorageProfile
): StorageProfileTenantOverridePolicy {
  const violation = validateTenantStorageProfileOverride(context.defaultStorageProfile, profile);
  return {
    ...buildStoragePolicyCatalog(context),
    tenantOverrideAllowed: violation === null,
    violationCode: violation?.code,
    reason: violation?.message,
  };
}

type RuntimeProfileDraft =
  | Omit<StorageProfile, 'id' | 'builtin'>
  | Omit<AuditProfile, 'id' | 'builtin'>
  | Omit<ResidencyProfile, 'id' | 'builtin'>;

function parseRuntimeProfileBody(
  kind: RuntimeProfileKind,
  body: unknown
): RuntimeProfileDraft | null {
  if (kind === 'storage') {
    const parsed = StorageProfileBodySchema.safeParse(body);
    return parsed.success ? ({ kind, ...parsed.data } as Omit<StorageProfile, 'id' | 'builtin'>) : null;
  }
  if (kind === 'audit') {
    const parsed = AuditProfileBodySchema.safeParse(body);
    return parsed.success ? ({ kind, ...parsed.data } as Omit<AuditProfile, 'id' | 'builtin'>) : null;
  }

  const parsed = ResidencyProfileBodySchema.safeParse(body);
  return parsed.success
    ? ({ kind, ...parsed.data } as Omit<ResidencyProfile, 'id' | 'builtin'>)
    : null;
}

function buildPersistedProfile(
  kind: RuntimeProfileKind,
  id: string,
  parsed: RuntimeProfileDraft
): RuntimeProfile {
  if (kind === 'storage') {
    return { ...(parsed as Omit<StorageProfile, 'id' | 'builtin'>), id, builtin: false };
  }
  if (kind === 'audit') {
    return { ...(parsed as Omit<AuditProfile, 'id' | 'builtin'>), id, builtin: false };
  }
  return { ...(parsed as Omit<ResidencyProfile, 'id' | 'builtin'>), id, builtin: false };
}

export async function adminRuntimeProfileListHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN-RUNTIME-PROFILES');

  try {
    const parsedQuery = QUERY_SCHEMA.safeParse(c.req.query());
    if (!parsedQuery.success) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'query' },
      });
    }

    const requestedKind = parsedQuery.data.kind;
    const includeBuiltins = parsedQuery.data.include_builtins;
    const registry = createRuntimeProfileRegistryFromEnv(c.env);
    const kinds = requestedKind ? [requestedKind] : VALID_KINDS;

    const listed = await Promise.all(
      kinds.map(async (kind) => [
        kind,
        await registry.list(kind, { includeBuiltins }),
      ] as const)
    );
    const profiles = Object.fromEntries(listed);
    const storagePolicyContext =
      requestedKind === undefined || requestedKind === 'storage'
        ? await loadStoragePolicyContext(c.env)
        : null;
    const storageProfiles = (profiles.storage as StorageProfile[] | undefined) ?? [];

    return c.json({
      registry_backend: getRegistryBackend(c.env),
      include_builtins: includeBuiltins,
      profiles,
      storage_policy:
        storagePolicyContext && storageProfiles.length > 0
          ? {
              ...buildStoragePolicyCatalog(storagePolicyContext),
              tenantOverrideEligibility: Object.fromEntries(
                storageProfiles.map((profile) => [
                  profile.id,
                  describeStorageProfileTenantOverridePolicy(storagePolicyContext, profile),
                ])
              ),
            }
          : undefined,
    });
  } catch (error) {
    log.error('Failed to list runtime profiles', { error: String(error) });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function adminRuntimeProfileGetHandler(c: Context<{ Bindings: Env }>) {
  const kind = c.req.param('kind');
  const id = c.req.param('id');

  if (!isRuntimeProfileKind(kind)) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'kind', reason: 'Unsupported runtime profile kind' },
    });
  }

  if (!id) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    const registry = createRuntimeProfileRegistryFromEnv(c.env);
    const profile = await registry.get(kind, id);
    if (!profile) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'runtime_profile' },
      });
    }

    return c.json({
      registry_backend: getRegistryBackend(c.env),
      profile,
      storage_policy:
        kind === 'storage'
          ? describeStorageProfileTenantOverridePolicy(
              await loadStoragePolicyContext(c.env),
              profile as StorageProfile
            )
          : undefined,
    });
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function adminRuntimeProfileUpsertHandler(c: Context<{ Bindings: Env }>) {
  const kind = c.req.param('kind');
  const id = c.req.param('id');

  if (!isRuntimeProfileKind(kind)) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'kind', reason: 'Unsupported runtime profile kind' },
    });
  }

  if (!id) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  const rawBody = await c.req.json<unknown>().catch(() => null);
  const parsed = parseRuntimeProfileBody(kind, rawBody);
  if (!parsed) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'body' },
    });
  }

  try {
    const registry = createRuntimeProfileRegistryFromEnv(c.env);
    const existing = await registry.get(kind, id);
    const profile = buildPersistedProfile(kind, id, parsed);
    await registry.put(profile);

    return c.json(
      {
        registry_backend: getRegistryBackend(c.env),
        created: !existing,
        profile,
      },
      existing ? 200 : 201
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'builtin_runtime_profiles_are_read_only') {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT, {
        variables: { resource: 'runtime_profile', reason: 'builtin profiles are read-only' },
      });
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function adminRuntimeProfileDeleteHandler(c: Context<{ Bindings: Env }>) {
  const kind = c.req.param('kind');
  const id = c.req.param('id');

  if (!isRuntimeProfileKind(kind)) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'kind', reason: 'Unsupported runtime profile kind' },
    });
  }

  if (!id) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  if (id.startsWith('builtin:')) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT, {
      variables: { resource: 'runtime_profile', reason: 'builtin profiles are read-only' },
    });
  }

  try {
    const registry = createRuntimeProfileRegistryFromEnv(c.env);
    const deleted = await registry.delete(kind, id);
    if (!deleted) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'runtime_profile' },
      });
    }

    return c.json({
      registry_backend: getRegistryBackend(c.env),
      deleted: true,
    });
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function adminRuntimeProfileDefaultsHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN-RUNTIME-PROFILE-DEFAULTS');

  try {
    const defaults = await loadEnvironmentProfileDefaultsFromEnv(c.env);
    const registry = createRuntimeProfileRegistryFromEnv(c.env);
    const [storage, audit, residency] = await Promise.all([
      registry.get('storage', defaults.storageProfileId),
      registry.get('audit', defaults.auditProfileId),
      registry.get('residency', defaults.residencyProfileId),
    ]);

    return c.json({
      registry_backend: getRegistryBackend(c.env),
      defaults,
      effective: {
        storage,
        audit,
        residency,
      },
    });
  } catch (error) {
    log.error('Failed to load runtime profile defaults', { error: String(error) });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function adminRuntimeProfileDefaultsUpdateHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN-RUNTIME-PROFILE-DEFAULTS');

  if (!c.env.SETTINGS) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  const rawBody = await c.req.json<unknown>().catch(() => null);
  const parsedBody = RuntimeProfileDefaultsBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'body' },
    });
  }

  try {
    const registry = createRuntimeProfileRegistryFromEnv(c.env);
    const updates: Record<string, string> = {};

    if (parsedBody.data.storageProfileId !== undefined) {
      const profile = await registry.get('storage', parsedBody.data.storageProfileId);
      if (!profile) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
          variables: { resource: 'runtime_profile' },
        });
      }
      updates['infra.default_storage_profile_id'] = profile.id;
    }

    if (parsedBody.data.auditProfileId !== undefined) {
      const profile = await registry.get('audit', parsedBody.data.auditProfileId);
      if (!profile) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
          variables: { resource: 'runtime_profile' },
        });
      }
      updates['infra.default_audit_profile_id'] = profile.id;
    }

    if (parsedBody.data.residencyProfileId !== undefined) {
      const profile = await registry.get('residency', parsedBody.data.residencyProfileId);
      if (!profile) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
          variables: { resource: 'runtime_profile' },
        });
      }
      updates['infra.default_residency_profile_id'] = profile.id;
    }

    const manager = createInfrastructureSettingsManager(c.env);
    const current = await manager.getAll('infrastructure', { type: 'platform' });
    await manager.patch(
      'infrastructure',
      { type: 'platform' },
      {
        ifMatch: current.version,
        set: updates,
      },
      'runtime-profile-defaults'
    );

    const defaults = await loadEnvironmentProfileDefaultsFromEnv(c.env);
    const [storage, audit, residency] = await Promise.all([
      registry.get('storage', defaults.storageProfileId),
      registry.get('audit', defaults.auditProfileId),
      registry.get('residency', defaults.residencyProfileId),
    ]);

    return c.json({
      registry_backend: getRegistryBackend(c.env),
      updated: Object.keys(updates),
      defaults,
      effective: {
        storage,
        audit,
        residency,
      },
    });
  } catch (error) {
    log.error('Failed to update runtime profile defaults', { error: String(error) });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function adminTenantRuntimeProfilesHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('id')!;
  const log = getLogger(c).module('ADMIN-RUNTIME-PROFILES');

  if (!tenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  const blocked = await ensureSupportedTenantId(c, tenantId);
  if (blocked) {
    return blocked;
  }

  try {
    const resolved = await resolveTenantRuntimeProfilesFromEnv(c.env, tenantId);
    const storagePolicy = describeStorageProfileTenantOverridePolicy(
      await loadStoragePolicyContext(c.env),
      resolved.storageProfile
    );

    return c.json({
      tenant_id: tenantId,
      registry_backend: getRegistryBackend(c.env),
      refs: resolved.refs,
      effective: {
        storage: resolved.storageProfile,
        audit: resolved.auditProfile,
        residency: resolved.residencyProfile,
      },
      storage_policy: {
        ...storagePolicy,
        tenantOverrideRequested: !resolved.refs.inherited.storage,
      },
    });
  } catch (error) {
    log.error('Failed to resolve tenant runtime profiles', {
      tenantId,
      error: String(error),
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
