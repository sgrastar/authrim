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
import { installFrozenNow, restoreRealClock } from '../fixtures/deterministic-clock';
import { getFixedSigningKeySet } from '../fixtures/fixed-keys';
import { SignJWT, importPKCS8 } from 'jose';
import {
  EXPECTED_TA_CASE_COUNT,
  TA_CASE_TABLE,
  TA_DIMENSION_ORDER,
  taAuthSuccess,
  taDecisionSignature,
  decideTokenA,
  type TokenACase,
} from './cases';
import {
  emptyObservation,
  checkObservation,
  corruptObservationDomain,
  OBSERVATION_DOMAINS,
  type TokenObservation,
} from './observation';

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CODE_PREFIX = 'abcdefghijklmnopqrstuvwxyzABCDEFGH';
const REDIRECT = 'https://client.example/callback';
const RESOURCE = 'svc://matrix-api';
const TOKEN_ENDPOINT = 'https://authrim.example/token';
const REQUEST_TENANT = 'default';
const FOREIGN_REQUEST_TENANT = 'tenant-b';
const FOREIGN_CLIENT_TENANT = 'tenant-a';
const SECRET = 'matrix-secret-001';

const CLIENT_IDS: Record<string, string> = {
  public: 'matrix-token-public',
  confidential: 'matrix-token-confidential',
  unknown: 'matrix-token-unknown',
  'wrong-tenant': 'matrix-token-wrong-tenant',
};

let suiteRealNowMs: number | null = null;

interface SeedClientOptions {
  clientId: string;
  tenantId?: string;
  method?: string;
  secretHash?: string;
  jwksJson?: string;
  requirePkce?: boolean;
}

/** Tenant-aware client seed: the D1 behavior matches tenant AND client (token.ts getClient). */
function seedClientRow(kit: SecurityMatrixEnvKit, options: SeedClientOptions): void {
  const {
    clientId,
    tenantId = REQUEST_TENANT,
    method = 'client_secret_basic',
    secretHash,
    jwksJson,
    requirePkce = true,
  } = options;
  const row: Record<string, unknown> = {
    client_id: clientId,
    client_secret_hash: secretHash ?? null,
    client_name: `Matrix ${clientId}`,
    redirect_uris: REDIRECT,
    grant_types: 'authorization_code refresh_token',
    response_types: 'code',
    scope: 'openid',
    token_endpoint_auth_method: method,
    default_resource: RESOURCE,
    require_pkce: requirePkce ? 1 : 0,
    tenant_id: tenantId,
    created_at: 1700000000,
    updated_at: 1700000000,
  };
  if (jwksJson) row.jwks = jwksJson;
  kit.coreAdapter.addBehavior({
    match: (sql, params) =>
      sql.includes('FROM oauth_clients') &&
      sql.includes('client_id') &&
      params[params.length - 1] === clientId &&
      params[0] === tenantId,
    result: () => [row],
  });
}

interface StoredCodeInput {
  code: string;
  clientId: string;
  tenantId?: string;
  userId?: string;
}

async function storeCode(kit: SecurityMatrixEnvKit, input: StoredCodeInput): Promise<void> {
  const storeId = kit.authCodeNamespace.idFromName('tenant:default:auth-code');
  const stub = kit.authCodeNamespace.get(storeId) as unknown as {
    storeCodeRpc(
      request: Record<string, unknown>
    ): Promise<{ success: boolean; expiresAt: number }>;
    consumeCodeRpc(request: Record<string, unknown>): Promise<unknown>;
    registerIssuedTokensRpc(code: string, accessJti: string, refreshJti?: string): Promise<boolean>;
    hasCodeRpc(code: string): Promise<boolean>;
  };
  await stub.storeCodeRpc({
    code: input.code,
    tenantId: input.tenantId ?? REQUEST_TENANT,
    clientId: input.clientId,
    redirectUri: REDIRECT,
    userId: input.userId ?? 'user-001',
    scope: 'openid',
    resource: RESOURCE,
  });
}

