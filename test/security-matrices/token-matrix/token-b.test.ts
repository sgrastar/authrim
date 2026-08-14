import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { Env } from '../../../packages/ar-lib-core/src/types/env';
import {
  createSecurityMatrixEnv,
  seedRegionShardConfig,
  type SecurityMatrixEnvKit,
} from '../fixtures/env';
import { CallLedger, LedgerExecutionContext } from '../fixtures/call-ledger';
import { createMatrixTokenApp, requestUrl } from '../fixtures/hono-context';
import { installFrozenNow, restoreRealClock, frozenNowMs } from '../fixtures/deterministic-clock';
import { getFixedSigningKeySet } from '../fixtures/fixed-keys';
import {
  jwtVerify,
  SignJWT,
  generateKeyPair,
  exportJWK,
  importJWK,
  calculateJwkThumbprint,
} from 'jose';
import {
  EXPECTED_TB_CASE_COUNT,
  TB_CASE_TABLE,
  TB_DIMENSION_ORDER,
  decideTokenB,
  tbBindingValid,
  tbDecisionSignature,
  tbMutationCandidates,
  type TokenBCase,
} from './cases';
import {
  emptyObservation,
  checkObservation,
  corruptObservationDomain,
  OBSERVATION_DOMAINS,
  type TokenObservation,
} from './observation';

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const WRONG_VERIFIER = 'wrong-wrong-wrong-wrong-wrong-wrong-wrong-wrong-wrong-wrong-123';
const CODE_PREFIX = 'abcdefghijklmnopqrstuvwxyzABCDEFGH';
const REDIRECT = 'https://client.example/callback';
const RESOURCE = 'svc://matrix-api';
const OTHER_RESOURCE = 'svc://other-api';
const CLIENT_PUBLIC = 'matrix-tb-public';
const TOKEN_URL = 'https://authrim.example/token';
const ISSUER = 'https://authrim.example';
const NONCE = 'n_matrix_0001';
const AUTH_TIME = 1699940;
/** env.REFRESH_TOKEN_EXPIRY in test/security-matrices/fixtures/env.ts. */
const REFRESH_TOKEN_TTL_SECONDS = 2592000;

interface DpopKeySet {
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
}

async function makeDpopKeySet(): Promise<DpopKeySet> {
  const { publicKey, privateKey } = (await generateKeyPair('ES256', {
    extractable: true,
    namedCurve: 'P-256',
  } as never)) as CryptoKeyPair;
  const publicJwk = (await exportJWK(publicKey)) as unknown as Record<string, unknown>;
  return { privateKey, publicJwk };
}

async function buildDpopProof(keySet: DpopKeySet, jti: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ jti, iat: now, htm: 'POST', htu: TOKEN_URL })
    .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: keySet.publicJwk })
    .sign(keySet.privateKey);
}

function seedClientRow(kit: SecurityMatrixEnvKit, clientId: string): void {
  kit.coreAdapter.addBehavior({
    match: (sql, params) =>
      sql.includes('FROM oauth_clients') &&
      sql.includes('client_id') &&
      params[params.length - 1] === clientId,
    result: () => [
      {
        client_id: clientId,
        client_secret_hash: undefined,
        client_name: `Matrix ${clientId}`,
        redirect_uris: REDIRECT,
        grant_types: 'authorization_code refresh_token',
        response_types: 'code',
        scope: 'openid',
        token_endpoint_auth_method: 'none',
        default_resource: RESOURCE,
        require_pkce: 0,
        tenant_id: 'default',
        created_at: 1700000000,
        updated_at: 1700000000,
      },
    ],
  });
}

interface StoredCodeInput {
  code: string;
  clientId: string;
  codeChallenge?: string;
  dpopJkt?: string;
  nonce?: string;
  authTime?: number;
}

