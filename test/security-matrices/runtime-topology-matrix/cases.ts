/**
 * Runtime-topology case tables.
 *
 * Matrices:
 * - R-A (request routing): drives the production `requestContextMiddleware` through a
 *   typed Hono app: Host/forwarded-host → request context → tenant existence/lifecycle →
 *   vanity binding → signed runtime registry → D1 binding ownership → canonical issuer.
 *   Required group 1 (host × forwarded-host policy × request class) includes admin.
 * - R-B (registry and binding resolution): drives the exported
 *   `resolveTenantDatabaseSourceFromRegistry` over signed runtime-registry snapshots.
 *   Required groups 2 (host tenant × registry tenant × binding owner) and 4 (allocation
 *   scope × owner tenant × data role), for BOTH alpha and beta tenants.
 * - R-C (route status): generation-document route status × cache state × runtime
 *   generation through the same resolver. Required group 3.
 * - R-D (canonical issuer): vanity state × canonical issuer state × browser/protocol
 *   request through the middleware. Required group 5.
 * - R-E (service binding × forwarded host × tenant context): middleware-driven binding
 *   state against the forwarded-host-selected tenant context. Required group 6.
 *
 * The independent legal-predicates and fixed coverage counts live in meta.test.ts and
 * do NOT share constraints, dimension arrays, or decision functions with this file.
 */
import {
  generateCoveringArray,
  type Constraint,
  type Row,
  type Scalar,
} from '../fixtures/covering-array';
import { deriveCaseId, semanticFingerprint } from '../fixtures/case-fingerprint';

// =============================================================================
// Matrix R-A dimensions
// =============================================================================

export const RA_DIMENSION_ORDER = [
  'deploymentMode',
  'hostClass',
  'forwardedPolicy',
  'forwardedState',
  'requestClass',
  'tenantLifecycle',
  'vanityState',
  'registryState',
  'bindingState',
] as const;

export const RA_VALUES: Record<string, readonly Scalar[]> = {
  deploymentMode: ['single', 'multi'],
  hostClass: [
    'canonical',
    'naked',
    'active-vanity',
    'inactive-vanity-alias',
    'non-primary-alias',
    'unrelated',
    'sub-subdomain',
    'uppercase',
    'port',
    'malformed',
    'missing',
    'ui-host',
  ],
  forwardedPolicy: ['disabled', 'enabled'],
  forwardedState: ['missing', 'matching', 'conflicting', 'malformed'],
  requestClass: ['browser', 'protocol', 'discovery', 'internal', 'admin'],
  tenantLifecycle: ['active', 'inactive', 'missing'],
  vanityState: ['canonical', 'non-canonical', 'inactive', 'missing', 'cross-tenant'],
  registryState: ['valid', 'bad-signature', 'missing', 'quarantined', 'not-configured'],
  bindingState: ['present', 'missing', 'wrong-type'],
};

/**
 * R-A reachability constraints. Every rule is grounded in the request-context middleware
 * branch order (packages/ar-lib-core/src/middleware/request-context.ts); provenance is
 * recorded per rule in FINDINGS.md.
 */
export const RA_CONSTRAINTS: Constraint[] = [
  // Single-tenant mode (no BASE_DOMAIN) never resolves a host tenant, vanity, or
  // binding layer (isMultiTenantEnabled guards each block), and the issuer is the
  // configured ISSUER_URL. The protocol path still resolves tenant metadata for the
  // default tenant through the signed runtime registry, so the registry state is
  // exercised freely. Only the unrelated-host browser/protocol shape is retained, with
  // and without a conflicting forwarded header.
  (row) =>
    row.deploymentMode !== 'single' ||
    (row.hostClass === 'unrelated' &&
      row.tenantLifecycle === 'missing' &&
      row.vanityState === 'missing' &&
      (row.requestClass === 'browser' || row.requestClass === 'protocol') &&
      row.bindingState === 'present' &&
      (row.forwardedState === 'missing' || row.forwardedState === 'conflicting')),
  // discovery/internal allow unknown tenants (allowUnknownTenant). Discovery resolves
  // tenant metadata for the selected/default tenant; internal health paths do not.
  // A resolved canonical discovery host therefore requires a valid registry and active
  // tenant, while an unresolved discovery host reaches the default metadata lookup.
  (row) =>
    (row.requestClass !== 'discovery' && row.requestClass !== 'internal') ||
    (row.registryState === 'not-configured' &&
      row.bindingState === 'present' &&
      row.vanityState === 'missing' &&
      row.tenantLifecycle === 'missing' &&
      row.forwardedPolicy === 'disabled' &&
      row.forwardedState === 'missing' &&
      (row.hostClass === 'unrelated' || row.hostClass === 'missing')) ||
    (row.hostClass === 'canonical' &&
      row.registryState === 'valid' &&
      row.bindingState === 'present' &&
      row.vanityState === 'missing' &&
      row.tenantLifecycle === 'active' &&
      row.forwardedPolicy === 'disabled' &&
      row.forwardedState === 'missing'),
  // Vanity-backed hosts only reach a resolution through resolveTenantFromVanityHost,
  // which requires the signed registry (resolveTenantDefaultStore) and an ACTIVE vanity
  // row joined to an ACTIVE tenant. Inactive aliases and cross-tenant (stale) caches
  // therefore require a fully valid registry so the failure is attributed to vanity.
  (row) =>
    row.hostClass !== 'active-vanity' ||
    (row.tenantLifecycle === 'active' &&
      (row.vanityState === 'canonical' || row.vanityState === 'cross-tenant') &&
      row.registryState === 'valid' &&
      row.bindingState === 'present' &&
      row.forwardedPolicy === 'disabled' &&
      row.forwardedState === 'missing' &&
      (row.requestClass === 'browser' || row.requestClass === 'protocol')),
  (row) =>
    row.hostClass !== 'inactive-vanity-alias' ||
    (row.tenantLifecycle === 'active' &&
      row.vanityState === 'inactive' &&
      row.registryState === 'valid' &&
      row.bindingState === 'present' &&
      row.forwardedPolicy === 'disabled' &&
      row.forwardedState === 'missing' &&
      (row.requestClass === 'browser' || row.requestClass === 'protocol')),
  (row) =>
    row.hostClass !== 'non-primary-alias' ||
    (row.tenantLifecycle === 'active' &&
      row.vanityState === 'non-canonical' &&
      row.registryState === 'valid' &&
      row.bindingState === 'present' &&
      row.forwardedPolicy === 'disabled' &&
      row.forwardedState === 'missing' &&
      (row.requestClass === 'browser' || row.requestClass === 'protocol')),
  // The reserved UI host resets tenant resolution to default (isReservedUiHost) but the
  // protocol path still resolves tenant metadata for the default tenant.
  (row) =>
    row.hostClass !== 'ui-host' ||
    (row.registryState === 'valid' &&
      row.tenantLifecycle === 'missing' &&
      row.vanityState === 'missing' &&
      row.bindingState === 'present' &&
      row.forwardedPolicy === 'disabled' &&
      row.forwardedState === 'missing' &&
      (row.requestClass === 'browser' || row.requestClass === 'protocol')),
  // Unresolvable host formats (sub-subdomain, malformed) are rejected before any
  // registry/vanity interaction; unrelated and missing hosts additionally appear in the
  // discovery/internal (unknown-tenant) and single-tenant shapes.
  (row) =>
    !(row.hostClass === 'sub-subdomain' || row.hostClass === 'malformed') ||
    (row.forwardedPolicy === 'disabled' &&
      row.registryState === 'not-configured' &&
      row.tenantLifecycle === 'missing' &&
      row.vanityState === 'missing' &&
      row.requestClass === 'protocol' &&
      row.bindingState === 'present' &&
      row.forwardedState === 'missing'),
  (row) =>
    (row.hostClass !== 'unrelated' && row.hostClass !== 'missing') ||
    (row.forwardedPolicy === 'disabled' &&
      row.registryState === 'not-configured' &&
      row.tenantLifecycle === 'missing' &&
      row.vanityState === 'missing' &&
      row.bindingState === 'present' &&
      row.forwardedState === 'missing' &&
      (row.requestClass === 'protocol' ||
        row.requestClass === 'discovery' ||
        row.requestClass === 'internal')) ||
    (row.deploymentMode === 'single' &&
      row.bindingState === 'present' &&
      (row.forwardedState === 'missing' || row.forwardedState === 'conflicting') &&
      (row.requestClass === 'browser' || row.requestClass === 'protocol')),
  // Naked/uppercase/port hosts resolve to the primary or subdomain tenant; the vanity
  // primary check still runs, so the registry must be valid and the tenant active.
  (row) =>
    !(row.hostClass === 'naked' || row.hostClass === 'uppercase' || row.hostClass === 'port') ||
    (row.tenantLifecycle === 'active' &&
      row.vanityState === 'missing' &&
      row.registryState === 'valid' &&
      row.bindingState === 'present' &&
      row.forwardedPolicy === 'disabled' &&
      row.forwardedState === 'missing' &&
      (row.requestClass === 'browser' || row.requestClass === 'protocol')),
  // Admin (tenant_scoped_admin) rows: the X-Tenant-Id header pins the tenant; the
  // forwarded-host state only shapes the issuer, never the admin tenant. The dedicated
  // admin preflight table in ra.test.ts covers missing/foreign/malformed
  // X-Tenant-Id and path mismatches.
  (row) =>
    row.requestClass !== 'admin' ||
    (row.deploymentMode === 'multi' &&
      row.hostClass === 'canonical' &&
      row.registryState === 'valid' &&
      row.bindingState === 'present' &&
      row.tenantLifecycle === 'active' &&
      row.vanityState === 'missing' &&
      (row.forwardedState === 'missing' ||
        row.forwardedState === 'matching' ||
        row.forwardedState === 'conflicting')),
  // Canonical subdomain shape rules (resolveTenantFromRequest precedence: trusted
  // X-Authrim-Forwarded-Host first, then Host; tenant_not_found never falls back to a
  // caller-supplied forwarded header).
  (row) => {
    if (row.hostClass !== 'canonical') return true;
    // Admin rows are governed by their own constraint (X-Tenant-Id pins the tenant);
    // the forwarded-host branches below apply only to browser/protocol rows.
    if (row.requestClass === 'admin') return true;
    const baseOk = (r: Row): boolean =>
      r.registryState === 'valid' &&
      r.bindingState === 'present' &&
      r.vanityState === 'missing' &&
      r.tenantLifecycle === 'active' &&
      (r.requestClass === 'browser' || r.requestClass === 'protocol');
    if (row.forwardedPolicy === 'enabled') {
      if (row.forwardedState === 'matching' || row.forwardedState === 'malformed') {
        return row.requestClass === 'protocol' && baseOk(row);
      }
      if (row.forwardedState === 'conflicting') return baseOk(row);
      // enabled + missing: identical to disabled + missing (no forwarded header present).
    }
    if (row.forwardedPolicy === 'disabled' && row.forwardedState === 'conflicting') {
      return baseOk(row);
    }
    if (
      row.forwardedPolicy === 'disabled' &&
      (row.forwardedState === 'matching' || row.forwardedState === 'malformed')
    ) {
      return row.requestClass === 'protocol' && baseOk(row);
    }
    // missing forwarded state: free within the independent legal set (see meta checker).
    if (row.tenantLifecycle === 'inactive' || row.tenantLifecycle === 'missing') {
      return (
        row.registryState === 'valid' &&
        row.vanityState === 'missing' &&
        row.bindingState === 'present' &&
        (row.requestClass === 'browser' || row.requestClass === 'protocol')
      );
    }
    if (row.vanityState === 'non-canonical') {
      return (
        row.registryState === 'valid' &&
        row.bindingState === 'present' &&
        (row.requestClass === 'browser' || row.requestClass === 'protocol')
      );
    }
    if (row.vanityState === 'inactive') {
      return (
        row.registryState === 'valid' &&
        row.bindingState === 'present' &&
        row.requestClass === 'protocol'
      );
    }
    if (row.bindingState === 'missing' || row.bindingState === 'wrong-type') {
      return (
        row.vanityState === 'missing' &&
        row.registryState === 'valid' &&
        (row.requestClass === 'browser' || row.requestClass === 'protocol')
      );
    }
    if (
      row.registryState === 'bad-signature' ||
      row.registryState === 'missing' ||
      row.registryState === 'quarantined'
    ) {
      return (
        row.vanityState === 'missing' &&
        row.bindingState === 'present' &&
        (row.requestClass === 'browser' || row.requestClass === 'protocol')
      );
    }
    return true;
  },
];

