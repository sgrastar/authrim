import { describe, expect, it } from 'vitest';
import {
  VC_ROUTE_PORTS,
  assertVcPorts,
  assertVcProductionBindings,
  assertVcRoutePorts,
  requireVcPort,
  vcRuntimePorts,
  type VcRouteId,
} from '../vc-runtime-ports';
import type { Env } from '../../types/env';
import type { VcPortName, VcRuntimePorts } from '../../types/vc-runtime-ports';
import { isVcRefusal } from '../../types/vc-runtime-ports';

/** A port is present when it is an object; the tests never call into them. */
const port = {} as never;
const replayGuard = { record: async () => 'recorded', isRecorded: async () => false } as never;

function cloudflare(): Env {
  return {} as unknown as Env;
}
/** A runtime with AUTH ports (and the replay guard unless told otherwise) and optional VC ports. */
function runtime(vc: VcRuntimePorts | undefined, withReplayGuard = true): Env {
  return {
    AUTH_RUNTIME_PORTS: withReplayGuard ? { replayGuard } : {},
    ...(vc ? { VC_RUNTIME_PORTS: vc } : {}),
  } as unknown as Env;
}
/** A runtime that has only VC ports (no AUTH ports at all). */
function vcOnly(vc: VcRuntimePorts): Env {
  return { VC_RUNTIME_PORTS: vc } as unknown as Env;
}
function ports(...names: VcPortName[]): VcRuntimePorts {
  return Object.fromEntries(names.map((name) => [name, port]));
}

/**
 * What each route needs, written out here on purpose: the table in the code is checked against
 * this list, not against itself. `rg` marks the routes that also need the replay guard.
 */
const EXPECTED: Record<VcRouteId, { vc: VcPortName[]; rg: boolean; unsupported?: true }> = {
  'ar-vc.credential-haip': {
    vc: [
      'keyCustody',
      'proofNonces',
      'opKeys',
      'tokenRevocation',
      'walletAllowlist',
      'productionGate',
    ],
    rg: true,
  },
  'ar-vc.nonce': { vc: ['proofNonces'], rg: false },
  'ar-vc.status-list': { vc: ['keyCustody', 'walletAllowlist'], rg: false },
  'ar-vc.jwks': { vc: ['keyCustody'], rg: false },
  'ar-vc.provisioning': { vc: ['keyCustody', 'leafIssuer'], rg: false },
  'ar-vc.haip-login-start': { vc: ['keyCustody', 'haipLoginState', 'productionGate'], rg: false },
  'ar-vc.haip-login-request': { vc: ['haipLoginState'], rg: false },
  'ar-vc.haip-login-response': {
    vc: ['keyCustody', 'haipLoginState', 'productionGate'],
    rg: false,
  },
  'ar-vc.haip-login-result': { vc: ['haipLoginState', 'productionGate'], rg: false },
  'ar-vc.metadata': { vc: ['walletAllowlist', 'productionGate'], rg: false },
  'ar-auth.wallet-login': { vc: ['verifierGateway', 'productionGate'], rg: false },
  'ar-auth.consent-wallet-client': { vc: ['walletAllowlist'], rg: false },
  'ar-auth.par-wallet': { vc: ['walletAllowlist'], rg: true, unsupported: true },
  'ar-auth.dpop-or-assertion': { vc: [], rg: true, unsupported: true },
  'ar-token.wallet-auth': { vc: ['walletAllowlist'], rg: true, unsupported: true },
  'ar-token.dpop-or-assertion': { vc: [], rg: true, unsupported: true },
  'ar-token.token-exchange': { vc: ['tokenRevocation'], rg: false, unsupported: true },
  'ar-token.revocation-write': { vc: ['tokenRevocationWriter'], rg: false, unsupported: true },
  'ar-management.revoke': { vc: ['tokenRevocationWriter'], rg: false, unsupported: true },
  'ar-management.revoke-private-key-jwt': {
    vc: ['tokenRevocationWriter'],
    rg: true,
    unsupported: true,
  },
  'ar-management.signing-keys': { vc: ['keyCustody'], rg: false, unsupported: true },
  'ar-management.wallet-allowlist-read': { vc: ['walletAllowlist'], rg: false },
  'ar-management.wallet-allowlist-write': {
    vc: ['walletAllowlist', 'walletAllowlistWriter'],
    rg: false,
    unsupported: true,
  },
  'ar-management.haip-offer': { vc: ['walletAllowlist', 'productionGate'], rg: false },
  'ar-management.client-config': { vc: ['walletAllowlist'], rg: false },
  'ar-management.introspect': { vc: ['tokenRevocation'], rg: false },
  'ar-management.introspect-private-key-jwt': { vc: ['tokenRevocation'], rg: true },
  'ar-userinfo.bearer': { vc: ['tokenRevocation', 'walletAllowlist'], rg: false },
  'ar-userinfo.dpop': { vc: ['tokenRevocation', 'walletAllowlist'], rg: true },
  'ar-discovery.metadata': { vc: ['walletAllowlist'], rg: false },
};
const ROUTES = Object.keys(EXPECTED) as VcRouteId[];
const ALL_PORTS: VcPortName[] = [
  'keyCustody',
  'leafIssuer',
  'proofNonces',
  'opKeys',
  'walletAllowlist',
  'walletAllowlistWriter',
  'tokenRevocation',
  'tokenRevocationWriter',
  'productionGate',
  'haipLoginState',
  'verifierGateway',
];

