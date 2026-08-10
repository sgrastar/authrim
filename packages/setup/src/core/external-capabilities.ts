import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getDomain } from 'tldts';
import { z } from 'zod';
import {
  isPluginHostInterfaceId,
  type PluginHostInterfaceId,
} from '@authrim/ar-lib-core/services/plugin-host-interface-contract';
import { WORKER_COMPONENTS } from './naming.js';

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_SCRIPT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const SAFE_BINDING_NAME = /^[A-Z][A-Z0-9_]*$/u;
const SAFE_HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const CLOUDFLARE_TOKEN_NAME = /^(?:CLOUDFLARE|CF)_.+_(?:API_)?TOKEN$/u;
const RAW_PLUGIN_BINDING =
  /^(?:DB(?:_PII|_ADMIN)?|CONTROL_DB|LOOKUP_DB|PLUGIN_RUNNER_DB|(?:[A-Z][A-Z0-9_]*_)?TDB_.+)$/u;
const DISALLOWED_HOST_SUFFIX = /(?:^|\.)(?:internal|localhost|local|localdomain|home|lan)$/u;
const SAFE_MODULE = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)\S{1,240}\.(?:js|cjs|json|txt)$/u;
const SAFE_CONFIG_KEY = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const SAFE_HEADER = /^[A-Za-z0-9-]{1,64}$/u;
const FORBIDDEN_CREDENTIAL_HEADERS = new Set([
  'cf-connecting-ip',
  'cf-ray',
  'cf-worker',
  'connection',
  'content-encoding',
  'content-length',
  'content-type',
  'cookie',
  'forwarded',
  'host',
  'proxy-authorization',
  'set-cookie',
  'transfer-encoding',
  'upgrade',
  'x-api-key',
  'x-auth-token',
  'x-forwarded-for',
  'x-real-ip',
]);
const MAX_DYNAMIC_WORKER_BUNDLE_BYTES = 2 * 1024 * 1024;
const RESERVED_PLUGIN_IDS = new Set([
  'notifier-cloudflare',
  'notifier-resend',
  'human-verification-cloudflare-turnstile',
  'human-verification-hcaptcha',
  'human-verification-google-recaptcha',
]);

const requestScopeSchema = z.enum(['platform', 'tenant']);

const extensionRequestSchema = z
  .object({
    name: z.string().regex(SAFE_BINDING_NAME),
    capability: z.string().trim().min(1).max(200),
    scope: requestScopeSchema,
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

const extensionWorkerSchema = z
  .object({
    scriptName: z.string().regex(SAFE_SCRIPT_NAME),
    bindings: z.array(extensionRequestSchema),
    secrets: z.array(extensionRequestSchema),
    services: z.array(extensionRequestSchema),
  })
  .strict();

export const extensionCapabilityManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    extensionId: z.string().regex(SAFE_ID),
    owner: z.string().trim().min(1).max(200),
    source: z.string().trim().min(1).max(1000),
    scope: requestScopeSchema,
    reason: z.string().trim().min(1).max(1000),
    workers: z.array(extensionWorkerSchema).min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    reportDuplicates(
      manifest.workers.map((worker) => worker.scriptName),
      ['workers'],
      context
    );
    for (const [workerIndex, worker] of manifest.workers.entries()) {
      if (
        WORKER_COMPONENTS.some(
          (component) =>
            worker.scriptName === component || worker.scriptName.endsWith(`-${component}`)
        )
      ) {
        addIssue(
          context,
          ['workers', workerIndex, 'scriptName'],
          'extension_core_worker_forbidden'
        );
      }
      const requests = [
        ...worker.bindings.map((request, index) => ({
          category: 'bindings' as const,
          index,
          request,
        })),
        ...worker.services.map((request, index) => ({
          category: 'services' as const,
          index,
          request,
        })),
        ...worker.secrets.map((request, index) => ({
          category: 'secrets' as const,
          index,
          request,
        })),
      ];
      reportDuplicates(
        requests.map(({ request }) => request.name),
        ['workers', workerIndex],
        context
      );
      for (const { category, index, request } of requests) {
        const path = ['workers', workerIndex, category, index];
        if (manifest.scope === 'tenant' && request.scope === 'platform') {
          addIssue(context, [...path, 'scope'], 'extension_request_exceeds_manifest_scope');
        }
        if (CLOUDFLARE_TOKEN_NAME.test(request.name)) {
          addIssue(context, [...path, 'name'], 'extension_cloudflare_token_forbidden');
        }
      }
    }
  });