export const RA_CONSTRAINT_LABELS = [
  'single-tenant never consults host/vanity/registry/binding layers; issuer is ISSUER_URL',
  'discovery/internal allow unknown tenants and never resolve tenant metadata; resolved hosts still pass tenant-exists',
  'active-vanity requires an active tenant and the signed registry; canonical and cross-tenant (stale cache) states only',
  'inactive-vanity-alias requires a valid registry so the failure is attributed to the vanity layer',
  'non-primary-alias resolves through vanity then fails the binding/canonicalization check',
  'reserved UI host resets tenant resolution to default and still resolves metadata for default',
  'sub-subdomain/malformed/missing/unrelated hosts are rejected before registry/vanity interaction (protocol rows)',
  'naked/uppercase/port resolve to a tenant; registry valid and tenant active because vanity primary check still runs',
  'admin rows pin the tenant via X-Tenant-Id; forwarded state shapes the issuer only (dedicated preflights cover X-Tenant-Id states)',
  'canonical subdomain: trusted forwarded host wins only when configured; tenant_not_found never falls back to forwarded',
];

// Required group 1: host × forwarded-host policy × request class (includes admin).
export const RA_SELECTED_TRIPLES: Array<[string, string, string]> = [
  ['hostClass', 'forwardedPolicy', 'requestClass'],
];

// =============================================================================
// Matrix R-B dimensions
// =============================================================================

export const RB_DIMENSION_ORDER = [
  'tenantHost',
  'snapshotState',
  'generationState',
  'allocationScope',
  'registryTenant',
  'bindingOwner',
  'dataRole',
  'bindingState',
  'serviceRoute',
  'provider',
  'cacheState',
] as const;

export const RB_VALUES: Record<string, readonly Scalar[]> = {
  tenantHost: ['alpha', 'beta'],
  snapshotState: [
    'valid',
    'missing',
    'expired',
    'payload-tampered',
    'signature-tampered',
    'unknown-kid',
    'unsigned',
    'quarantined',
  ],
  generationState: ['matching', 'stale', 'ahead', 'missing'],
  allocationScope: ['shared-pool', 'tenant-exclusive'],
  registryTenant: ['matching', 'foreign'],
  bindingOwner: ['matching', 'foreign', 'unowned'],
  dataRole: ['core-default', 'core-users', 'pii'],
  bindingState: ['present', 'missing', 'wrong-type', 'throws'],
  serviceRoute: ['issuer-hosted-ui', 'service-binding', 'login-ui', 'unavailable'],
  provider: ['d1', 'unsupported'],
  cacheState: ['cold', 'warm', 'warm-stale'],
};

/**
 * R-B reachability constraints, grounded in tenant-database-resolver.ts /
 * tenant-runtime-registry-snapshot.ts. Both alpha and beta tenants are exercised across
 * all security-relevant states; the only tenant-based restriction is the registryTenant
 * 'foreign' target (the foreign snapshot is always the OTHER tenant's fully valid
 * snapshot). Provenance per rule in FINDINGS.md.
 */