async function storeCode(kit: SecurityMatrixEnvKit, input: StoredCodeInput): Promise<void> {
  const storeId = kit.authCodeNamespace.idFromName('tenant:default:auth-code');
  const stub = kit.authCodeNamespace.get(storeId) as unknown as {
    storeCodeRpc(
      request: Record<string, unknown>
    ): Promise<{ success: boolean; expiresAt: number }>;
    consumeCodeRpc(request: Record<string, unknown>): Promise<unknown>;
    registerIssuedTokensRpc(code: string, accessJti: string, refreshJti?: string): Promise<boolean>;
  };
  await stub.storeCodeRpc({
    code: input.code,
    tenantId: 'default',
    clientId: input.clientId,
    redirectUri: REDIRECT,
    userId: 'user-001',
    scope: 'openid',
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallenge ? 'S256' : undefined,
    nonce: input.nonce,
    authTime: input.authTime,
    dpopJkt: input.dpopJkt,
    resource: RESOURCE,
  });
}

async function makeChallenge(verifier: string): Promise<string> {
  const { generateCodeChallenge } = await import('../../../packages/ar-lib-core/src/utils/crypto');
  return generateCodeChallenge(verifier);
}

async function consumeCode(
  kit: SecurityMatrixEnvKit,
  code: string,
  clientId: string,
  verifier: string | undefined,
  dpopJkt: string | undefined,
  dpopProof: string | undefined
): Promise<unknown> {
  const storeId = kit.authCodeNamespace.idFromName('tenant:default:auth-code');
  const stub = kit.authCodeNamespace.get(storeId) as unknown as {
    consumeCodeRpc(request: Record<string, unknown>): Promise<unknown>;
  };
  return stub.consumeCodeRpc({
    code,
    tenantId: 'default',
    clientId,
    ...(verifier !== undefined ? { codeVerifier: verifier } : {}),
    expectedAuthorizationServer: 'default',
    expectedSubjectType: 'end_user',
    expectedResource: RESOURCE,
    expectedRedirectUri: REDIRECT,
    enforceDpopBinding: true,
    expectedDpopJkt: dpopJkt,
    ...(dpopProof !== undefined ? { dpopProof } : {}),
  });
}

async function registerJtis(
  kit: SecurityMatrixEnvKit,
  code: string,
  accessJti: string,
  refreshJti?: string
): Promise<void> {
  const storeId = kit.authCodeNamespace.idFromName('tenant:default:auth-code');
  const stub = kit.authCodeNamespace.get(storeId) as unknown as {
    registerIssuedTokensRpc(code: string, accessJti: string, refreshJti?: string): Promise<boolean>;
  };
  await stub.registerIssuedTokensRpc(code, accessJti, refreshJti);
}

/**
 * Seed an authorization code whose replay-detection flag raced ahead of token
 * registration, DIRECTLY into durable storage without instantiating the real DO. The
 * consume/register then hydrates the DO from storage and observes the flag
 * (storeCodeRpc would leave it invisible to the already-materialized in-memory map).
 */
async function seedRegistrationRaceCodeDirect(
  kit: SecurityMatrixEnvKit,
  code: string,
  clientId: string,
  codeChallenge: string | undefined,
  dpopJkt: string | undefined
): Promise<void> {
  const storage = kit.authCodeNamespace.getStorage('tenant:default:auth-code');
  await storage.put(`code:${code}`, {
    code,
    tenantId: 'default',
    clientId,
    redirectUri: REDIRECT,
    userId: 'user-001',
    scope: 'openid',
    codeChallenge,
    codeChallengeMethod: codeChallenge ? 'S256' : undefined,
    nonce: NONCE,
    authTime: AUTH_TIME,
    dpopJkt,
    resource: RESOURCE,
    authorizationServer: 'default',
    subjectType: 'end_user',
    used: false,
    replayDetectedBeforeTokenRegistration: true,
    expiresAt: 1700000000 + 60000,
    createdAt: 1700000000,
  });
}

