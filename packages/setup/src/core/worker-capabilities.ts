import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { getSecretNamesForWorker } from './secrets.js';
import { getControlGeneratedDatabaseDataRoleFromBinding } from './tenant-database.js';
import { WORKER_COMPONENTS, type WorkerComponent } from './naming.js';
import type { WranglerConfig } from './wrangler.js';

export type WorkerInventoryComponent = WorkerComponent | 'ar-admin-ui' | 'ar-login-ui';

export const WORKER_DATA_ROLES = [
  'tenant_core/default',
  'tenant_core/users',
  'tenant_pii',
  'lookup',
  'control',
  'plugin_runner',
] as const;

export type WorkerDataRole = (typeof WORKER_DATA_ROLES)[number];

export const WORKER_BINDING_KINDS = [
  'd1',
  'kv_namespace',
  'r2_bucket',
  'service',
  'worker_loader',
  'durable_object_namespace',
  'queue',
  'send_email',
  'hyperdrive',
  'version_metadata',
] as const;

export type WorkerBindingKind = (typeof WORKER_BINDING_KINDS)[number];

const SAFE_BINDING_NAME = /^[A-Z][A-Z0-9_]*$/u;
const SAFE_PACKAGE_NAME = /^@authrim\/[a-z0-9-]+$/u;
const SAFE_WORKER_NAME = /^ar-[a-z0-9-]+$/u;
const CLOUDFLARE_TOKEN_NAME = /^(?:CLOUDFLARE|CF)_.+_(?:API_)?TOKEN$/u;
const CONTROL_TOKEN_NAMES = new Set([
  'CLOUDFLARE_D1_API_TOKEN',
  'CLOUDFLARE_WORKERS_API_TOKEN',
  'CLOUDFLARE_KV_API_TOKEN',
  'CLOUDFLARE_R2_API_TOKEN',
]);
const SHA256_HEX = /^[a-f0-9]{64}$/u;

const workerDataRoleSchema = z.enum(WORKER_DATA_ROLES);
const workerBindingKindSchema = z.enum(WORKER_BINDING_KINDS);

const workerBindingSchema = z
  .object({
    name: z.string().regex(SAFE_BINDING_NAME),
    kind: workerBindingKindSchema,
    required: z.boolean(),
    dataRole: workerDataRoleSchema.optional(),
    capability: z.string().min(1).optional(),
  })
  .strict();

const dynamicWorkerBindingSchema = z
  .object({
    prefix: z.enum(['PRES_D1_', 'PRES_KV_', 'PRES_R2_']),
    kind: z.enum(['d1', 'kv_namespace', 'r2_bucket']),
    suffixFormat: z.literal('uppercase_hex_24'),
    capability: z.string().min(1),
  })
  .strict();

const workerSecretSchema = z
  .object({
    name: z.string().regex(SAFE_BINDING_NAME),
    capability: z.string().min(1),
    required: z.boolean(),
  })
  .strict();