export const RB_CONSTRAINTS: Constraint[] = [
  // A warm memory/request cache is only reachable after a previously resolved success;
  // the warm-stale shape changes the generation between the two calls.
  (row) =>
    row.cacheState === 'cold' ||
    (row.snapshotState === 'valid' &&
      row.generationState === 'matching' &&
      row.registryTenant === 'matching' &&
      row.bindingOwner === 'matching' &&
      row.bindingState === 'present' &&
      row.provider === 'd1' &&
      row.allocationScope === 'shared-pool' &&
      row.dataRole === 'core-default' &&
      row.serviceRoute === 'issuer-hosted-ui'),
  // A foreign registry tenant snapshot is signature-valid but names another tenant.
  (row) =>
    row.registryTenant !== 'foreign' ||
    (row.snapshotState === 'valid' &&
      row.generationState === 'matching' &&
      row.provider === 'd1' &&
      row.bindingState === 'present' &&
      row.allocationScope === 'shared-pool' &&
      row.bindingOwner === 'matching' &&
      row.dataRole === 'core-default' &&
      row.serviceRoute === 'issuer-hosted-ui' &&
      row.cacheState === 'cold'),
  // Owner violations parse-fail the snapshot (parseRuntimeRegistrySnapshot enforces
  // shared_pool ⇒ owner null and tenant_exclusive ⇒ owner == tenant).
  (row) =>
    row.bindingOwner !== 'foreign' ||
    (row.allocationScope === 'tenant-exclusive' &&
      row.snapshotState === 'valid' &&
      row.generationState === 'matching' &&
      row.provider === 'd1' &&
      row.bindingState === 'present' &&
      row.registryTenant === 'matching' &&
      row.dataRole === 'core-default' &&
      row.serviceRoute === 'issuer-hosted-ui' &&
      row.cacheState === 'cold'),
  (row) =>
    row.bindingOwner !== 'unowned' ||
    (row.allocationScope === 'shared-pool' &&
      row.snapshotState === 'valid' &&
      row.generationState === 'matching' &&
      row.provider === 'd1' &&
      row.bindingState === 'present' &&
      row.registryTenant === 'matching' &&
      row.dataRole === 'core-default' &&
      row.serviceRoute === 'issuer-hosted-ui' &&
      row.cacheState === 'cold'),
  // An unsupported provider fails closed during snapshot parsing.
  (row) =>
    row.provider !== 'unsupported' ||
    (row.snapshotState === 'valid' &&
      row.generationState === 'matching' &&
      row.bindingState === 'present' &&
      row.registryTenant === 'matching' &&
      row.bindingOwner === 'matching' &&
      row.allocationScope === 'shared-pool' &&
      row.dataRole === 'core-default' &&
      row.serviceRoute === 'issuer-hosted-ui' &&
      row.cacheState === 'cold'),
  // Non-valid snapshot states are exercised with a matching generation over the minimal
  // resolvable shape so the failure is attributed to the snapshot layer.
  (row) =>
    row.snapshotState === 'valid' ||
    (row.generationState === 'matching' &&
      row.provider === 'd1' &&
      row.bindingState === 'present' &&
      row.registryTenant === 'matching' &&
      row.bindingOwner === 'matching' &&
      row.allocationScope === 'shared-pool' &&
      row.dataRole === 'core-default' &&
      row.serviceRoute === 'issuer-hosted-ui' &&
      row.cacheState === 'cold'),
  // Generation problems require a signature-valid snapshot.
  (row) =>
    row.generationState === 'matching' ||
    (row.snapshotState === 'valid' &&
      row.provider === 'd1' &&
      row.bindingState === 'present' &&
      row.registryTenant === 'matching' &&
      row.bindingOwner === 'matching' &&
      row.allocationScope === 'shared-pool' &&
      row.dataRole === 'core-default' &&
      row.serviceRoute === 'issuer-hosted-ui' &&
      row.cacheState === 'cold'),
  // Binding problems require a valid snapshot and matching generation.
  (row) =>
    row.bindingState === 'present' ||
    (row.snapshotState === 'valid' &&
      row.generationState === 'matching' &&
      row.provider === 'd1' &&
      row.registryTenant === 'matching' &&
      row.bindingOwner === 'matching' &&
      row.allocationScope === 'shared-pool' &&
      row.dataRole === 'core-default' &&
      row.cacheState === 'cold'),
  // Service route / data role linkage: the route labels the resolved binding kind.
  (row) => row.serviceRoute !== 'unavailable' || row.bindingState === 'missing',
  (row) => row.serviceRoute !== 'login-ui' || row.dataRole === 'core-default',
  (row) =>
    row.dataRole !== 'pii' ||
    (row.serviceRoute === 'service-binding' && row.bindingState === 'present'),
  (row) => row.dataRole !== 'core-users' || row.serviceRoute === 'issuer-hosted-ui',
];

export const RB_CONSTRAINT_LABELS = [
  'warm cache shapes require a previously resolved success',
  'foreign registry tenant snapshot is signature-valid but names another tenant',
  'tenant_exclusive owner mismatch parse-fails the snapshot',
  'shared_pool owner (non-null) parse-fails the snapshot',
  'unsupported provider fails closed during snapshot parsing',
  'expired/payload-tampered/signature-tampered/unknown-kid/unsigned/quarantined/missing snapshots are exercised with a matching generation over the minimal resolvable shape',
  'stale/ahead/missing generation requires a signature-valid snapshot',
  'missing/wrong-type/throws bindings require a valid snapshot and matching generation',
  'unavailable service route implies a missing binding',
  'login-ui service route binds the core-default data role',
  'pii data role routes through the dedicated PII service binding',
  'core-users data role is served by the issuer-hosted UI binding',
];

// Required groups 2 and 4.
export const RB_SELECTED_TRIPLES: Array<[string, string, string]> = [
  ['tenantHost', 'registryTenant', 'bindingOwner'],
  ['allocationScope', 'bindingOwner', 'dataRole'],
];

// =============================================================================
// Matrix R-C (required group 3: route status × cache state × runtime generation)
// =============================================================================

export const RC_DIMENSION_ORDER = ['routeStatus', 'cacheState', 'runtimeGeneration'] as const;

export const RC_VALUES: Record<string, readonly Scalar[]> = {
  routeStatus: ['active', 'quarantining', 'quarantined', 'disabled'],
  cacheState: ['cold', 'warm', 'warm-stale'],
  runtimeGeneration: ['matching', 'stale', 'ahead', 'missing'],
};

export const RC_CONSTRAINTS: Constraint[] = [
  // The generation-document route check (assertRuntimeRouteAvailable) runs before the
  // cache and generation-vs-snapshot checks, so a non-active route never populates or
  // consults a cache and a generation mismatch is unobservable.
  (row) =>
    row.routeStatus === 'active' ||
    (row.cacheState === 'cold' && row.runtimeGeneration === 'matching'),
  (row) =>
    row.cacheState !== 'warm' ||
    (row.routeStatus === 'active' && row.runtimeGeneration === 'matching'),
  (row) =>
    row.cacheState !== 'warm-stale' ||
    (row.routeStatus === 'active' && row.runtimeGeneration === 'ahead'),
  // stale/ahead/missing generations require an active route on a cold path, except the
  // warm-stale shape whose observed generation is ahead by design.
  (row) =>
    row.runtimeGeneration === 'matching' ||
    row.cacheState === 'warm-stale' ||
    (row.routeStatus === 'active' && row.cacheState === 'cold'),
];

export const RC_CONSTRAINT_LABELS = [
  'a non-active generation-document route throws quarantined_route before any cache or generation check; kept minimal so the failure attributes to the route',
  'warm cache reuse requires an active route and an unchanged generation',
  'warm-stale re-resolves against an advanced generation (never the stale one)',
  'stale/ahead/missing generations require an active route on a cold path',
];

// The whole matrix is the required group 3 triple.
export const RC_SELECTED_TRIPLES: Array<[string, string, string]> = [
  ['routeStatus', 'cacheState', 'runtimeGeneration'],
];

// =============================================================================
// Matrix R-D (required group 5: vanity state × canonical issuer × browser/protocol)
// =============================================================================

export const RD_DIMENSION_ORDER = [
  'hostState',
  'vanityState',
  'canonicalIssuerState',
  'requestClass',
] as const;

export const RD_VALUES: Record<string, readonly Scalar[]> = {
  hostState: ['canonical', 'naked', 'vanity', 'alias', 'unresolvable'],
  vanityState: ['missing', 'canonical', 'non-canonical', 'inactive', 'cross-tenant'],
  canonicalIssuerState: [
    'tenant-canonical',
    'primary-naked',
    'active-vanity',
    'mismatched',
    'unavailable',
  ],
  requestClass: ['browser', 'protocol'],
};