describe('the route table', () => {
  it('is exactly the written-out expectation', () => {
    expect(Object.keys(VC_ROUTE_PORTS).sort()).toEqual([...ROUTES].sort());
    for (const route of ROUTES) {
      const actual = VC_ROUTE_PORTS[route] as {
        vc: readonly VcPortName[];
        replayGuard: boolean;
        unsupported?: true;
      };
      expect([...actual.vc].sort(), route).toEqual([...EXPECTED[route].vc].sort());
      expect(actual.replayGuard, route).toBe(EXPECTED[route].rg);
      expect(actual.unsupported, route).toBe(EXPECTED[route].unsupported);
    }
  });

  it('uses every port somewhere, and the first-release pieces are not mixed up', () => {
    const used = new Set(ROUTES.flatMap((route) => EXPECTED[route].vc));
    expect([...used].sort()).toEqual([...ALL_PORTS].sort());
    // Signing routes of normal operation never need leaf issuance; provisioning does.
    expect(EXPECTED['ar-vc.credential-haip'].vc).not.toContain('leafIssuer');
    expect(EXPECTED['ar-vc.status-list'].vc).not.toContain('leafIssuer');
    // Reading revocations never needs the writer.
    expect(EXPECTED['ar-vc.credential-haip'].vc).not.toContain('tokenRevocationWriter');
  });
});

