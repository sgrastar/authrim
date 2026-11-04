import { DatabaseSettingsCanonicalStore } from '@authrim/ar-lib-core/services/settings-canonical-store';
import { legacyUrlString, z } from './zod';
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
  createRuntimeProfileWriterFromEnv,
  ProfileProjectionDisagreementError,
  createSettingsManager,
  getLogger,
  getPrimaryTenantId,
  hasSystemAdminAuthority,
  INFRASTRUCTURE_CATEGORY_META,
  ConflictError,
  loadEnvironmentProfileDefaultsFromEnv,
  readEnvironmentProfileDefaults,
  loadTenantProfileOverridesFromEnv,
  purgeTenantRuntimeRegistrySnapshot,
  requireDedicatedAdminDatabaseAdapter,
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
import { getAdminAuth, requireTenantResourceAccess } from './admin-tenant-access';
import { writeAdminAuditLog } from './admin-shared';
import { requireAdminStepUp } from './admin-step-up-gate';
import { auditRetentionWeakened } from './audit-retention-compare';
import { auditDeliveryChanged, auditDeliveryDigests } from './audit-profile-delivery';
import {
  readComparedProfile,
  verifySwitchAfterCommit,
  type ProfileSwitchGuard,
} from './profile-switch-verify';

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
      url: legacyUrlString()
        .refine((value) => value.startsWith('https://'), {
          error: 'HTTP audit targets must use https URLs',
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
        code: 'custom',
        message: 'Database audit targets require bindingRef or connectionRef',
      });
    }
    if (value.type === 'http' && !value.url && !value.urlRef) {
      ctx.addIssue({
        code: 'custom',
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
              url: legacyUrlString()
                .refine((value) => value.startsWith('https://'), {
                  error: 'HTTP audit targets must use https URLs',
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
                  code: 'custom',
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
    error: 'At least one default profile ID must be provided',
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

export function createInfrastructureSettingsManager(env: Env, options: { strict?: boolean } = {}) {
  const manager = createSettingsManager({
    strictReads: options.strict === true,
    env: {
      DEFAULT_AUDIT_PROFILE_ID: env.DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID: env.DEFAULT_RESIDENCY_PROFILE_ID,
    },
    kv: env.SETTINGS ?? null,
    cacheTTL: 0,
    // Platform documents are saved through the canonical store, as the Settings API saves them.
    canonicalStore: new DatabaseSettingsCanonicalStore(
      requireDedicatedAdminDatabaseAdapter(env, 'settings-canonical')
    ),
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
    return parsed.success ? { kind, ...parsed.data } : null;
  }

  const parsed = ResidencyProfileBodySchema.safeParse(body);
  return parsed.success ? { kind, ...parsed.data } : null;
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
      entries.reduce<Record<string, ReturnType<typeof describeRuntimeProfileActivationStatus>>>(
        (acc, profile) => {
          acc[profile.id] = describeRuntimeProfileActivationStatus(env, profile);
          return acc;
        },
        {}
      ),
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
        entries.reduce<Record<string, ReturnType<typeof describeRuntimeProfileReferenceStatus>>>(
          (acc, profile) => {
            acc[profile.id] = describeRuntimeProfileReferenceStatus(c.env, profile);
            return acc;
          },
          {}
        ),
      ])
    );
    const activationStatus = buildRuntimeProfileActivationStatusMap(c.env, profiles);
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

  // Refused before anything else, so no step-up receipt is spent on a write that cannot happen.
  if (id.startsWith('builtin:')) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT, {
      variables: { resource: 'runtime_profile', reason: 'builtin profiles are read-only' },
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
    // D1 is the source of truth for writes: the profile is read once as stored, compared, gated,
    // and written only if it is still that stored profile (see RuntimeProfileWriter).
    const writer = createRuntimeProfileWriterFromEnv(c.env);
    const { profile: existing, expected } = await writer.readForWrite(kind, id);
    const profile = buildPersistedProfile(kind, id, parsed);
    if (kind === 'audit') {
      const auditErrors = validateAuditProfileForEnvironment(profile as AuditProfile, c.env);
      if (auditErrors.length > 0) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: { field: 'body', reason: auditErrors.join(' ') },
        });
      }
    }
    // Changing the jurisdiction of a residency profile moves where the tenants using it keep their
    // data; shortening an audit profile's retention deletes their logs sooner. Creating a profile
    // is gated too: any tenant may already name the id (it was deleted and is being recreated),
    // and which tenants do cannot be listed here. Everything above has passed; the receipt is spent
    // here.
    if (kind === 'residency') {
      const next = profile as ResidencyProfile;
      const before = existing?.kind === 'residency' ? existing : null;
      if (!before || before.jurisdiction !== next.jurisdiction) {
        const stepUpRefused = await requireAdminStepUp(c as never, {
          operation: 'tenant.jurisdiction.update',
          targetTenantId: getPrimaryTenantId(c.env),
          targetIds: [id],
          params: {
            scope: 'residency_profile',
            profile_id: id,
            from_jurisdiction: before?.jurisdiction ?? null,
            to_jurisdiction: next.jurisdiction,
          },
        });
        if (stepUpRefused) return stepUpRefused;
      }
    }
    if (kind === 'audit') {
      const before = existing?.kind === 'audit' ? existing : null;
      const next = profile as AuditProfile;
      const deliveryChanged = auditDeliveryChanged(before, next);
      const retentionGated = !before || auditRetentionWeakened(before, next);
      if (retentionGated || deliveryChanged) {
        // One receipt covers one operation. A profile whose delivery changes sends logs somewhere
        // new (sinks, archive, primary store), which is gated as a destination update; when the
        // same request also shortens retention that one receipt covers both (the resulting
        // retention is bound in the params). Retention alone is gated as a shortening.
        const stepUpRefused = await requireAdminStepUp(c as never, {
          operation: deliveryChanged ? 'webhook.destination.update' : 'audit.retention.shorten',
          // Both at once: the receipt carries the other operation too, so a machine holding only
          // the destination exemption cannot also shorten retention.
          ...(deliveryChanged && retentionGated
            ? { alsoCovers: ['audit.retention.shorten' as const] }
            : {}),
          targetTenantId: getPrimaryTenantId(c.env),
          targetIds: [id],
          params: {
            scope: 'audit_profile',
            profile_id: id,
            retention: next.retention ?? null,
            // Which of the days apply depends on whether the profile has a primary store.
            has_primary: Boolean(next.primary),
            // Where the resulting profile sends logs (digests only; the values are secrets).
            ...(await auditDeliveryDigests(next)),
          },
        });
        if (stepUpRefused) return stepUpRefused;
      }
    }
    const written = await writer.putIfUnchanged(profile, expected);
    if (!written.committed) return profileChangedResponse(c);

    return c.json(
      {
        registry_backend: getRegistryBackend(c.env),
        created: !existing,
        ...(written.projection ? { projection: written.projection } : {}),
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
    if (error instanceof ProfileProjectionDisagreementError) return profileChangedResponse(c);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/** The stored profile is no longer the one that was compared (or runtime's copy lagged). */
function profileChangedResponse(c: Context<{ Bindings: Env }>) {
  return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT, {
    variables: {
      resource: 'runtime_profile',
      reason:
        'The profile changed while this request was being decided; repeat the step-up and retry',
    },
  });
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
    const writer = createRuntimeProfileWriterFromEnv(c.env);
    // Deleting a profile and creating it again under the same id would swap its jurisdiction or
    // retention without the update gate. Which tenants use a profile cannot be listed cheaply, so
    // deleting is gated like changing it; the receipt is spent only once the profile is known to
    // exist. The delete is made only if the profile is still the one that was read.
    const { profile: existing, expected } = await writer.readForWrite(kind, id);
    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'runtime_profile' },
      });
    }
    // Deleting an audit profile also changes where logs go for whoever names it (they fall back
    // to the built-in profile: an external sink stops, an archive may start). The retention
    // operation stays the main one (it always applied to a delete); when the delivery differs
    // from the fallback the receipt also covers the destination operation, and the deleted
    // profile's delivery is bound by digest.
    const deliveryLost = existing.kind === 'audit' && auditDeliveryChanged(existing, null);
    const stepUpRefused = await requireAdminStepUp(c as never, {
      operation: kind === 'residency' ? 'tenant.jurisdiction.update' : 'audit.retention.shorten',
      ...(deliveryLost ? { alsoCovers: ['webhook.destination.update' as const] } : {}),
      targetTenantId: getPrimaryTenantId(c.env),
      targetIds: [id],
      params: {
        scope: `${kind}_profile_delete`,
        profile_id: id,
        ...(existing.kind === 'audit' ? await auditDeliveryDigests(existing) : {}),
      },
    });
    if (stepUpRefused) return stepUpRefused;
    const deleted = await writer.deleteIfUnchanged(kind, id, expected);
    if (!deleted.committed) return profileChangedResponse(c);

    return c.json({
      registry_backend: getRegistryBackend(c.env),
      deleted: true,
      ...(deleted.projection ? { projection: deleted.projection } : {}),
    });
  } catch (error) {
    if (error instanceof ProfileProjectionDisagreementError) return profileChangedResponse(c);
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

    // Pointing the environment default at a residency profile with another jurisdiction changes
    // where tenants without their own profile keep their data; pointing it at an audit profile that
    // keeps logs for less time deletes them sooner. One request needing both is refused: the two
    // receipts are separate.
    // The document's version is read first and the save is made against it: if the defaults change
    // after this point (another request), the save is refused rather than applied over a
    // comparison made against older values.
    // One read gives both the values compared and the version saved against. Strict: a fallback
    // could hide a change.
    const manager = createInfrastructureSettingsManager(c.env, { strict: true });
    const judged = await manager.getAll('infrastructure', { type: 'platform' });
    const judgedVersion = judged.version;
    const currentDefaults = readEnvironmentProfileDefaults(judged.values);
    // What runtime reads (the KV projection) must agree with the document compared: while they
    // differ (a projection still pending), the step-up could be judged against the wrong values.
    const runtimeDefaults = await loadEnvironmentProfileDefaultsFromEnv(c.env, { strict: true });
    if (
      runtimeDefaults.auditProfileId !== currentDefaults.auditProfileId ||
      runtimeDefaults.residencyProfileId !== currentDefaults.residencyProfileId
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
    }
    // The profiles compared are verified again after the save commits (profile-switch-verify).
    const switchGuard: ProfileSwitchGuard = { compared: [] };
    let residencyGate: Parameters<typeof requireAdminStepUp>[1] | null = null;
    let auditGate: Parameters<typeof requireAdminStepUp>[1] | null = null;
    if (parsedBody.data.residencyProfileId !== undefined) {
      const [currentResidency, nextResidency] = await Promise.all([
        readComparedProfile(c.env, 'residency', currentDefaults.residencyProfileId, switchGuard),
        readComparedProfile(c.env, 'residency', parsedBody.data.residencyProfileId, switchGuard),
      ]);
      const fromJurisdiction =
        currentResidency?.kind === 'residency' ? currentResidency.jurisdiction : null;
      const toJurisdiction =
        nextResidency?.kind === 'residency' ? nextResidency.jurisdiction : null;
      // A profile that cannot be found on either side cannot be compared: a switch counts.
      const switches = currentDefaults.residencyProfileId !== parsedBody.data.residencyProfileId;
      if (
        fromJurisdiction !== toJurisdiction ||
        (switches && (fromJurisdiction === null || toJurisdiction === null))
      ) {
        residencyGate = {
          operation: 'tenant.jurisdiction.update',
          targetTenantId: getPrimaryTenantId(c.env),
          targetIds: [parsedBody.data.residencyProfileId],
          params: {
            scope: 'environment_default',
            residency_profile_id: parsedBody.data.residencyProfileId,
            from_jurisdiction: fromJurisdiction,
            to_jurisdiction: toJurisdiction,
          },
        };
      }
    }
    if (parsedBody.data.auditProfileId !== undefined) {
      const [currentAudit, nextAudit] = await Promise.all([
        readComparedProfile(c.env, 'audit', currentDefaults.auditProfileId, switchGuard),
        readComparedProfile(c.env, 'audit', parsedBody.data.auditProfileId, switchGuard),
      ]);
      // A profile that cannot be found on either side cannot be compared: a switch counts as
      // shortening (the audit service falls back to the built-in profile meanwhile).
      const switches = currentDefaults.auditProfileId !== parsedBody.data.auditProfileId;
      // Switching to a profile that sends logs elsewhere (other sinks, archive or store) is a
      // destination change even when it keeps logs as long.
      // An unregistered id is what runtime uses for it: the built-in profile.
      const deliveryDiffers = auditDeliveryChanged(
        currentAudit?.kind === 'audit' ? currentAudit : null,
        nextAudit?.kind === 'audit' ? nextAudit : null
      );
      const retentionGated =
        currentAudit?.kind !== 'audit' ||
        nextAudit?.kind !== 'audit' ||
        auditRetentionWeakened(currentAudit, nextAudit);
      if (switches && (retentionGated || deliveryDiffers)) {
        // One receipt covers one operation: a delivery change is gated as a destination update
        // (the resulting retention is bound too); retention alone as a shortening.
        auditGate = {
          operation: deliveryDiffers ? 'webhook.destination.update' : 'audit.retention.shorten',
          ...(deliveryDiffers && retentionGated
            ? { alsoCovers: ['audit.retention.shorten' as const] }
            : {}),
          targetTenantId: getPrimaryTenantId(c.env),
          targetIds: [parsedBody.data.auditProfileId],
          params: {
            scope: 'environment_default',
            audit_profile_id: parsedBody.data.auditProfileId,
            retention: nextAudit?.kind === 'audit' ? (nextAudit.retention ?? null) : null,
            ...(await auditDeliveryDigests(nextAudit?.kind === 'audit' ? nextAudit : null)),
          },
        };
      }
    }
    if (residencyGate && auditGate) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'body',
          reason:
            'Changing the residency profile and moving to a shorter-retention audit profile need separate step-ups: change them in separate requests',
        },
      });
    }
    const defaultsGate = residencyGate ?? auditGate;
    if (defaultsGate) {
      const stepUpRefused = await requireAdminStepUp(c as never, defaultsGate);
      if (stepUpRefused) return stepUpRefused;
    }

    // What the document holds of these keys now, to put back if a compared profile changed.
    const dryRun = await manager.patch(
      'infrastructure',
      { type: 'platform' },
      { ifMatch: judgedVersion, set: updates },
      'runtime-profile-defaults',
      { dryRun: true }
    );
    switchGuard.before = dryRun.candidate?.before ?? {};
    const committed = await manager.patch(
      'infrastructure',
      { type: 'platform' },
      {
        ifMatch: judgedVersion,
        set: updates,
      },
      'runtime-profile-defaults'
    );
    if (
      !(await verifySwitchAfterCommit({
        env: c.env,
        manager,
        category: 'infrastructure',
        scope: { type: 'platform' },
        guard: switchGuard,
        committedVersion: committed.version,
        changedKeys: Object.keys(updates),
        actor: 'runtime-profile-defaults',
      }))
    ) {
      return profileChangedResponse(c);
    }

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
    // The defaults changed after the step-up decision was made: retry against the current ones.
    if (error instanceof ConflictError || error instanceof ProfileProjectionDisagreementError) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
    }
    log.error('Failed to update runtime profile defaults', { error: String(error) });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