const pluginBindingSchema = z
  .object({
    name: z.string().regex(SAFE_BINDING_NAME),
    interface: z.custom<PluginHostInterfaceId>(
      isPluginHostInterfaceId,
      'plugin_host_interface_unknown'
    ),
    scope: z.literal('tenant'),
  })
  .strict();

const pluginCapabilitySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    execution: z.enum(['sync', 'async']),
    failurePolicy: z.enum(['fail_open', 'fail_closed', 'retry_async']),
    timeoutMs: z.number().int().min(1).max(30_000),
    mutationScopes: z
      .array(
        z.enum([
          'notifier.send',
          'human_verification.verify',
          'identity_provider.resolve',
          'flow.evaluate',
          'account.metadata.write',
        ])
      )
      .refine((values) => new Set(values).size === values.length, 'duplicate_mutation_scope'),
    asyncOutbox: z
      .object({
        enabled: z.boolean(),
        succeededRetentionDays: z.literal(7),
        deadLetterRetentionDays: z.literal(90),
      })
      .strict(),
  })
  .strict();

const exactEgressHostSchema = z
  .object({ kind: z.literal('exact'), host: z.string().min(1) })
  .strict();
const wildcardEgressHostSchema = z
  .object({ kind: z.literal('suffix_wildcard'), suffix: z.string().min(1) })
  .strict();

const workerBundleReferenceSchema = z.object({ path: z.string().trim().min(1).max(500) }).strict();

const pluginCredentialSchema = z
  .object({
    configKey: z.string().regex(SAFE_CONFIG_KEY),
    required: z.boolean(),
    destinationHost: z.string().min(1),
    injectionKind: z.enum(['header', 'bearer']),
    injectionName: z.string().regex(SAFE_HEADER),
  })
  .strict();

const pluginResourceSchema = z
  .object({
    schemaVersion: z.literal(1),
    logicalResourceId: z.string().regex(SAFE_ID),
    binding: z.string().regex(SAFE_BINDING_NAME),
    kind: z.enum(['d1', 'kv_namespace', 'r2_bucket']),
    scope: z.literal('tenant'),
    access: z.enum(['read_only', 'read_write']),
    provisioning: z
      .object({
        defaultMode: z.literal('managed'),
        allowExisting: z.boolean(),
      })
      .strict(),
    migrationStream: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._/-]{0,199}$/u)
      .nullable(),
  })
  .strict()
  .superRefine((resource, context) => {
    if ((resource.kind === 'd1') !== (resource.migrationStream !== null)) {
      addIssue(context, ['migrationStream'], 'plugin_resource_migration_stream_invalid');
    }
    if (RAW_PLUGIN_BINDING.test(resource.binding)) {
      addIssue(context, ['binding'], 'plugin_raw_data_binding_forbidden');
    }
    if (CLOUDFLARE_TOKEN_NAME.test(resource.binding)) {
      addIssue(context, ['binding'], 'plugin_cloudflare_token_forbidden');
    }
  });

const workerBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    pluginId: z.string().regex(SAFE_ID),
    compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    compatibilityFlags: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u)).max(16),
    mainModule: z.string().regex(SAFE_MODULE),
    modules: z.record(z.string(), z.string()),
  })
  .strict()
  .superRefine((bundle, context) => {
    const names = Object.keys(bundle.modules);
    if (names.length < 1 || names.length > 64 || !names.includes(bundle.mainModule)) {
      addIssue(context, ['modules'], 'plugin_worker_bundle_modules_invalid');
    }
    for (const name of names) {
      if (!SAFE_MODULE.test(name)) {
        addIssue(context, ['modules', name], 'plugin_worker_bundle_module_name_invalid');
      }
    }
  });

export const pluginWorkerCapabilityManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    pluginId: z.string().regex(SAFE_ID),
    backend: z.enum(['in_process', 'dynamic_worker']),
    workerBundle: workerBundleReferenceSchema.optional(),
    resourceScope: z.literal('tenant'),
    visibility: z.enum(['tenant', 'platform']),
    bindings: z.array(pluginBindingSchema),
    resources: z.array(pluginResourceSchema).max(16),
    capabilities: z.array(pluginCapabilitySchema),
    credentials: z.array(pluginCredentialSchema).max(16),
    egressAllowedHosts: z.array(
      z.discriminatedUnion('kind', [exactEgressHostSchema, wildcardEgressHostSchema])
    ),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (RESERVED_PLUGIN_IDS.has(manifest.pluginId)) {
      addIssue(context, ['pluginId'], 'plugin_reserved_id_forbidden');
    }
    if (manifest.backend === 'dynamic_worker' && !manifest.workerBundle) {
      addIssue(context, ['workerBundle'], 'plugin_worker_bundle_required');
    }
    if (manifest.backend === 'in_process' && manifest.workerBundle) {
      addIssue(context, ['workerBundle'], 'plugin_worker_bundle_forbidden');
    }
    if (manifest.workerBundle) {
      const path = manifest.workerBundle.path;
      const segments = path.split('/');
      if (
        isAbsolute(path) ||
        path.includes('\\') ||
        segments.some((segment) => segment === '' || segment === '.' || segment === '..')
      ) {
        addIssue(context, ['workerBundle', 'path'], 'plugin_worker_bundle_path_invalid');
      }
    }
    reportDuplicates(
      manifest.bindings.map((binding) => binding.name),
      ['bindings'],
      context
    );
    reportDuplicates(
      manifest.capabilities.map((capability) => capability.name),
      ['capabilities'],
      context
    );
    reportDuplicates(
      manifest.resources.map((resource) => resource.logicalResourceId),
      ['resources'],
      context
    );
    reportDuplicates(
      [
        ...manifest.bindings.map((binding) => binding.name),
        ...manifest.resources.map((resource) => resource.binding),
      ],
      ['bindings', 'resources'],
      context
    );
    reportDuplicates(
      manifest.credentials.map((credential) => credential.configKey),
      ['credentials'],
      context
    );
    reportDuplicates(
      manifest.credentials.map(
        (credential) => `${credential.destinationHost}:${credential.injectionName.toLowerCase()}`
      ),
      ['credentials'],
      context
    );
    reportDuplicates(
      manifest.egressAllowedHosts.map((entry) =>
        entry.kind === 'exact' ? `exact:${entry.host}` : `suffix:${entry.suffix}`
      ),
      ['egressAllowedHosts'],
      context
    );

    for (const [index, binding] of manifest.bindings.entries()) {
      if (RAW_PLUGIN_BINDING.test(binding.name)) {
        addIssue(context, ['bindings', index, 'name'], 'plugin_raw_data_binding_forbidden');
      }
      if (CLOUDFLARE_TOKEN_NAME.test(binding.name)) {
        addIssue(context, ['bindings', index, 'name'], 'plugin_cloudflare_token_forbidden');
      }
      if (
        binding.interface === 'authrim.account_metadata.v1' &&
        !manifest.capabilities.some((capability) =>
          capability.mutationScopes.includes('account.metadata.write')
        )
      ) {
        addIssue(
          context,
          ['bindings', index, 'interface'],
          'plugin_host_interface_capability_missing'
        );
      }
    }
    for (const [index, capability] of manifest.capabilities.entries()) {
      const asyncPolicyValid =
        capability.execution === 'async' &&
        capability.failurePolicy === 'retry_async' &&
        capability.asyncOutbox.enabled;
      const syncPolicyValid =
        capability.execution === 'sync' &&
        capability.failurePolicy !== 'retry_async' &&
        !capability.asyncOutbox.enabled;
      if (!asyncPolicyValid && !syncPolicyValid) {
        addIssue(context, ['capabilities', index], 'plugin_execution_policy_inconsistent');
      }
    }
    for (const [index, entry] of manifest.egressAllowedHosts.entries()) {
      const host = entry.kind === 'exact' ? entry.host : entry.suffix.replace(/^\*\./u, '');
      if (!isApprovedPublicHost(host)) {
        addIssue(context, ['egressAllowedHosts', index], 'plugin_egress_host_not_approved');
        continue;
      }
      if (entry.kind === 'suffix_wildcard' && entry.suffix !== `*.${host}`) {
        addIssue(
          context,
          ['egressAllowedHosts', index, 'suffix'],
          'plugin_egress_wildcard_invalid'
        );
      }
    }
    const exactHosts = new Set(
      manifest.egressAllowedHosts.flatMap((entry) => (entry.kind === 'exact' ? [entry.host] : []))
    );
    for (const [index, credential] of manifest.credentials.entries()) {
      if (
        !isApprovedPublicHost(credential.destinationHost) ||
        credential.destinationHost !== credential.destinationHost.toLowerCase() ||
        !exactHosts.has(credential.destinationHost)
      ) {
        addIssue(
          context,
          ['credentials', index, 'destinationHost'],
          'plugin_credential_host_not_exact'
        );
      }
      const normalized = credential.injectionName.toLowerCase();
      if (
        (credential.injectionKind === 'bearer' && normalized !== 'authorization') ||
        (credential.injectionKind === 'header' &&
          (normalized === 'authorization' || FORBIDDEN_CREDENTIAL_HEADERS.has(normalized)))
      ) {
        addIssue(
          context,
          ['credentials', index, 'injectionName'],
          'plugin_credential_injection_forbidden'
        );
      }
    }
  });

