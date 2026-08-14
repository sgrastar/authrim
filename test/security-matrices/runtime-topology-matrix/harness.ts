/**
 * Shared middleware-driver harness for the runtime-topology matrices (R-A, R-D, R-E).
 *
 * Every request drives the production `requestContextMiddleware` on a typed Hono app and
 * normalizes the result into an RaObservation. The helper functions here are NOT
 * security matrix tests (this module must not be named *.test.ts so it is never collected
 * or re-run as a suite).
 */
import {
  createTopologyKit,
  createProbeApp,
  runProbe,
  seedTenantRow,
  seedVanityRows,
  seedVanityCache,
  seedRegistryForTenant,
  observedTenantAccessSet,
  observedBindingOperation,
  PRIMARY_VANITY_ALPHA,
  NON_PRIMARY_VANITY_ALPHA,
  INACTIVE_VANITY_ALPHA,
  UI_HOST,
  type TopologyEnvKit,
  type VanityRowSeed,
  type ProbeResult,
} from './routing-env';
import { decideRoutingRa, type TopoCase, type RaDecision } from './cases';
import { checkRaObservation, emptyRaObservation, type RaObservation } from './observation';
import type { CallLedger } from '../fixtures/call-ledger';

export { PRIMARY_VANITY_ALPHA, NON_PRIMARY_VANITY_ALPHA, INACTIVE_VANITY_ALPHA };

export function hostOf(hostClass: string): string | null {
  switch (hostClass) {
    case 'canonical':
      return 'alpha.authrim.example';
    case 'naked':
      return 'authrim.example';
    case 'active-vanity':
      return 'vanity.alpha.example';
    case 'inactive-vanity-alias':
      return 'vanity-inactive.example';
    case 'non-primary-alias':
      return 'alias.alpha.example';
    case 'unrelated':
      return 'evil.example';
    case 'sub-subdomain':
      return 'dev.alpha.authrim.example';
    case 'uppercase':
      return 'ALPHA.AUTHRIM.EXAMPLE';
    case 'port':
      return 'alpha.authrim.example:8443';
    case 'malformed':
      return 'bad host!';
    case 'missing':
      return null;
    case 'ui-host':
      return 'login.authrim.example';
    default:
      throw new Error(`Unknown hostClass ${hostClass}`);
  }
}

export function buildRaRequest(d: Record<string, unknown>): Request {
  const requestClass = String(d.requestClass);
  const method = requestClass === 'protocol' ? 'POST' : 'GET';
  const path =
    requestClass === 'discovery'
      ? '/.well-known/openid-configuration'
      : requestClass === 'internal'
        ? '/internal/health'
        : requestClass === 'browser'
          ? '/probe'
          : requestClass === 'admin'
            ? '/api/admin/settings/logging/tenant/alpha'
            : '/api/v1/login/interactions/start';
  const headers: Record<string, string> = {};
  if (requestClass === 'browser') headers['Accept'] = 'text/html';
  if (requestClass === 'admin') headers['X-Tenant-Id'] = 'alpha';
  const host = hostOf(String(d.hostClass));
  if (host !== null) headers['Host'] = host;
  if (String(d.forwardedPolicy) === 'enabled' && String(d.forwardedState) !== 'missing') {
    const forwarded =
      String(d.forwardedState) === 'matching'
        ? 'alpha.authrim.example'
        : String(d.forwardedState) === 'conflicting'
          ? 'beta.authrim.example'
          : 'bad host';
    headers['X-Authrim-Forwarded-Host'] = forwarded;
  }
  // A malformed Host header is carried only in the header (the URL itself must parse).
  const url =
    host !== null && String(d.hostClass) !== 'malformed'
      ? `https://${host}${path}`
      : `https://node.example${path}`;
  return new Request(url, { method, headers });
}

export interface SeededRaRow {
  kit: TopologyEnvKit;
  app: ReturnType<typeof createProbeApp>;
  request: Request;
  secrets: string[];
}