function tenantViewOfAuditProfile(profile: AuditProfile) {
  return {
    id: profile.id,
    kind: profile.kind,
    label: profile.label,
    description: profile.description,
    builtin: profile.builtin,
    version: profile.version,
    // Each field is named: stored objects may carry attributes this view was not written for.
    retention: profile.retention && {
      eventLogRetentionDays: profile.retention.eventLogRetentionDays,
      piiLogRetentionDays: profile.retention.piiLogRetentionDays,
      archiveBeforeDelete: profile.retention.archiveBeforeDelete,
      minimumRetentionDays: profile.retention.minimumRetentionDays,
      primaryDays: profile.retention.primaryDays,
      archiveDays: profile.retention.archiveDays,
    },
    archiveFailureMode: profile.archiveFailureMode,
    sinkFailureMode: profile.sinkFailureMode,
    backpressure: profile.backpressure && {
      mode: profile.backpressure.mode,
      allowTenantOverride: profile.backpressure.allowTenantOverride,
    },
  };
}

function tenantViewOfResidencyProfile(profile: ResidencyProfile) {
  return {
    id: profile.id,
    kind: profile.kind,
    label: profile.label,
    description: profile.description,
    builtin: profile.builtin,
    version: profile.version,
    locationHint: profile.locationHint,
    jurisdiction: profile.jurisdiction,
    allowedRegions: profile.allowedRegions,
  };
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

    const refs = {
      auditProfileId,
      residencyProfileId,
      inherited: {
        audit: !overrides.auditProfileId,
        residency: !overrides.residencyProfileId,
      },
    };
    // A system administrator sees the profiles as stored, as before this route was opened to
    // tenants. Anyone else sees what applies to the tenant (retention, failure handling,
    // residency) and none of where the platform delivers it: targets, destinations, headers and
    // metadata can name infrastructure and credentials shared by every tenant on the profile.
    // That includes a global machine token with only a read permission.
    const adminAuth = getAdminAuth(c);
    if (!adminAuth || !hasSystemAdminAuthority(adminAuth)) {
      return c.json({
        tenant_id: tenantId,
        refs,
        effective: {
          audit: tenantViewOfAuditProfile(auditProfile),
          residency: tenantViewOfResidencyProfile(residencyProfile),
        },
      });
    }
    return c.json({
      tenant_id: tenantId,
      registry_backend: getRegistryBackend(c.env),
      refs,
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
    if (message === 'tenant_runtime_registry_purge_requires_super_admin') {
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
