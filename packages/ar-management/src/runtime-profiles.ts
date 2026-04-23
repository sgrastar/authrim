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
  AR_ERROR_CODES,
  createErrorResponse,
  createRuntimeProfileRegistryFromEnv,
  getLogger,
  resolveTenantRuntimeProfilesFromEnv,
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
  });

const AuditRetentionSchema = z
  .object({
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
    primary: AuditTargetSchema.nullable(),
    archive: AuditTargetSchema.nullable().optional(),
    sinks: z.array(AuditTargetSchema).default([]),
    retention: AuditRetentionSchema.optional(),
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

function isRuntimeProfileKind(value: string | undefined): value is RuntimeProfileKind {
  return value !== undefined && VALID_KINDS.includes(value as RuntimeProfileKind);
}

function getRegistryBackend(env: Env): string {
  return env.PROFILE_REGISTRY_BACKEND ?? 'kv';
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

    return c.json({
      registry_backend: getRegistryBackend(c.env),
      include_builtins: includeBuiltins,
      profiles: Object.fromEntries(listed),
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

    return c.json({
      tenant_id: tenantId,
      registry_backend: getRegistryBackend(c.env),
      refs: resolved.refs,
      effective: {
        storage: resolved.storageProfile,
        audit: resolved.auditProfile,
        residency: resolved.residencyProfile,
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