describe('requireVcPort and assertVcPorts', () => {
  it('are undefined / silent on Cloudflare, where the services keep their Durable Objects and bindings', () => {
    expect(vcRuntimePorts(cloudflare())).toBeUndefined();
    expect(requireVcPort(cloudflare(), 'keyCustody')).toBeUndefined();
    expect(() => assertVcPorts(cloudflare(), ['keyCustody', 'proofNonces'])).not.toThrow();
  });

  it('return the named port of a runtime that has it', () => {
    expect(requireVcPort(runtime(ports('keyCustody')), 'keyCustody')).toBe(port);
    expect(() =>
      assertVcPorts(runtime(ports('keyCustody', 'proofNonces')), ['keyCustody', 'proofNonces'])
    ).not.toThrow();
  });

  it('throw, naming the port, when a runtime that has ports lacks one that is needed', () => {
    expect(() => assertVcPorts(runtime(ports('keyCustody')), ['keyCustody', 'leafIssuer'])).toThrow(
      'vc_runtime_port_unavailable:leafIssuer'
    );
    expect(() => requireVcPort(runtime({}), 'verifierGateway')).toThrow(
      'vc_runtime_port_unavailable:verifierGateway'
    );
  });

  it('a runtime with AUTH ports but no VC ports is not Cloudflare: it throws', () => {
    expect(() => requireVcPort(runtime(undefined), 'keyCustody')).toThrow(
      'vc_runtime_ports_unavailable'
    );
  });

  it('every kind of port set marks a runtime that is not Cloudflare', () => {
    for (const key of [
      'AUTH_RUNTIME_PORTS',
      'SAML_RUNTIME_PORTS',
      'RUNTIME_DATA_PORTS',
      'AUDIT_RUNTIME_PORTS',
      'EVENT_RUNTIME_PORTS',
    ]) {
      const env = { [key]: {} } as unknown as Env;
      expect(() => requireVcPort(env, 'keyCustody'), key).toThrow('vc_runtime_ports_unavailable');
      expect(() => assertVcRoutePorts(env, 'ar-vc.credential-haip'), key).toThrow();
    }
  });

  it('a runtime that has only VC ports is a runtime with ports too', () => {
    expect(() => assertVcPorts(vcOnly(ports('keyCustody')), ['leafIssuer'])).toThrow(
      'vc_runtime_port_unavailable:leafIssuer'
    );
    expect(requireVcPort(vcOnly(ports('keyCustody')), 'keyCustody')).toBe(port);
  });
});

describe('assertVcRoutePorts', () => {
  it('does nothing on Cloudflare, for every route (the unsupported one too)', () => {
    for (const route of ROUTES) expect(() => assertVcRoutePorts(cloudflare(), route)).not.toThrow();
  });

  it('accepts a runtime that has exactly the ports of the route and the replay guard where needed', () => {
    for (const route of ROUTES) {
      if (EXPECTED[route].unsupported) continue;
      expect(
        () => assertVcRoutePorts(runtime(ports(...EXPECTED[route].vc)), route),
        route
      ).not.toThrow();
    }
  });

  it('refuses every route that is not available on a runtime with ports, however complete the ports are', () => {
    const unsupported = ROUTES.filter((route) => EXPECTED[route].unsupported);
    expect(unsupported).toContain('ar-management.wallet-allowlist-write');
    expect(unsupported).toContain('ar-auth.par-wallet');
    expect(unsupported).toContain('ar-management.signing-keys');
    for (const route of unsupported) {
      expect(() => assertVcRoutePorts(runtime(ports(...ALL_PORTS)), route), route).toThrow(
        `vc_route_unsupported:${route}`
      );
    }
  });

  it('refuses a route that needs VC ports on a runtime with AUTH ports but no VC ports', () => {
    for (const route of ROUTES) {
      if (EXPECTED[route].vc.length === 0) continue;
      expect(() => assertVcRoutePorts(runtime(undefined), route), route).toThrow();
    }
  });

  it('refuses a route that is missing any single one of its ports', () => {
    for (const route of ROUTES) {
      if (EXPECTED[route].unsupported) continue;
      for (const missing of EXPECTED[route].vc) {
        const present = EXPECTED[route].vc.filter((name) => name !== missing);
        expect(
          () => assertVcRoutePorts(runtime(ports(...present)), route),
          `${route} without ${missing}`
        ).toThrow(`vc_runtime_port_unavailable:${missing}`);
      }
    }
  });

  it('requires the replay guard of the routes that record proofs, also on a runtime with only VC ports', () => {
    for (const route of ROUTES) {
      if (!EXPECTED[route].rg || EXPECTED[route].unsupported) continue;
      expect(
        () => assertVcRoutePorts(runtime(ports(...EXPECTED[route].vc), false), route),
        route
      ).toThrow('vc_runtime_port_unavailable:replayGuard');
      expect(() => assertVcRoutePorts(vcOnly(ports(...EXPECTED[route].vc)), route), route).toThrow(
        'vc_runtime_port_unavailable:replayGuard'
      );
    }
  });

  it('checks only what the route needs: a service that does not sign needs no key custody', () => {
    const gatewayOnly = ports('verifierGateway', 'productionGate');
    expect(() => assertVcRoutePorts(runtime(gatewayOnly), 'ar-auth.wallet-login')).not.toThrow();
    expect(() => assertVcRoutePorts(runtime(gatewayOnly), 'ar-vc.haip-login-start')).toThrow(
      'vc_runtime_port_unavailable:keyCustody'
    );
  });

  it('the entries that start or advertise the HAIP flow all depend on the production gate', () => {
    for (const route of [
      'ar-vc.credential-haip',
      'ar-vc.haip-login-start',
      'ar-vc.haip-login-response',
      'ar-vc.haip-login-result',
      'ar-vc.metadata',
      'ar-auth.wallet-login',
      'ar-management.haip-offer',
    ] as const) {
      const without = EXPECTED[route].vc.filter((name) => name !== 'productionGate');
      expect(() => assertVcRoutePorts(runtime(ports(...without)), route), route).toThrow(
        'vc_runtime_port_unavailable:productionGate'
      );
    }
  });
});

