import { decodeTenantBundle } from './bundle-codec';
import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';
import type { TenantBundleReadLimits } from './bundle-framing';
import type { TenantBundleManifest, TenantBundleManifestExpectation } from './bundle-manifest';
import { TENANT_PORTABILITY_MODULES, type TenantPortableDataset } from './module-contract';
import type { TenantPortableDependency, TenantPortableRecordIdentity } from './reference-contract';

export interface TenantBundleInspection {
  records: readonly TenantPortableRecordIdentity[];
  references: readonly TenantPortableDependency[];
}
/** Installed code only. Must parse schema, validate values/ownership and reject malformed records. */
export interface TenantBundleDatasetInspector {
  chunk(bytes: Uint8Array, ordinal: number): Promise<TenantBundleInspection>;
  /** Detect incomplete multi-chunk records/assets and dataset-level invariants. */
  finish(): Promise<void>;
  dispose(): Promise<void>;
}
export type TenantBundleInspectorFactory = (
  dataset: TenantPortableDataset,
  manifest: TenantBundleManifest
) => Promise<TenantBundleDatasetInspector>;

/**
 * Fresh operation-local scratch index. Production implementations must use bounded
 * pages/queries, not accumulate all identities or edges in Worker memory.
 * `record` atomically rejects duplicates across ALL inputs to the pinned plan.
 */
export interface TenantBundleReferenceIndex {
  record(bundleId: string, identity: TenantPortableRecordIdentity): Promise<boolean>;
  hasRecord(identity: TenantPortableRecordIdentity, bundleId?: string): Promise<boolean>;
  reference(bundleId: string, dependency: TenantPortableDependency): Promise<void>;
  references(): AsyncIterable<{ bundleId: string; dependency: TenantPortableDependency }>;
  dispose(): Promise<void>;
}
export interface TenantBundleValidationInput {
  stream: AsyncIterable<Uint8Array>;
  key: TenantBundleKeyEnvelope;
  expected: TenantBundleManifestExpectation;
  limits: TenantBundleReadLimits;
}

function invalid(): never {
  throw new Error('invalid_tenant_bundle_validation');
}
function boundedArray(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 4096;
}
function validIdentity(record: TenantPortableRecordIdentity, tenantId: string): boolean {
  return (
    Boolean(record) &&
    record.tenantId === tenantId &&
    (TENANT_PORTABILITY_MODULES as readonly string[]).includes(record.module) &&
    typeof record.collection === 'string' &&
    record.collection.length > 0 &&
    record.collection.length <= 256 &&
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    record.id.length <= 4096
  );
}

/**
 * Validates a complete pinned input set without importing records. Inspectors may
 * use isolated scratch storage, never live target tables or external delivery.
 * A successful return still requires authorization, prerequisites and target-plan checks.
 */
export async function validateTenantBundleInputSet(
  inputs: readonly TenantBundleValidationInput[],
  factories: ReadonlyMap<string, TenantBundleInspectorFactory>,
  createIndex: () => Promise<TenantBundleReferenceIndex>
): Promise<{ manifests: TenantBundleManifest[]; unresolvedProvenanceCount: number }> {
  if (!inputs.length || inputs.length > 32) invalid();
  // Pin control data before yielding to any adapter or storage operation.
  const pinned = inputs.map((input) => ({
    ...input,
    expected: structuredClone(input.expected),
    limits: { ...input.limits },
  }));
  const installed = new Map(factories);
  const source = pinned[0].expected.source;
  const ids = new Set<string>();
  for (const input of pinned) {
    const identity = input.expected.source;
    if (
      identity.tenantId !== source.tenantId ||
      identity.issuer !== source.issuer ||
      identity.productVersion !== source.productVersion ||
      ids.has(input.expected.bundleId)
    )
      invalid();
    ids.add(input.expected.bundleId);
  }
  const index = await createIndex();
  const manifests: TenantBundleManifest[] = [];
  try {
    for (const input of pinned) {
      let manifest: TenantBundleManifest | undefined;
      let inspector: TenantBundleDatasetInspector | undefined;
      let datasetIndex = 0;
      async function startInspector() {
        const dataset = manifest?.datasets[datasetIndex];
        const factory = dataset && installed.get(dataset.id);
        if (!dataset || !factory || !manifest) invalid();
        return factory(structuredClone(dataset), structuredClone(manifest));
      }
      try {
        for await (const event of decodeTenantBundle(
          input.stream,
          input.key,
          input.expected,
          input.limits
        )) {
          if (event.kind === 'manifest') {
            manifest = event.manifest;
            // Require support even for empty, external and rebuild datasets.
            if (manifest.datasets.some((dataset) => !installed.has(dataset.id))) invalid();
            inspector = await startInspector();
          } else if (event.kind === 'chunk') {
            if (!inspector || !manifest) invalid();
            const result = await inspector.chunk(event.bytes, event.ordinal);
            if (!result || !boundedArray(result.records) || !boundedArray(result.references))
              invalid();
            for (const record of result.records) {
              if (
                !validIdentity(record, source.tenantId) ||
                record.module !== manifest.datasets[datasetIndex].module ||
                !(await index.record(manifest.bundleId, record))
              )
                invalid();
            }
            for (const dependency of result.references) {
              if (
                !dependency ||
                !validIdentity(dependency.from, source.tenantId) ||
                !validIdentity(dependency.to, source.tenantId) ||
                dependency.from.module !== manifest.datasets[datasetIndex].module ||
                !['resource', 'user', 'admin_actor', 'admin_principal', 'asset', 'secret'].includes(
                  dependency.to.meaning
                ) ||
                !['required', 'provenance'].includes(dependency.to.requirement)
              )
                invalid();
              await index.reference(manifest.bundleId, dependency);
            }
          } else if (event.kind === 'dataset_end') {
            if (!inspector || !manifest) invalid();
            await inspector.finish();
            const finished = inspector;
            inspector = undefined;
            await finished.dispose();
            datasetIndex++;
            if (datasetIndex < manifest.datasets.length) inspector = await startInspector();
          } else {
            if (!manifest || inspector || datasetIndex !== manifest.datasets.length) invalid();
            manifests.push(event.manifest);
          }
        }
      } finally {
        if (inspector) await inspector.dispose();
      }
    }
    if (manifests.length !== pinned.length) invalid();
    let unresolvedProvenanceCount = 0;
    for await (const { bundleId, dependency } of index.references()) {
      if (!(await index.hasRecord(dependency.from, bundleId))) invalid();
      if (await index.hasRecord(dependency.to)) continue;
      if (dependency.to.requirement === 'provenance' && dependency.to.meaning === 'admin_actor')
        unresolvedProvenanceCount++;
      else invalid();
    }
    return { manifests, unresolvedProvenanceCount };
  } catch {
    // Parsers may put uploaded record contents in exception messages. Never let
    // those messages escape this boundary into API errors or operation logs.
    return invalid();
  } finally {
    try {
      await index.dispose();
    } catch {
      invalid();
    }
  }
}