export const RD_CONSTRAINTS: Constraint[] = [
  // A primary vanity redirects the canonical subdomain to the vanity host (browser 308 /
  // protocol 404); the vanity host itself resolves to the vanity issuer.
  (row) =>
    row.vanityState !== 'canonical' ||
    (row.hostState === 'vanity' && row.canonicalIssuerState === 'active-vanity') ||
    (row.hostState === 'canonical' && row.canonicalIssuerState === 'mismatched'),
  // A non-primary alias fails the tenant binding policy before canonicalization.
  (row) =>
    row.vanityState !== 'non-canonical' ||
    (row.hostState === 'alias' && row.canonicalIssuerState === 'mismatched'),
  // Inactive aliases and cross-tenant (stale cache) vanity rows fail closed.
  (row) =>
    row.vanityState !== 'inactive' ||
    (row.hostState === 'vanity' && row.canonicalIssuerState === 'unavailable'),
  (row) =>
    row.vanityState !== 'cross-tenant' ||
    (row.hostState === 'vanity' && row.canonicalIssuerState === 'unavailable'),
  // With no vanity involvement the canonical issuer is the tenant subdomain, the naked
  // domain, or unavailable for unresolvable hosts.
  (row) =>
    row.vanityState !== 'missing' ||
    (row.hostState === 'canonical' && row.canonicalIssuerState === 'tenant-canonical') ||
    (row.hostState === 'naked' && row.canonicalIssuerState === 'primary-naked') ||
    (row.hostState === 'unresolvable' && row.canonicalIssuerState === 'unavailable'),
  (row) => row.hostState !== 'alias' || row.vanityState === 'non-canonical',
  (row) => row.hostState !== 'unresolvable' || row.vanityState === 'missing',
  (row) => row.hostState !== 'naked' || row.vanityState === 'missing',
];

export const RD_CONSTRAINT_LABELS = [
  'a primary vanity makes the vanity host the canonical issuer; the canonical subdomain then redirects/rejects as mismatched',
  'a non-primary alias fails the tenant binding policy (mismatched issuer)',
  'an inactive vanity alias fails closed (issuer unavailable)',
  'a cross-tenant stale vanity cache fails closed (issuer unavailable)',
  'without vanity, the issuer is the tenant subdomain, the naked domain, or unavailable for unresolvable hosts',
  'alias hosts are only reachable through the non-primary vanity row',
  'unresolvable hosts are rejected before any vanity interaction',
  'the naked domain is only reachable without vanity involvement',
];

// Required group 5 triple.
export const RD_SELECTED_TRIPLES: Array<[string, string, string]> = [
  ['vanityState', 'canonicalIssuerState', 'requestClass'],
];

// =============================================================================
// Matrix R-E (required group 6: service-binding state × forwarded host × tenant context)
// =============================================================================

export const RE_DIMENSION_ORDER = [
  'serviceBindingState',
  'forwardedHost',
  'tenantContextState',
  'hostState',
] as const;

export const RE_VALUES: Record<string, readonly Scalar[]> = {
  serviceBindingState: ['present', 'missing', 'wrong-type', 'throws'],
  forwardedHost: ['none', 'matching', 'conflicting'],
  tenantContextState: ['matching', 'foreign', 'missing'],
  hostState: ['canonical', 'unresolvable'],
};

export const RE_CONSTRAINTS: Constraint[] = [
  // The tenant context is determined by the forwarded host: a trusted conflicting
  // forwarded host selects the foreign (beta) context; a matching or absent forwarded
  // host keeps the host tenant (alpha). An unresolvable host yields no context.
  (row) =>
    row.tenantContextState !== 'foreign' ||
    (row.forwardedHost === 'conflicting' && row.hostState === 'canonical'),
  (row) =>
    row.tenantContextState !== 'matching' ||
    (row.hostState === 'canonical' &&
      (row.forwardedHost === 'none' || row.forwardedHost === 'matching')),
  (row) =>
    row.tenantContextState !== 'missing' ||
    (row.hostState === 'unresolvable' &&
      row.forwardedHost === 'none' &&
      row.serviceBindingState === 'present'),
  (row) => row.hostState !== 'unresolvable' || row.tenantContextState === 'missing',
];

export const RE_CONSTRAINT_LABELS = [
  'a trusted conflicting forwarded host selects the foreign tenant context; a matching or absent forwarded host keeps the host tenant',
  'the service binding is resolved for the CONTEXT tenant, never the host tenant',
  'an unresolvable host yields no tenant context; the binding is never consulted',
  'unresolvable hosts never establish a tenant context',
];

// Required group 6 triple.
export const RE_SELECTED_TRIPLES: Array<[string, string, string]> = [
  ['serviceBindingState', 'forwardedHost', 'tenantContextState'],
];

// =============================================================================
// R-A decisions (test-local independent decision table)
// =============================================================================

export type RaRejectionLayer =
  | 'tenant-resolution'
  | 'metadata-context'
  | 'tenant-exists'
  | 'vanity-canonicalization'
  | 'binding-policy'
  | 'admin-header'
  | null;

export interface RaDecision {
  status: number;
  error: string | null;
  errorDescription: string | null;
  rejectionLayer: RaRejectionLayer;
  tenantId: string | null;
  tenantSource: 'host' | 'forwarded' | 'vanity' | 'default' | 'admin-header' | null;
  issuerHost: string | null;
  locationHost: string | null;
  registryStatus:
    | 'valid'
    | 'bad-signature'
    | 'missing'
    | 'quarantined'
    | 'not-configured'
    | 'not-reached'
    | null;
  bindingRef: string | null;
  tenantContextState: 'matching' | 'foreign' | 'missing' | null;
  canonicalIssuerState:
    | 'tenant-canonical'
    | 'primary-naked'
    | 'active-vanity'
    | 'mismatched'
    | 'unavailable';
}

export function raDecisionSignature(decision: RaDecision): string {
  return JSON.stringify(decision);
}