export type ExtensionCapabilityManifest = z.infer<typeof extensionCapabilityManifestSchema>;
export type PluginWorkerCapabilityManifest = z.infer<typeof pluginWorkerCapabilityManifestSchema>;

export interface CompiledExternalCapabilityManifest<TManifest> {
  manifest: TManifest;
  sourceManifestPath: string;
  sourceManifestHash: string;
  capabilityManifestDigest: string;
  dynamicWorkerArtifact?: DynamicWorkerArtifactDescriptor;
}

export interface DynamicWorkerArtifactDescriptor {
  sourceBundlePath: string;
  codeSha256: string;
  codeObjectKey: string;
  size: number;
}

export interface AggregatedExternalCapabilitySource {
  sourceKind: 'extension_manifest' | 'plugin_manifest';
  sourceId: string;
  sourceManifestPath: string;
  sourceManifestHash: string;
  capabilityManifestDigest: string;
  provenance: {
    owner: string;
    source: string;
    scope: 'platform' | 'tenant';
    reason: string;
  } | null;
  pluginPolicy: {
    backend: 'in_process' | 'dynamic_worker';
    resourceScope: 'tenant';
    visibility: 'platform' | 'tenant';
    capabilities: PluginWorkerCapabilityManifest['capabilities'];
    credentials: PluginWorkerCapabilityManifest['credentials'];
    egressAllowedHosts: PluginWorkerCapabilityManifest['egressAllowedHosts'];
    workerArtifact: DynamicWorkerArtifactDescriptor | null;
    hostInterfaces: PluginWorkerCapabilityManifest['bindings'];
    resources: PluginWorkerCapabilityManifest['resources'];
  } | null;
  workers: Array<{
    workerReference: string;
    scriptName: string | null;
    bindings: Array<{
      name: string;
      kind: 'binding' | 'service' | 'secret' | 'plugin_interface';
      capability: string;
      scope: 'platform' | 'tenant';
      reason: string | null;
    }>;
  }>;
}