async function codeRecord(
  kit: SecurityMatrixEnvKit,
  code: string
): Promise<
  | {
      used?: boolean;
      issuedAccessTokenJti?: string;
      issuedRefreshTokenJti?: string;
    }
  | undefined
> {
  return kit.authCodeNamespace.getStorage('tenant:default:auth-code').get<{
    used?: boolean;
    issuedAccessTokenJti?: string;
    issuedRefreshTokenJti?: string;
  }>(`code:${code}`);
}

interface RunResult {
  status: number;
  body: Record<string, unknown>;
  bodyText: string;
  response: Response;
  ledger: CallLedger;
  proofJkt: string | null;
}

async function tokenPost(
  app: Hono<{ Bindings: Env }>,
  kit: SecurityMatrixEnvKit,
  body: Record<string, string>,
  headers: Record<string, string> = {}
): Promise<RunResult> {
  // The production handler drives its Durable Objects through the kit env bindings, so
  // side effects land in the kit ledger; reset it after seeding so this request's
  // entries are isolated.
  kit.ledger.reset();
  const request = new Request(requestUrl('/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body).toString(),
  });
  const response = await app.fetch(request, kit.env, new LedgerExecutionContext(kit.ledger));
  await kit.ledger.drain();
  const bodyText = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return {
    status: response.status,
    body: parsed,
    bodyText,
    response,
    ledger: kit.ledger,
    proofJkt: null,
  };
}

/** Verify a response token and expose only comparable facts (never the values). */
async function verifyTokenMaterial(
  token: string
): Promise<{ payload: Record<string, unknown>; kid: string | undefined }> {
  const publicKey = (await importJWK(moduleFixedPublicJwkOrThrow(), 'RS256')) as CryptoKey;
  const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
    algorithms: ['RS256'],
    currentDate: new Date(frozenNowMs()),
  });
  return {
    payload: payload as Record<string, unknown>,
    kid: typeof protectedHeader.kid === 'string' ? protectedHeader.kid : undefined,
  };
}