export function decideRoutingRa(row: Row): RaDecision {
  if (String(row.deploymentMode) === 'single') {
    // Single-tenant mode never resolves a host tenant, vanity, or binding, but the
    // protocol path still resolves tenant metadata for the default tenant through the
    // signed runtime registry (shouldResolveTenantDataContexts is request-class based).
    const registryState = String(row.registryState);
    if (registryState === 'not-configured') {
      return {
        status: 409,
        error: 'missing_generation',
        errorDescription: null,
        rejectionLayer: 'metadata-context',
        tenantId: null,
        tenantSource: null,
        issuerHost: null,
        locationHost: null,
        registryStatus: 'not-configured',
        bindingRef: null,
        tenantContextState: null,
        canonicalIssuerState: 'unavailable',
      };
    }
    if (registryState !== 'valid') {
      const error =
        registryState === 'bad-signature'
          ? 'invalid_snapshot_signature'
          : registryState === 'quarantined'
            ? 'quarantined_route'
            : 'missing_snapshot';
      return {
        status: 409,
        error,
        errorDescription: null,
        rejectionLayer: 'metadata-context',
        tenantId: null,
        tenantSource: null,
        issuerHost: null,
        locationHost: null,
        registryStatus: registryState as RaDecision['registryStatus'],
        bindingRef: null,
        tenantContextState: null,
        canonicalIssuerState: 'unavailable',
      };
    }
    return {
      status: 200,
      error: null,
      errorDescription: null,
      rejectionLayer: null,
      tenantId: 'default',
      tenantSource: 'default',
      issuerHost: 'single.authrim.example',
      locationHost: null,
      registryStatus: 'valid',
      bindingRef: 'DB',
      tenantContextState: 'matching',
      canonicalIssuerState: 'tenant-canonical',
    };
  }

  const requestClass = String(row.requestClass);
  const forwardedPolicy = String(row.forwardedPolicy);
  const forwardedState = String(row.forwardedState);
  const hostClass = String(row.hostClass);

  // Admin (tenant_scoped_admin): the X-Tenant-Id header pins the tenant context; the
  // forwarded host only shapes the issuer.
  if (requestClass === 'admin') {
    const forwardedHost =
      forwardedPolicy === 'enabled' && forwardedState !== 'missing'
        ? forwardedState === 'matching'
          ? 'alpha.authrim.example'
          : forwardedState === 'conflicting'
            ? 'beta.authrim.example'
            : null
        : null;
    return {
      status: 200,
      error: null,
      errorDescription: null,
      rejectionLayer: null,
      tenantId: 'alpha',
      tenantSource: 'admin-header',
      issuerHost: forwardedHost ?? 'alpha.authrim.example',
      locationHost: null,
      registryStatus: 'valid',
      bindingRef: 'DB',
      tenantContextState: 'matching',
      canonicalIssuerState:
        forwardedHost === 'beta.authrim.example' ? 'mismatched' : 'tenant-canonical',
    };
  }

  // Internal health paths do not resolve tenant metadata. Unresolved hosts continue on
  // the default tenant; a resolved canonical host reaches tenant-exists without a core
  // database and fails closed.
  if (requestClass === 'internal') {
    if (hostClass === 'unrelated' || hostClass === 'missing') {
      const fallbackHost = hostClass === 'missing' ? 'node.example' : 'evil.example';
      return {
        status: 200,
        error: null,
        errorDescription: null,
        rejectionLayer: null,
        tenantId: 'default',
        tenantSource: 'default',
        issuerHost: fallbackHost,
        locationHost: null,
        registryStatus: 'not-reached',
        bindingRef: null,
        tenantContextState: 'matching',
        canonicalIssuerState: 'unavailable',
      };
    }
    return {
      status: 404,
      error: 'not_found',
      errorDescription: 'Tenant not found',
      rejectionLayer: 'tenant-exists',
      tenantId: null,
      tenantSource: null,
      issuerHost: null,
      locationHost: null,
      registryStatus: null,
      bindingRef: null,
      tenantContextState: null,
      canonicalIssuerState: 'unavailable',
    };
  }

  // Discovery now resolves tenant metadata even when allowUnknownTenant selected the
  // default tenant. These constrained unresolved-host rows intentionally carry a
  // not-configured registry and therefore fail at metadata-context, not host parsing.
  if (requestClass === 'discovery' && (hostClass === 'unrelated' || hostClass === 'missing')) {
    return {
      status: 409,
      error: 'missing_generation',
      errorDescription: null,
      rejectionLayer: 'metadata-context',
      tenantId: null,
      tenantSource: null,
      issuerHost: null,
      locationHost: null,
      registryStatus: 'not-configured',
      bindingRef: null,
      tenantContextState: null,
      canonicalIssuerState: 'unavailable',
    };
  }

  // Reserved UI host: isReservedUiHost resets tenant resolution to the default tenant
  // and clears the error, which the middleware then reports as an invalid host (400).
  if (hostClass === 'ui-host') {
    return {
      status: 400,
      error: 'invalid_request',
      errorDescription: 'Invalid Host header format',
      rejectionLayer: 'tenant-resolution',
      tenantId: null,
      tenantSource: null,
      issuerHost: null,
      locationHost: null,
      registryStatus: null,
      bindingRef: null,
      tenantContextState: null,
      canonicalIssuerState: 'unavailable',
    };
  }

  // Trusted forwarded host wins over Host (buildRequestIssuerUrl and
  // resolveTenantFromRequest precedence). Only the canonical shape carries forwarded
  // headers in this matrix.
  if (
    hostClass === 'canonical' &&
    forwardedPolicy === 'enabled' &&
    forwardedState === 'conflicting'
  ) {
    return {
      status: 200,
      error: null,
      errorDescription: null,
      rejectionLayer: null,
      tenantId: 'beta',
      tenantSource: 'forwarded',
      issuerHost: 'beta.authrim.example',
      locationHost: null,
      registryStatus: 'valid',
      bindingRef: 'DB',
      tenantContextState: 'foreign',
      canonicalIssuerState: 'tenant-canonical',
    };
  }

  // Host-class tenant resolution (with vanity for vanity-backed hosts).
  let tenantId: string;
  let tenantSource: 'host' | 'forwarded' | 'vanity';
  let hostError: {
    status: number;
    error: string;
    errorDescription: string;
    layer: 'tenant-resolution';
    registryStatus?: RaDecision['registryStatus'];
  } | null = null;
  switch (hostClass) {
    case 'canonical':
      if (forwardedPolicy === 'enabled' && forwardedState === 'matching') {
        tenantId = 'alpha';
        tenantSource = 'forwarded';
      } else {
        tenantId = 'alpha';
        tenantSource = 'host';
      }
      break;
    case 'naked':
      tenantId = 'default';
      tenantSource = 'host';
      break;
    case 'active-vanity':
      if (String(row.vanityState) === 'canonical') {
        tenantId = 'alpha';
        tenantSource = 'vanity';
      } else {
        // cross-tenant: the vanity revalidation read the signed registry and the D1 row
        // before failing, so the registry status is observable.
        hostError = {
          status: 404,
          error: 'not_found',
          errorDescription: 'Tenant not found',
          layer: 'tenant-resolution',
          registryStatus: 'valid',
        };
        tenantId = 'default';
        tenantSource = 'host';
      }
      break;
    case 'inactive-vanity-alias':
      // The vanity revalidation also read the signed registry before failing.
      hostError = {
        status: 404,
        error: 'not_found',
        errorDescription: 'Tenant not found',
        layer: 'tenant-resolution',
        registryStatus: 'valid',
      };
      tenantId = 'default';
      tenantSource = 'host';
      break;
    case 'non-primary-alias':
      tenantId = 'alpha';
      tenantSource = 'vanity';
      break;
    case 'uppercase':
    case 'port':
      tenantId = 'alpha';
      tenantSource = 'host';
      break;
    case 'unrelated':
      hostError = {
        status: 404,
        error: 'not_found',
        errorDescription: 'Tenant not found',
        layer: 'tenant-resolution',
      };
      tenantId = 'default';
      tenantSource = 'host';
      break;
    case 'sub-subdomain':
    case 'malformed':
      hostError = {
        status: 400,
        error: 'invalid_request',
        errorDescription: 'Invalid Host header format',
        layer: 'tenant-resolution',
      };
      tenantId = 'default';
      tenantSource = 'host';
      break;
    case 'missing':
      hostError = {
        status: 400,
        error: 'invalid_request',
        errorDescription: 'Host header is required',
        layer: 'tenant-resolution',
      };
      tenantId = 'default';
      tenantSource = 'host';
      break;
    default:
      throw new Error(`Unknown hostClass: ${hostClass}`);
  }

  if (hostError) {
    return {
      status: hostError.status,
      error: hostError.error,
      errorDescription: hostError.errorDescription,
      rejectionLayer: hostError.layer,
      tenantId: null,
      tenantSource: null,
      issuerHost: null,
      locationHost: null,
      registryStatus: hostError.registryStatus ?? null,
      bindingRef: null,
      tenantContextState: null,
      canonicalIssuerState: 'unavailable',
    };
  }

  // Signed runtime registry (tenant metadata context).
  const registryState = String(row.registryState);
  if (registryState === 'not-configured') {
    return {
      status: 409,
      error: 'missing_generation',
      errorDescription: null,
      rejectionLayer: 'metadata-context',
      tenantId: null,
      tenantSource: null,
      issuerHost: null,
      locationHost: null,
      registryStatus: 'not-configured',
      bindingRef: null,
      tenantContextState: null,
      canonicalIssuerState: 'unavailable',
    };
  }
  if (registryState !== 'valid') {
    const error =
      registryState === 'bad-signature'
        ? 'invalid_snapshot_signature'
        : registryState === 'quarantined'
          ? 'quarantined_route'
          : 'missing_snapshot';
    return {
      status: 409,
      error,
      errorDescription: null,
      rejectionLayer: 'metadata-context',
      tenantId: null,
      tenantSource: null,
      issuerHost: null,
      locationHost: null,
      registryStatus: registryState as RaDecision['registryStatus'],
      bindingRef: null,
      tenantContextState: null,
      canonicalIssuerState: 'unavailable',
    };
  }

  // Binding ownership inside the registry resolution.
  const bindingState = String(row.bindingState);
  if (bindingState !== 'present') {
    return {
      status: 409,
      error: 'missing_binding',
      errorDescription: null,
      rejectionLayer: 'metadata-context',
      tenantId: null,
      tenantSource: null,
      issuerHost: null,
      locationHost: null,
      registryStatus: 'valid',
      bindingRef: null,
      tenantContextState: null,
      canonicalIssuerState: 'unavailable',
    };
  }

  // Tenant existence and lifecycle (tenants.lifecycle_state = 'active').
  const lifecycle = String(row.tenantLifecycle);
  if (lifecycle === 'inactive' || lifecycle === 'missing') {
    return {
      status: 404,
      error: 'not_found',
      errorDescription: 'Tenant not found',
      rejectionLayer: 'tenant-exists',
      tenantId: null,
      tenantSource: null,
      issuerHost: null,
      locationHost: null,
      registryStatus: 'valid',
      bindingRef: null,
      tenantContextState: null,
      canonicalIssuerState: 'unavailable',
    };
  }

  // Primary-vanity canonicalization (middleware block 2, all hosts) — reached for the
  // resolved host; a non-primary alias first fails the tenant binding policy
  // (requestHost not in allowedHosts) because the primary vanity is the only extra
  // allowed host.
  if (hostClass === 'non-primary-alias') {
    return {
      status: 404,
      error: 'not_found',
      errorDescription: 'Tenant not found',
      rejectionLayer: 'binding-policy',
      tenantId: null,
      tenantSource: null,
      issuerHost: null,
      locationHost: null,
      registryStatus: 'valid',
      bindingRef: 'DB',
      tenantContextState: null,
      canonicalIssuerState: 'mismatched',
    };
  }
  const vanityState = String(row.vanityState);
  if (vanityState === 'non-canonical') {
    const browser = requestClass === 'browser';
    return {
      status: browser ? 308 : 404,
      error: browser ? null : 'not_found',
      errorDescription: browser ? null : 'Tenant not found',
      rejectionLayer: 'vanity-canonicalization',
      tenantId: null,
      tenantSource: null,
      issuerHost: null,
      locationHost: browser ? 'vanity.alpha.example' : null,
      registryStatus: 'valid',
      bindingRef: 'DB',
      tenantContextState: null,
      canonicalIssuerState: 'mismatched',
    };
  }

  // Pass: tenant context, canonical issuer, and binding are consistent.
  const issuerHost =
    hostClass === 'canonical' || hostClass === 'uppercase' || hostClass === 'port'
      ? 'alpha.authrim.example'
      : hostClass === 'naked'
        ? 'authrim.example'
        : hostClass === 'active-vanity'
          ? 'vanity.alpha.example'
          : null;
  if (!issuerHost) {
    throw new Error(`Unhandled pass issuerHost for ${hostClass}`);
  }
  return {
    status: 200,
    error: null,
    errorDescription: null,
    rejectionLayer: null,
    tenantId,
    tenantSource,
    issuerHost,
    locationHost: null,
    registryStatus: 'valid',
    bindingRef: 'DB',
    tenantContextState: tenantId === 'beta' ? 'foreign' : 'matching',
    canonicalIssuerState:
      issuerHost === 'authrim.example'
        ? 'primary-naked'
        : issuerHost === 'vanity.alpha.example'
          ? 'active-vanity'
          : 'tenant-canonical',
  };
}

