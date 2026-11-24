/**
 * Access to `env.VC_RUNTIME_PORTS` (design `20261123-authrim-haip-aws-portability.md`, step P2).
 *
 * The rule is the one `runtimeReplayGuard` follows for the replay guard: on Cloudflare no port set
 * exists and the caller uses its Durable Object, KV or service binding (accessors return
 * `undefined`); on a runtime that has any port set, a port the running route needs but that is
 * missing stops the service, never a silent fallback. Each service checks only the ports of the
 * routes it enables (`VC_ROUTE_PORTS`), so a deployment can keep key custody away from services
 * that do not sign.
 */
import type { Env } from '../types/env';
import type { VcPortName, VcRuntimePorts } from '../types/vc-runtime-ports';

/**
 * A binding that must be usable (not merely present) once HAIP is served: `eligibility` is the
 * administrator eligibility service (it must offer `checkAdminCredentialEligibility`);
 * `writable-database` is a database a probe has shown to accept a write (an AWS snapshot adapter
 * refuses every write and is present all the same).
 */
interface ProductionBinding {
  readonly name: string;
  readonly kind: 'eligibility' | 'writable-database';
}

interface RouteRequirement {
  /** Ports of `VC_RUNTIME_PORTS` the route needs. */
  readonly vc: readonly VcPortName[];
  /** The route records proofs or assertions: `AUTH_RUNTIME_PORTS.replayGuard` is needed. */
  readonly replayGuard: boolean;
  /** Bindings of this worker a route needs once HAIP is served (see `assertVcProductionBindings`). */
  readonly productionBindings?: readonly ProductionBinding[];
  /** Not available on a runtime with ports in the first AWS release. */
  readonly unsupported?: true;
}

/**
 * The routes that depend on a port and what each needs (design sections 4a.7, 4c.7, 4d.8, 4g.1,
 * 4h.4, 4k.3, 4t.1, 4z, 4aa). Rows are routes or route x authentication method, not services.
 * `unsupported` rows exist so that enabling such a route on a runtime with ports is detected,
 * however complete the ports are.
 */
