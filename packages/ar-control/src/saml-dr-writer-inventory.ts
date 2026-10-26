import {
  CloudflareControlApiClient,
  type CloudflareWorkerBinding,
  type CloudflareWorkerDeployment,
  type CloudflareWorkerScript,
  type CloudflareWorkerVersionDetail,
} from '@authrim/ar-lib-core/control-plane';
import {
  SAML_DR_WRITER_COMPONENTS,
  samlDrContractSha256,
  samlDrDurableObjectClasses,
  samlDrWriterContractDigest,
  samlDrWriterSurfaces,
  type SamlDrBindingFact,
  type SamlDrWriterComponent,
  type SamlDrWriterInventoryReceipt,
  type SamlDrWriterInventoryWorker,
  type SamlDrWriterProbe,
} from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer-contract';
import type { ControlEnv } from './types';

const MAX_ACCOUNT_SCRIPTS = 128;
const MAX_BINDINGS = 512;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/u;
const SOURCE_TYPES = new Set([
  'd1',
  'kv_namespace',
  'r2_bucket',
  'durable_object_namespace',
  'hyperdrive',
]);
const RESOLVED_BINDING_TYPES = new Set([
  ...SOURCE_TYPES,
  'plain_text',
  'secret_text',
  'json',
  'version_metadata',
  'service',
  'queue',
  'send_email',
  'worker_loader',
  'assets',
  'analytics_engine',
  'ai',
  'browser',
  'images',
  'wasm_module',
  'text_blob',
  'data_blob',
  'unsafe_eval',
]);

export interface SamlDrWriterInventoryApi {
  listWorkerScriptsForInventory(maximumScripts: number): Promise<CloudflareWorkerScript[]>;
  listWorkerDeployments(scriptName: string): Promise<CloudflareWorkerDeployment[]>;
  getWorkerVersion(scriptName: string, versionId: string): Promise<CloudflareWorkerVersionDetail>;
}

