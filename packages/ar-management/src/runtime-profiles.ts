import { z } from 'zod';
import type { Context } from 'hono';
import type {
  AdminAuthContext,
  AuditProfile,
  Env,
  ResidencyProfile,
  RuntimeProfile,
  RuntimeProfileKind,
} from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  createErrorResponse,
  createRuntimeProfileRegistryFromEnv,
  createSettingsManager,
  getLogger,
  INFRASTRUCTURE_CATEGORY_META,
  loadEnvironmentProfileDefaultsFromEnv,
  loadTenantProfileOverridesFromEnv,
  purgeTenantRuntimeRegistrySnapshot,
} from '@authrim/ar-lib-core';
import { validateAuditOperationalConstraints } from './audit-ops-policy';
import {
  buildRuntimeProfileReferenceCatalog,
  describeRuntimeProfileActivationStatus,
  describeRuntimeProfileReferenceStatus,
  RUNTIME_PROFILE_REFERENCE_MANAGEMENT_POLICY,
  type RuntimeProfileReferenceCatalog,
} from './runtime-profile-reference-status';
import { ensureSupportedTenantId } from './single-tenant-guard';
import { requireTenantResourceAccess } from './admin-tenant-access';
import { writeAdminAuditLog } from './admin-shared';

type AdminRuntimeProfileKind = Extract<RuntimeProfileKind, 'audit' | 'residency'>;

const VALID_KINDS = ['audit', 'residency'] as const satisfies readonly AdminRuntimeProfileKind[];
const QUERY_SCHEMA = z.object({
  kind: z.enum(VALID_KINDS).optional(),
  include_builtins: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value !== 'false'),
});
const VERSION_SCHEMA = z.number().int().positive().optional();
const METADATA_SCHEMA = z.record(z.string(), z.unknown()).optional();

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
      url: z
        .string()
        .url()
        .refine((value) => value.startsWith('https://'), {
          message: 'HTTP audit targets must use https URLs',
        })
        .optional(),
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