export const workerCapabilityManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    packageName: z.string().regex(SAFE_PACKAGE_NAME),
    worker: z.string().regex(SAFE_WORKER_NAME),
    requiredDataRoles: z.array(workerDataRoleSchema),
    lookupBlindIndex: z.boolean().optional().default(false),
    bindings: z.array(workerBindingSchema),
    dynamicBindings: z.array(dynamicWorkerBindingSchema).optional().default([]),
    secrets: z.array(workerSecretSchema),
  })
  .strict()
  .superRefine((manifest, context) => {
    reportDuplicates(manifest.requiredDataRoles, 'requiredDataRoles', context);
    reportDuplicates(
      manifest.bindings.map((binding) => binding.name),
      'bindings',
      context
    );
    reportDuplicates(
      manifest.dynamicBindings.map((binding) => `${binding.kind}:${binding.prefix}`),
      'dynamicBindings',
      context
    );
    reportDuplicates(
      manifest.secrets.map((secret) => secret.name),
      'secrets',
      context
    );

    const requiredRoles = new Set(manifest.requiredDataRoles);
    for (const [index, binding] of manifest.bindings.entries()) {
      if (binding.dataRole && !requiredRoles.has(binding.dataRole)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bindings', index, 'dataRole'],
          message: 'binding_data_role_not_declared',
        });
      }
    }

    const allowedDynamicBindings = new Map<WorkerBindingKind, string>([
      ['d1', 'PRES_D1_'],
      ['kv_namespace', 'PRES_KV_'],
      ['r2_bucket', 'PRES_R2_'],
    ]);
    for (const [index, binding] of manifest.dynamicBindings.entries()) {
      if (
        manifest.worker !== 'ar-plugin-runner' ||
        allowedDynamicBindings.get(binding.kind) !== binding.prefix
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dynamicBindings', index],
          message: 'dynamic_binding_family_not_allowed',
        });
      }
    }

    for (const [index, secret] of manifest.secrets.entries()) {
      if (!CLOUDFLARE_TOKEN_NAME.test(secret.name)) continue;
      if (manifest.worker !== 'ar-control' || !CONTROL_TOKEN_NAMES.has(secret.name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['secrets', index, 'name'],
          message: 'cloudflare_api_token_not_allowed_for_worker',
        });
      }
    }

    if (manifest.lookupBlindIndex) {
      const secretNames = new Set(manifest.secrets.map((secret) => secret.name));
      for (const requiredSecret of ['LOOKUP_HMAC_KEY_SLOT_A', 'LOOKUP_HMAC_KEY_SLOT_B']) {
        if (!secretNames.has(requiredSecret)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['secrets'],
            message: `lookup_blind_index_secret_missing:${requiredSecret}`,
          });
        }
      }
    }
  });

export type WorkerCapabilityManifest = z.infer<typeof workerCapabilityManifestSchema>;

export interface CompiledWorkerCapabilityManifest {
  component: WorkerInventoryComponent;
  manifest: WorkerCapabilityManifest;
  sourceManifestPath: string;
  sourceManifestHash: string;
  capabilityManifestDigest: string;
}

export interface DesiredWorkerInventoryRecord {
  environmentId: string;
  environmentName: string;
  workerScriptName: string;
  packageName: string;
  deploymentTarget: string;
  capabilityManifestDigest: string;
  sourceManifestPath: string;
  sourceManifestHash: string;
  generatedArtifactHash: string;
  sourceKind: 'core_manifest';
  sourceReference: string;
  registrationMode: 'auto';
  status: 'active';
  reviewState: 'auto_registered';
  requiredDataRoles: WorkerDataRole[];
  bindings: Array<{
    name: string;
    kind: WorkerBindingKind | 'secret';
    dataRole: WorkerDataRole | null;
    capability: string | null;
    required: boolean;
  }>;
}