function fail(reason: string): never {
  throw new Error(`saml_dr_writer_inventory_${reason}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) fail('binding_invalid');
  return value;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}
function activeVersion(deployments: CloudflareWorkerDeployment[]): {
  deploymentId: string;
  versionId: string;
} {
  if (
    !Array.isArray(deployments) ||
    !deployments.length ||
    deployments.length > 100 ||
    deployments.some(
      (deployment) =>
        !deployment ||
        !SAFE_ID.test(deployment.id) ||
        !Number.isFinite(Date.parse(deployment.created_on))
    )
  )
    fail('deployment_invalid');
  const sorted = [...deployments].sort(
    (a, b) => Date.parse(b.created_on) - Date.parse(a.created_on)
  );
  const current = sorted[0];
  if (sorted[1] && Date.parse(sorted[1].created_on) === Date.parse(current.created_on))
    fail('deployment_ambiguous');
  // Never fall back to an older 100% deployment when the newest version is split or malformed.
  if (
    current.strategy !== 'percentage' ||
    !Array.isArray(current.versions) ||
    current.versions.length !== 1 ||
    current.versions[0].percentage !== 100 ||
    !SAFE_ID.test(current.versions[0].version_id)
  )
    fail('deployment_not_pinned');
  return { deploymentId: current.id, versionId: current.versions[0].version_id };
}
function resourceIdentity(binding: CloudflareWorkerBinding): string | null {
  if (!SOURCE_TYPES.has(binding.type)) return null;
  switch (binding.type) {
    case 'd1': {
      if (
        binding.id !== undefined &&
        binding.database_id !== undefined &&
        binding.id !== binding.database_id
      )
        fail('binding_invalid');
      return `d1:${text(binding.id ?? binding.database_id)}`;
    }
    case 'kv_namespace':
      return `kv:${text(binding.namespace_id)}`;
    case 'durable_object_namespace':
      return `do:${text(binding.namespace_id)}`;
    case 'hyperdrive':
      return `hyperdrive:${text(binding.id)}`;
    case 'r2_bucket':
      return `r2:${text(binding.jurisdiction ?? 'default')}:${text(binding.bucket_name)}`;
    default:
      return fail('binding_invalid');
  }
}
async function bindingFacts(bindings: CloudflareWorkerBinding[]): Promise<SamlDrBindingFact[]> {
  if (
    !Array.isArray(bindings) ||
    bindings.length > MAX_BINDINGS ||
    bindings.some(
      (binding) =>
        !record(binding) || !SAFE_ID.test(binding.name) || typeof binding.type !== 'string'
    ) ||
    new Set(bindings.map((binding) => binding.name)).size !== bindings.length
  )
    fail('binding_invalid');
  if (bindings.some((binding) => !RESOLVED_BINDING_TYPES.has(binding.type)))
    fail('binding_type_unsupported');
  return Promise.all(
    [...bindings]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (binding) => ({
        name: binding.name,
        type: binding.type,
        resourceIdentity: resourceIdentity(binding),
        // Hash every field, including plaintext configuration, but never persist secret values.
        configurationDigest: await samlDrContractSha256(canonical(binding)),
      }))
  );
}
function requirePlainBinding(
  bindings: CloudflareWorkerBinding[],
  name: string,
  expected: string
): void {
  const binding = bindings.find((candidate) => candidate.name === name);
  if (binding?.type !== 'plain_text' || binding.text !== expected) fail('configuration_mismatch');
}
function requireServiceBinding(
  bindings: CloudflareWorkerBinding[],
  input: {
    name: string;
    service: string;
    entrypoint: string;
    props: Record<string, string>;
  }
): void {
  const binding = bindings.find((candidate) => candidate.name === input.name);
  if (
    binding?.type !== 'service' ||
    binding.service !== input.service ||
    binding.entrypoint !== input.entrypoint ||
    (binding.environment !== undefined && binding.environment !== 'production') ||
    canonical(binding.props) !== canonical(input.props)
  )
    fail('service_binding_mismatch');
}
function names(scripts: CloudflareWorkerScript[]): string[] {
  if (
    !Array.isArray(scripts) ||
    !scripts.length ||
    scripts.length > MAX_ACCOUNT_SCRIPTS ||
    scripts.some(
      (script) => !script || typeof script.id !== 'string' || !SAFE_ID.test(script.id)
    ) ||
    new Set(scripts.map((script) => script.id)).size !== scripts.length
  )
    fail('account_scripts_invalid');
  return scripts.map((script) => script.id).sort();
}
async function mapBounded<T, R>(
  values: readonly T[],
  operation: (value: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await operation(values[index]);
      }
    })
  );
  return results;
}

/** Read-only provider verification. Call before admission is frozen and again after release. */
export async function verifySamlDrSourceWriterInventory(input: {
  api: SamlDrWriterInventoryApi;
  accountId: string;
  environmentId: string;
  tenantId: string;
  probeWorker(component: SamlDrWriterComponent): Promise<SamlDrWriterProbe>;
  expectedReceipt?: SamlDrWriterInventoryReceipt;
}): Promise<SamlDrWriterInventoryReceipt> {
  if (
    !/^[a-f0-9]{32}$/u.test(input.accountId) ||
    !SAFE_ENVIRONMENT.test(input.environmentId) ||
    !SAFE_ID.test(input.tenantId)
  )
    fail('identity_invalid');
  const scriptNames = names(await input.api.listWorkerScriptsForInventory(MAX_ACCOUNT_SCRIPTS));
  const expected = new Map<string, SamlDrWriterComponent>(
    SAML_DR_WRITER_COMPONENTS.map(
      (component) => [`${input.environmentId}-${component}`, component] as const
    )
  );
  if ([...expected.keys()].some((name) => !scriptNames.includes(name))) fail('component_missing');
  const observed = await mapBounded(scriptNames, async (workerName) => {
    const active = activeVersion(await input.api.listWorkerDeployments(workerName));
    const version = await input.api.getWorkerVersion(workerName, active.versionId);
    if (
      version?.id !== active.versionId ||
      !record(version.resources) ||
      !Array.isArray(version.resources.bindings)
    )
      fail('version_mismatch');
    const bindings = version.resources.bindings;
    const facts = await bindingFacts(bindings);
    return { workerName, ...active, bindings, facts, component: expected.get(workerName) ?? null };
  });
  // The conservative protected set comes only from actual immutable configurations, never a caller's list.
  const protectedResources = [
    ...new Set(
      observed
        .filter((worker) => worker.component !== null)
        .flatMap((worker) =>
          worker.facts.flatMap((binding) =>
            binding.resourceIdentity ? [binding.resourceIdentity] : []
          )
        )
    ),
  ].sort();
  if (!protectedResources.length) fail('source_resources_missing');
  const protectedSet = new Set(protectedResources);
  for (const worker of observed) {
    if (
      worker.component === null &&
      worker.facts.some(
        (binding) => binding.resourceIdentity && protectedSet.has(binding.resourceIdentity)
      )
    )
      fail('unexplained_holder');
  }
  const control = observed.find((worker) => worker.component === 'ar-control');
  if (!control) fail('component_missing');
  const workers: SamlDrWriterInventoryWorker[] = await mapBounded(observed, async (worker) => {
    let contractDigest: string | null = null;
    if (worker.component) {
      // D1-backed source snapshots do not prove external PostgreSQL alias/writer identity.
      if (worker.bindings.some((binding) => binding.type === 'hyperdrive'))
        fail('external_source_unsupported');
      for (const binding of worker.bindings) {
        if (binding.type !== 'durable_object_namespace') continue;
        const ownerName =
          binding.script_name === undefined ? worker.workerName : text(binding.script_name);
        const owner = expected.get(ownerName);
        if (
          !owner ||
          typeof binding.class_name !== 'string' ||
          !samlDrDurableObjectClasses(owner).includes(binding.class_name) ||
          (binding.environment !== undefined && binding.environment !== 'production')
        )
          fail('durable_object_owner_unverified');
      }
      requirePlainBinding(worker.bindings, 'ENABLE_SAML_DR_EXPORT', 'true');
      requirePlainBinding(worker.bindings, 'AUTHRIM_ENVIRONMENT_NAME', input.environmentId);
      requirePlainBinding(worker.bindings, 'AUTHRIM_WORKER_SCRIPT_NAME', worker.workerName);
      if (
        !worker.bindings.some(
          (binding) =>
            binding.name === 'CONTROL_SMOKE_VERSION' && binding.type === 'version_metadata'
        )
      )
        fail('version_metadata_missing');
      if (worker.component === 'ar-control') {
        if (!worker.facts.some((binding) => binding.name === 'CONTROL_DB' && binding.type === 'd1'))
          fail('local_admission_missing');
      } else {
        requireServiceBinding(worker.bindings, {
          name: 'SAML_DR_MUTATION_CONTROL',
          service: control.workerName,
          entrypoint: 'SamlDrMutationEntrypoint',
          props: {
            caller: worker.component,
            audience: 'authrim-saml-dr-mutation-v1',
            environmentId: input.environmentId,
          },
        });
      }
      requireServiceBinding(control.bindings, {
        name: `SMOKE_${worker.component.replaceAll('-', '_').toUpperCase()}`,
        service: worker.workerName,
        entrypoint: 'RuntimeSmokeEntrypoint',
        props: {
          caller: 'ar-control',
          audience: 'authrim-runtime-smoke-v1',
          environmentId: input.environmentId,
          targetWorker: worker.workerName,
        },
      });
      const probe = await input.probeWorker(worker.component);
      contractDigest = await samlDrWriterContractDigest(worker.component);
      if (
        !probe ||
        probe.formatVersion !== 1 ||
        probe.environmentId !== input.environmentId ||
        probe.workerName !== worker.workerName ||
        probe.component !== worker.component ||
        probe.versionId !== worker.versionId ||
        probe.contractDigest !== contractDigest ||
        canonical(probe.surfaces) !== canonical(samlDrWriterSurfaces(worker.component))
      )
        fail('probe_mismatch');
    }
    return {
      workerName: worker.workerName,
      deploymentId: worker.deploymentId,
      versionId: worker.versionId,
      bindings: worker.facts,
      bindingsDigest: await samlDrContractSha256(canonical(worker.facts)),
      component: worker.component,
      contractDigest,
    };
  });
  // Detect account inventory and deployment races during the read/probe phase as well as across capture.
  if (
    canonical(names(await input.api.listWorkerScriptsForInventory(MAX_ACCOUNT_SCRIPTS))) !==
    canonical(scriptNames)
  )
    fail('changed');
  await mapBounded(workers, async (worker) => {
    const current = activeVersion(await input.api.listWorkerDeployments(worker.workerName));
    if (current.deploymentId !== worker.deploymentId || current.versionId !== worker.versionId)
      fail('changed');
  });
  const body = {
    formatVersion: 1 as const,
    accountId: input.accountId,
    environmentId: input.environmentId,
    tenantId: input.tenantId,
    workers,
    protectedResources,
  };
  const receipt: SamlDrWriterInventoryReceipt = {
    ...body,
    inventoryDigest: await samlDrContractSha256(canonical(body)),
  };
  if (input.expectedReceipt && canonical(receipt) !== canonical(input.expectedReceipt))
    fail('changed');
  return receipt;
}

export function verifyEnvironmentSamlDrWriterInventory(
  env: ControlEnv,
  input: {
    tenantId: string;
    expectedReceipt?: SamlDrWriterInventoryReceipt;
  }
): Promise<SamlDrWriterInventoryReceipt> {
  if (
    env.ENABLE_SAML_DR_EXPORT !== 'true' ||
    !env.AUTHRIM_ENVIRONMENT_NAME ||
    !env.CLOUDFLARE_WORKERS_API_TOKEN
  )
    fail('unavailable');
  const api = new CloudflareControlApiClient({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    tokens: { workers: env.CLOUDFLARE_WORKERS_API_TOKEN },
  });
  return verifySamlDrSourceWriterInventory({
    api,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    environmentId: env.AUTHRIM_ENVIRONMENT_NAME,
    ...input,
    probeWorker(component) {
      const name = `SMOKE_${component.replaceAll('-', '_').toUpperCase()}` as keyof ControlEnv;
      const binding = env[name];
      if (
        !binding ||
        typeof binding !== 'object' ||
        !('inspectSamlDrWriter' in binding) ||
        typeof binding.inspectSamlDrWriter !== 'function'
      )
        fail('probe_unavailable');
      return binding.inspectSamlDrWriter();
    },
  });
}