export const VC_ROUTE_PORTS = {
  /** `/vci/credential`, HAIP path. The chain is fixed at provisioning: no leaf issuance here. */
  'ar-vc.credential-haip': {
    vc: [
      'keyCustody',
      'proofNonces',
      'opKeys',
      'tokenRevocation',
      'walletAllowlist',
      'productionGate',
    ],
    replayGuard: true,
    productionBindings: [{ name: 'ADMIN_CREDENTIAL_ELIGIBILITY', kind: 'eligibility' }],
  },
  /** `/vci/nonce`: creates the holder-proof nonce. */
  'ar-vc.nonce': { vc: ['proofNonces'], replayGuard: false },
  /** Token Status List signing (a HAIP tenant's lists are signed with the chain required). */
  'ar-vc.status-list': { vc: ['keyCustody', 'walletAllowlist'], replayGuard: false },
  /** `/.well-known/jwt-vc-issuer`: the public keys. */
  'ar-vc.jwks': { vc: ['keyCustody'], replayGuard: false },
  /** Provisioning of a tenant's key set and certificate chain (an operator action). */
  'ar-vc.provisioning': { vc: ['keyCustody', 'leafIssuer'], replayGuard: false },
  /** `POST /api/admin/auth/wallet-login/start` (through the gateway): builds and signs the request. */
  'ar-vc.haip-login-start': {
    vc: ['keyCustody', 'haipLoginState', 'productionGate'],
    replayGuard: false,
  },
  /** `GET /vp/login/request/:id`: serves the signed request object that is already stored. */
  'ar-vc.haip-login-request': { vc: ['haipLoginState'], replayGuard: false },
  /** `POST /vp/login/response`: verifies the wallet's answer (needs the issuer's public keys). */
  'ar-vc.haip-login-response': {
    vc: ['keyCustody', 'haipLoginState', 'productionGate'],
    replayGuard: false,
  },
  /** Status and consume (directly callable RPCs): they hand a result to a session. */
  'ar-vc.haip-login-result': { vc: ['haipLoginState', 'productionGate'], replayGuard: false },
  /** Credential issuer metadata: advertises the HAIP path only while the gate is on. */
  'ar-vc.metadata': { vc: ['walletAllowlist', 'productionGate'], replayGuard: false },
  /** `/api/admin/auth/wallet-login/*`; it needs a writable admin database to open a session. */
  'ar-auth.wallet-login': {
    vc: ['verifierGateway', 'productionGate'],
    replayGuard: false,
    productionBindings: [{ name: 'DB_ADMIN', kind: 'writable-database' }],
  },
  /** Wallet client lookup at the consent screen. */
  'ar-auth.consent-wallet-client': { vc: ['walletAllowlist'], replayGuard: false },
  /** PAR with wallet attestation: there is no PAR on the first AWS release. */
  'ar-auth.par-wallet': { vc: ['walletAllowlist'], replayGuard: true, unsupported: true },
  /** PAR or `/authorize` that accepts a DPoP proof or a `private_key_jwt`: not on AWS either. */
  'ar-auth.dpop-or-assertion': { vc: [], replayGuard: true, unsupported: true },
  /** `/token` with wallet attestation: no AWS OP in the first release. */
  'ar-token.wallet-auth': { vc: ['walletAllowlist'], replayGuard: true, unsupported: true },
  /** `/token` with a DPoP proof or a `private_key_jwt`. */
  'ar-token.dpop-or-assertion': { vc: [], replayGuard: true, unsupported: true },
  /** Token exchange of a token that may have been revoked. */
  'ar-token.token-exchange': { vc: ['tokenRevocation'], replayGuard: false, unsupported: true },
  /** The OP revoking tokens (code reuse, admin actions): the writer side. */
  'ar-token.revocation-write': {
    vc: ['tokenRevocationWriter'],
    replayGuard: false,
    unsupported: true,
  },
  /** Public revoke with a client secret. */
  'ar-management.revoke': { vc: ['tokenRevocationWriter'], replayGuard: false, unsupported: true },
  /** Public revoke with `private_key_jwt`. */
  'ar-management.revoke-private-key-jwt': {
    vc: ['tokenRevocationWriter'],
    replayGuard: true,
    unsupported: true,
  },
  /** Management `signing-keys` (rotate and revoke): Cloudflare only in the first release. */
  'ar-management.signing-keys': { vc: ['keyCustody'], replayGuard: false, unsupported: true },
  /** Management `GET /api/admin/wallet-attestation-allowlist`. */
  'ar-management.wallet-allowlist-read': { vc: ['walletAllowlist'], replayGuard: false },
  /** Management `PUT`: needs a durable fan-out audit the AWS audit adapter refuses (4k.3). */
  'ar-management.wallet-allowlist-write': {
    vc: ['walletAllowlist', 'walletAllowlistWriter'],
    replayGuard: false,
    unsupported: true,
  },
  /** Management `/api/admin/me/wallet-credentials/haip-offer`: off while the gate is off. */
  'ar-management.haip-offer': {
    vc: ['walletAllowlist', 'productionGate'],
    replayGuard: false,
    productionBindings: [{ name: 'DB_ADMIN', kind: 'writable-database' }],
  },
  /** Management `GET /clients/:client_id/config`: a wallet type is a client that has no stored row. */
  'ar-management.client-config': { vc: ['walletAllowlist'], replayGuard: false },
  /** Management `/introspect` with a client secret (reads revocations). */
  'ar-management.introspect': { vc: ['tokenRevocation'], replayGuard: false },
  /** Management `/introspect` with `private_key_jwt` (replay protection is explicit). */
  'ar-management.introspect-private-key-jwt': { vc: ['tokenRevocation'], replayGuard: true },
  /** UserInfo with a Bearer token (reads revocations through the shared introspection). */
  'ar-userinfo.bearer': { vc: ['tokenRevocation', 'walletAllowlist'], replayGuard: false },
  /** UserInfo with a DPoP-bound token (the proof's `jti` is recorded first). */
  'ar-userinfo.dpop': { vc: ['tokenRevocation', 'walletAllowlist'], replayGuard: true },
  /** Discovery (advertises wallet authentication). */
  'ar-discovery.metadata': { vc: ['walletAllowlist'], replayGuard: false },
} as const satisfies Record<string, RouteRequirement>;

export type VcRouteId = keyof typeof VC_ROUTE_PORTS;