// =============================================================================
// R-B decisions
// =============================================================================

export type RbRejectionLayer =
  | 'generation'
  | 'snapshot'
  | 'registry-tenant'
  | 'signature'
  | 'route'
  | 'expiry'
  | 'provider'
  | 'binding'
  | 'binding-access'
  | null;

export interface RbDecision {
  outcome: 'resolved' | 'error';
  errorCode: string | null;
  rejectionLayer: RbRejectionLayer;
  bindingRef: string | null;
  generation: number | null;
  runtimeGeneration: number | null;
  dataRole: string | null;
  allocationScope: string | null;
  ownerTenantId: string | null;
  provider: string | null;
  cacheHit: boolean;
  securityEventWritten: boolean;
  foreignTenantAccess: boolean;
}

export function rbDecisionSignature(decision: RbDecision): string {
  return JSON.stringify(decision);
}

export function decideRoutingRb(row: Row): RbDecision {
  const base = {
    outcome: 'error' as const,
    errorCode: null as string | null,
    rejectionLayer: null as RbRejectionLayer,
    bindingRef: null as string | null,
    generation: null as number | null,
    runtimeGeneration: null as number | null,
    dataRole: null as string | null,
    allocationScope: null as string | null,
    ownerTenantId: null as string | null,
    provider: null as string | null,
    cacheHit: false,
    securityEventWritten: false,
    foreignTenantAccess: false,
  };
  const snapshotState = String(row.snapshotState);
  const generationState = String(row.generationState);
  const cacheState = String(row.cacheState);
  const provider = String(row.provider);
  const bindingState = String(row.bindingState);
  const dataRoleOf = (): string => {
    switch (String(row.dataRole)) {
      case 'pii':
        return 'tenant_pii';
      case 'core-users':
        return 'tenant_core/users';
      default:
        return 'tenant_core/default';
    }
  };
  const allocationScopeOf = (): string =>
    String(row.allocationScope) === 'tenant-exclusive' ? 'tenant_exclusive' : 'shared_pool';
  const ownerTenantIdOf = (): string | null =>
    String(row.allocationScope) === 'tenant-exclusive'
      ? String(row.tenantHost) === 'beta'
        ? 'beta'
        : 'alpha'
      : null;
  const bindingRefOf = (): string => {
    switch (String(row.serviceRoute)) {
      case 'service-binding':
        return 'DB_PII';
      case 'login-ui':
        return 'DB_LOGIN';
      case 'unavailable':
        return 'MISSING_DB';
      default:
        return 'DB';
    }
  };

  // Warm cache: the second call reuses the resolved binding when the generation still
  // matches; warm-stale re-resolves against the new generation (never the stale one).
  if (cacheState === 'warm') {
    return {
      ...base,
      outcome: 'resolved',
      bindingRef: bindingRefOf(),
      generation: 5,
      runtimeGeneration: 5,
      dataRole: dataRoleOf(),
      allocationScope: allocationScopeOf(),
      ownerTenantId: ownerTenantIdOf(),
      provider: 'd1',
      cacheHit: true,
    };
  }
  if (cacheState === 'warm-stale') {
    // The generation advanced between the two calls, so the request cache entry is
    // evicted and the tenant re-resolves against the new signed snapshot. Never the
    // stale one.
    return {
      ...base,
      outcome: 'resolved',
      bindingRef: 'DB',
      generation: 6,
      runtimeGeneration: 6,
      dataRole: dataRoleOf(),
      allocationScope: allocationScopeOf(),
      ownerTenantId: ownerTenantIdOf(),
      provider: 'd1',
      cacheHit: false,
    };
  }

  // Cold path.
  if (generationState === 'missing') {
    return { ...base, errorCode: 'missing_generation', rejectionLayer: 'generation' };
  }
  if (snapshotState === 'missing') {
    return { ...base, errorCode: 'missing_snapshot', rejectionLayer: 'snapshot' };
  }
  if (String(row.registryTenant) === 'foreign') {
    // A signature-valid snapshot stored under this tenant's key but naming another
    // tenant fails the tenant-identity check with no security event.
    return {
      ...base,
      errorCode: 'invalid_snapshot_signature',
      rejectionLayer: 'registry-tenant',
      securityEventWritten: false,
    };
  }
  if (String(row.bindingOwner) === 'foreign' || String(row.bindingOwner) === 'unowned') {
    return { ...base, errorCode: 'invalid_route_contract', rejectionLayer: 'snapshot' };
  }
  if (provider === 'unsupported') {
    return { ...base, errorCode: 'invalid_route_contract', rejectionLayer: 'provider' };
  }
  if (generationState === 'stale' || generationState === 'ahead') {
    return { ...base, errorCode: 'snapshot_generation_propagating', rejectionLayer: 'generation' };
  }
  // Four distinct verification failures share the same error surface and each writes a
  // security event: the payload was tampered after signing, the signature bytes were
  // tampered, the snapshot was signed with a key whose kid is absent from the
  // verification JWKS, or the snapshot was never signed.
  if (
    snapshotState === 'payload-tampered' ||
    snapshotState === 'signature-tampered' ||
    snapshotState === 'unknown-kid' ||
    snapshotState === 'unsigned'
  ) {
    return {
      ...base,
      errorCode: 'invalid_snapshot_signature',
      rejectionLayer: 'signature',
      securityEventWritten: true,
    };
  }
  if (snapshotState === 'quarantined') {
    return { ...base, errorCode: 'quarantined_route', rejectionLayer: 'route' };
  }
  if (snapshotState === 'expired') {
    return { ...base, errorCode: 'expired_snapshot', rejectionLayer: 'expiry' };
  }
  if (bindingState === 'throws') {
    return { ...base, errorCode: 'binding_access_threw', rejectionLayer: 'binding-access' };
  }
  if (bindingState === 'missing' || bindingState === 'wrong-type') {
    return {
      ...base,
      errorCode: 'missing_binding',
      rejectionLayer: 'binding',
      securityEventWritten: true,
    };
  }
  return {
    ...base,
    outcome: 'resolved',
    bindingRef: bindingRefOf(),
    generation: 5,
    runtimeGeneration: 5,
    dataRole: dataRoleOf(),
    allocationScope: allocationScopeOf(),
    ownerTenantId: ownerTenantIdOf(),
    provider: 'd1',
  };
}

