/**
 * Shared R-B resolver-driver harness for the runtime-topology matrices (R-B, and the
 * mutation-to-observation meta tests).
 *
 * This helper module is intentionally not collected as a test; the actual
 * per-row tests live in rb.test.ts.
 */
import type { Row } from '../fixtures/covering-array';
import { installFrozenNow, restoreRealClock, frozenNowMs } from '../fixtures/deterministic-clock';
import { RB_CASE_TABLE, decideRoutingRb, type TopoCase, type RbDecision } from './cases';
import { checkRbObservation, emptyRbObservation, type RbObservation } from './observation';
import {
  createTopologyKit,
  makeGenerationDocument,
  observedTenantAccessSet,
  observedBindingLabel,
  type TopologyEnvKit,
} from './routing-env';
import {
  buildSnapshot,
  signSnapshot,
  signSnapshotWithUnknownKid,
  corruptSnapshotSignature,
  tamperSnapshotPayloadAfterSigning,
  RUNTIME_REGISTRY_GENERATION_KEY,
  RUNTIME_REGISTRY_SNAPSHOT_KEY,
  type SnapshotStoreSpec,
} from './registry-fixtures';
import {
  clearTenantDatabaseResolverMemoryCache,
  resolveTenantDatabaseSourceFromRegistry,
  TenantDatabaseResolverError,
  type ResolvedTenantDatabaseSource,
  type TenantDatabaseRequestCache,
} from '../../../packages/ar-lib-core/src/services/tenant-database-resolver';
import type { CallLedger } from '../fixtures/call-ledger';

export { RB_CASE_TABLE, clearTenantDatabaseResolverMemoryCache };

export function rbBeforeEach(nowMs: number): void {
  installFrozenNow(nowMs);
  clearTenantDatabaseResolverMemoryCache();
}

export function rbAfterEach(): void {
  restoreRealClock();
}

// =============================================================================
// R-B dimension → production contract mapping
// =============================================================================

function roleOf(dataRole: string): 'tenant_core' | 'tenant_pii' {
  return dataRole === 'pii' ? 'tenant_pii' : 'tenant_core';
}

function dataRoleOf(dataRole: string): 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii' {
  if (dataRole === 'pii') return 'tenant_pii';
  if (dataRole === 'core-users') return 'tenant_core/users';
  return 'tenant_core/default';
}

function bindingRefOf(serviceRoute: string): string {
  switch (serviceRoute) {
    case 'service-binding':
      return 'DB_PII';
    case 'login-ui':
      return 'DB_LOGIN';
    case 'unavailable':
      return 'DB_MISSING';
    default:
      return 'DB';
  }
}

// =============================================================================
// R-B seeding
// =============================================================================

export interface RbRunResult {
  resolved?: ResolvedTenantDatabaseSource;
  error?: unknown;
  bindingAccessFailed?: boolean;
}

export interface SeededRbRow {
  kit: TopologyEnvKit;
  requestCache: TenantDatabaseRequestCache;
  secrets: string[];
  run: () => Promise<RbRunResult>;
}

function throwingBinding(): unknown {
  return {
    prepare: () => {
      throw new Error('binding transport failed');
    },
    batch: async () => {
      throw new Error('binding transport failed');
    },
  };
}