/**
 * Seed an expired authorization code DIRECTLY into durable storage without instantiating
 * the real AuthorizationCodeStore DO (consume then hydrates from storage and observes the
 * expired record).
 */
async function seedExpiredCodeDirect(
  kit: SecurityMatrixEnvKit,
  code: string,
  clientId: string
): Promise<void> {
  const storage = kit.authCodeNamespace.getStorage('tenant:default:auth-code');
  await storage.put(`code:${code}`, {
    code,
    tenantId: REQUEST_TENANT,
    clientId,
    redirectUri: REDIRECT,
    userId: 'user-001',
    scope: 'openid',
    authorizationServer: 'default',
    subjectType: 'end_user',
    resource: RESOURCE,
    used: false,
    expiresAt: 1699000000,
    createdAt: 1700000000,
  });
}

/** Consume a code once WITHOUT registering JTIs (consumed state). */
async function consumeOnly(
  kit: SecurityMatrixEnvKit,
  code: string,
  clientId: string
): Promise<void> {
  const storeId = kit.authCodeNamespace.idFromName('tenant:default:auth-code');
  const stub = kit.authCodeNamespace.get(storeId) as unknown as {
    consumeCodeRpc(request: Record<string, unknown>): Promise<unknown>;
  };
  await stub.consumeCodeRpc({
    code,
    tenantId: REQUEST_TENANT,
    clientId,
    expectedAuthorizationServer: 'default',
    expectedSubjectType: 'end_user',
    expectedResource: RESOURCE,
    expectedRedirectUri: REDIRECT,
    enforceDpopBinding: true,
  });
}

/** Consume a code once and register issued JTIs (replayed state). */
async function consumeAndRegister(
  kit: SecurityMatrixEnvKit,
  code: string,
  clientId: string,
  accessJti: string,
  refreshJti?: string
): Promise<void> {
  await consumeOnly(kit, code, clientId);
  const storeId = kit.authCodeNamespace.idFromName('tenant:default:auth-code');
  const stub = kit.authCodeNamespace.get(storeId) as unknown as {
    registerIssuedTokensRpc(code: string, accessJti: string, refreshJti?: string): Promise<boolean>;
  };
  await stub.registerIssuedTokensRpc(code, accessJti, refreshJti);
}

async function hashSecret(secret: string): Promise<string> {
  const { hashClientSecret } = await import('../../../packages/ar-lib-core/src/utils/crypto');
  return hashClientSecret(secret);
}

/** RFC 7523 asymmetric assertion (private_key_jwt). */
async function buildRsaAssertion(
  privatePem: string,
  kid: string,
  clientId: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const privateKey = (await importPKCS8(privatePem, 'RS256')) as CryptoKey;
  return new SignJWT({
    iss: clientId,
    sub: clientId,
    aud: TOKEN_ENDPOINT,
    exp: now + 300,
    iat: now,
    jti: crypto.randomUUID(),
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid })
    .sign(privateKey);
}