// =============================================================================
// R-C decisions (route status × cache × generation)
// =============================================================================

export interface RcDecision extends RbDecision {}

export function decideRoutingRc(row: Row): RcDecision {
  const base = {
    outcome: 'error' as const,
    errorCode: null as string | null,
    rejectionLayer: null as RbRejectionLayer,
    bindingRef: null as string | null,
    generation: null as number | null,
    runtimeGeneration: null as number | null,
    dataRole: null as string | null,
    allocationScope: null as string | null,
    ownerTenantId: null as string | null,
    provider: null as string | null,
    cacheHit: false,
    securityEventWritten: false,
    foreignTenantAccess: false,
  };
  const routeStatus = String(row.routeStatus);
  const cacheState = String(row.cacheState);
  const runtimeGeneration = String(row.runtimeGeneration);
  if (routeStatus !== 'active') {
    return { ...base, errorCode: 'quarantined_route', rejectionLayer: 'route' };
  }
  // Warm cache shapes are observed on their second call and resolved before the
  // generation checks; the warm-stale shape observes the ADVANCED generation.
  if (cacheState === 'warm') {
    return {
      ...base,
      outcome: 'resolved',
      bindingRef: 'DB',
      generation: 5,
      runtimeGeneration: 5,
      dataRole: 'tenant_core/default',
      allocationScope: 'shared_pool',
      ownerTenantId: null,
      provider: 'd1',
      cacheHit: true,
    };
  }
  if (cacheState === 'warm-stale') {
    return {
      ...base,
      outcome: 'resolved',
      bindingRef: 'DB',
      generation: 6,
      runtimeGeneration: 6,
      dataRole: 'tenant_core/default',
      allocationScope: 'shared_pool',
      ownerTenantId: null,
      provider: 'd1',
      cacheHit: false,
    };
  }
  if (runtimeGeneration === 'missing') {
    return { ...base, errorCode: 'missing_generation', rejectionLayer: 'generation' };
  }
  if (runtimeGeneration === 'stale' || runtimeGeneration === 'ahead') {
    return { ...base, errorCode: 'snapshot_generation_propagating', rejectionLayer: 'generation' };
  }
  return {
    ...base,
    outcome: 'resolved',
    bindingRef: 'DB',
    generation: 5,
    runtimeGeneration: 5,
    dataRole: 'tenant_core/default',
    allocationScope: 'shared_pool',
    ownerTenantId: null,
    provider: 'd1',
  };
}

// =============================================================================
// R-D decisions (vanity × canonical issuer × browser/protocol)
// =============================================================================

export interface RdDecision {
  status: number;
  error: string | null;
  errorDescription: string | null;
  rejectionLayer: RaRejectionLayer;
  tenantId: string | null;
  issuerHost: string | null;
  locationHost: string | null;
  canonicalIssuerState:
    | 'tenant-canonical'
    | 'primary-naked'
    | 'active-vanity'
    | 'mismatched'
    | 'unavailable';
}

export function decideRoutingRd(row: Row): RdDecision {
  const hostState = String(row.hostState);
  const vanityState = String(row.vanityState);
  const browser = String(row.requestClass) === 'browser';
  switch (vanityState) {
    case 'canonical':
      if (hostState === 'vanity') {
        return {
          status: 200,
          error: null,
          errorDescription: null,
          rejectionLayer: null,
          tenantId: 'alpha',
          issuerHost: 'vanity.alpha.example',
          locationHost: null,
          canonicalIssuerState: 'active-vanity',
        };
      }
      return {
        status: browser ? 308 : 404,
        error: browser ? null : 'not_found',
        errorDescription: browser ? null : 'Tenant not found',
        rejectionLayer: 'vanity-canonicalization',
        tenantId: null,
        issuerHost: null,
        locationHost: browser ? 'vanity.alpha.example' : null,
        canonicalIssuerState: 'mismatched',
      };
    case 'non-canonical':
      return {
        status: 404,
        error: 'not_found',
        errorDescription: 'Tenant not found',
        rejectionLayer: 'binding-policy',
        tenantId: null,
        issuerHost: null,
        locationHost: null,
        canonicalIssuerState: 'mismatched',
      };
    case 'inactive':
    case 'cross-tenant':
      return {
        status: 404,
        error: 'not_found',
        errorDescription: 'Tenant not found',
        rejectionLayer: 'tenant-resolution',
        tenantId: null,
        issuerHost: null,
        locationHost: null,
        canonicalIssuerState: 'unavailable',
      };
    default: {
      // vanityState 'missing'
      if (hostState === 'naked') {
        return {
          status: 200,
          error: null,
          errorDescription: null,
          rejectionLayer: null,
          tenantId: 'default',
          issuerHost: 'authrim.example',
          locationHost: null,
          canonicalIssuerState: 'primary-naked',
        };
      }
      if (hostState === 'unresolvable') {
        return {
          status: 404,
          error: 'not_found',
          errorDescription: 'Tenant not found',
          rejectionLayer: 'tenant-resolution',
          tenantId: null,
          issuerHost: null,
          locationHost: null,
          canonicalIssuerState: 'unavailable',
        };
      }
      return {
        status: 200,
        error: null,
        errorDescription: null,
        rejectionLayer: null,
        tenantId: 'alpha',
        issuerHost: 'alpha.authrim.example',
        locationHost: null,
        canonicalIssuerState: 'tenant-canonical',
      };
    }
  }
}

// =============================================================================
// R-E decisions (service binding × forwarded host × tenant context)
// =============================================================================

export interface ReDecision {
  status: number;
  error: string | null;
  errorDescription: string | null;
  rejectionLayer: RaRejectionLayer;
  tenantId: string | null;
  issuerHost: string | null;
  tenantContextState: 'matching' | 'foreign' | 'missing' | null;
  bindingOperation: string | null;
}

export function decideRoutingRe(row: Row): ReDecision {
  const tenantContextState = String(row.tenantContextState);
  const bindingState = String(row.serviceBindingState);
  if (tenantContextState === 'missing') {
    return {
      status: 404,
      error: 'not_found',
      errorDescription: 'Tenant not found',
      rejectionLayer: 'tenant-resolution',
      tenantId: null,
      issuerHost: null,
      tenantContextState: null,
      bindingOperation: null,
    };
  }
  const contextTenant = tenantContextState === 'foreign' ? 'beta' : 'alpha';
  switch (bindingState) {
    case 'missing':
    case 'wrong-type':
      return {
        status: 409,
        error: 'missing_binding',
        errorDescription: null,
        rejectionLayer: 'metadata-context',
        tenantId: null,
        issuerHost: null,
        tenantContextState: null,
        bindingOperation: null,
      };
    case 'throws':
      // The metadata context resolves, but the tenant-exists query against the throwing
      // binding fails closed (validateTenantExistsAsync returns false on error).
      return {
        status: 404,
        error: 'not_found',
        errorDescription: 'Tenant not found',
        rejectionLayer: 'tenant-exists',
        tenantId: null,
        issuerHost: null,
        tenantContextState: null,
        bindingOperation: null,
      };
    default:
      if (tenantContextState === 'foreign') {
        // A trusted conflicting forwarded host selects the foreign (beta) context and
        // its binding for the tenant-exists check, but the tenant host-binding policy
        // then rejects the request host (alpha) for the beta tenant: the foreign
        // context is never silently accepted.
        return {
          status: 404,
          error: 'not_found',
          errorDescription: 'Tenant not found',
          rejectionLayer: 'binding-policy',
          tenantId: null,
          issuerHost: null,
          tenantContextState: null,
          bindingOperation: null,
        };
      }
      return {
        status: 200,
        error: null,
        errorDescription: null,
        rejectionLayer: null,
        tenantId: contextTenant,
        issuerHost: `${contextTenant}.authrim.example`,
        tenantContextState: 'matching',
        bindingOperation: 'd1:core:tenants',
      };
  }
}