/**
 * Seed a full middleware environment for an R-A-style row. `vanitySeedFor` performs the
 * vanity cache + D1 row seeding for the row's host and vanity state; R-A, R-D, and R-E
 * pass their own mappings.
 */
export async function seedMiddlewareRow(
  d: Record<string, unknown>,
  vanitySeedFor: (hostKey: string, vanityState: string, kit: TopologyEnvKit) => Promise<void>
): Promise<SeededRaRow> {
  const deploymentMode = String(d.deploymentMode);
  const registryState = String(d.registryState);
  const bindingState = String(d.bindingState);
  const hostClass = String(d.hostClass);

  const kit = await createTopologyKit({
    deploymentMode: deploymentMode as 'single' | 'multi',
    forwardedPolicy: String(d.forwardedPolicy) as 'disabled' | 'enabled',
    registryState: registryState as
      | 'valid'
      | 'bad-signature'
      | 'missing'
      | 'quarantined'
      | 'not-configured',
    uiUrl: hostClass === 'ui-host' ? `https://${UI_HOST}` : undefined,
  });
  if (bindingState === 'wrong-type') {
    (kit.env as unknown as Record<string, unknown>)['DB_WRONG'] = 'not-a-database';
  }

  seedTenantRow(kit, 'default', 'active');
  const secrets: string[] = [];
  if (deploymentMode === 'multi') {
    seedTenantRow(kit, 'alpha', String(d.tenantLifecycle) === 'active' ? 'active' : 'inactive');
    seedTenantRow(kit, 'beta', 'active');
    if (registryState !== 'not-configured') {
      secrets.push(...(await seedRegistryForTenant(kit, 'alpha', registryState, bindingState)));
      if (
        hostClass === 'canonical' &&
        String(d.forwardedPolicy) === 'enabled' &&
        String(d.forwardedState) === 'conflicting'
      ) {
        await seedRegistryForTenant(kit, 'beta', 'valid', 'present');
      }
      await seedRegistryForTenant(kit, 'default', 'valid', 'present');
    }
  } else if (registryState !== 'not-configured') {
    secrets.push(...(await seedRegistryForTenant(kit, 'default', registryState, bindingState)));
  }

  if (deploymentMode === 'multi') {
    await vanitySeedFor(hostClass, String(d.vanityState), kit);
  }

  const request = buildRaRequest(d);
  const app = createProbeApp(kit.env);
  return { kit, app, request, secrets };
}

// =============================================================================
// Observation builders
// =============================================================================

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

export function secretLeakScan(
  ledger: CallLedger,
  result: ProbeResult,
  secrets: string[]
): boolean {
  const serialized = ledger
    .all()
    .map((entry) => `${entry.target}\n${safeStringify(entry.detail)}`)
    .join('\n');
  const bodyText = result.bodyText;
  for (const secret of secrets) {
    if (!secret) continue;
    if (serialized.includes(secret) || bodyText.includes(secret)) return true;
  }
  return false;
}

function deriveRaRejectionLayer(
  obs: RaObservation,
  ledger: CallLedger
): RaObservation['rejectionLayer'] {
  if (obs.status === 400) {
    if ((obs.errorDescription ?? '').includes('X-Tenant-Id')) return 'admin-header';
    return 'tenant-resolution';
  }
  if (obs.status === 308) return 'vanity-canonicalization';
  if (obs.status === 409 || obs.status === 503) return 'metadata-context';
  if (obs.status === 404 && obs.error === 'not_found') {
    if (obs.settingsRead) return 'binding-policy';
    if (obs.tenantExistsQuery) {
      return obs.vanityPrimaryQuery ? 'vanity-canonicalization' : 'tenant-exists';
    }
    // A tenant-exists positive-cache read (KV) without a D1 query still proves the
    // rejection happened at the existence stage (fail closed without a core database).
    if (ledger.has('kv.get', (t) => t.includes('tenant-exists'))) return 'tenant-exists';
    return 'tenant-resolution';
  }
  return null;
}