describe('assertVcProductionBindings', () => {
  const eligibility = { checkAdminCredentialEligibility: async () => ({ eligible: true }) };
  const writable = async () => true;
  const readOnly = async () => false;

  it('serving the stored request object needs no key custody and no gate: it only hands out a stored string', () => {
    expect(EXPECTED['ar-vc.haip-login-request'].vc).toEqual(['haipLoginState']);
    expect(() =>
      assertVcRoutePorts(runtime(ports('haipLoginState')), 'ar-vc.haip-login-request')
    ).not.toThrow();
  });

  it('needs a working eligibility service for HAIP issuance, not just an object', async () => {
    await expect(assertVcProductionBindings({}, 'ar-vc.credential-haip')).rejects.toThrow(
      'vc_production_binding_unavailable:ADMIN_CREDENTIAL_ELIGIBILITY'
    );
    await expect(
      assertVcProductionBindings({ ADMIN_CREDENTIAL_ELIGIBILITY: {} }, 'ar-vc.credential-haip')
    ).rejects.toThrow('vc_production_binding_unavailable:ADMIN_CREDENTIAL_ELIGIBILITY');
    await expect(
      assertVcProductionBindings(
        { ADMIN_CREDENTIAL_ELIGIBILITY: eligibility },
        'ar-vc.credential-haip'
      )
    ).resolves.toBeUndefined();
  });

  it('needs an admin database that a probe has shown to accept writes (wallet login and the offer route)', async () => {
    for (const route of ['ar-auth.wallet-login', 'ar-management.haip-offer'] as const) {
      await expect(
        assertVcProductionBindings({}, route, { writableDatabase: writable })
      ).rejects.toThrow('vc_production_binding_unavailable:DB_ADMIN');
      // Present but never probed, or probed and read-only (an AWS snapshot adapter): not usable.
      await expect(assertVcProductionBindings({ DB_ADMIN: {} }, route)).rejects.toThrow(
        'vc_production_binding_unverified:DB_ADMIN'
      );
      await expect(
        assertVcProductionBindings({ DB_ADMIN: {} }, route, { writableDatabase: readOnly })
      ).rejects.toThrow('vc_production_binding_unverified:DB_ADMIN');
      await expect(
        assertVcProductionBindings({ DB_ADMIN: {} }, route, { writableDatabase: writable })
      ).resolves.toBeUndefined();
    }
  });

  it('a route without such bindings asks for nothing', async () => {
    await expect(assertVcProductionBindings({}, 'ar-vc.nonce')).resolves.toBeUndefined();
  });
});

describe('isVcRefusal', () => {
  it('recognizes a returned refusal and nothing else', () => {
    expect(isVcRefusal({ refused: true, code: 'x5c_required' })).toBe(true);
    expect(isVcRefusal({ refused: true })).toBe(false);
    expect(isVcRefusal({ token: 't', kid: 'k' })).toBe(false);
    expect(isVcRefusal(null)).toBe(false);
  });
});