function reportDuplicates(values: readonly string[], path: string, context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path, index],
        message: `duplicate_${path}_entry`,
      });
    }
    seen.add(value);
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function portableRelativePath(baseDir: string, path: string): string {
  return relative(baseDir, path).split(sep).join('/');
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}:${issue.message}`)
    .join(',');
}

export function parseWorkerCapabilityManifest(
  input: unknown,
  expected?: { component?: WorkerInventoryComponent; packageName?: string }
): WorkerCapabilityManifest {
  const result = workerCapabilityManifestSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`invalid_worker_capability_manifest:${formatZodError(result.error)}`);
  }
  if (expected?.component && result.data.worker !== expected.component) {
    throw new Error(
      `worker_capability_component_mismatch:${expected.component}:${result.data.worker}`
    );
  }
  if (expected?.packageName && result.data.packageName !== expected.packageName) {
    throw new Error(
      `worker_capability_package_mismatch:${expected.packageName}:${result.data.packageName}`
    );
  }
  return result.data;
}

export async function loadWorkerCapabilityManifest(input: {
  baseDir: string;
  component: WorkerInventoryComponent;
}): Promise<CompiledWorkerCapabilityManifest> {
  const packageDir = join(input.baseDir, 'packages', input.component);
  const packagePath = join(packageDir, 'package.json');
  const manifestPath = join(packageDir, 'authrim.worker-capabilities.json');
  const [packageBytes, manifestBytes] = await Promise.all([
    readFile(packagePath, 'utf8'),
    readFile(manifestPath),
  ]);
  const packageJson = JSON.parse(packageBytes) as { name?: unknown };
  if (typeof packageJson.name !== 'string') {
    throw new Error(`worker_capability_package_name_missing:${input.component}`);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error(`worker_capability_manifest_json_invalid:${input.component}`);
  }
  const manifest = parseWorkerCapabilityManifest(parsedJson, {
    component: input.component,
    packageName: packageJson.name,
  });
  return {
    component: input.component,
    manifest,
    sourceManifestPath: portableRelativePath(input.baseDir, manifestPath),
    sourceManifestHash: sha256(manifestBytes),
    capabilityManifestDigest: sha256(JSON.stringify(canonicalize(manifest))),
  };
}

export async function loadWorkerCapabilityManifests(input: {
  baseDir: string;
  components: readonly WorkerInventoryComponent[];
}): Promise<CompiledWorkerCapabilityManifest[]> {
  const manifests = await Promise.all(
    input.components.map((component) =>
      loadWorkerCapabilityManifest({ baseDir: input.baseDir, component })
    )
  );
  const packageNames = new Set<string>();
  for (const compiled of manifests) {
    if (packageNames.has(compiled.manifest.packageName)) {
      throw new Error(`duplicate_worker_capability_package:${compiled.manifest.packageName}`);
    }
    packageNames.add(compiled.manifest.packageName);
  }
  return manifests.sort((left, right) => left.component.localeCompare(right.component));
}

function generatedBindings(
  config: WranglerConfig
): Array<{ name: string; kind: WorkerBindingKind }> {
  return [
    ...(config.d1_databases ?? []).map((binding) => ({
      name: binding.binding,
      kind: 'd1' as const,
    })),
    ...(config.kv_namespaces ?? []).map((binding) => ({
      name: binding.binding,
      kind: 'kv_namespace' as const,
    })),
    ...(config.r2_buckets ?? []).map((binding) => ({
      name: binding.binding,
      kind: 'r2_bucket' as const,
    })),
    ...(config.services ?? []).map((binding) => ({
      name: binding.binding,
      kind: 'service' as const,
    })),
    ...(config.worker_loaders ?? []).map((binding) => ({
      name: binding.binding,
      kind: 'worker_loader' as const,
    })),
    ...(config.durable_objects?.bindings ?? []).map((binding) => ({
      name: binding.name,
      kind: 'durable_object_namespace' as const,
    })),
    ...(config.queues?.producers ?? []).map((binding) => ({
      name: binding.binding,
      kind: 'queue' as const,
    })),
    ...(config.send_email ?? []).map((binding) => ({
      name: binding.name,
      kind: 'send_email' as const,
    })),
    ...((config.hyperdrive?.length ?? 0) > 0
      ? [{ name: 'TENANT_DATABASE_HYPERDRIVE', kind: 'hyperdrive' as const }]
      : []),
    ...(config.version_metadata
      ? [{ name: config.version_metadata.binding, kind: 'version_metadata' as const }]
      : []),
  ];
}

function matchesDynamicBindingFamily(
  manifest: WorkerCapabilityManifest,
  binding: { name: string; kind: WorkerBindingKind }
): boolean {
  return manifest.dynamicBindings.some(
    (family) =>
      family.kind === binding.kind &&
      binding.name.startsWith(family.prefix) &&
      /^[A-F0-9]{24}$/u.test(binding.name.slice(family.prefix.length))
  );
}

export function validateGeneratedWorkerCapabilities(input: {
  compiled: CompiledWorkerCapabilityManifest;
  config: WranglerConfig;
}): void {
  const { manifest } = input.compiled;
  if (
    input.config.name !== input.compiled.component &&
    !input.config.name.endsWith(`-${manifest.worker}`)
  ) {
    throw new Error(`worker_capability_generated_script_mismatch:${manifest.worker}`);
  }

  const declaredBindings = new Map(
    manifest.bindings.map((binding) => [`${binding.kind}:${binding.name}`, binding])
  );
  const generated = generatedBindings(input.config);
  const generatedKeys = new Set<string>();
  for (const binding of generated) {
    const key = `${binding.kind}:${binding.name}`;
    generatedKeys.add(key);
    if (binding.kind === 'd1') {
      const role = getControlGeneratedDatabaseDataRoleFromBinding(binding.name);
      if (role) {
        if (!manifest.requiredDataRoles.includes(role)) {
          throw new Error(
            `worker_capability_undeclared_tenant_data_role:${manifest.worker}:${binding.name}:${role}`
          );
        }
        continue;
      }
    }
    if (!declaredBindings.has(key) && !matchesDynamicBindingFamily(manifest, binding)) {
      throw new Error(
        `worker_capability_undeclared_binding:${manifest.worker}:${binding.kind}:${binding.name}`
      );
    }
  }

  for (const binding of manifest.bindings) {
    if (binding.required && !generatedKeys.has(`${binding.kind}:${binding.name}`)) {
      throw new Error(
        `worker_capability_required_binding_missing:${manifest.worker}:${binding.kind}:${binding.name}`
      );
    }
  }

  const declaredSecrets = new Set(manifest.secrets.map((secret) => secret.name));
  const generatedSecrets = new Set<string>(
    (WORKER_COMPONENTS as readonly string[]).includes(input.compiled.component)
      ? getSecretNamesForWorker(input.compiled.component as WorkerComponent)
      : manifest.secrets.map((secret) => secret.name)
  );
  for (const secret of generatedSecrets) {
    if (!declaredSecrets.has(secret)) {
      throw new Error(`worker_capability_undeclared_secret:${manifest.worker}:${secret}`);
    }
  }
  for (const secret of manifest.secrets) {
    if (secret.required && !generatedSecrets.has(secret.name)) {
      throw new Error(
        `worker_capability_required_secret_missing:${manifest.worker}:${secret.name}`
      );
    }
  }
}

export function compileDesiredWorkerInventory(input: {
  environmentId: string;
  environmentName: string;
  deploymentTarget?: string;
  manifests: readonly CompiledWorkerCapabilityManifest[];
  generatedArtifactHashes: Readonly<Record<string, string>>;
}): DesiredWorkerInventoryRecord[] {
  const deploymentTarget = input.deploymentTarget ?? 'default';
  return input.manifests.map((compiled) => {
    const generatedArtifactHash = input.generatedArtifactHashes[compiled.component];
    if (!generatedArtifactHash || !SHA256_HEX.test(generatedArtifactHash)) {
      throw new Error(`worker_capability_generated_artifact_hash_missing:${compiled.component}`);
    }
    return {
      environmentId: input.environmentId,
      environmentName: input.environmentName,
      workerScriptName: `${input.environmentName}-${compiled.component}`,
      packageName: compiled.manifest.packageName,
      deploymentTarget,
      capabilityManifestDigest: compiled.capabilityManifestDigest,
      sourceManifestPath: compiled.sourceManifestPath,
      sourceManifestHash: compiled.sourceManifestHash,
      generatedArtifactHash,
      sourceKind: 'core_manifest',
      sourceReference: `${basename(compiled.sourceManifestPath)}#sha256:${compiled.sourceManifestHash}`,
      registrationMode: 'auto',
      status: 'active',
      reviewState: 'auto_registered',
      requiredDataRoles: [...compiled.manifest.requiredDataRoles].sort(),
      bindings: [
        ...compiled.manifest.bindings.map((binding) => ({
          name: binding.name,
          kind: binding.kind,
          dataRole: binding.dataRole ?? null,
          capability: binding.capability ?? null,
          required: binding.required,
        })),
        ...compiled.manifest.secrets.map((secret) => ({
          name: secret.name,
          kind: 'secret' as const,
          dataRole: null,
          capability: secret.capability,
          required: secret.required,
        })),
      ].sort((left, right) =>
        `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`)
      ),
    };
  });
}

export function hashGeneratedWorkerArtifact(config: WranglerConfig): string {
  return sha256(JSON.stringify(canonicalize(config)));
}