/** RFC 7519 left-half SHA-256 hash of the access token (OIDC Core §3.1.3.6). */
async function computeAtHash(accessToken: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken))
  );
  let binary = '';
  for (const byte of digest.slice(0, 16)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function extractTenantFromTarget(target: string): string | null {
  const match = /:tenant:([^:]+):/.exec(target);
  return match ? match[1] : null;
}

/** Normalize the REAL production observation for this row. */
async function buildObservation(
  kit: SecurityMatrixEnvKit,
  run: RunResult,
  code: string,
  proofJkt: string | null
): Promise<TokenObservation> {
  const obs = emptyObservation();
  obs.status = run.status;
  obs.error = typeof run.body.error === 'string' ? run.body.error : null;
  obs.cacheControl = run.response.headers.get('Cache-Control');
  obs.pragma = run.response.headers.get('Pragma');
  obs.codeConsumed = run.ledger.has(
    'do.rpc',
    (t) => t.includes('auth_code') && t.includes('consumeCodeRpc')
  );
  const record = await codeRecord(kit, code);
  obs.codeUsed = record?.used;
  obs.registrationCount = run.ledger
    .all()
    .filter((e) => e.target.includes('registerIssuedTokensRpc')).length;
  const families = run.ledger.all().filter((e) => e.target.includes('createFamilyRpc'));
  obs.familyCount = families.length;
  obs.familyTenant = families.length > 0 ? extractTenantFromTarget(families[0].target) : null;
  obs.revocationCount = kit.revocationJtis.length;
  obs.foreignTenantAccess = false;
  // Secret-leak: authorization code, verifier, proof, and issued tokens must not appear
  // on non-delivery surfaces (ledger targets/details). The client id is a public
  // identifier and legitimately appears in rotator instance names (e.g.
  // `refresh-rotator:{clientId}:v1:shard-0`) and KV keys.
  const secrets = [code];
  if (typeof run.body.access_token === 'string') secrets.push(run.body.access_token);
  if (typeof run.body.refresh_token === 'string') secrets.push(run.body.refresh_token);
  if (typeof run.body.id_token === 'string') secrets.push(run.body.id_token);
  for (const item of run.ledger.all()) {
    let text: string;
    try {
      text = `${item.target}\n${JSON.stringify(item.detail) ?? ''}`;
    } catch {
      text = `${item.target}\n${String(item.detail)}`;
    }
    for (const secret of secrets) {
      if (!secret) continue;
      if (item.kind === 'do.fetch' && secret === code && item.target.includes(`code:${code}`))
        continue;
      if (text.includes(secret)) obs.secretLeak = true;
    }
  }
  // Token claim oracles: only when tokens were actually delivered in the response.
  if (typeof run.body.access_token === 'string') {
    const access = await verifyTokenMaterial(run.body.access_token);
    obs.kidMatchesFixedKey = access.kid === moduleFixedKeyKid();
    obs.scopePresent = access.payload.scope === 'openid';
    if (typeof run.body.id_token === 'string') {
      const id = await verifyTokenMaterial(run.body.id_token);
      const atHash = typeof id.payload.at_hash === 'string' ? id.payload.at_hash : null;
      obs.atHashMatchesAccessToken =
        atHash !== null && atHash === (await computeAtHash(run.body.access_token));
      obs.authTimePresent = typeof id.payload.auth_time === 'number';
      obs.noncePresent = id.payload.nonce === NONCE;
    }
    if (typeof run.body.refresh_token === 'string') {
      const refresh = await verifyTokenMaterial(run.body.refresh_token);
      obs.refreshTokenTtlMatchesConfig =
        (refresh.payload.exp as number) - (refresh.payload.iat as number) ===
        REFRESH_TOKEN_TTL_SECONDS;
    }
    obs.accessJtiRegistered = record?.issuedAccessTokenJti === access.payload.jti;
    if (typeof run.body.refresh_token === 'string') {
      const refresh = await verifyTokenMaterial(run.body.refresh_token);
      obs.refreshJtiRegistered = record?.issuedRefreshTokenJti === refresh.payload.jti;
    }
    const cnf = access.payload.cnf as { jkt?: unknown } | undefined;
    obs.cnfJktMatchesProof = proofJkt !== null && cnf?.jkt === proofJkt;
  }
  return obs;
}

/** Expected observation derived from the independent decision table and the row. */
function expectedObservation(
  entry: TokenBCase,
  decision: ReturnType<typeof decideTokenB>,
  proofJkt: string | null
): TokenObservation {
  const obs = emptyObservation();
  const d = entry.dimensions;
  const kind = decision.outcome.kind;
  obs.status =
    kind === 'success'
      ? 200
      : kind === 'invalid_client'
        ? 401
        : kind === 'server_error'
          ? 500
          : 400;
  obs.error = kind === 'success' ? null : kind;
  // oauthError (token.ts:607-618) sets no-store/no-cache on every OAuth error; the
  // refresh-family failure (token.ts:2932-2938) and a throwing rotator return a plain
  // c.json server_error with no cache headers. The token response carries no-store.
  const plainServerError = kind === 'server_error' && String(d.downstream) === 'family';
  obs.cacheControl = plainServerError ? null : 'no-store';
  obs.pragma = plainServerError ? null : 'no-cache';
  obs.codeConsumed = decision.codeConsumed;
  // Durable used flag after the request: a used-code seed stays used no matter how this
  // request rejects; a successful consume or a seed-consumed replay leaves used=true; a
  // binding failure inside consumeCodeRpc (PKCE/redirect/DPoP) never transitions the
  // code; requests rejected before the consume leave it untouched.
  if (String(d.replayState) === 'used') {
    obs.codeUsed = true;
  } else if (decision.codeConsumed) {
    // A binding validation failure inside consumeCodeRpc (PKCE/redirect/DPoP) never
    // transitions the code; every other reached consume succeeds and marks it used
    // (including the raced-registration rows, which consume before the rejection).
    const bindingFailure =
      kind === 'invalid_grant' && !decision.replayReached && !tbBindingValid(entry.dimensions);
    obs.codeUsed = bindingFailure ? false : true;
  } else {
    obs.codeUsed = false;
  }
  obs.registrationCount = decision.registrationCount;
  obs.familyCount = decision.familyCreated ? 1 : 0;
  obs.familyTenant = decision.familyCreated ? 'default' : null;
  obs.revocationCount = decision.revocationCount;
  obs.foreignTenantAccess = false;
  obs.secretLeak = false;
  // Token claim oracles: only a 200 token response exposes tokens.
  if (kind === 'success') {
    obs.kidMatchesFixedKey = true;
    obs.atHashMatchesAccessToken = true;
    obs.refreshTokenTtlMatchesConfig = true;
    obs.accessJtiRegistered = true;
    obs.refreshJtiRegistered = true;
    obs.cnfJktMatchesProof = decision.cnfBound && proofJkt !== null;
    obs.scopePresent = true;
    obs.authTimePresent = true;
    obs.noncePresent = true;
  }
  return obs;
}

function assertObservation(observation: TokenObservation, expected: TokenObservation): void {
  const mismatches = checkObservation(observation, expected);
  expect(mismatches, `observation mismatches: ${mismatches.join(', ')}`).toEqual([]);
}

describe('token-matrix T-B: grant binding × issuance/postcondition', () => {
  let kit: SecurityMatrixEnvKit;
  let fixedKeys: { privatePem: string; kid: string; publicJwk: Record<string, unknown> };
  let app: Hono<{ Bindings: Env }>;
  let originalKeyManagerGetActiveKey: unknown;
  let originalKeyManagerGetOidc: unknown;
  let originalTokenRevocationStore: unknown;
  let originalDpopJtiStore: unknown;

  beforeEach(async () => {
    installFrozenNow(1700000000);
    const ledger = new CallLedger();
    kit = await createSecurityMatrixEnv(ledger);
    seedRegionShardConfig(kit);
    const keys = await getFixedSigningKeySet();
    fixedKeys = { privatePem: keys.privatePem, kid: keys.kid, publicJwk: keys.publicJwk };
    moduleFixedPublicJwk = keys.publicJwk;
    moduleFixedKeyId = keys.kid;
    app = createMatrixTokenApp(kit);
    seedClientRow(kit, CLIENT_PUBLIC);
    originalKeyManagerGetActiveKey = kit.keyManagerStub['getActiveKeyWithPrivateRpc'];
    originalKeyManagerGetOidc = kit.keyManagerStub['getActiveOIDCSigningKeyWithPrivateRpc'];
    originalTokenRevocationStore = (kit.env as unknown as Record<string, unknown>)
      .TOKEN_REVOCATION_STORE;
    originalDpopJtiStore = (kit.env as unknown as Record<string, unknown>).DPOP_JTI_STORE;
  });

  afterEach(() => {
    restoreRealClock();
  });

  async function runRow(
    entry: TokenBCase
  ): Promise<{ run: RunResult; code: string; proofJkt: string | null }> {
    // Each row observes its own request: revocations recorded by earlier rows must not
    // leak into this row's observation, every row starts from the canonical frozen clock
    // (a signing/family row advances it below to age out caches, so later rows in the
    // same describe must be re-pinned), and failure injections left by an earlier row are
    // undone before this row applies its own.
    kit.revocationJtis.length = 0;
    installFrozenNow(1700000000);
    kit.authrimConfig.resetGetFailures();
    kit.keyManagerStub['getActiveKeyWithPrivateRpc'] = originalKeyManagerGetActiveKey;
    kit.keyManagerStub['getActiveOIDCSigningKeyWithPrivateRpc'] = originalKeyManagerGetOidc;
    (kit.env as unknown as Record<string, unknown>).TOKEN_REVOCATION_STORE =
      originalTokenRevocationStore;
    (kit.env as unknown as Record<string, unknown>).DPOP_JTI_STORE = originalDpopJtiStore;
    const d = entry.dimensions;
    const code = `${CODE_PREFIX}${entry.id.replace('token-b-', '').padStart(3, '0')}`;
    const challenge = await makeChallenge(VERIFIER);
    const codeBinding = String(d.codeBinding);
    const pkce = String(d.pkce);
    const dpop = String(d.dpop);
    const downstream = String(d.downstream);
    const replayState = String(d.replayState);
    const jtiState = String(d.jtiState);

    // The signing-failure injection must also age out the module-level signing-key
    // cache (KEY_CACHE_TTL is 30 min); the family-failure injection must age out the
    // refresh shard-config cache (10 s). Re-pin the frozen clock before seeding so the
    // code and any DPoP proof stay consistent with the same clock.
    if (downstream === 'signing') {
      installFrozenNow(1700000000 + 1800_000 + 1);
    } else if (downstream === 'family') {
      installFrozenNow(1700000000 + 10_000 + 1);
    }

    const challengeForCode = codeBinding.includes('pkce') ? challenge : undefined;
    let dpopJktForCode: string | undefined;
    const dpopKeySet = await makeDpopKeySet();
    const secondDpopKeySet = await makeDpopKeySet();
    const dpopProof = await buildDpopProof(dpopKeySet, `${code}-proof`);
    const differentKeyProof = await buildDpopProof(secondDpopKeySet, `${code}-proof2`);
    if (codeBinding.includes('dpop')) {
      dpopJktForCode = await calculateJwkThumbprint(dpopKeySet.publicJwk as never, 'sha256');
    }

    if (downstream === 'registration') {
      await seedRegistrationRaceCodeDirect(
        kit,
        code,
        CLIENT_PUBLIC,
        challengeForCode,
        dpopJktForCode
      );
    } else {
      await storeCode(kit, {
        code,
        clientId: CLIENT_PUBLIC,
        codeChallenge: challengeForCode,
        dpopJkt: dpopJktForCode,
        nonce: NONCE,
        authTime: AUTH_TIME,
      });
    }

    if (replayState === 'used') {
      await consumeCode(
        kit,
        code,
        CLIENT_PUBLIC,
        challengeForCode ? VERIFIER : undefined,
        dpopJktForCode,
        dpopJktForCode ? dpopProof : undefined
      );
      if (jtiState === 'access') await registerJtis(kit, code, `at-${code}`);
      if (jtiState === 'access+refresh') await registerJtis(kit, code, `at-${code}`, `rt-${code}`);
    }

    // Downstream failure injection, scoped to this request.
    if (downstream === 'signing') {
      // The frozen clock was already advanced above; make the KeyManager stub fail so
      // the forced cache refresh rejects, and pin a mismatched KV key version.
      (kit.keyManagerStub as Record<string, unknown>)['getActiveKeyWithPrivateRpc'] = async () => {
        throw new Error('matrix-test signing failure');
      };
      kit.authrimConfig.seed('v1:key-version:default', 'rotated');
    }
    if (downstream === 'family') {
      // Fail the refresh-token shard-config KV read: createRefreshTokenFamily cannot
      // resolve the rotator instance and the whole issuance fails (server_error).
      kit.authrimConfig.setGetFailure('refresh-token-shards:matrix-tb-public');
    }
    if (downstream === 'revocation') {
      (kit.env as unknown as Record<string, unknown>).TOKEN_REVOCATION_STORE = failingNamespace(
        (_) => 500
      );
    }
    if (dpop === 'replayed') {
      (kit.env as unknown as Record<string, unknown>).DPOP_JTI_STORE = failingNamespace((url) =>
        url.includes('/check-and-store') ? 400 : 200
      );
    }

    const body: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_PUBLIC,
    };
    const headers: Record<string, string> = {};

    const redirect = String(d.redirect);
    if (redirect === 'exact') body.redirect_uri = REDIRECT;
    else if (redirect === 'mismatched') body.redirect_uri = 'https://other.example/cb';
    else if (redirect === 'malformed') body.redirect_uri = 'not-a-url';

    const resource = String(d.resource);
    if (resource === 'exact') body.resource = RESOURCE;
    else if (resource === 'changed') body.resource = OTHER_RESOURCE;
    else if (resource === 'conflict') {
      body.resource = OTHER_RESOURCE;
      body.audience = RESOURCE;
    } else if (resource === 'disallowed') {
      body.resource = 'svc://disallowed-api';
    }

    const pkceValue =
      pkce === 'valid'
        ? VERIFIER
        : pkce === 'mismatched'
          ? WRONG_VERIFIER
          : pkce === 'malformed'
            ? 'bad'
            : undefined;
    if (pkceValue !== undefined) body.code_verifier = pkceValue;

    if (dpop === 'valid') headers.DPoP = dpopProof;
    else if (dpop === 'different-key') headers.DPoP = differentKeyProof;
    else if (dpop === 'malformed') headers.DPoP = 'not-a-dpop-proof';
    else if (dpop === 'replayed') headers.DPoP = dpopProof;

    const run = await tokenPost(app, kit, body, headers);
    let proofJkt: string | null = null;
    if (dpop === 'valid') {
      proofJkt = await calculateJwkThumbprint(dpopKeySet.publicJwk as never, 'sha256');
    }
    return { run, code, proofJkt };
  }

  for (const entry of TB_CASE_TABLE) {
    it(`${entry.id} ${entry.title}`, async () => {
      expect.hasAssertions();
      const decision = decideTokenB(entry.dimensions);
      const { run, code, proofJkt } = await runRow(entry);
      const observation = await buildObservation(kit, run, code, proofJkt);
      assertObservation(observation, expectedObservation(entry, decision, proofJkt));
    });
  }

  it('oracle sensitivity: corrupted real T-B observations are rejected per domain', async () => {
    expect.hasAssertions();
    // Representative rows covering every outcome family.
    const representatives = TB_CASE_TABLE.filter((entry) => {
      const kind = decideTokenB(entry.dimensions).outcome.kind;
      if (kind === 'success') return true;
      if (kind === 'server_error') return String(entry.dimensions.downstream) === 'signing';
      if (kind === 'invalid_grant') {
        const state = String(entry.dimensions.codeBinding);
        return state === 'pkce' || String(entry.dimensions.downstream) === 'registration';
      }
      return false;
    });
    expect(representatives.length).toBeGreaterThanOrEqual(6);
    for (const entry of representatives.slice(0, 10)) {
      const decision = decideTokenB(entry.dimensions);
      const { run, code, proofJkt } = await runRow(entry);
      const observed = await buildObservation(kit, run, code, proofJkt);
      const expected = expectedObservation(entry, decision, proofJkt);
      const mismatches = checkObservation(observed, expected);
      expect(
        mismatches,
        `real observation of ${entry.id} mismatches: ${mismatches.join(', ')}`
      ).toEqual([]);
      // Every domain corruption is rejected by the same comparator.
      for (const domain of OBSERVATION_DOMAINS) {
        const corrupted = corruptObservationDomain(expected, domain);
        expect(
          checkObservation(corrupted, expected).length,
          `domain ${domain} on ${entry.id}`
        ).toBeGreaterThan(0);
      }
    }
  });

  it('every T-B case carries a discriminating mutation witness', () => {
    expect.hasAssertions();
    for (const entry of TB_CASE_TABLE) {
      const base = decideTokenB(entry.dimensions);
      const baseSignature = tbDecisionSignature(base);
      expect(entry.mutationIds.length).toBeGreaterThan(0);
      for (const mutationId of entry.mutationIds) {
        const candidate = tbMutationCandidates(entry.dimensions).find((c) => c.id === mutationId);
        expect(candidate, `${entry.id} mutation ${mutationId}`).toBeDefined();
        const mutant = candidate!.mutantRow
          ? decideTokenB(candidate!.mutantRow)
          : candidate!.custom!(base);
        expect(tbDecisionSignature(mutant), `${entry.id} mutation ${mutationId}`).not.toBe(
          baseSignature
        );
      }
    }
  });

  it('createFamilyRpc throwing fails issuance without any partial postcondition', async () => {
    expect.hasAssertions();
    // A fresh code with valid bindings: the rotator RPC itself throws, so issuance
    // fails with server_error and nothing is published downstream (no token response,
    // no registration, no family, no revocation, no secret leak).
    const code = `${CODE_PREFIX}throw`;
    await storeCode(kit, { code, clientId: CLIENT_PUBLIC });
    (kit.env as unknown as Record<string, unknown>).REFRESH_TOKEN_ROTATOR =
      throwingRotatorNamespace();
    const run = await tokenPost(app, kit, {
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_PUBLIC,
      redirect_uri: REDIRECT,
    });
    const observation = await buildObservation(kit, run, code, null);
    const expected = emptyObservation();
    expected.status = 500;
    expected.error = 'server_error';
    expected.cacheControl = null;
    expected.pragma = null;
    expected.codeConsumed = true;
    expected.codeUsed = true;
    expected.registrationCount = 0;
    expected.familyCount = 0;
    expected.familyTenant = null;
    expected.revocationCount = 0;
    expected.foreignTenantAccess = false;
    expected.secretLeak = false;
    assertObservation(observation, expected);
  });
});