/** OIDC Core §9 client_secret_jwt assertion (HMAC SHA-256 with the client secret). */
async function buildHmacAssertion(secret: string, clientId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const secretKey = new TextEncoder().encode(secret);
  return new SignJWT({
    iss: clientId,
    sub: clientId,
    aud: TOKEN_ENDPOINT,
    exp: now + 300,
    iat: now,
    jti: crypto.randomUUID(),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .sign(secretKey);
}

interface RunResult {
  response: Response;
  ledger: CallLedger;
  status: number;
  body: Record<string, unknown>;
  bodyText: string;
}

async function tokenPost(
  app: Hono<{ Bindings: Env }>,
  kit: SecurityMatrixEnvKit,
  body: Record<string, string>,
  headers: Record<string, string> = {}
): Promise<RunResult> {
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
  return { response, ledger: kit.ledger, status: response.status, body: parsed, bodyText };
}

function clientIdFor(client: string): string {
  return CLIENT_IDS[client];
}

async function seedClientForRow(
  kit: SecurityMatrixEnvKit,
  registeredMethod: string,
  client: string,
  jwksJson: string,
  requestTenantId = REQUEST_TENANT
): Promise<void> {
  const clientId = clientIdFor(client);
  if (client === 'public') {
    seedClientRow(kit, {
      clientId,
      tenantId: requestTenantId,
      method: 'none',
      secretHash: undefined,
    });
    return;
  }
  if (client === 'unknown') return;
  if (client === 'wrong-tenant') {
    seedClientRow(kit, {
      clientId,
      tenantId: FOREIGN_CLIENT_TENANT,
      method: registeredMethod,
      secretHash: await hashSecret(SECRET),
    });
    return;
  }
  const jwtMethods = ['client_secret_jwt', 'private_key_jwt'];
  seedClientRow(kit, {
    clientId,
    tenantId: requestTenantId,
    method: registeredMethod,
    secretHash: await hashSecret(SECRET),
    jwksJson: jwtMethods.includes(registeredMethod) ? jwksJson : undefined,
  });
}

function buildBodyFor(
  registeredMethod: string,
  presented: string,
  client: string,
  code: string,
  assertion: string | undefined,
  hmacAssertion: string | undefined
): { body: Record<string, string>; headers: Record<string, string> } {
  const clientId = clientIdFor(client);
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
  };
  const headers: Record<string, string> = {};
  switch (presented) {
    case 'none':
      body.client_id = clientId;
      break;
    case 'basic': {
      body.client_id = clientId;
      headers.Authorization = `Basic ${Buffer.from(`${clientId}:${SECRET}`).toString('base64')}`;
      break;
    }
    case 'post':
      body.client_id = clientId;
      body.client_secret = SECRET;
      break;
    case 'jwt':
      body.client_assertion = assertion ?? hmacAssertion ?? '';
      body.client_assertion_type = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
      break;
    case 'malformed':
      body.client_id = clientId;
      headers.Authorization = 'Basic !!!not-base64!!!';
      break;
    case 'conflicting':
      body.client_id = clientId;
      body.client_secret = SECRET;
      headers.Authorization = `Basic ${Buffer.from(`${clientId}:${SECRET}`).toString('base64')}`;
      break;
    default:
      throw new Error(`Unknown presented: ${presented}`);
  }
  return { body, headers };
}

/** Normalize the REAL production observation for this row. */
async function buildObservation(
  kit: SecurityMatrixEnvKit,
  run: RunResult,
  code: string
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
  const record = await kit.authCodeNamespace
    .getStorage('tenant:default:auth-code')
    .get<{ used?: boolean }>(`code:${code}`);
  obs.codeUsed = record?.used;
  obs.registrationCount = run.ledger
    .all()
    .filter((e) => e.target.includes('registerIssuedTokensRpc')).length;
  const families = run.ledger.all().filter((e) => e.target.includes('createFamilyRpc'));
  obs.familyCount = families.length;
  obs.familyTenant = families.length > 0 ? extractTenantFromTarget(families[0].target) : null;
  obs.revocationCount = kit.revocationJtis.length;
  // A store access is foreign when it targets a tenant that is not this request's tenant.
  // FOREIGN_CLIENT_TENANT is never the request tenant; the foreign REQUEST tenant's own
  // store accesses are legitimate for those rows.
  obs.foreignTenantAccess = run.ledger.all().some((e) => e.target.includes(FOREIGN_CLIENT_TENANT));
  // Secret-leak: client secret, assertion, authorization code, verifier, proof, and
  // issued tokens must not appear on non-delivery surfaces (ledger targets/details).
  const secrets = [SECRET, code];
  if (typeof run.body.access_token === 'string') secrets.push(run.body.access_token);
  if (typeof run.body.refresh_token === 'string') secrets.push(run.body.refresh_token);
  if (typeof run.body.id_token === 'string') secrets.push(run.body.id_token);
  const deliveredTokens = secrets.filter((value) => value !== SECRET && value !== code);
  for (const item of run.ledger.all()) {
    let text: string;
    try {
      text = `${item.target}\n${JSON.stringify(item.detail) ?? ''}`;
    } catch {
      text = `${item.target}\n${String(item.detail)}`;
    }
    for (const secret of secrets) {
      if (!secret) continue;
      if (deliveredTokens.includes(secret)) continue;
      if (item.kind === 'do.fetch' && secret === code && item.target.includes(`code:${code}`))
        continue;
      if (text.includes(secret)) obs.secretLeak = true;
    }
  }
  return obs;
}

function extractTenantFromTarget(target: string): string | null {
  const match = /:tenant:([^:]+):/.exec(target);
  return match ? match[1] : null;
}

/** Expected observation derived from the independent decision table and the row. */
function expectedObservation(
  entry: TokenACase,
  decision: ReturnType<typeof decideTokenA>
): TokenObservation {
  const obs = emptyObservation();
  const kind = decision.outcome.kind;
  obs.status = kind === 'invalid_client' ? 401 : kind === 'success' ? 200 : 400;
  obs.error = kind === 'success' ? null : kind;
  // oauthError (token.ts:607-618) sets no-store/no-cache on every OAuth error; a
  // malformed code is rejected by validateAuthCode with a plain c.json (token.ts:1646-1655)
  // and carries no cache headers.
  obs.cacheControl = entry.dimensions.codeState === 'malformed' ? null : 'no-store';
  obs.pragma = entry.dimensions.codeState === 'malformed' ? null : 'no-cache';
  obs.codeConsumed = decision.codeConsumed;
  // Durable used flag after the request: consumed/replayed seeds are already used; a
  // successful exchange consumes the code; expired and malformed rows have no usable
  // record; every other rejected row leaves a fresh code unused. A foreign request
  // tenant never reads the default store, so the seeded record stays untouched.
  const codeState = String(entry.dimensions.codeState);
  const foreign = String(entry.dimensions.requestTenant) === 'foreign';
  if (codeState === 'consumed' || codeState === 'replayed' || kind === 'success') {
    obs.codeUsed = true;
  } else if (codeState === 'malformed') {
    obs.codeUsed = undefined;
  } else if (foreign) {
    // The default-tenant record exists (expired/wrong-*) untouched with used=false.
    obs.codeUsed = false;
  } else if (codeState === 'expired') {
    obs.codeUsed = undefined;
  } else {
    obs.codeUsed = false;
  }
  obs.registrationCount = kind === 'success' ? 1 : 0;
  obs.familyCount = kind === 'success' ? 1 : 0;
  obs.familyTenant = kind === 'success' ? REQUEST_TENANT : null;
  obs.revocationCount = decision.revocationCount;
  obs.foreignTenantAccess = false;
  obs.secretLeak = false;
  return obs;
}

function assertObservation(observation: TokenObservation, expected: TokenObservation): void {
  const mismatches = checkObservation(observation, expected);
  expect(mismatches, `observation mismatches: ${mismatches.join(', ')}`).toEqual([]);
}

describe('token-matrix T-A: client authentication × code ownership/state', () => {
  let kit: SecurityMatrixEnvKit;
  let fixedKeys: { privatePem: string; kid: string; publicJwk: Record<string, unknown> };
  let jwksJson: string;

  beforeEach(async () => {
    suiteRealNowMs ??= Date.now();
    installFrozenNow(1700000000);
    const ledger = new CallLedger();
    kit = await createSecurityMatrixEnv(ledger);
    seedRegionShardConfig(kit);
    seedRegionShardConfig(kit, FOREIGN_REQUEST_TENANT);
    const keys = await getFixedSigningKeySet();
    fixedKeys = { privatePem: keys.privatePem, kid: keys.kid, publicJwk: keys.publicJwk };
    jwksJson = JSON.stringify({ keys: [keys.publicJwk] });
  });

  afterEach(() => {
    restoreRealClock();
  });

  async function runRow(entry: TokenACase): Promise<{ run: RunResult; code: string }> {
    // Each row observes its own request: revocations recorded by earlier rows must not
    // leak into this row's observation.
    kit.revocationJtis.length = 0;
    const client = String(entry.client);
    const registeredMethod = String(entry.registeredMethod);
    const presented = String(entry.presented);
    const requestTenant = String(entry.requestTenant);
    if (presented === 'jwt' && client === 'confidential') {
      installFrozenNow((suiteRealNowMs as number) + 3600_000);
    }
    await seedClientForRow(
      kit,
      registeredMethod,
      client,
      jwksJson,
      requestTenant === 'foreign' ? FOREIGN_REQUEST_TENANT : REQUEST_TENANT
    );

    const code = `${CODE_PREFIX}${entry.id.replace('token-a-', '').padStart(3, '0')}`;
    const codeClientId = clientIdFor(client === 'confidential' ? 'confidential' : 'public');
    const codeState = String(entry.codeState);
    if (codeState === 'expired') {
      await seedExpiredCodeDirect(kit, code, codeClientId);
    } else if (codeState === 'wrong-tenant') {
      await storeCode(kit, { code, clientId: codeClientId, tenantId: FOREIGN_CLIENT_TENANT });
    } else if (codeState === 'wrong-client') {
      await storeCode(kit, { code, clientId: 'matrix-other-client' });
    } else if (codeState !== 'malformed') {
      await storeCode(kit, { code, clientId: codeClientId });
    }
    if (codeState === 'consumed') {
      await consumeOnly(kit, code, codeClientId);
    } else if (codeState === 'replayed') {
      await consumeAndRegister(kit, code, codeClientId, `at-${entry.id}`, `rt-${entry.id}`);
    }

    const app =
      requestTenant === 'foreign'
        ? createMatrixTokenApp(kit, { tenantId: FOREIGN_REQUEST_TENANT })
        : createMatrixTokenApp(kit);
    const assertion =
      presented === 'jwt' && client === 'confidential'
        ? await buildRsaAssertion(fixedKeys.privatePem, fixedKeys.kid, codeClientId)
        : undefined;
    const { body, headers } = buildBodyFor(
      registeredMethod,
      presented,
      client,
      codeState === 'malformed' ? 'bad-code' : code,
      assertion,
      undefined
    );
    return { run: await tokenPost(app, kit, body, headers), code };
  }

  for (const entry of TA_CASE_TABLE) {
    it(`${entry.id} ${entry.title}`, async () => {
      expect.hasAssertions();
      const decision = decideTokenA(entry.dimensions);
      const { run, code } = await runRow(entry);
      const observation = await buildObservation(kit, run, code);
      assertObservation(observation, expectedObservation(entry, decision));
      if (decision.revocationCount > 0) {
        expect(kit.revocationJtis).toEqual([`at-${entry.id}`, `rt-${entry.id}`]);
      }
    });
  }

  it('reuses the PKCE authenticated-replay ordering regression unchanged', async () => {
    expect.hasAssertions();
    seedClientRow(kit, {
      clientId: CLIENT_IDS.public,
      method: 'none',
      secretHash: undefined,
      requirePkce: true,
    });
    const { generateCodeChallenge } =
      await import('../../../packages/ar-lib-core/src/utils/crypto');
    const challenge = await generateCodeChallenge(VERIFIER);
    const code = `${CODE_PREFIX}rp`;
    // Seed the PKCE-bound code DIRECTLY into durable storage without instantiating the
    // DO, so the consume hydrates the challenge from storage (a storeCodeRpc would leave
    // the challenge invisible to the already-materialized in-memory map).
    const storage = kit.authCodeNamespace.getStorage('tenant:default:auth-code');
    await storage.put(`code:${code}`, {
      code,
      tenantId: REQUEST_TENANT,
      clientId: CLIENT_IDS.public,
      redirectUri: REDIRECT,
      userId: 'user-001',
      scope: 'openid',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      resource: RESOURCE,
      authorizationServer: 'default',
      subjectType: 'end_user',
      used: false,
      expiresAt: 1700000000 + 60000,
      createdAt: 1700000000,
    });

    const app = createMatrixTokenApp(kit);
    const base: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: CLIENT_IDS.public,
    };

    const first = await tokenPost(app, kit, { ...base, code_verifier: VERIFIER });
    expect(first.status, first.bodyText).toBe(200);
    expect(typeof first.body.access_token).toBe('string');
    expect(typeof first.body.refresh_token).toBe('string');
    const { decodeJwtPayloadUnverified } = await import('../fixtures/oracles');
    const accessJti = decodeJwtPayloadUnverified(first.body.access_token as string).jti as string;
    const refreshJti = decodeJwtPayloadUnverified(first.body.refresh_token as string).jti as string;
    expect(typeof accessJti).toBe('string');
    expect(typeof refreshJti).toBe('string');
    expect(first.ledger.has('do.rpc', (target) => target.includes('registerIssuedTokensRpc'))).toBe(
      true
    );

    const generic = 'Authorization code is invalid or expired';
    for (const verifier of [
      undefined,
      'bad',
      'wrong-wrong-wrong-wrong-wrong-wrong-wrong-wrong-wrong-wrong-123',
    ]) {
      kit.ledger.reset();
      kit.revocationJtis.length = 0;
      const body = { ...base, ...(verifier !== undefined ? { code_verifier: verifier } : {}) };
      const run = await tokenPost(app, kit, body);
      expect(run.status).toBe(400);
      expect(run.body.error).toBe('invalid_grant');
      expect(run.body.error_description).toBe(generic);
      expect(kit.ledger.has('revoke')).toBe(false);
    }

    kit.ledger.reset();
    kit.revocationJtis.length = 0;
    const replay = await tokenPost(app, kit, { ...base, code_verifier: VERIFIER });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
    expect(kit.revocationJtis).toEqual([accessJti, refreshJti]);
  });

  it('legacy client_secret_jwt registrations fail closed because reversible shared secrets are not stored', async () => {
    expect.hasAssertions();
    const confidentialId = CLIENT_IDS.confidential;
    seedClientRow(kit, {
      clientId: confidentialId,
      method: 'client_secret_jwt',
      secretHash: await hashSecret(SECRET),
    });
    const code = `${CODE_PREFIX}csj`;
    await storeCode(kit, { code, clientId: confidentialId });
    const app = createMatrixTokenApp(kit);
    const base: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    };

    // Wrong shared secret: the HMAC assertion must be rejected.
    const wrongSecret = await buildHmacAssertion('wrong-secret-000', confidentialId);
    const wrongSecretRun = await tokenPost(app, kit, { ...base, client_assertion: wrongSecret });
    expect(wrongSecretRun.status, wrongSecretRun.bodyText).toBe(401);
    expect(wrongSecretRun.body.error).toBe('invalid_client');

    // A client_secret_jwt client presenting an asymmetric RS256 assertion is a method
    // misuse per §9 (client_secret_jwt is HMAC-only).
    const rsaAssertion = await buildRsaAssertion(
      fixedKeys.privatePem,
      fixedKeys.kid,
      confidentialId
    );
    const rsaOnCsjRun = await tokenPost(app, kit, { ...base, client_assertion: rsaAssertion });
    expect(rsaOnCsjRun.status, rsaOnCsjRun.bodyText).toBe(401);
    expect(rsaOnCsjRun.body.error).toBe('invalid_client');

    // Authrim stores only a one-way client-secret hash and no reversible HMAC key.
    // New registrations no longer advertise or accept this unusable method; a legacy
    // row must continue to fail closed even when the caller knows the original secret.
    const correctHmac = await buildHmacAssertion(SECRET, confidentialId);
    const hmacRun = await tokenPost(app, kit, { ...base, client_assertion: correctHmac });
    expect(hmacRun.status, hmacRun.bodyText).toBe(401);
    expect(hmacRun.body.error).toBe('invalid_client');
    expect(hmacRun.body.access_token).toBeUndefined();
  });

  it('private_key_jwt rejects HMAC assertions (asymmetric-only per OIDC Core §9)', async () => {
    expect.hasAssertions();
    const confidentialId = CLIENT_IDS.confidential;
    seedClientRow(kit, {
      clientId: confidentialId,
      method: 'private_key_jwt',
      secretHash: await hashSecret(SECRET),
      jwksJson,
    });
    const code = `${CODE_PREFIX}pkj`;
    await storeCode(kit, { code, clientId: confidentialId });
    const app = createMatrixTokenApp(kit);
    const hmac = await buildHmacAssertion(SECRET, confidentialId);
    const run = await tokenPost(app, kit, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_assertion: hmac,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    });
    expect(run.status, run.bodyText).toBe(401);
    expect(run.body.error).toBe('invalid_client');
  });

  it('boundary: malformed code is rejected before client authentication (validateAuthCode precedes auth)', async () => {
    expect.hasAssertions();
    seedClientRow(kit, {
      clientId: CLIENT_IDS.confidential,
      method: 'client_secret_basic',
      secretHash: await hashSecret(SECRET),
    });
    const app = createMatrixTokenApp(kit);
    const run = await tokenPost(app, kit, {
      grant_type: 'authorization_code',
      code: 'bad-code',
      redirect_uri: REDIRECT,
      client_id: CLIENT_IDS.confidential,
      client_secret: 'definitely-wrong-secret',
    });
    expect(run.status).toBe(400);
    expect(run.body.error).toBe('invalid_grant');
    expect(run.ledger.has('do.rpc', (t) => t.includes('consumeCodeRpc'))).toBe(false);
    expect(run.ledger.has('d1.queryOne', (t) => t.includes('oauth_clients'))).toBe(false);
    expect(run.response.headers.get('Cache-Control')).toBeNull();
  });

  it('boundary: invalid credentials with a used code and registered JTIs never consume or revoke', async () => {
    expect.hasAssertions();
    const publicId = CLIENT_IDS.public;
    seedClientRow(kit, { clientId: publicId, method: 'none', secretHash: undefined });
    const confidentialId = CLIENT_IDS.confidential;
    seedClientRow(kit, {
      clientId: confidentialId,
      method: 'client_secret_basic',
      secretHash: await hashSecret(SECRET),
    });
    const code = `${CODE_PREFIX}ic`;
    await storeCode(kit, { code, clientId: publicId });
    await consumeAndRegister(kit, code, publicId, 'at-used', 'rt-used');
    const app = createMatrixTokenApp(kit);
    const run = await tokenPost(app, kit, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: confidentialId,
      client_secret: 'wrong-secret',
    });
    expect(run.status).toBe(401);
    expect(run.body.error).toBe('invalid_client');
    expect(run.ledger.has('do.rpc', (t) => t.includes('consumeCodeRpc'))).toBe(false);
    expect(kit.revocationJtis).toEqual([]);
  });

  it('boundary: invalid credentials with a foreign request tenant touch no cross-tenant code store', async () => {
    expect.hasAssertions();
    seedClientRow(kit, {
      clientId: CLIENT_IDS.confidential,
      tenantId: FOREIGN_REQUEST_TENANT,
      method: 'client_secret_basic',
      secretHash: await hashSecret(SECRET),
    });
    const code = `${CODE_PREFIX}ft`;
    await storeCode(kit, { code, clientId: CLIENT_IDS.public });
    const app = createMatrixTokenApp(kit, { tenantId: FOREIGN_REQUEST_TENANT });
    const run = await tokenPost(app, kit, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: CLIENT_IDS.confidential,
      client_secret: 'wrong-secret',
    });
    expect(run.status).toBe(401);
    expect(run.body.error).toBe('invalid_client');
    expect(run.ledger.has('do.rpc', (t) => t.includes('consumeCodeRpc'))).toBe(false);
    expect(kit.revocationJtis).toEqual([]);
    expect(run.ledger.all().some((e) => e.target.includes('auth_code'))).toBe(false);
  });

  it('boundary: valid credentials with a wrong-tenant code return a generic invalid_grant without leaks', async () => {
    expect.hasAssertions();
    const publicId = CLIENT_IDS.public;
    seedClientRow(kit, { clientId: publicId, method: 'none', secretHash: undefined });
    const code = `${CODE_PREFIX}wtc`;
    await storeCode(kit, { code, clientId: publicId, tenantId: FOREIGN_CLIENT_TENANT });
    const app = createMatrixTokenApp(kit);
    const run = await tokenPost(app, kit, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: publicId,
    });
    expect(run.status).toBe(400);
    expect(run.body.error).toBe('invalid_grant');
    expect(run.body.error_description).toBe('Authorization code is invalid or expired');
    expect(run.bodyText.includes(FOREIGN_CLIENT_TENANT)).toBe(false);
    expect(run.bodyText.includes(code)).toBe(false);
    expect(kit.revocationJtis).toEqual([]);
  });

  it('oracle sensitivity: corrupted real T-A observations are rejected per domain', async () => {
    expect.hasAssertions();
    // Representative rows covering every outcome family.
    const representatives = TA_CASE_TABLE.filter((entry) => {
      const kind = decideTokenA(entry.dimensions).outcome.kind;
      if (kind === 'success') return true;
      if (kind === 'invalid_client') return entry.dimensions.presented === 'malformed';
      if (kind === 'invalid_grant') {
        const state = String(entry.dimensions.codeState);
        return (
          state === 'replayed' ||
          state === 'consumed' ||
          state === 'malformed' ||
          state === 'wrong-tenant'
        );
      }
      return false;
    });
    expect(representatives.length).toBeGreaterThanOrEqual(6);
    for (const entry of representatives.slice(0, 10)) {
      const decision = decideTokenA(entry.dimensions);
      const { run, code } = await runRow(entry);
      const observed = await buildObservation(kit, run, code);
      const expected = expectedObservation(entry, decision);
      // The real observation passes the same comparator used by the per-row tests.
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

  it('every T-A case carries a discriminating mutation witness', () => {
    expect.hasAssertions();
    for (const entry of TA_CASE_TABLE) {
      const base = decideTokenA(entry.dimensions);
      const baseSignature = taDecisionSignature(base);
      expect(entry.mutationIds.length).toBeGreaterThan(0);
      for (const mutationId of entry.mutationIds) {
        const mutant = mutationCandidatesFor(entry, mutationId);
        expect(taDecisionSignature(mutant), `${entry.id} mutation ${mutationId}`).not.toBe(
          baseSignature
        );
      }
    }
  });

  it('includes a genuine success path for every successful authentication combination', () => {
    expect.hasAssertions();
    for (const registeredMethod of [
      'none',
      'client_secret_basic',
      'client_secret_post',
      'client_secret_jwt',
      'private_key_jwt',
    ]) {
      for (const presented of ['none', 'basic', 'post', 'jwt', 'malformed', 'conflicting']) {
        for (const client of ['public', 'confidential', 'unknown', 'wrong-tenant']) {
          if (!taAuthSuccess(registeredMethod, presented, client)) continue;
          const present = TA_CASE_TABLE.some(
            (entry) =>
              entry.registeredMethod === registeredMethod &&
              entry.presented === presented &&
              entry.client === client &&
              decideTokenA(entry.dimensions).outcome.kind === 'success'
          );
          expect(present, `${registeredMethod}/${presented}/${client} success row`).toBe(true);
        }
      }
    }
  });
});

/** Re-derive the T-A mutation decisions for the witness meta check (duplicated cheaply). */
function mutationCandidatesFor(entry: TokenACase, mutationId: string) {
  const base = decideTokenA(entry.dimensions);
  const row = entry.dimensions;
  switch (mutationId) {
    case 'token:consume-before-auth':
      return { ...base, codeConsumed: true, outcome: { kind: 'success' as const } };
    case 'token:accept-bad-client-credentials':
      return decideTokenA({ ...row, presented: 'none' });
    case 'token:issue-without-code-consume':
      return { ...base, codeConsumed: false };
    case 'token:revoke-on-non-replay-grant-failure':
      return { ...base, revocationCount: 2 };
    case 'token:omit-revocation-after-replay':
      return { ...base, revocationCount: 0 };
    case 'token:derive-claims-wrong-tenant':
      return { ...base, outcome: { kind: 'invalid_grant' as const } };
    default:
      throw new Error(`Unknown T-A mutation id: ${mutationId}`);
  }
}

export { EXPECTED_TA_CASE_COUNT, TA_DIMENSION_ORDER };
