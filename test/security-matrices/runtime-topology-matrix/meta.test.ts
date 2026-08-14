import { describe, expect, it } from 'vitest';
import {
  RA_CASE_TABLE,
  RB_CASE_TABLE,
  RC_CASE_TABLE,
  RD_CASE_TABLE,
  RE_CASE_TABLE,
  RA_CONSTRAINTS,
  RB_CONSTRAINTS,
  RC_CONSTRAINTS,
  RD_CONSTRAINTS,
  RE_CONSTRAINTS,
  type TopoCase,
} from './cases';
import type { Row, Scalar } from '../fixtures/covering-array';
import { findDuplicateIds } from '../fixtures/case-fingerprint';
import {
  enumerateLegalAssignments,
  requiredPairKeys,
  requiredTripleKeys,
  verifyCoverage,
  type CoverageSpec,
} from '../fixtures/coverage-verifier';
import { generateCoveringArray } from '../fixtures/covering-array';
import { getRuntimeRegistryKeys, buildSnapshot, signSnapshot } from './registry-fixtures';
import { extractTenantLabelsFromTarget, observedTenantAccessSet } from './routing-env';
import { CallLedger } from '../fixtures/call-ledger';
import { installFrozenNow, restoreRealClock } from '../fixtures/deterministic-clock';
import {
  seedMiddlewareRow,
  buildRaObservation,
  expectedRaObservation,
  raVanitySeedFor,
  intendedTenantOf,
} from './harness';
import { runProbe } from './routing-env';
import { decideRoutingRa, decideRoutingRb } from './cases';
import {
  seedRbRow,
  buildRbObservation,
  expectedRbObservation,
  rbSecurityEventWritten,
} from './rb-harness';
import { checkRaObservation, checkRbObservation } from './observation';
import { corruptRaObservationDomain, corruptRbObservationDomain } from './observation';

// =============================================================================
// Independent checker (independently declared literals).
//
// The coverage computations below share NO constraint functions, dimension orders,
// value arrays, selected-triple definitions, or decision functions with cases.ts.
// Every dimension order and selected-triple group is re-declared here as a
// independently declared string literal. By the coverage checker, the only cases.ts values
// referenced are the generator constraint arrays (RA_CONSTRAINTS..RE_CONSTRAINTS),
// imported for exactly one purpose: proving that the generator's legal assignment set
// equals the independent predicate's legal assignment set. They are never used in
// coverage counting, enumeration, or the faulty-matrix negative tests. (The case tables
// and decision functions imported elsewhere in this file are used only to run REAL
// production observations for the fixture/mutation meta tests, not for coverage.)
// =============================================================================