function failingNamespace(handler: (url: string) => number): unknown {
  const makeId = (name: string) => ({
    toString: () => name,
    equals: (o: { toString(): string }) => o.toString() === name,
    name,
  });
  return {
    idFromName: makeId,
    idFromString: (id: string) => makeId(id),
    newUniqueId: () => makeId(`uniq-${crypto.randomUUID()}`),
    get: () => ({
      fetch: async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        const status = handler(url);
        if (status === 400) {
          return new Response(
            JSON.stringify({ error: 'use_dpop_nonce', error_description: 'jti already used' }),
            { status: 400 }
          );
        }
        return new Response(JSON.stringify({ error: 'server_error' }), { status });
      },
    }),
  };
}

/** Rotator namespace whose createFamilyRpc RPC always throws. */
function throwingRotatorNamespace(): unknown {
  const makeId = (name: string) => ({
    toString: () => name,
    equals: (o: { toString(): string }) => o.toString() === name,
    name,
  });
  return {
    idFromName: makeId,
    idFromString: (id: string) => makeId(id),
    newUniqueId: () => makeId(`uniq-${crypto.randomUUID()}`),
    get: () => ({
      fetch: async () => new Response(JSON.stringify({ error: 'server_error' }), { status: 500 }),
      createFamilyRpc: async () => {
        throw new Error('matrix-test rotator failure');
      },
    }),
  };
}

let moduleFixedPublicJwk: Record<string, unknown> | null = null;
let moduleFixedKeyId: string | null = null;
function moduleFixedPublicJwkOrThrow(): Record<string, unknown> {
  if (!moduleFixedPublicJwk) {
    throw new Error('fixed public key not initialized');
  }
  return moduleFixedPublicJwk;
}
function moduleFixedKeyKid(): string {
  if (!moduleFixedKeyId) {
    throw new Error('fixed key id not initialized');
  }
  return moduleFixedKeyId;
}

export { EXPECTED_TB_CASE_COUNT, TB_DIMENSION_ORDER };