/** The environment a service passes: every port set that marks a runtime other than Cloudflare. */
export type VcPortEnv = Pick<
  Env,
  | 'VC_RUNTIME_PORTS'
  | 'AUTH_RUNTIME_PORTS'
  | 'SAML_RUNTIME_PORTS'
  | 'RUNTIME_DATA_PORTS'
  | 'AUDIT_RUNTIME_PORTS'
  | 'EVENT_RUNTIME_PORTS'
>;

/** Whether this is a runtime with ports (not Cloudflare): any port set at all is present. */
function hasRuntimePorts(env: VcPortEnv): boolean {
  return Boolean(
    env.VC_RUNTIME_PORTS ||
    env.AUTH_RUNTIME_PORTS ||
    env.SAML_RUNTIME_PORTS ||
    env.RUNTIME_DATA_PORTS ||
    env.AUDIT_RUNTIME_PORTS ||
    env.EVENT_RUNTIME_PORTS
  );
}

/** The ports of a non-Cloudflare runtime; undefined on Cloudflare. */
export function vcRuntimePorts(env: Pick<Env, 'VC_RUNTIME_PORTS'>): VcRuntimePorts | undefined {
  return env.VC_RUNTIME_PORTS;
}

/**
 * One port, typed as itself: undefined on Cloudflare (no port set at all). On a runtime that has
 * ports it throws `vc_runtime_ports_unavailable` when there are no VC ports and
 * `vc_runtime_port_unavailable:<name>` when this one is missing.
 */
export function requireVcPort<K extends VcPortName>(
  env: VcPortEnv,
  name: K
): NonNullable<VcRuntimePorts[K]> | undefined {
  if (!hasRuntimePorts(env)) return undefined;
  const ports = env.VC_RUNTIME_PORTS;
  if (!ports) throw new Error('vc_runtime_ports_unavailable');
  const port = ports[name];
  if (!port) throw new Error(`vc_runtime_port_unavailable:${name}`);
  return port;
}

/**
 * Checks that every named port exists, and returns nothing: a list of names that is only known at
 * run time cannot give a caller a type for each of them, so a port is then taken with
 * `requireVcPort`.
 */
export function assertVcPorts(env: VcPortEnv, names: readonly VcPortName[]): void {
  for (const name of names) requireVcPort(env, name);
}

/**
 * Start-up check of one route. On Cloudflare it does nothing. On a runtime with ports it refuses a
 * route that is not available there, requires every port of the route and the replay guard where
 * the route records proofs or assertions.
 */
export function assertVcRoutePorts(env: VcPortEnv, route: VcRouteId): void {
  if (!hasRuntimePorts(env)) return;
  const requirement: RouteRequirement = VC_ROUTE_PORTS[route];
  if (requirement.unsupported) throw new Error(`vc_route_unsupported:${route}`);
  assertVcPorts(env, requirement.vc);
  if (requirement.replayGuard && !env.AUTH_RUNTIME_PORTS?.replayGuard) {
    throw new Error('vc_runtime_port_unavailable:replayGuard');
  }
}

/** Checks a database for writes (the runtime supplies it: it writes in a transaction and rolls back). */
export type WritableDatabaseProbe = (database: unknown) => Promise<boolean>;

/**
 * The bindings a route needs once HAIP is served, checked for being usable. Called where the route
 * is turned on, not at every start: an instance started with the gate off may lack them. An
 * eligibility binding must offer its check; a database must pass `probes.writableDatabase` (none
 * supplied means it is unverified). Throws `vc_production_binding_unavailable:<name>` or
 * `vc_production_binding_unverified:<name>`.
 */
export async function assertVcProductionBindings(
  env: object,
  route: VcRouteId,
  probes: { writableDatabase?: WritableDatabaseProbe } = {}
): Promise<void> {
  const requirement: RouteRequirement = VC_ROUTE_PORTS[route];
  for (const { name, kind } of requirement.productionBindings ?? []) {
    const value = (env as Record<string, unknown>)[name];
    if (!value) throw new Error(`vc_production_binding_unavailable:${name}`);
    if (kind === 'eligibility') {
      const check = (value as { checkAdminCredentialEligibility?: unknown })
        .checkAdminCredentialEligibility;
      if (typeof check !== 'function') {
        throw new Error(`vc_production_binding_unavailable:${name}`);
      }
    } else if (!probes.writableDatabase || !(await probes.writableDatabase(value))) {
      throw new Error(`vc_production_binding_unverified:${name}`);
    }
  }
}