function addIssue(context: z.RefinementCtx, path: Array<string | number>, message: string): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function reportDuplicates(
  values: readonly string[],
  path: Array<string | number>,
  context: z.RefinementCtx
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) addIssue(context, [...path, index], 'duplicate_capability_entry');
    seen.add(value);
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}:${issue.message}`)
    .join(',');
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

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function portablePath(baseDir: string, path: string): string {
  const relativePath = relative(resolve(baseDir), resolve(path));
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('external_capability_manifest_outside_project');
  }
  return relativePath.split(sep).join('/');
}

function isApprovedPublicHost(host: string): boolean {
  if (!SAFE_HOST.test(host) || host.includes('xn--') || DISALLOWED_HOST_SUFFIX.test(host)) {
    return false;
  }
  return getDomain(host, { allowPrivateDomains: true }) !== null;
}

function parseManifest<T>(input: unknown, schema: z.ZodType<T>, kind: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`invalid_${kind}_capability_manifest:${formatZodError(result.error)}`);
  }
  return result.data;
}

export function parseExtensionCapabilityManifest(input: unknown): ExtensionCapabilityManifest {
  return parseManifest(input, extensionCapabilityManifestSchema, 'extension');
}

export function parsePluginWorkerCapabilityManifest(
  input: unknown
): PluginWorkerCapabilityManifest {
  return parseManifest(input, pluginWorkerCapabilityManifestSchema, 'plugin_worker');
}

async function loadManifest<T>(input: {
  baseDir: string;
  path: string;
  schema: z.ZodType<T>;
  kind: string;
}): Promise<CompiledExternalCapabilityManifest<T>> {
  const canonicalBaseDir = await realpath(resolve(input.baseDir));
  const path = await realpath(resolve(input.path));
  const sourceManifestPath = portablePath(canonicalBaseDir, path);
  const bytes = await readFile(path);
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`invalid_${input.kind}_capability_manifest_json`);
  }
  const manifest = parseManifest(json, input.schema, input.kind);
  return {
    manifest,
    sourceManifestPath,
    sourceManifestHash: digest(bytes),
    capabilityManifestDigest: digest(JSON.stringify(canonicalize(manifest))),
  };
}

export function loadProjectExtensionCapabilityManifest(input: {
  baseDir: string;
  path?: string;
}): Promise<CompiledExternalCapabilityManifest<ExtensionCapabilityManifest>> {
  return loadManifest({
    baseDir: input.baseDir,
    path: input.path ?? join(input.baseDir, 'authrim.extension-capabilities.json'),
    schema: extensionCapabilityManifestSchema,
    kind: 'extension',
  });
}

export async function loadPluginWorkerCapabilityManifests(input: {
  baseDir: string;
  paths: readonly string[];
}): Promise<Array<CompiledExternalCapabilityManifest<PluginWorkerCapabilityManifest>>> {
  const manifests = await Promise.all(
    input.paths.map((path) =>
      loadManifest({
        baseDir: input.baseDir,
        path: resolve(input.baseDir, path),
        schema: pluginWorkerCapabilityManifestSchema,
        kind: 'plugin_worker',
      })
    )
  );
  const ids = new Set<string>();
  for (const compiled of manifests) {
    if (ids.has(compiled.manifest.pluginId)) {
      throw new Error(`duplicate_plugin_capability_manifest:${compiled.manifest.pluginId}`);
    }
    ids.add(compiled.manifest.pluginId);
    if (compiled.manifest.backend === 'dynamic_worker') {
      const bundleReference = compiled.manifest.workerBundle;
      if (!bundleReference) throw new Error('plugin_worker_bundle_required');
      const manifestPath = resolve(input.baseDir, compiled.sourceManifestPath);
      const bundlePath = await realpath(resolve(dirname(manifestPath), bundleReference.path));
      const sourceBundlePath = portablePath(await realpath(resolve(input.baseDir)), bundlePath);
      const bytes = await readFile(bundlePath);
      if (bytes.byteLength < 1 || bytes.byteLength > MAX_DYNAMIC_WORKER_BUNDLE_BYTES) {
        throw new Error('plugin_worker_bundle_size_invalid');
      }
      let bundle: z.infer<typeof workerBundleSchema>;
      try {
        bundle = workerBundleSchema.parse(JSON.parse(bytes.toString('utf8')));
      } catch {
        throw new Error('plugin_worker_bundle_invalid');
      }
      if (bundle.pluginId !== compiled.manifest.pluginId) {
        throw new Error('plugin_worker_bundle_plugin_mismatch');
      }
      const codeSha256 = digest(bytes);
      compiled.dynamicWorkerArtifact = {
        sourceBundlePath,
        codeSha256,
        codeObjectKey: `plugins/${compiled.manifest.pluginId}/${codeSha256}.json`,
        size: bytes.byteLength,
      };
    }
  }
  return manifests.sort((left, right) =>
    left.manifest.pluginId.localeCompare(right.manifest.pluginId)
  );
}

export function aggregateExternalCapabilities(input: {
  extension?: CompiledExternalCapabilityManifest<ExtensionCapabilityManifest>;
  plugins?: readonly CompiledExternalCapabilityManifest<PluginWorkerCapabilityManifest>[];
}): AggregatedExternalCapabilitySource[] {
  const result: AggregatedExternalCapabilitySource[] = [];
  if (input.extension) {
    const { manifest } = input.extension;
    result.push({
      sourceKind: 'extension_manifest',
      sourceId: manifest.extensionId,
      sourceManifestPath: input.extension.sourceManifestPath,
      sourceManifestHash: input.extension.sourceManifestHash,
      capabilityManifestDigest: input.extension.capabilityManifestDigest,
      provenance: {
        owner: manifest.owner,
        source: manifest.source,
        scope: manifest.scope,
        reason: manifest.reason,
      },
      pluginPolicy: null,
      workers: manifest.workers.map((worker) => ({
        workerReference: worker.scriptName,
        scriptName: worker.scriptName,
        bindings: [
          ...worker.bindings.map((request) => ({ ...request, kind: 'binding' as const })),
          ...worker.services.map((request) => ({ ...request, kind: 'service' as const })),
          ...worker.secrets.map((request) => ({ ...request, kind: 'secret' as const })),
        ]
          .map(({ name, capability, scope, reason, kind }) => ({
            name,
            capability,
            scope,
            reason,
            kind,
          }))
          .sort((left, right) =>
            `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`)
          ),
      })),
    });
  }
  const pluginIds = new Set<string>();
  for (const plugin of input.plugins ?? []) {
    if (pluginIds.has(plugin.manifest.pluginId)) {
      throw new Error(`duplicate_plugin_capability_manifest:${plugin.manifest.pluginId}`);
    }
    pluginIds.add(plugin.manifest.pluginId);
    if (plugin.manifest.backend === 'dynamic_worker' && !plugin.dynamicWorkerArtifact) {
      throw new Error(`plugin_worker_artifact_missing:${plugin.manifest.pluginId}`);
    }
    result.push({
      sourceKind: 'plugin_manifest',
      sourceId: plugin.manifest.pluginId,
      sourceManifestPath: plugin.sourceManifestPath,
      sourceManifestHash: plugin.sourceManifestHash,
      capabilityManifestDigest: plugin.capabilityManifestDigest,
      provenance: null,
      pluginPolicy: {
        backend: plugin.manifest.backend,
        resourceScope: plugin.manifest.resourceScope,
        visibility: plugin.manifest.visibility,
        capabilities: plugin.manifest.capabilities,
        credentials: plugin.manifest.credentials,
        egressAllowedHosts: plugin.manifest.egressAllowedHosts,
        workerArtifact: plugin.dynamicWorkerArtifact ?? null,
        hostInterfaces: plugin.manifest.bindings,
        resources: plugin.manifest.resources,
      },
      workers: [
        {
          workerReference: `plugin:${plugin.manifest.pluginId}`,
          scriptName: null,
          bindings: plugin.manifest.bindings
            .map((binding) => ({
              name: binding.name,
              kind: 'plugin_interface' as const,
              capability: binding.interface,
              scope: binding.scope,
              reason: null,
            }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        },
      ],
    });
  }
  return result.sort((left, right) =>
    `${left.sourceKind}:${left.sourceId}`.localeCompare(`${right.sourceKind}:${right.sourceId}`)
  );
}