export async function seedRbRow(entry: TopoCase): Promise<SeededRbRow> {
  const d = entry.dimensions;
  const tenantHost = String(d.tenantHost);
  const snapshotState = String(d.snapshotState);
  const generationState = String(d.generationState);
  const allocationScope = String(d.allocationScope);
  const registryTenant = String(d.registryTenant);
  const bindingOwner = String(d.bindingOwner);
  const dataRole = String(d.dataRole);
  const bindingState = String(d.bindingState);
  const serviceRoute = String(d.serviceRoute);
  const provider = String(d.provider);
  const cacheState = String(d.cacheState);

  const kit = await createTopologyKit({
    deploymentMode: 'multi',
    forwardedPolicy: 'disabled',
    registryState: 'valid',
  });
  const env = kit.env as unknown as Record<string, unknown>;
  if (bindingState === 'wrong-type') env['DB_WRONG'] = 'not-a-database';
  if (bindingState === 'throws') env['DB_THROW'] = throwingBinding();

  const snapshotTenantId =
    registryTenant === 'foreign' ? (tenantHost === 'alpha' ? 'beta' : 'alpha') : tenantHost;
  const bindingRef =
    bindingState === 'missing'
      ? 'DB_MISSING'
      : bindingState === 'wrong-type'
        ? 'DB_WRONG'
        : bindingState === 'throws'
          ? 'DB_THROW'
          : bindingRefOf(serviceRoute);

  const nowMs = frozenNowMs();
  const store: SnapshotStoreSpec = {
    tenantId: snapshotTenantId,
    dataRole: dataRoleOf(dataRole),
    bindingRef,
    generation: 5,
    runtimeGeneration: 5,
    allocationScope: allocationScope === 'tenant-exclusive' ? 'tenant_exclusive' : 'shared_pool',
    ownerTenantId:
      bindingOwner === 'matching'
        ? allocationScope === 'tenant-exclusive'
          ? snapshotTenantId
          : null
        : bindingOwner === 'foreign'
          ? 'foreign-owner'
          : 'other-tenant',
    provider,
    databaseId: `db-${snapshotTenantId}-${dataRole}`,
  };
  const unsigned = snapshotState === 'unsigned';
  const built = buildSnapshot({
    tenantId: snapshotTenantId,
    runtimeGeneration: 5,
    routeStatus: snapshotState === 'quarantined' ? 'quarantined' : 'active',
    quarantineDenyGeneration: snapshotState === 'quarantined' ? 1 : 0,
    stores: [store],
    publishedAt: new Date(nowMs - 60_000).toISOString(),
    expiresAt:
      snapshotState === 'expired'
        ? new Date(nowMs - 3600_000).toISOString()
        : new Date(nowMs + 3600_000).toISOString(),
  });
  let signed = unsigned ? built : await signSnapshot(built, new Date(nowMs).toISOString());
  const secrets = [signed.metadata.signature as string];
  if (snapshotState === 'signature-tampered') {
    corruptSnapshotSignature(signed);
  } else if (snapshotState === 'payload-tampered') {
    tamperSnapshotPayloadAfterSigning(signed);
  } else if (snapshotState === 'unknown-kid') {
    // A well-formed JWS signed with a key whose kid is absent from the verification
    // JWKS: envelope OK, no matching verification key.
    signed = await signSnapshotWithUnknownKid(built, new Date(nowMs).toISOString());
    secrets.push(signed.metadata.signature as string);
  }

  const generation = makeGenerationDocument(
    generationState === 'stale' ? 4 : generationState === 'ahead' ? 6 : 5,
    'active',
    0,
    nowMs
  );
  if (generationState !== 'missing') {
    await kit.runtimeRegistry.put(RUNTIME_REGISTRY_GENERATION_KEY(tenantHost), generation);
  }
  if (snapshotState !== 'missing') {
    await kit.runtimeRegistry.put(
      RUNTIME_REGISTRY_SNAPSHOT_KEY(tenantHost),
      JSON.stringify(signed)
    );
  }

  const requestCache: TenantDatabaseRequestCache = new Map();
  const resolveOnce = async (): Promise<RbRunResult> => {
    try {
      const resolved = await resolveTenantDatabaseSourceFromRegistry(kit.env, {
        tenantId: tenantHost,
        role: roleOf(dataRole),
        dataRole: dataRoleOf(dataRole),
        shardGroup: 'default',
        shardIndex: 0,
        requestCache,
        memoryCacheTtlMs: 0,
        generationCacheTtlMs: 0,
      });
      return { resolved };
    } catch (error) {
      return { error };
    }
  };

  const reseedGenerationSix = async (): Promise<void> => {
    const next = buildSnapshot({
      tenantId: tenantHost,
      runtimeGeneration: 6,
      routeStatus: 'active',
      quarantineDenyGeneration: 0,
      stores: [
        {
          tenantId: tenantHost,
          dataRole: 'tenant_core/default',
          bindingRef: 'DB',
          generation: 6,
          runtimeGeneration: 6,
          allocationScope: 'shared_pool',
          ownerTenantId: null,
          provider: 'd1',
          databaseId: `db-${tenantHost}-core-default`,
        },
      ],
      publishedAt: new Date(nowMs - 30_000).toISOString(),
      expiresAt: new Date(nowMs + 3600_000).toISOString(),
    });
    const signedNext = await signSnapshot(next, new Date(nowMs).toISOString());
    const nextGeneration = makeGenerationDocument(6, 'active', 0, nowMs);
    await kit.runtimeRegistry.put(RUNTIME_REGISTRY_GENERATION_KEY(tenantHost), nextGeneration);
    await kit.runtimeRegistry.put(
      RUNTIME_REGISTRY_SNAPSHOT_KEY(tenantHost),
      JSON.stringify(signedNext)
    );
  };

  const run = async (): Promise<RbRunResult> => {
    if (cacheState === 'warm' || cacheState === 'warm-stale') {
      const first = await resolveOnce();
      if (first.error) {
        throw new Error(`warm row ${entry.id}: first resolution failed: ${String(first.error)}`);
      }
      if (cacheState === 'warm-stale') {
        await reseedGenerationSix();
      }
    }
    const result = await resolveOnce();
    if (bindingState === 'throws' && result.resolved) {
      try {
        (result.resolved.source as unknown as { prepare(sql: string): unknown }).prepare(
          'SELECT 1'
        );
        return { ...result, bindingAccessFailed: false };
      } catch (error) {
        return { error, bindingAccessFailed: true };
      }
    }
    if (result.resolved) {
      // Exercise the selected binding with a minimal real operation so the actual
      // binding used is observed in the ledger.
      try {
        await (
          result.resolved.source as unknown as {
            queryOne(sql: string, params?: unknown[]): Promise<unknown>;
          }
        ).queryOne('SELECT 1', []);
      } catch (error) {
        return { error };
      }
    }
    return result;
  };

  return { kit, requestCache, secrets, run };
}

