import type {
  TenantPortableReference,
  TenantPortableSourceIdentity,
} from './selection-contract.js';

export interface TenantPortableRecordIdentity {
  module: string;
  collection: string;
  id: string;
  tenantId: string;
}

export interface TenantPortableDependency {
  from: TenantPortableRecordIdentity;
  to: TenantPortableReference;
}

/** Input produced by authenticated bundle decoding, never raw uploaded JSON. */
export interface TenantPortableReferenceInventory {
  bundleId: string;
  source: TenantPortableSourceIdentity;
  records: readonly TenantPortableRecordIdentity[];
  references: readonly TenantPortableDependency[];
}

export interface TenantPortableReferenceIssue {
  code:
    | 'empty_input'
    | 'duplicate_bundle'
    | 'source_mismatch'
    | 'unknown_module'
    | 'cross_tenant_identity'
    | 'duplicate_record'
    | 'missing_reference_owner'
    | 'missing_required_reference';
  bundleId?: string;
  record?: TenantPortableRecordIdentity;
}

export interface TenantPortableReferenceValidation {
  issues: TenantPortableReferenceIssue[];
  /** Historical attribution is retained without creating or authorizing a live principal. */
  unresolvedProvenance: TenantPortableDependency[];
}

function identityKey(record: TenantPortableRecordIdentity): string {
  // Tuple encoding avoids collisions when a logical ID itself contains a separator.
  return JSON.stringify([record.tenantId, record.module, record.collection, record.id]);
}

function sameSource(a: TenantPortableSourceIdentity, b: TenantPortableSourceIdentity): boolean {
  // The initial restore contract is exact-version, same-tenant and same-issuer.
  // No URL normalization or version coercion silently changes the source identity.
  return (
    a.tenantId === b.tenantId && a.issuer === b.issuer && a.productVersion === b.productVersion
  );
}

/**
 * Resolve required logical references across a pinned set of decoded bundle inventories.
 * This is one validation stage: it neither authorizes an import nor proves business-state
 * compatibility. Module validators must additionally check revisions, revocations and
 * authorization constraints. Shared/external dependencies and explicit Admin mappings are
 * validated separately; this function never satisfies a reference by an email match.
 */
export function validateTenantPortableReferences(
  inputs: readonly TenantPortableReferenceInventory[],
  expectedSource: TenantPortableSourceIdentity,
  knownModules: ReadonlySet<string>
): TenantPortableReferenceValidation {
  const issues: TenantPortableReferenceIssue[] = [];
  const unresolvedProvenance: TenantPortableDependency[] = [];
  const bundles = new Set<string>();
  const records = new Set<string>();
  const ownedRecords = new Map<string, Set<string>>();
  if (inputs.length === 0) return { issues: [{ code: 'empty_input' }], unresolvedProvenance };

  for (const input of inputs) {
    if (bundles.has(input.bundleId)) {
      issues.push({ code: 'duplicate_bundle', bundleId: input.bundleId });
    }
    bundles.add(input.bundleId);
    if (!sameSource(input.source, expectedSource)) {
      issues.push({ code: 'source_mismatch', bundleId: input.bundleId });
    }
    const localRecords = new Set<string>();
    ownedRecords.set(input.bundleId, localRecords);
    for (const record of input.records) {
      if (record.tenantId !== expectedSource.tenantId) {
        issues.push({ code: 'cross_tenant_identity', bundleId: input.bundleId, record });
      }
      if (!knownModules.has(record.module)) {
        issues.push({ code: 'unknown_module', bundleId: input.bundleId, record });
      }
      const key = identityKey(record);
      if (records.has(key)) {
        // Even byte-identical duplicates require an explicit future merge contract.
        issues.push({ code: 'duplicate_record', bundleId: input.bundleId, record });
      }
      records.add(key);
      localRecords.add(key);
    }
  }

  for (const input of inputs) {
    for (const reference of input.references) {
      if (!ownedRecords.get(input.bundleId)?.has(identityKey(reference.from))) {
        issues.push({
          code: 'missing_reference_owner',
          bundleId: input.bundleId,
          record: reference.from,
        });
      }
      const target = reference.to;
      if (target.tenantId !== expectedSource.tenantId) {
        issues.push({ code: 'cross_tenant_identity', bundleId: input.bundleId, record: target });
        continue;
      }
      if (!knownModules.has(target.module)) {
        issues.push({ code: 'unknown_module', bundleId: input.bundleId, record: target });
        continue;
      }
      if (records.has(identityKey(target))) continue;
      if (target.requirement === 'provenance' && target.meaning === 'admin_actor') {
        unresolvedProvenance.push(reference);
      } else {
        // An executable principal/resource cannot bypass resolution by claiming to be
        // historical provenance. The decoder also validates the reference union.
        issues.push({
          code: 'missing_required_reference',
          bundleId: input.bundleId,
          record: target,
        });
      }
    }
  }
  return { issues, unresolvedProvenance };
}