const AuditBackpressureSchema = z
  .object({
    mode: z.enum(['event_class', 'fail_closed_all']),
    allowTenantOverride: z.boolean().optional(),
    eventCategoryOverrides: z
      .record(z.string(), z.enum(['inherit', 'fail_open', 'fail_closed']))
      .optional(),
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
          z
            .object({
              type: z.literal('http'),
              url: z
                .string()
                .url()
                .refine((value) => value.startsWith('https://'), {
                  message: 'HTTP audit targets must use https URLs',
                })
                .optional(),
              urlRef: z.string().min(1).optional(),
              authTokenRef: z.string().min(1).optional(),
              method: z.literal('POST').optional(),
              headers: z.record(z.string(), z.string()).optional(),
              format: z.literal('json').optional(),
            })
            .superRefine((value, ctx) => {
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
    backpressure: AuditBackpressureSchema.optional(),
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
    auditProfileId: z.string().min(1).optional(),
    residencyProfileId: z.string().min(1).optional(),
  })
  .strict()
  .refine((value) => value.auditProfileId !== undefined || value.residencyProfileId !== undefined, {
    message: 'At least one default profile ID must be provided',
  });

const RuntimeRegistryEmergencyPurgeBodySchema = z
  .object({
    breakGlassConfirmation: z.string().min(1),
    reason: z.string().min(1),
    deploymentTarget: z.string().min(1).optional(),
  })
  .strict();

function isRuntimeProfileKind(value: string | undefined): value is AdminRuntimeProfileKind {
  return value !== undefined && VALID_KINDS.includes(value as AdminRuntimeProfileKind);
}

function getRegistryBackend(env: Env): string {
  return env.PROFILE_REGISTRY_BACKEND ?? 'kv';
}

function createInfrastructureSettingsManager(env: Env) {
  const manager = createSettingsManager({
    env: {
      DEFAULT_AUDIT_PROFILE_ID: env.DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID: env.DEFAULT_RESIDENCY_PROFILE_ID,
    },
    kv: env.SETTINGS ?? null,
    cacheTTL: 0,
  });
  manager.registerCategory(INFRASTRUCTURE_CATEGORY_META);
  return manager;
}

type RuntimeProfileDraft =
  | Omit<AuditProfile, 'id' | 'builtin'>
  | Omit<ResidencyProfile, 'id' | 'builtin'>;

function parseRuntimeProfileBody(
  kind: AdminRuntimeProfileKind,
  body: unknown
): RuntimeProfileDraft | null {
  if (kind === 'audit') {
    const parsed = AuditProfileBodySchema.safeParse(body);
    return parsed.success
      ? ({ kind, ...parsed.data } as Omit<AuditProfile, 'id' | 'builtin'>)
      : null;
  }

  const parsed = ResidencyProfileBodySchema.safeParse(body);
  return parsed.success
    ? ({ kind, ...parsed.data } as Omit<ResidencyProfile, 'id' | 'builtin'>)
    : null;
}

function buildPersistedProfile(
  kind: AdminRuntimeProfileKind,
  id: string,
  parsed: RuntimeProfileDraft
): RuntimeProfile {
  if (kind === 'audit') {
    return { ...(parsed as Omit<AuditProfile, 'id' | 'builtin'>), id, builtin: false };
  }
  return { ...(parsed as Omit<ResidencyProfile, 'id' | 'builtin'>), id, builtin: false };
}

function validateAuditProfileForEnvironment(profile: AuditProfile, env: Env): string[] {
  return validateAuditOperationalConstraints(profile, {
    queueConfigured: Boolean(env.AUDIT_QUEUE),
  });
}

function buildRuntimeProfileActivationStatusMap(
  env: Env,
  profiles: Partial<Record<RuntimeProfileKind, RuntimeProfile[]>>
) {
  return Object.fromEntries(
    Object.entries(profiles).map(([profileKind, entries]) => [
      profileKind,
      (entries as RuntimeProfile[]).reduce<
        Record<string, ReturnType<typeof describeRuntimeProfileActivationStatus>>
      >((acc, profile) => {
        acc[profile.id] = describeRuntimeProfileActivationStatus(env, profile);
        return acc;
      }, {}),
    ])
  );
}

function describeOptionalRuntimeProfileActivationStatus(
  env: Env,
  profile: RuntimeProfile | null | undefined
) {
  if (!profile) {
    return {
      state: 'blocked' as const,
      activatable: false,
      severity: 'error' as const,
      blockingReasons: ['Runtime profile is not configured.'],
      warnings: [],
    };
  }

  return describeRuntimeProfileActivationStatus(env, profile);
}

async function loadRuntimeProfileReferenceCatalog(
  env: Env
): Promise<RuntimeProfileReferenceCatalog> {
  const registry = createRuntimeProfileRegistryFromEnv(env);
  const entries = await Promise.all(VALID_KINDS.map(async (kind) => await registry.list(kind)));
  return buildRuntimeProfileReferenceCatalog(env, entries.flat() as RuntimeProfile[]);
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
      kinds.map(async (kind) => [kind, await registry.list(kind, { includeBuiltins })] as const)
    );
    const profiles = Object.fromEntries(listed);
    const referenceStatus = Object.fromEntries(
      Object.entries(profiles).map(([profileKind, entries]) => [
        profileKind,
        (entries as RuntimeProfile[]).reduce<
          Record<string, ReturnType<typeof describeRuntimeProfileReferenceStatus>>
        >((acc, profile) => {
          acc[profile.id] = describeRuntimeProfileReferenceStatus(c.env, profile);
          return acc;
        }, {}),
      ])
    );
    const activationStatus = buildRuntimeProfileActivationStatusMap(
      c.env,
      profiles as Partial<Record<RuntimeProfileKind, RuntimeProfile[]>>
    );
    const referenceCatalog = await loadRuntimeProfileReferenceCatalog(c.env);

    return c.json({
      registry_backend: getRegistryBackend(c.env),
      include_builtins: includeBuiltins,
      profiles,
      reference_status: referenceStatus,
      activation_status: activationStatus,
      reference_catalog: referenceCatalog,
      reference_management: RUNTIME_PROFILE_REFERENCE_MANAGEMENT_POLICY,
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
      reference_status: describeRuntimeProfileReferenceStatus(c.env, profile),
      activation_status: describeRuntimeProfileActivationStatus(c.env, profile),
      reference_catalog: await loadRuntimeProfileReferenceCatalog(c.env),
      reference_management: RUNTIME_PROFILE_REFERENCE_MANAGEMENT_POLICY,
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
    if (kind === 'audit') {
      const auditErrors = validateAuditProfileForEnvironment(profile as AuditProfile, c.env);
      if (auditErrors.length > 0) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: { field: 'body', reason: auditErrors.join(' ') },
        });
      }
    }
    await registry.put(profile);

    return c.json(
      {
        registry_backend: getRegistryBackend(c.env),
        created: !existing,
        profile,
        reference_status: describeRuntimeProfileReferenceStatus(c.env, profile),
        activation_status: describeRuntimeProfileActivationStatus(c.env, profile),
        reference_catalog: await loadRuntimeProfileReferenceCatalog(c.env),
        reference_management: RUNTIME_PROFILE_REFERENCE_MANAGEMENT_POLICY,
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
    const [audit, residency] = await Promise.all([
      registry.get('audit', defaults.auditProfileId),
      registry.get('residency', defaults.residencyProfileId),
    ]);

    return c.json({
      registry_backend: getRegistryBackend(c.env),
      defaults: {
        auditProfileId: defaults.auditProfileId,
        residencyProfileId: defaults.residencyProfileId,
      },
      effective: {
        audit,
        residency,
      },
      reference_status: {
        audit: audit ? describeRuntimeProfileReferenceStatus(c.env, audit) : [],
        residency: residency ? describeRuntimeProfileReferenceStatus(c.env, residency) : [],
      },
      activation_status: {
        audit: describeOptionalRuntimeProfileActivationStatus(c.env, audit),
        residency: describeOptionalRuntimeProfileActivationStatus(c.env, residency),
      },
      reference_catalog: await loadRuntimeProfileReferenceCatalog(c.env),
      reference_management: RUNTIME_PROFILE_REFERENCE_MANAGEMENT_POLICY,
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

    if (parsedBody.data.auditProfileId !== undefined) {
      const profile = await registry.get('audit', parsedBody.data.auditProfileId);
      if (!profile) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
          variables: { resource: 'runtime_profile' },
        });
      }
      const auditErrors = validateAuditProfileForEnvironment(profile as AuditProfile, c.env);
      if (auditErrors.length > 0) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: { field: 'auditProfileId', reason: auditErrors.join(' ') },
        });
      }
      const activation = describeRuntimeProfileActivationStatus(c.env, profile);
      if (!activation.activatable) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: {
            field: 'auditProfileId',
            reason: activation.blockingReasons.join(' '),
          },
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
    const [audit, residency] = await Promise.all([
      registry.get('audit', defaults.auditProfileId),
      registry.get('residency', defaults.residencyProfileId),
    ]);

    return c.json({
      registry_backend: getRegistryBackend(c.env),
      updated: Object.keys(updates),
      defaults: {
        auditProfileId: defaults.auditProfileId,
        residencyProfileId: defaults.residencyProfileId,
      },
      effective: {
        audit,
        residency,
      },
      reference_status: {
        audit: audit ? describeRuntimeProfileReferenceStatus(c.env, audit) : [],
        residency: residency ? describeRuntimeProfileReferenceStatus(c.env, residency) : [],
      },
      activation_status: {
        audit: describeOptionalRuntimeProfileActivationStatus(c.env, audit),
        residency: describeOptionalRuntimeProfileActivationStatus(c.env, residency),
      },
      reference_catalog: await loadRuntimeProfileReferenceCatalog(c.env),
      reference_management: RUNTIME_PROFILE_REFERENCE_MANAGEMENT_POLICY,
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
  const accessError = await requireTenantResourceAccess(c, tenantId);
  if (accessError) {
    return accessError;
  }

  try {
    const [defaults, overrides] = await Promise.all([
      loadEnvironmentProfileDefaultsFromEnv(c.env),
      loadTenantProfileOverridesFromEnv(c.env, tenantId),
    ]);
    const auditProfileId = overrides.auditProfileId ?? defaults.auditProfileId;
    const residencyProfileId = overrides.residencyProfileId ?? defaults.residencyProfileId;
    const registry = createRuntimeProfileRegistryFromEnv(c.env);
    const [auditProfile, residencyProfile] = await Promise.all([
      registry.get<AuditProfile>('audit', auditProfileId),
      registry.get<ResidencyProfile>('residency', residencyProfileId),
    ]);
    if (!auditProfile) {
      throw new Error(`audit_profile_not_found:${auditProfileId}`);
    }
    if (!residencyProfile) {
      throw new Error(`residency_profile_not_found:${residencyProfileId}`);
    }

    return c.json({
      tenant_id: tenantId,
      registry_backend: getRegistryBackend(c.env),
      refs: {
        auditProfileId,
        residencyProfileId,
        inherited: {
          audit: !overrides.auditProfileId,
          residency: !overrides.residencyProfileId,
        },
      },
      effective: {
        audit: auditProfile,
        residency: residencyProfile,
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

export async function adminTenantRuntimeRegistryEmergencyPurgeHandler(
  c: Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>
) {
  const tenantId = c.req.param('id')!;
  if (!tenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  const blocked = await ensureSupportedTenantId(c, tenantId);
  if (blocked) {
    return blocked;
  }
  if (!c.env.TENANT_RUNTIME_REGISTRY) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: {
        field: 'TENANT_RUNTIME_REGISTRY',
        reason: 'runtime registry KV binding is not configured',
      },
    });
  }

  const rawBody = await c.req.json<unknown>().catch(() => null);
  const parsedBody = RuntimeRegistryEmergencyPurgeBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'body' },
    });
  }

  const auth = c.get('adminAuth') as AdminAuthContext | undefined;
  try {
    const result = await purgeTenantRuntimeRegistrySnapshot({
      tenantId,
      snapshotStore: c.env.TENANT_RUNTIME_REGISTRY,
      deploymentTarget: parsedBody.data.deploymentTarget,
      actorId: auth?.actorId ?? auth?.userId ?? 'unknown',
      actorRoles: auth?.roles ?? [],
      breakGlassConfirmation: parsedBody.data.breakGlassConfirmation,
      reason: parsedBody.data.reason,
    });
    await writeAdminAuditLog(c, {
      action: result.auditEvent.action,
      resourceType: result.auditEvent.resourceType,
      resourceId: result.auditEvent.resourceId,
      result: 'success',
      severity: 'critical',
      metadata: result.auditEvent.metadata,
    });

    return c.json({
      purged: true,
      tenant_id: result.tenantId,
      deployment_target: result.deploymentTarget,
      snapshot_key: result.snapshotKey,
      generation_key: result.generationKey,
      purged_at: result.purgedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'tenant_runtime_registry_purge_requires_system_admin') {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS, {
        variables: { resource: 'tenant_runtime_registry_snapshot' },
      });
    }
    if (
      message === 'tenant_runtime_registry_purge_requires_break_glass_confirmation' ||
      message === 'tenant_runtime_registry_purge_requires_reason'
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'body', reason: message },
      });
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