/** Independently declared literal dimension orders for the five matrices. */
const IND_RA_DIMENSION_ORDER = [
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

const IND_RB_DIMENSION_ORDER = [
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

const IND_RC_DIMENSION_ORDER = ['routeStatus', 'cacheState', 'runtimeGeneration'] as const;

const IND_RD_DIMENSION_ORDER = [
  'hostState',
  'vanityState',
  'canonicalIssuerState',
  'requestClass',
] as const;

const IND_RE_DIMENSION_ORDER = [
  'serviceBindingState',
  'forwardedHost',
  'tenantContextState',
  'hostState',
] as const;

/** Independently declared literal selected-triple groups per matrix. */
const IND_RA_SELECTED_TRIPLES: Array<[string, string, string]> = [
  ['hostClass', 'forwardedPolicy', 'requestClass'],
];

const IND_RB_SELECTED_TRIPLES: Array<[string, string, string]> = [
  ['tenantHost', 'registryTenant', 'bindingOwner'],
  ['allocationScope', 'bindingOwner', 'dataRole'],
];

const IND_RC_SELECTED_TRIPLES: Array<[string, string, string]> = [
  ['routeStatus', 'cacheState', 'runtimeGeneration'],
];

const IND_RD_SELECTED_TRIPLES: Array<[string, string, string]> = [
  ['vanityState', 'canonicalIssuerState', 'requestClass'],
];

const IND_RE_SELECTED_TRIPLES: Array<[string, string, string]> = [
  ['serviceBindingState', 'forwardedHost', 'tenantContextState'],
];

export const IND_RA_VALUES: Record<string, readonly Scalar[]> = {
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
 * Independent R-A legality predicate, derived from the production middleware flow
 * (request-context.ts) rather than from the case-table constraints.
 */
export function independentRaLegal(row: Row): boolean {
  const m = String(row.deploymentMode);
  const h = String(row.hostClass);
  const p = String(row.forwardedPolicy);
  const f = String(row.forwardedState);
  const r = String(row.requestClass);
  const t = String(row.tenantLifecycle);
  const v = String(row.vanityState);
  const g = String(row.registryState);
  const b = String(row.bindingState);
  const browserProtocol = r === 'browser' || r === 'protocol';

  if (m === 'single') {
    return (
      h === 'unrelated' &&
      t === 'missing' &&
      v === 'missing' &&
      browserProtocol &&
      b === 'present' &&
      (f === 'missing' || f === 'conflicting')
    );
  }
  if (r === 'discovery' || r === 'internal') {
    return (
      (g === 'not-configured' &&
        b === 'present' &&
        v === 'missing' &&
        t === 'missing' &&
        p === 'disabled' &&
        f === 'missing' &&
        (h === 'unrelated' || h === 'missing')) ||
      (h === 'canonical' &&
        g === 'valid' &&
        b === 'present' &&
        v === 'missing' &&
        t === 'active' &&
        p === 'disabled' &&
        f === 'missing')
    );
  }
  if (r === 'admin') {
    // The X-Tenant-Id header pins the tenant; the admin rows run on the canonical host
    // with a valid registry and an active tenant.
    return (
      h === 'canonical' &&
      g === 'valid' &&
      b === 'present' &&
      t === 'active' &&
      v === 'missing' &&
      (f === 'missing' || f === 'matching' || f === 'conflicting')
    );
  }
  switch (h) {
    case 'active-vanity':
      return (
        t === 'active' &&
        (v === 'canonical' || v === 'cross-tenant') &&
        g === 'valid' &&
        b === 'present' &&
        p === 'disabled' &&
        f === 'missing' &&
        browserProtocol
      );
    case 'inactive-vanity-alias':
      return (
        t === 'active' &&
        v === 'inactive' &&
        g === 'valid' &&
        b === 'present' &&
        p === 'disabled' &&
        f === 'missing' &&
        browserProtocol
      );
    case 'non-primary-alias':
      return (
        t === 'active' &&
        v === 'non-canonical' &&
        g === 'valid' &&
        b === 'present' &&
        p === 'disabled' &&
        f === 'missing' &&
        browserProtocol
      );
    case 'ui-host':
      return (
        g === 'valid' &&
        t === 'missing' &&
        v === 'missing' &&
        b === 'present' &&
        p === 'disabled' &&
        f === 'missing' &&
        browserProtocol
      );
    case 'sub-subdomain':
    case 'malformed':
    case 'missing':
      return (
        p === 'disabled' &&
        g === 'not-configured' &&
        t === 'missing' &&
        v === 'missing' &&
        r === 'protocol' &&
        b === 'present' &&
        f === 'missing'
      );
    case 'unrelated':
      return (
        g === 'not-configured' &&
        t === 'missing' &&
        v === 'missing' &&
        r === 'protocol' &&
        b === 'present' &&
        p === 'disabled' &&
        f === 'missing'
      );
    case 'naked':
      return (
        t === 'active' &&
        v === 'missing' &&
        g === 'valid' &&
        b === 'present' &&
        p === 'disabled' &&
        f === 'missing' &&
        browserProtocol
      );
    case 'uppercase':
    case 'port':
      return (
        t === 'active' &&
        v === 'missing' &&
        g === 'valid' &&
        b === 'present' &&
        p === 'disabled' &&
        f === 'missing' &&
        browserProtocol
      );
    case 'canonical': {
      const validActiveMissing = (): boolean =>
        t === 'active' && v === 'missing' && g === 'valid' && b === 'present';
      if (p === 'enabled' && f === 'matching') return validActiveMissing() && r === 'protocol';
      if (p === 'enabled' && f === 'malformed') return validActiveMissing() && r === 'protocol';
      if (p === 'enabled' && f === 'conflicting') return validActiveMissing() && browserProtocol;
      if (p === 'disabled' && f === 'conflicting') return validActiveMissing() && browserProtocol;
      if (p === 'disabled' && (f === 'matching' || f === 'malformed'))
        return validActiveMissing() && r === 'protocol';
      if (t === 'inactive' || t === 'missing')
        return g === 'valid' && v === 'missing' && b === 'present' && browserProtocol;
      if (v === 'non-canonical') return g === 'valid' && b === 'present' && browserProtocol;
      if (v === 'inactive') return g === 'valid' && b === 'present' && r === 'protocol';
      if (b === 'missing' || b === 'wrong-type')
        return v === 'missing' && g === 'valid' && browserProtocol;
      if (g === 'bad-signature' || g === 'missing' || g === 'quarantined')
        return v === 'missing' && b === 'present' && browserProtocol;
      return true;
    }
    default:
      return false;
  }
}

export const IND_RB_VALUES: Record<string, readonly Scalar[]> = {
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
 * Independent R-B legality predicate, derived from the resolver flow
 * (tenant-database-resolver.ts). BOTH tenants are legal in every security-relevant state.
 */
export function independentRbLegal(row: Row): boolean {
  const t = String(row.tenantHost);
  const s = String(row.snapshotState);
  const g = String(row.generationState);
  const a = String(row.allocationScope);
  const rt = String(row.registryTenant);
  const o = String(row.bindingOwner);
  const d = String(row.dataRole);
  const b = String(row.bindingState);
  const sv = String(row.serviceRoute);
  const p = String(row.provider);
  const c = String(row.cacheState);

  if (c !== 'cold') {
    return (
      s === 'valid' &&
      g === 'matching' &&
      rt === 'matching' &&
      o === 'matching' &&
      b === 'present' &&
      p === 'd1' &&
      a === 'shared-pool' &&
      d === 'core-default' &&
      sv === 'issuer-hosted-ui'
    );
  }
  if (rt === 'foreign') {
    return (
      s === 'valid' &&
      g === 'matching' &&
      p === 'd1' &&
      b === 'present' &&
      a === 'shared-pool' &&
      o === 'matching' &&
      d === 'core-default' &&
      sv === 'issuer-hosted-ui'
    );
  }
  if (o === 'foreign') {
    return (
      a === 'tenant-exclusive' &&
      s === 'valid' &&
      g === 'matching' &&
      p === 'd1' &&
      b === 'present' &&
      rt === 'matching' &&
      d === 'core-default' &&
      sv === 'issuer-hosted-ui'
    );
  }
  if (o === 'unowned') {
    return (
      a === 'shared-pool' &&
      s === 'valid' &&
      g === 'matching' &&
      p === 'd1' &&
      b === 'present' &&
      rt === 'matching' &&
      d === 'core-default' &&
      sv === 'issuer-hosted-ui'
    );
  }
  if (p === 'unsupported') {
    return (
      s === 'valid' &&
      g === 'matching' &&
      b === 'present' &&
      rt === 'matching' &&
      o === 'matching' &&
      a === 'shared-pool' &&
      d === 'core-default' &&
      sv === 'issuer-hosted-ui'
    );
  }
  if (s !== 'valid') {
    return (
      g === 'matching' &&
      p === 'd1' &&
      b === 'present' &&
      rt === 'matching' &&
      o === 'matching' &&
      a === 'shared-pool' &&
      d === 'core-default' &&
      sv === 'issuer-hosted-ui'
    );
  }
  if (g !== 'matching') {
    return (
      s === 'valid' &&
      p === 'd1' &&
      b === 'present' &&
      rt === 'matching' &&
      o === 'matching' &&
      a === 'shared-pool' &&
      d === 'core-default' &&
      sv === 'issuer-hosted-ui'
    );
  }
  if (b !== 'present') {
    if (sv === 'unavailable')
      return (
        b === 'missing' &&
        s === 'valid' &&
        g === 'matching' &&
        p === 'd1' &&
        rt === 'matching' &&
        o === 'matching' &&
        a === 'shared-pool' &&
        d === 'core-default'
      );
    return (
      s === 'valid' &&
      g === 'matching' &&
      p === 'd1' &&
      rt === 'matching' &&
      o === 'matching' &&
      a === 'shared-pool' &&
      d === 'core-default'
    );
  }
  if (sv === 'unavailable') return false;
  if (sv === 'login-ui') return d === 'core-default' && p === 'd1';
  if (d === 'pii') return sv === 'service-binding' && p === 'd1';
  if (d === 'core-users') return sv === 'issuer-hosted-ui' && p === 'd1';
  void t;
  return p === 'd1' && b === 'present';
}

export const IND_RC_VALUES: Record<string, readonly Scalar[]> = {
  routeStatus: ['active', 'quarantining', 'quarantined', 'disabled'],
  cacheState: ['cold', 'warm', 'warm-stale'],
  runtimeGeneration: ['matching', 'stale', 'ahead', 'missing'],
};

export function independentRcLegal(row: Row): boolean {
  const routeStatus = String(row.routeStatus);
  const cacheState = String(row.cacheState);
  const runtimeGeneration = String(row.runtimeGeneration);
  if (routeStatus !== 'active') {
    return cacheState === 'cold' && runtimeGeneration === 'matching';
  }
  if (cacheState === 'warm') return runtimeGeneration === 'matching';
  if (cacheState === 'warm-stale') return runtimeGeneration === 'ahead';
  return true;
}

export const IND_RD_VALUES: Record<string, readonly Scalar[]> = {
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

export function independentRdLegal(row: Row): boolean {
  const hostState = String(row.hostState);
  const vanityState = String(row.vanityState);
  const issuer = String(row.canonicalIssuerState);
  switch (vanityState) {
    case 'canonical':
      return (
        (hostState === 'vanity' && issuer === 'active-vanity') ||
        (hostState === 'canonical' && issuer === 'mismatched')
      );
    case 'non-canonical':
      return hostState === 'alias' && issuer === 'mismatched';
    case 'inactive':
      return hostState === 'vanity' && issuer === 'unavailable';
    case 'cross-tenant':
      return hostState === 'vanity' && issuer === 'unavailable';
    default:
      return (
        (hostState === 'canonical' && issuer === 'tenant-canonical') ||
        (hostState === 'naked' && issuer === 'primary-naked') ||
        (hostState === 'unresolvable' && issuer === 'unavailable')
      );
  }
}

export const IND_RE_VALUES: Record<string, readonly Scalar[]> = {
  serviceBindingState: ['present', 'missing', 'wrong-type', 'throws'],
  forwardedHost: ['none', 'matching', 'conflicting'],
  tenantContextState: ['matching', 'foreign', 'missing'],
  hostState: ['canonical', 'unresolvable'],
};

export function independentReLegal(row: Row): boolean {
  const serviceBindingState = String(row.serviceBindingState);
  const forwardedHost = String(row.forwardedHost);
  const tenantContextState = String(row.tenantContextState);
  const hostState = String(row.hostState);
  if (tenantContextState === 'foreign') {
    return forwardedHost === 'conflicting' && hostState === 'canonical';
  }
  if (tenantContextState === 'matching') {
    return hostState === 'canonical' && (forwardedHost === 'none' || forwardedHost === 'matching');
  }
  if (tenantContextState === 'missing') {
    return (
      hostState === 'unresolvable' && forwardedHost === 'none' && serviceBindingState === 'present'
    );
  }
  return false;
}

// Fixed expected coverage counts (computed by the independent checker, not by the
// generator). Recorded here as independently declared literals.
const EXPECTED_RA_PAIR_COUNT = 365;
const EXPECTED_RB_PAIR_COUNT = 350;

// The six required 3-wise groups with their independently declared literal legal-triple counts.
const REQUIRED_GROUPS: Array<{
  name: string;
  axes: [string, string, string];
  expectedTriples: number;
  values: Record<string, readonly Scalar[]>;
  order: readonly string[];
  legal: (row: Row) => boolean;
}> = [
  {
    name: 'G1 host × forwarded-host policy × request class',
    axes: ['hostClass', 'forwardedPolicy', 'requestClass'],
    expectedTriples: 33,
    values: IND_RA_VALUES,
    order: IND_RA_DIMENSION_ORDER,
    legal: independentRaLegal,
  },
  {
    name: 'G2 host tenant × registry tenant × binding owner',
    axes: ['tenantHost', 'registryTenant', 'bindingOwner'],
    expectedTriples: 8,
    values: IND_RB_VALUES,
    order: IND_RB_DIMENSION_ORDER,
    legal: independentRbLegal,
  },
  {
    name: 'G3 route status × cache state × runtime generation',
    axes: ['routeStatus', 'cacheState', 'runtimeGeneration'],
    expectedTriples: 9,
    values: IND_RC_VALUES,
    order: IND_RC_DIMENSION_ORDER,
    legal: independentRcLegal,
  },
  {
    name: 'G4 allocation scope × owner tenant × data role',
    axes: ['allocationScope', 'bindingOwner', 'dataRole'],
    expectedTriples: 8,
    values: IND_RB_VALUES,
    order: IND_RB_DIMENSION_ORDER,
    legal: independentRbLegal,
  },
  {
    name: 'G5 vanity state × canonical issuer × browser/protocol request',
    axes: ['vanityState', 'canonicalIssuerState', 'requestClass'],
    expectedTriples: 16,
    values: IND_RD_VALUES,
    order: IND_RD_DIMENSION_ORDER,
    legal: independentRdLegal,
  },
  {
    name: 'G6 service-binding state × forwarded host × tenant context',
    axes: ['serviceBindingState', 'forwardedHost', 'tenantContextState'],
    expectedTriples: 13,
    values: IND_RE_VALUES,
    order: IND_RE_DIMENSION_ORDER,
    legal: independentReLegal,
  },
];

function indSpec(
  values: Record<string, readonly Scalar[]>,
  order: readonly string[],
  legal: (row: Row) => boolean,
  triples: Array<[string, string, string]>
): CoverageSpec {
  return {
    dimensionOrder: [...order],
    values,
    constraints: [legal],
    selectedTriples: triples,
  };
}

function rowsOf(table: TopoCase[]): Row[] {
  return table.map((entry) => entry.dimensions as unknown as Row);
}

// =============================================================================
// Coverage tests
// =============================================================================

describe('runtime-topology coverage (independent checker)', () => {
  it('independent checker: R-A legal pair count is the fixed literal 365', () => {
    expect.hasAssertions();
    const pairs = requiredPairKeys(
      indSpec(IND_RA_VALUES, IND_RA_DIMENSION_ORDER, independentRaLegal, [])
    );
    expect(pairs.length).toBe(EXPECTED_RA_PAIR_COUNT);
  });

  it('independent checker: R-B legal pair count is the fixed literal 350', () => {
    expect.hasAssertions();
    const pairs = requiredPairKeys(
      indSpec(IND_RB_VALUES, IND_RB_DIMENSION_ORDER, independentRbLegal, [])
    );
    expect(pairs.length).toBe(EXPECTED_RB_PAIR_COUNT);
  });

  it('the six required 3-wise groups match their independently declared literal triple counts', () => {
    expect.hasAssertions();
    for (const group of REQUIRED_GROUPS) {
      const triples = requiredTripleKeys(
        indSpec(group.values, group.order, group.legal, [group.axes])
      );
      expect(
        triples.length,
        `${group.name}: expected ${group.expectedTriples} legal triples, got ${triples.length}`
      ).toBe(group.expectedTriples);
    }
  });

  it('every retained row is legal for the independent predicate of its matrix', () => {
    expect.hasAssertions();
    for (const entry of RA_CASE_TABLE) {
      expect(independentRaLegal(entry.dimensions as unknown as Row), `${entry.id}`).toBe(true);
    }
    for (const entry of RB_CASE_TABLE) {
      expect(independentRbLegal(entry.dimensions as unknown as Row), `${entry.id}`).toBe(true);
    }
    for (const entry of RC_CASE_TABLE) {
      expect(independentRcLegal(entry.dimensions as unknown as Row), `${entry.id}`).toBe(true);
    }
    for (const entry of RD_CASE_TABLE) {
      expect(independentRdLegal(entry.dimensions as unknown as Row), `${entry.id}`).toBe(true);
    }
    for (const entry of RE_CASE_TABLE) {
      expect(independentReLegal(entry.dimensions as unknown as Row), `${entry.id}`).toBe(true);
    }
  });

  it('the generator constraints and the independent predicates accept the same assignment set', () => {
    expect.hasAssertions();
    const key = (rows: Row[], order: readonly string[]): string =>
      rows
        .map((row) => order.map((d) => `${d}=${row[d]}`).join('|'))
        .sort()
        .join('\n');
    const cases: Array<{
      gen: Constraint[];
      ind: (row: Row) => boolean;
      order: readonly string[];
      values: Record<string, readonly Scalar[]>;
    }> = [
      {
        gen: RA_CONSTRAINTS,
        ind: independentRaLegal,
        order: IND_RA_DIMENSION_ORDER,
        values: IND_RA_VALUES,
      },
      {
        gen: RB_CONSTRAINTS,
        ind: independentRbLegal,
        order: IND_RB_DIMENSION_ORDER,
        values: IND_RB_VALUES,
      },
      {
        gen: RC_CONSTRAINTS,
        ind: independentRcLegal,
        order: IND_RC_DIMENSION_ORDER,
        values: IND_RC_VALUES,
      },
      {
        gen: RD_CONSTRAINTS,
        ind: independentRdLegal,
        order: IND_RD_DIMENSION_ORDER,
        values: IND_RD_VALUES,
      },
      {
        gen: RE_CONSTRAINTS,
        ind: independentReLegal,
        order: IND_RE_DIMENSION_ORDER,
        values: IND_RE_VALUES,
      },
    ];
    for (const item of cases) {
      const gen = enumerateLegalAssignments({
        dimensionOrder: [...item.order],
        values: item.values,
        constraints: item.gen,
      });
      const ind = enumerateLegalAssignments(indSpec(item.values, item.order, item.ind, []));
      expect(key(gen, item.order)).toBe(key(ind, item.order));
    }
  });

  it('every matrix covers every legal pair and its required triples', () => {
    expect.hasAssertions();
    const specs: Array<{ table: TopoCase[]; spec: CoverageSpec }> = [
      {
        table: RA_CASE_TABLE,
        spec: indSpec(
          IND_RA_VALUES,
          IND_RA_DIMENSION_ORDER,
          independentRaLegal,
          IND_RA_SELECTED_TRIPLES
        ),
      },
      {
        table: RB_CASE_TABLE,
        spec: indSpec(
          IND_RB_VALUES,
          IND_RB_DIMENSION_ORDER,
          independentRbLegal,
          IND_RB_SELECTED_TRIPLES
        ),
      },
      {
        table: RC_CASE_TABLE,
        spec: indSpec(
          IND_RC_VALUES,
          IND_RC_DIMENSION_ORDER,
          independentRcLegal,
          IND_RC_SELECTED_TRIPLES
        ),
      },
      {
        table: RD_CASE_TABLE,
        spec: indSpec(
          IND_RD_VALUES,
          IND_RD_DIMENSION_ORDER,
          independentRdLegal,
          IND_RD_SELECTED_TRIPLES
        ),
      },
      {
        table: RE_CASE_TABLE,
        spec: indSpec(
          IND_RE_VALUES,
          IND_RE_DIMENSION_ORDER,
          independentReLegal,
          IND_RE_SELECTED_TRIPLES
        ),
      },
    ];
    for (const { table, spec } of specs) {
      const diagnostics = verifyCoverage(spec, rowsOf(table));
      expect(diagnostics.illegalRows).toEqual([]);
      expect(diagnostics.missingPairs).toEqual([]);
      expect(diagnostics.missingTriples).toEqual([]);
    }
  });

  it('the six required 3-wise groups are covered 100% by their matrices', () => {
    expect.hasAssertions();
    const matrixFor: Array<{ group: (typeof REQUIRED_GROUPS)[number]; table: TopoCase[] }> = [
      { group: REQUIRED_GROUPS[0], table: RA_CASE_TABLE },
      { group: REQUIRED_GROUPS[1], table: RB_CASE_TABLE },
      { group: REQUIRED_GROUPS[2], table: RC_CASE_TABLE },
      { group: REQUIRED_GROUPS[3], table: RB_CASE_TABLE },
      { group: REQUIRED_GROUPS[4], table: RD_CASE_TABLE },
      { group: REQUIRED_GROUPS[5], table: RE_CASE_TABLE },
    ];
    for (const { group, table } of matrixFor) {
      const diagnostics = verifyCoverage(
        indSpec(group.values, group.order, group.legal, [group.axes]),
        rowsOf(table)
      );
      expect(diagnostics.missingTriples, `${group.name}`).toEqual([]);
    }
  });

  it('rejects a matrix that drops one legal pair', () => {
    expect.hasAssertions();
    const rows = rowsOf(RA_CASE_TABLE);
    const pairs = requiredPairKeys(
      indSpec(IND_RA_VALUES, IND_RA_DIMENSION_ORDER, independentRaLegal, [])
    );
    const dropped = pairs.find((pair) => pair.includes('hostClass=canonical')) as string;
    const filtered = rows.filter((row) => {
      const [left, right] = dropped.split('|');
      const [a, av] = left.split('=');
      const [b, bv] = right.split('=');
      return !(String(row[a]) === av && String(row[b]) === bv);
    });
    const diagnostics = verifyCoverage(
      indSpec(IND_RA_VALUES, IND_RA_DIMENSION_ORDER, independentRaLegal, []),
      filtered
    );
    expect(diagnostics.missingPairs).toContain(dropped);
  });

  it('rejects a matrix that keeps pairwise coverage but drops a required triple', () => {
    expect.hasAssertions();
    const rows = rowsOf(RB_CASE_TABLE);
    const triples = requiredTripleKeys(
      indSpec(IND_RB_VALUES, IND_RB_DIMENSION_ORDER, independentRbLegal, IND_RB_SELECTED_TRIPLES)
    );
    const dropped = triples.find((triple) => triple.includes('bindingOwner=foreign')) as string;
    const parts = dropped.split('|').map((part) => {
      const [dimension, value] = part.split('=');
      return { dimension, value };
    });
    const filtered = rows.filter((row) =>
      parts.some(({ dimension, value }) => String(row[dimension]) !== value)
    );
    const diagnostics = verifyCoverage(
      indSpec(IND_RB_VALUES, IND_RB_DIMENSION_ORDER, independentRbLegal, IND_RB_SELECTED_TRIPLES),
      filtered
    );
    expect(diagnostics.missingTriples).toContain(dropped);
  });

  it('detects a wrong constraint that hides a legal tuple', () => {
    expect.hasAssertions();
    const bogusRows = RA_CASE_TABLE.filter(
      (entry) =>
        !(
          String(entry.dimensions.hostClass) === 'canonical' &&
          (String(entry.dimensions.registryState) === 'bad-signature' ||
            String(entry.dimensions.registryState) === 'quarantined')
        )
    ).map((entry) => entry.dimensions as unknown as Row);
    const diagnostics = verifyCoverage(
      indSpec(IND_RA_VALUES, IND_RA_DIMENSION_ORDER, independentRaLegal, []),
      bogusRows
    );
    const missingPair = diagnostics.missingPairs.find((pair) =>
      pair.includes('registryState=bad-signature')
    );
    expect(missingPair).toBeDefined();
  });

  it('assigns unique case ids and unique semantic fingerprints across all matrices', () => {
    expect.hasAssertions();
    const all = [
      ...RA_CASE_TABLE,
      ...RB_CASE_TABLE,
      ...RC_CASE_TABLE,
      ...RD_CASE_TABLE,
      ...RE_CASE_TABLE,
    ];
    const ids = all.map((entry) => entry.id);
    expect(findDuplicateIds(ids)).toEqual([]);
    const fingerprints = all.map((entry) => entry.fingerprint);
    expect(findDuplicateIds(fingerprints)).toEqual([]);
  });

  it('pins the covering-array case counts', () => {
    expect.hasAssertions();
    // The independent predicate's legal set equals the generator's (verified by the
    // set-equality test), so regenerating over the independent set pins the
    // deterministic covering-array count without importing the generator constraints.
    const ra = generateCoveringArray({
      dimensionOrder: [...IND_RA_DIMENSION_ORDER],
      values: IND_RA_VALUES,
      constraints: [independentRaLegal],
      selectedTriples: IND_RA_SELECTED_TRIPLES,
    });
    expect(RA_CASE_TABLE.length).toBe(ra.length);
  });
});

// =============================================================================
// Fixture fixity tests
// =============================================================================

describe('runtime-topology fixture fixity', () => {
  it('the Ed25519 fixed test key is fixed and private material never enters the public JWKS', async () => {
    expect.hasAssertions();
    const keys = await getRuntimeRegistryKeys();
    const again = await getRuntimeRegistryKeys();
    expect(keys.primary.kid).toBe('security-matrix-runtime-registry-kid-001');
    expect(keys.primary.publicJwksJson).toBe(again.primary.publicJwksJson);
    expect(JSON.stringify(keys.primary.privateJwk)).toBe(JSON.stringify(again.primary.privateJwk));
    expect(keys.primary.publicJwksJson).not.toContain('"d"');
    expect(keys.primary.publicJwksJson).not.toContain(keys.primary.privateJwk.d);
    expect(keys.unknownKid.kid).toBe('security-matrix-runtime-registry-kid-002');
    expect(keys.unknownKid.publicJwksJson).not.toContain('"d"');
  });

  it('the same payload produces the same signing input every time (deterministic signature)', async () => {
    expect.hasAssertions();
    const snapshot = buildSnapshot({
      tenantId: 'default',
      runtimeGeneration: 5,
      routeStatus: 'active',
      quarantineDenyGeneration: 0,
      stores: [
        {
          tenantId: 'default',
          dataRole: 'tenant_core/default',
          bindingRef: 'DB',
          generation: 5,
          runtimeGeneration: 5,
          allocationScope: 'shared_pool',
          ownerTenantId: null,
          provider: 'd1',
          databaseId: 'db-fixity',
        },
      ],
      publishedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-02-01T00:00:00.000Z',
    });
    const first = await signSnapshot(snapshot, '2026-01-01T00:00:00.000Z');
    const second = await signSnapshot(snapshot, '2026-01-01T00:00:00.000Z');
    expect(first.metadata.signature).toBe(second.metadata.signature);
    expect(first.metadata.signatureKeyId).toBe('security-matrix-runtime-registry-kid-001');
  });

  it('tenant labels are extracted only from safe key shapes (no hostname false positives)', () => {
    expect.hasAssertions();
    expect(
      extractTenantLabelsFromTarget(
        'runtime_registry:tenant:alpha:runtime-registry:snapshot:tenant:default'
      )
    ).toEqual(['alpha']);
    expect(extractTenantLabelsFromTarget('autrhm_config:settings:tenant:alpha:tenant')).toEqual([
      'alpha',
    ]);
    expect(extractTenantLabelsFromTarget('autrhm_config:v1:tenant-exists:beta')).toEqual(['beta']);
    expect(
      extractTenantLabelsFromTarget('autrhm_config:v1:tenant-primary-vanity-domain:default')
    ).toEqual(['default']);
    // The vanity-domain cache key embeds a HOSTNAME that contains a tenant-looking
    // label; it must NOT be extracted as a tenant access.
    expect(
      extractTenantLabelsFromTarget('autrhm_config:v1:tenant-vanity-domain:vanity.alpha.example')
    ).toEqual([]);
    expect(
      extractTenantLabelsFromTarget('environment:matrix-env:runtime-registry:snapshot')
    ).toEqual([]);
  });

  it('the tenant-access ledger aggregates D1 and KV observations', async () => {
    expect.hasAssertions();
    const ledger = new CallLedger();
    ledger.record('tenant-access', 'core:alpha');
    ledger.record(
      'kv.get',
      'runtime_registry:tenant:beta:runtime-registry:snapshot:tenant:default'
    );
    ledger.record('kv.get', 'autrhm_config:v1:tenant-vanity-domain:vanity.alpha.example');
    expect(observedTenantAccessSet(ledger)).toEqual(['alpha', 'beta']);
  });

  it('an injected foreign D1 tenant access is detected by the observation oracle', async () => {
    expect.hasAssertions();
    // A production run for alpha that legitimately touches only alpha, with a foreign
    // beta access injected into the ledger, must flip the foreignTenantAccess fact.
    const entry = RA_CASE_TABLE.find(
      (row) =>
        String(row.dimensions.hostClass) === 'canonical' &&
        decideRoutingRa(row.dimensions as never).status === 200
    ) as TopoCase;
    installFrozenNow(1700000000);
    const seeded = await seedMiddlewareRow(entry.dimensions as never, raVanitySeedFor);
    const result = await runProbe(seeded.app, seeded.kit.env, seeded.request, seeded.kit.ledger);
    const observed = await buildRaObservation(
      seeded.kit,
      result,
      seeded.secrets,
      intendedTenantOf(entry.dimensions)
    );
    const expected = expectedRaObservation(entry, decideRoutingRa(entry.dimensions as never));
    observed.foreignTenantAccess = observed.tenantAccessSet.some(
      (t) => !expected.tenantAccessSet.includes(t)
    );
    expect(observed.foreignTenantAccess).toBe(false);
    // Inject a foreign tenant access via the D1 tenant-routing label path.
    seeded.kit.ledger.record('tenant-access', 'core:beta');
    const injected = observedTenantAccessSet(seeded.kit.ledger);
    expect(injected).toContain('beta');
    const injectedObs = { ...observed, tenantAccessSet: injected };
    injectedObs.foreignTenantAccess = injectedObs.tenantAccessSet.some(
      (t) => !expected.tenantAccessSet.includes(t)
    );
    expect(injectedObs.foreignTenantAccess).toBe(true);
    const mismatches = checkRaObservation(injectedObs, expected);
    expect(mismatches).toContain('tenantAccessSet');
    expect(mismatches).toContain('foreignTenantAccess');
    restoreRealClock();
  });
});

// =============================================================================
// Mutation witnesses connected to real production observations
// =============================================================================

const MUTATION_OBSERVATION_FIELDS: Array<{
  id: string;
  matrix: 'RA' | 'RB';
  domain: string;
  description: string;
}> = [
  {
    id: 'topology:trust-forwarded-host-without-config',
    matrix: 'RA',
    domain: 'tenant',
    description: 'the resolved tenant/context would switch to the forwarded tenant',
  },
  {
    id: 'topology:accept-inactive-vanity-alias',
    matrix: 'RA',
    domain: 'tenant',
    description: 'an inactive alias would resolve as an active tenant',
  },
  {
    id: 'topology:use-foreign-tenant-registry-or-binding',
    matrix: 'RA',
    domain: 'tenant-access-set',
    description: 'a foreign tenant would appear in the access set',
  },
  {
    id: 'topology:accept-tenant-exclusive-binding-ownership-mismatch',
    matrix: 'RB',
    domain: 'owner',
    description: 'the resolved owner would be the wrong tenant',
  },
  {
    id: 'topology:assign-pii-role-to-core-binding',
    matrix: 'RB',
    domain: 'data-role',
    description: 'the PII role would be served by the core binding',
  },
  {
    id: 'topology:accept-bad-signature-snapshot',
    matrix: 'RB',
    domain: 'error-code',
    description: 'a tampered snapshot would resolve instead of failing closed',
  },
  {
    id: 'topology:use-quarantined-route-as-active',
    matrix: 'RB',
    domain: 'error-code',
    description: 'a quarantined route would resolve as active',
  },
  {
    id: 'topology:fall-back-to-common-database-when-required-binding-missing',
    matrix: 'RB',
    domain: 'error-code',
    description: 'a missing binding would fall back to the common database',
  },
  {
    id: 'topology:return-success-route-after-service-binding-failure',
    matrix: 'RB',
    domain: 'outcome',
    description: 'a failed binding access would still return a success route',
  },
  {
    id: 'topology:reuse-stale-runtime-generation-cache',
    matrix: 'RB',
    domain: 'generation',
    description: 'the stale generation would be served from cache',
  },
  {
    id: 'topology:use-stale-route-after-canonicalization',
    matrix: 'RA',
    domain: 'location',
    description: 'the non-canonical route would be served after the canonicalization check',
  },
];

describe('runtime-topology mutation witnesses connected to real observations', () => {
  it('every mutation ID is connected to at least one production observation field', async () => {
    expect.hasAssertions();
    for (const mapping of MUTATION_OBSERVATION_FIELDS) {
      const table = mapping.matrix === 'RA' ? RA_CASE_TABLE : RB_CASE_TABLE;
      const representative = table.find((entry) => entry.mutationIds.includes(mapping.id));
      expect(representative, `${mapping.id} must have a representative case`).toBeDefined();
      installFrozenNow(1700000000);
      if (mapping.matrix === 'RA') {
        const seeded = await seedMiddlewareRow(
          representative!.dimensions as never,
          raVanitySeedFor
        );
        const result = await runProbe(
          seeded.app,
          seeded.kit.env,
          seeded.request,
          seeded.kit.ledger
        );
        const observed = await buildRaObservation(
          seeded.kit,
          result,
          seeded.secrets,
          intendedTenantOf(representative!.dimensions)
        );
        const expected = expectedRaObservation(
          representative!,
          decideRoutingRa(representative!.dimensions as never)
        );
        observed.foreignTenantAccess = observed.tenantAccessSet.some(
          (tenant) => !expected.tenantAccessSet.includes(tenant)
        );
        const mismatches = checkRaObservation(observed, expected);
        expect(
          mismatches,
          `${mapping.id} real observation must pass: ${mismatches.join(', ')}`
        ).toEqual([]);
        const corrupted = corruptRaObservationDomain(observed, mapping.domain);
        expect(
          checkRaObservation(corrupted, expected).length,
          `${mapping.id} (${mapping.domain}) must be rejected by the common assertion`
        ).toBeGreaterThan(0);
      } else {
        const seeded = await seedRbRow(representative!);
        const cacheHit = String(representative!.dimensions.cacheState) === 'warm';
        const result = await seeded.run();
        const securityEventWritten = rbSecurityEventWritten(seeded.kit.ledger);
        const observed = await buildRbObservation(
          representative!,
          result,
          cacheHit,
          securityEventWritten,
          seeded.kit.ledger
        );
        const expected = expectedRbObservation(
          representative!,
          decideRoutingRb(representative!.dimensions as never)
        );
        observed.foreignTenantAccess = observed.tenantAccessSet.some(
          (tenant) => tenant !== String(representative!.dimensions.tenantHost)
        );
        const mismatches = checkRbObservation(observed, expected);
        expect(
          mismatches,
          `${mapping.id} real observation must pass: ${mismatches.join(', ')}`
        ).toEqual([]);
        const corrupted = corruptRbObservationDomain(observed, mapping.domain);
        expect(
          checkRbObservation(corrupted, expected).length,
          `${mapping.id} (${mapping.domain}) must be rejected by the common assertion`
        ).toBeGreaterThan(0);
      }
      restoreRealClock();
    }
  });
});

// Keep the import type used.
type Constraint = (row: Row) => boolean;
export type { Constraint };