function deriveRaRegistryStatus(obs: RaObservation): RaObservation['registryStatus'] {
  if (obs.status === 409) {
    switch (obs.error) {
      case 'missing_generation':
        return 'not-configured';
      case 'invalid_snapshot_signature':
        return 'bad-signature';
      case 'missing_snapshot':
        return 'missing';
      case 'quarantined_route':
        return 'quarantined';
      default:
        return 'valid';
    }
  }
  if (obs.registrySnapshotRead || obs.tenantExistsQuery || obs.settingsRead) return 'valid';
  if (obs.status === 200) return 'not-reached';
  return null;
}

export function deriveTenantContextState(obs: RaObservation): RaObservation['tenantContextState'] {
  if (obs.tenantId === 'beta') return 'foreign';
  if (obs.tenantId !== null) return 'matching';
  return null;
}

export function deriveCanonicalIssuerState(
  obs: RaObservation
): RaObservation['canonicalIssuerState'] {
  if (obs.status === 308) return 'mismatched';
  if (obs.status === 200) {
    if (obs.issuerHost === 'authrim.example') return 'primary-naked';
    if (obs.issuerHost === 'vanity.alpha.example') return 'active-vanity';
    // A tenant subdomain (or the configured single-tenant issuer) is the canonical
    // issuer; any other host (URL fallback, unrelated host) is not a canonical issuer.
    if (
      obs.issuerHost === 'single.authrim.example' ||
      obs.issuerHost?.endsWith('.authrim.example')
    ) {
      return 'tenant-canonical';
    }
    return 'unavailable';
  }
  // A 404 at the tenant binding policy or vanity canonicalization proves the canonical
  // issuer exists but the request host is not it.
  if (obs.rejectionLayer === 'binding-policy' || obs.rejectionLayer === 'vanity-canonicalization') {
    return 'mismatched';
  }
  return 'unavailable';
}

/** The tenant a request intends to resolve, even when resolution fails. */
export function intendedTenantOf(d: Record<string, unknown>): string | null {
  if (String(d.deploymentMode) !== 'multi') return null;
  const h = String(d.hostClass);
  if (h === 'naked' || h === 'ui-host') return 'default';
  if (
    h === 'canonical' ||
    h === 'active-vanity' ||
    h === 'inactive-vanity-alias' ||
    h === 'non-primary-alias' ||
    h === 'uppercase' ||
    h === 'port'
  ) {
    if (
      h === 'canonical' &&
      String(d.forwardedPolicy) === 'enabled' &&
      String(d.forwardedState) === 'conflicting'
    ) {
      return 'beta';
    }
    return 'alpha';
  }
  return null;
}

/**
 * The tenant labels production is allowed to touch for this row: the resolved tenant,
 * plus the intended tenant when the resolution path read its storage (registry snapshot,
 * vanity revalidation, tenant-exists check, or a tenant-exists rejection), plus the
 * default tenant in single-tenant mode when the registry layer was reached.
 */
export function allowedTenantSetOf(d: Record<string, unknown>, decision: RaDecision): string[] {
  const set = new Set<string>();
  const intended = intendedTenantOf(d);
  const registryReached =
    decision.registryStatus !== null &&
    decision.registryStatus !== 'not-reached' &&
    decision.registryStatus !== 'not-configured';
  const intendedTouched = registryReached || decision.rejectionLayer === 'tenant-exists';
  if (decision.tenantId && intendedTouched) set.add(decision.tenantId);
  if (intendedTouched && intended) set.add(intended);
  if (String(d.deploymentMode) === 'single' && registryReached) set.add('default');
  return [...set].sort();
}