// =============================================================================
// Case tables
// =============================================================================

export interface TopoCase {
  id: string;
  title: string;
  dimensions: Record<string, Scalar>;
  fingerprint: string;
  mutationIds: string[];
}

function raMutationIds(row: Row): string[] {
  const ids: string[] = [];
  if (String(row.forwardedPolicy) === 'disabled' && String(row.forwardedState) === 'conflicting') {
    ids.push('topology:trust-forwarded-host-without-config');
  }
  if (String(row.hostClass) === 'inactive-vanity-alias') {
    ids.push('topology:accept-inactive-vanity-alias');
  }
  if (String(row.hostClass) === 'active-vanity' && String(row.vanityState) === 'cross-tenant') {
    ids.push('topology:use-foreign-tenant-registry-or-binding');
  }
  if (String(row.registryState) === 'bad-signature') {
    ids.push('topology:accept-bad-signature-snapshot');
  }
  if (String(row.registryState) === 'quarantined') {
    ids.push('topology:use-quarantined-route-as-active');
  }
  if (String(row.bindingState) !== 'present') {
    ids.push('topology:fall-back-to-common-database-when-required-binding-missing');
  }
  if (String(row.vanityState) === 'non-canonical') {
    ids.push('topology:use-stale-route-after-canonicalization');
  }
  if (ids.length === 0) {
    ids.push('topology:reuse-stale-runtime-generation-cache');
  }
  return ids;
}

function rbMutationIds(row: Row): string[] {
  const ids: string[] = [];
  if (String(row.registryTenant) === 'foreign') {
    ids.push('topology:use-foreign-tenant-registry-or-binding');
  }
  if (String(row.bindingOwner) === 'foreign' || String(row.bindingOwner) === 'unowned') {
    ids.push('topology:accept-tenant-exclusive-binding-ownership-mismatch');
  }
  if (String(row.dataRole) === 'pii') {
    ids.push('topology:assign-pii-role-to-core-binding');
  }
  if (
    String(row.snapshotState) === 'payload-tampered' ||
    String(row.snapshotState) === 'signature-tampered' ||
    String(row.snapshotState) === 'unknown-kid' ||
    String(row.snapshotState) === 'unsigned'
  ) {
    ids.push('topology:accept-bad-signature-snapshot');
  }
  if (String(row.snapshotState) === 'quarantined') {
    ids.push('topology:use-quarantined-route-as-active');
  }
  if (String(row.snapshotState) === 'expired') {
    ids.push('topology:accept-bad-signature-snapshot');
  }
  if (String(row.bindingState) === 'missing' || String(row.bindingState) === 'wrong-type') {
    ids.push('topology:fall-back-to-common-database-when-required-binding-missing');
  }
  if (String(row.bindingState) === 'throws') {
    ids.push('topology:return-success-route-after-service-binding-failure');
  }
  if (String(row.cacheState) === 'warm-stale') {
    ids.push('topology:reuse-stale-runtime-generation-cache');
  }
  if (String(row.provider) === 'unsupported') {
    ids.push('topology:fall-back-to-common-database-when-required-binding-missing');
  }
  if (ids.length === 0) {
    ids.push('topology:reuse-stale-runtime-generation-cache');
  }
  return ids;
}

function rcMutationIds(row: Row): string[] {
  const ids: string[] = [];
  if (String(row.routeStatus) !== 'active') {
    ids.push('topology:use-quarantined-route-as-active');
  }
  if (String(row.runtimeGeneration) === 'stale' || String(row.runtimeGeneration) === 'ahead') {
    ids.push('topology:reuse-stale-runtime-generation-cache');
  }
  if (String(row.cacheState) === 'warm-stale') {
    ids.push('topology:reuse-stale-runtime-generation-cache');
  }
  if (ids.length === 0) {
    ids.push('topology:reuse-stale-runtime-generation-cache');
  }
  return ids;
}

function rdMutationIds(row: Row): string[] {
  const ids: string[] = [];
  if (
    String(row.vanityState) === 'canonical' &&
    String(row.canonicalIssuerState) === 'mismatched'
  ) {
    ids.push('topology:use-stale-route-after-canonicalization');
  }
  if (String(row.vanityState) === 'cross-tenant') {
    ids.push('topology:use-foreign-tenant-registry-or-binding');
  }
  if (String(row.vanityState) === 'inactive') {
    ids.push('topology:accept-inactive-vanity-alias');
  }
  if (ids.length === 0) {
    ids.push('topology:reuse-stale-runtime-generation-cache');
  }
  return ids;
}

function reMutationIds(row: Row): string[] {
  const ids: string[] = [];
  if (
    String(row.serviceBindingState) === 'missing' ||
    String(row.serviceBindingState) === 'wrong-type'
  ) {
    ids.push('topology:fall-back-to-common-database-when-required-binding-missing');
  }
  if (String(row.serviceBindingState) === 'throws') {
    ids.push('topology:return-success-route-after-service-binding-failure');
  }
  if (String(row.tenantContextState) === 'foreign') {
    ids.push('topology:use-foreign-tenant-registry-or-binding');
  }
  if (ids.length === 0) {
    ids.push('topology:reuse-stale-runtime-generation-cache');
  }
  return ids;
}

function buildCaseRow(
  suitePrefix: string,
  index: number,
  row: Row,
  dimensionOrder: readonly string[],
  mutationIds: string[]
): TopoCase {
  const dimensions: Record<string, Scalar> = {};
  for (const dimension of dimensionOrder) {
    dimensions[dimension] = row[dimension];
  }
  return {
    id: deriveCaseId(suitePrefix, index + 1),
    title: Object.entries(dimensions)
      .map(([key, value]) => `${key}=${value}`)
      .join(', '),
    dimensions,
    fingerprint: semanticFingerprint(dimensions),
    mutationIds,
  };
}

function buildTable(
  suitePrefix: string,
  dimensionOrder: readonly string[],
  values: Record<string, readonly Scalar[]>,
  constraints: Constraint[],
  selectedTriples: Array<[string, string, string]>,
  mutationIds: (row: Row) => string[]
): TopoCase[] {
  const rows = generateCoveringArray({
    dimensionOrder: [...dimensionOrder],
    values,
    constraints,
    selectedTriples,
  });
  return rows.map((row, index) => ({
    ...buildCaseRow(suitePrefix, index, row, dimensionOrder, mutationIds(row)),
  }));
}

export const RA_CASE_TABLE = buildTable(
  'topo-ra',
  RA_DIMENSION_ORDER,
  RA_VALUES,
  RA_CONSTRAINTS,
  RA_SELECTED_TRIPLES,
  raMutationIds
);
export const RB_CASE_TABLE = buildTable(
  'topo-rb',
  RB_DIMENSION_ORDER,
  RB_VALUES,
  RB_CONSTRAINTS,
  RB_SELECTED_TRIPLES,
  rbMutationIds
);
export const RC_CASE_TABLE = buildTable(
  'topo-rc',
  RC_DIMENSION_ORDER,
  RC_VALUES,
  RC_CONSTRAINTS,
  RC_SELECTED_TRIPLES,
  rcMutationIds
);
export const RD_CASE_TABLE = buildTable(
  'topo-rd',
  RD_DIMENSION_ORDER,
  RD_VALUES,
  RD_CONSTRAINTS,
  RD_SELECTED_TRIPLES,
  rdMutationIds
);
export const RE_CASE_TABLE = buildTable(
  'topo-re',
  RE_DIMENSION_ORDER,
  RE_VALUES,
  RE_CONSTRAINTS,
  RE_SELECTED_TRIPLES,
  reMutationIds
);

export const EXPECTED_RA_CASE_COUNT = RA_CASE_TABLE.length;
export const EXPECTED_RB_CASE_COUNT = RB_CASE_TABLE.length;
export const EXPECTED_RC_CASE_COUNT = RC_CASE_TABLE.length;
export const EXPECTED_RD_CASE_COUNT = RD_CASE_TABLE.length;
export const EXPECTED_RE_CASE_COUNT = RE_CASE_TABLE.length;