// =============================================================================
// R-B observation builder (production artifacts only)
// =============================================================================

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

export function deriveRbErrorCode(error: unknown): string | null {
  if (error instanceof TenantDatabaseResolverError) return error.code;
  if (error instanceof Error && error.message === 'binding transport failed') {
    return 'binding_access_threw';
  }
  return null;
}

export function deriveRbRejectionLayer(
  row: Row,
  errorCode: string | null,
  securityEventWritten: boolean
): RbObservation['rejectionLayer'] {
  switch (errorCode) {
    case 'missing_generation':
      return 'generation';
    case 'missing_snapshot':
      return 'snapshot';
    case 'invalid_route_contract':
      return String(row.provider) === 'unsupported' ? 'provider' : 'snapshot';
    case 'invalid_snapshot_signature':
      if (securityEventWritten) return 'signature';
      return String(row.registryTenant) === 'foreign' ? 'registry-tenant' : 'generation';
    case 'quarantined_route':
      return 'route';
    case 'expired_snapshot':
      return 'expiry';
    case 'missing_binding':
      return 'binding';
    case 'binding_access_threw':
      return 'binding-access';
    default:
      return null;
  }
}

export function rbSecurityEventWritten(ledger: CallLedger): boolean {
  return ledger.has(
    'd1.execute',
    (target) =>
      target.includes('security_alerts') ||
      target.includes('admin_jobs') ||
      target.includes('admin_audit_log') ||
      target.includes('internal_notification_events')
  );
}

export function rbSecretLeakScan(
  ledger: CallLedger,
  result: RbRunResult,
  secrets: string[],
  cache: TenantDatabaseRequestCache
): boolean {
  const serialized = [
    ...ledger.all().map((entry) => `${entry.target}\n${safeStringify(entry.detail)}`),
    safeStringify(result.error),
    safeStringify(Array.from(cache.keys())),
  ].join('\n');
  for (const secret of secrets) {
    if (!secret) continue;
    if (serialized.includes(secret)) return true;
  }
  return false;
}

export function bindingLabelOf(bindingRef: string | null): string | null {
  if (bindingRef === 'DB_PII') return 'pii';
  if (bindingRef === 'DB_LOGIN') return 'core-login';
  if (bindingRef === 'DB') return 'core';
  return null;
}

export async function buildRbObservation(
  entry: TopoCase,
  result: RbRunResult,
  cacheHit: boolean,
  securityEventWritten: boolean,
  ledger: CallLedger
): Promise<RbObservation> {
  const row = entry.dimensions as Row;
  const obs = emptyRbObservation();
  const errorCode = deriveRbErrorCode(result.error);
  const resolved = result.resolved;
  if (errorCode !== null) {
    obs.outcome = 'error';
    obs.errorCode = errorCode;
    obs.securityEventWritten = securityEventWritten;
  } else if (resolved) {
    obs.outcome = 'resolved';
    obs.bindingRef = resolved.bindingRef;
    obs.generation = resolved.generation;
    obs.runtimeGeneration = resolved.runtimeGeneration;
    obs.dataRole = resolved.dataRole;
    obs.allocationScope = resolved.allocationScope;
    obs.ownerTenantId = resolved.ownerTenantId;
    obs.provider = resolved.driver;
    obs.securityEventWritten = securityEventWritten;
  }
  obs.cacheHit = cacheHit;
  obs.rejectionLayer = deriveRbRejectionLayer(row, obs.errorCode, obs.securityEventWritten);
  obs.tenantAccessSet = observedTenantAccessSet(ledger);
  const bindingLabel = observedBindingLabel(ledger);
  obs.bindingOperation =
    obs.outcome === 'resolved' && obs.errorCode === null && bindingLabel !== null
      ? `d1:${bindingLabel}:SELECT 1`
      : null;
  return obs;
}