export async function buildRaObservation(
  kit: TopologyEnvKit,
  result: ProbeResult,
  secrets: string[],
  intendedTenant: string | null
): Promise<RaObservation> {
  const obs = emptyRaObservation();
  obs.status = result.status;
  obs.error = result.error;
  obs.errorDescription = result.errorDescription;
  obs.locationHost = result.location ? new URL(result.location).hostname : null;
  obs.tenantId = result.body?.tenantId ?? null;
  obs.issuerHost = result.body?.issuer ? new URL(result.body.issuer).hostname : null;
  obs.tenantAccessSet = observedTenantAccessSet(kit.ledger);
  obs.bindingOperation = observedBindingOperation(kit.ledger, 'tenants');
  obs.tenantExistsQuery = kit.ledger.has('d1.queryOne', (t) => t.includes('FROM tenants'));
  obs.tenantExistsCacheWrite = kit.ledger.has('kv.put', (t) => t.includes('tenant-exists'));
  obs.vanityResolutionAttempted =
    kit.ledger.has('kv.get', (t) => t.includes('tenant-vanity-domain')) ||
    kit.ledger.has('d1.queryOne', (t) => t.includes('active_hostname'));
  obs.vanityPrimaryQuery = kit.ledger.has('d1.queryOne', (t) =>
    t.includes('primary_active_tenant_key')
  );
  obs.settingsRead = kit.ledger.has('kv.get', (t) => t.includes('settings:tenant:'));
  obs.registrySnapshotRead = kit.ledger.has('kv.get', (t) =>
    t.includes('runtime-registry:snapshot')
  );
  obs.securityEventWritten = kit.ledger.has(
    'd1.execute',
    (t) =>
      t.includes('security_alerts') ||
      t.includes('admin_jobs') ||
      t.includes('admin_audit_log') ||
      t.includes('internal_notification_events')
  );
  obs.secretLeak = secretLeakScan(kit.ledger, result, secrets);
  obs.rejectionLayer = deriveRaRejectionLayer(obs, kit.ledger);
  obs.registryStatus = deriveRaRegistryStatus(obs);
  obs.tenantContextState = deriveTenantContextState(obs);
  obs.canonicalIssuerState = deriveCanonicalIssuerState(obs);
  void intendedTenant;
  return obs;
}

export function raResolveSucceeded(d: Record<string, unknown>, decision: RaDecision): boolean {
  if (String(d.deploymentMode) !== 'multi') return false;
  const r = String(d.requestClass);
  const h = String(d.hostClass);
  if (r === 'internal') return false;
  if (r === 'discovery' && (h === 'unrelated' || h === 'missing')) return false;
  if (h === 'ui-host') return false;
  if (h === 'active-vanity') return String(d.vanityState) === 'canonical';
  if (h === 'inactive-vanity-alias') return false;
  if (h === 'non-primary-alias') return true;
  if (h === 'unrelated' || h === 'sub-subdomain' || h === 'malformed' || h === 'missing')
    return false;
  return true;
}