export function expectedRbObservation(entry: TopoCase, decision: RbDecision): RbObservation {
  const obs = emptyRbObservation();
  obs.outcome = decision.outcome;
  obs.errorCode = decision.errorCode;
  obs.rejectionLayer = decision.rejectionLayer;
  obs.bindingRef = decision.bindingRef;
  obs.generation = decision.generation;
  obs.runtimeGeneration = decision.runtimeGeneration;
  obs.dataRole = decision.dataRole;
  obs.allocationScope = decision.allocationScope;
  obs.ownerTenantId = decision.ownerTenantId;
  obs.provider = decision.provider;
  obs.cacheHit = decision.cacheHit;
  obs.securityEventWritten = decision.securityEventWritten;
  obs.foreignTenantAccess = false;
  obs.secretLeak = false;
  obs.tenantAccessSet = [String(entry.dimensions.tenantHost)];
  obs.bindingOperation =
    decision.outcome === 'resolved'
      ? `d1:${bindingLabelOf(decision.bindingRef) ?? 'core'}:SELECT 1`
      : null;
  return obs;
}

export function assertRbObservation(observation: RbObservation, expected: RbObservation): void {
  const mismatches = checkRbObservation(observation, expected);
  expect(
    mismatches,
    `observation mismatches: ${mismatches.join(', ')}\nOBS=${JSON.stringify(observation)}\nEXP=${JSON.stringify(expected)}`
  ).toEqual([]);
}

// =============================================================================
// R-B mutation witnesses
// =============================================================================

export function rbMutationCandidate(entry: TopoCase, mutationId: string): RbDecision {
  const base = decideRoutingRb(entry.dimensions as Row);
  const resolvedShape = {
    ...base,
    outcome: 'resolved' as const,
    errorCode: null,
    rejectionLayer: null,
  };
  switch (mutationId) {
    case 'topology:use-foreign-tenant-registry-or-binding':
      // Resolving a foreign-tenant snapshot as the tenant's own binding.
      return {
        ...resolvedShape,
        bindingRef: 'DB',
        ownerTenantId: String(entry.dimensions.tenantHost) === 'beta' ? 'alpha' : 'beta',
      };
    case 'topology:accept-tenant-exclusive-binding-ownership-mismatch':
      // Accepting a tenant-exclusive binding whose owner is another tenant.
      return { ...resolvedShape, bindingRef: 'DB', ownerTenantId: 'beta' };
    case 'topology:assign-pii-role-to-core-binding':
      // Assigning the PII role to the shared core binding.
      return { ...base, dataRole: 'tenant_pii', bindingRef: 'DB' };
    case 'topology:accept-bad-signature-snapshot':
      // Accepting a tampered/unsigned/expired snapshot.
      return { ...resolvedShape, bindingRef: base.bindingRef ?? 'DB' };
    case 'topology:use-quarantined-route-as-active':
      // Treating a quarantined route as active.
      return { ...resolvedShape, bindingRef: base.bindingRef ?? 'DB' };
    case 'topology:fall-back-to-common-database-when-required-binding-missing':
      // Falling back to the common database when the required binding is missing.
      return { ...resolvedShape, bindingRef: 'DB' };
    case 'topology:return-success-route-after-service-binding-failure':
      // Returning a success route after the service binding failed to access.
      return { ...resolvedShape, bindingRef: base.bindingRef ?? 'DB' };
    case 'topology:reuse-stale-runtime-generation-cache':
      // Serving the stale generation from cache.
      return base.outcome === 'resolved'
        ? { ...base, generation: 4, runtimeGeneration: 4, cacheHit: true }
        : { ...resolvedShape, bindingRef: 'DB' };
    default:
      throw new Error(`Unknown R-B mutation ${mutationId}`);
  }
}

export { RB_CASE_TABLE as RB_TABLE };