export function expectedRaObservation(entry: TopoCase, decision: RaDecision): RaObservation {
  const obs = emptyRaObservation();
  obs.status = decision.status;
  obs.error = decision.error;
  obs.errorDescription = decision.errorDescription;
  obs.locationHost = decision.locationHost;
  obs.tenantId = decision.tenantId;
  obs.issuerHost = decision.issuerHost;
  obs.rejectionLayer = decision.rejectionLayer;
  obs.registryStatus = decision.registryStatus;
  obs.tenantContextState = decision.tenantContextState;
  obs.canonicalIssuerState = decision.canonicalIssuerState;
  obs.tenantAccessSet = allowedTenantSetOf(entry.dimensions, decision);

  const d = entry.dimensions;
  const multi = String(d.deploymentMode) === 'multi';
  const r = String(d.requestClass);
  const h = String(d.hostClass);
  const t = String(d.tenantLifecycle);
  const registryState = String(d.registryState);
  const bindingState = String(d.bindingState);
  const resolveSucceeded = raResolveSucceeded(d, decision);

  obs.tenantExistsQuery = resolveSucceeded && decision.rejectionLayer !== 'metadata-context';
  obs.bindingOperation = obs.tenantExistsQuery ? 'd1:core:tenants' : null;
  obs.tenantExistsCacheWrite = obs.tenantExistsQuery && t === 'active';
  obs.vanityResolutionAttempted =
    multi &&
    (h === 'active-vanity' ||
      h === 'inactive-vanity-alias' ||
      h === 'non-primary-alias' ||
      h === 'unrelated' ||
      h === 'missing' ||
      h === 'malformed') &&
    r !== 'tenant_inventory_admin' &&
    r !== 'platform_admin';
  obs.vanityPrimaryQuery =
    multi &&
    resolveSucceeded &&
    (decision.rejectionLayer === null ||
      decision.rejectionLayer === 'vanity-canonicalization' ||
      decision.rejectionLayer === 'binding-policy');
  obs.settingsRead =
    multi &&
    (r === 'browser' || r === 'protocol') &&
    resolveSucceeded &&
    decision.rejectionLayer !== 'vanity-canonicalization' &&
    decision.rejectionLayer !== 'metadata-context' &&
    decision.rejectionLayer !== 'tenant-exists';
  obs.registrySnapshotRead =
    (multi || r === 'browser' || r === 'protocol') &&
    decision.registryStatus !== null &&
    decision.registryStatus !== 'not-configured' &&
    decision.registryStatus !== 'not-reached' &&
    decision.registryStatus !== 'quarantined';
  obs.securityEventWritten = registryState === 'bad-signature' || bindingState !== 'present';
  obs.foreignTenantAccess = false;
  obs.secretLeak = false;
  return obs;
}

export function assertRaObservation(observation: RaObservation, expected: RaObservation): void {
  const mismatches = checkRaObservation(observation, expected);
  expect(
    mismatches,
    `observation mismatches: ${mismatches.join(', ')}\nOBS=${JSON.stringify(observation)}\nEXP=${JSON.stringify(expected)}`
  ).toEqual([]);
}

// =============================================================================
// Vanity seeding maps
// =============================================================================

/** R-A hostClass → vanity cache + rows. */
export async function raVanitySeedFor(
  hostClass: string,
  vanityState: string,
  kit: TopologyEnvKit
): Promise<void> {
  const rows: VanityRowSeed[] = [];
  if (hostClass === 'active-vanity') {
    await seedVanityCache(kit, PRIMARY_VANITY_ALPHA, 'alpha');
    if (vanityState === 'canonical') {
      rows.push({
        tenantId: 'alpha',
        hostname: PRIMARY_VANITY_ALPHA,
        isActive: true,
        isPrimary: true,
      });
    } else {
      rows.push({
        tenantId: 'beta',
        hostname: PRIMARY_VANITY_ALPHA,
        isActive: true,
        isPrimary: false,
      });
    }
  } else if (hostClass === 'inactive-vanity-alias') {
    await seedVanityCache(kit, INACTIVE_VANITY_ALPHA, 'alpha');
    rows.push({
      tenantId: 'alpha',
      hostname: INACTIVE_VANITY_ALPHA,
      isActive: false,
      isPrimary: true,
    });
  } else if (hostClass === 'non-primary-alias') {
    await seedVanityCache(kit, NON_PRIMARY_VANITY_ALPHA, 'alpha');
    rows.push({
      tenantId: 'alpha',
      hostname: NON_PRIMARY_VANITY_ALPHA,
      isActive: true,
      isPrimary: false,
    });
  } else if (vanityState === 'non-canonical') {
    rows.push({
      tenantId: 'alpha',
      hostname: PRIMARY_VANITY_ALPHA,
      isActive: true,
      isPrimary: true,
    });
  } else if (vanityState === 'inactive') {
    rows.push({
      tenantId: 'alpha',
      hostname: PRIMARY_VANITY_ALPHA,
      isActive: false,
      isPrimary: true,
    });
  }
  seedVanityRows(kit, rows);
}
