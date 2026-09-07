import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { Env } from '../../../packages/ar-lib-core/src/types/env';
import {
  createSecurityMatrixEnv,
  seedRegionShardConfig,
  TEST_ISSUER,
  TEST_USER,
  type SecurityMatrixEnvKit,
} from '../fixtures/env';
import { CallLedger, LedgerExecutionContext } from '../fixtures/call-ledger';
import { createMatrixAuthorizeApp, requestUrl } from '../fixtures/hono-context';
import { installFrozenNow, restoreRealClock, frozenNowMs } from '../fixtures/deterministic-clock';
import { findDuplicateIds } from '../fixtures/case-fingerprint';
import { runBinaryGoldenChecks } from '../fixtures/coverage-verifier';
import { getFixedSigningKeySet } from '../fixtures/fixed-keys';
import { decodeJwtPayloadUnverified } from '../fixtures/oracles';
import type { Row, Scalar } from '../fixtures/covering-array';
import { importJWK, importPKCS8, exportPKCS8, jwtVerify, SignJWT } from 'jose';
import { verifyToken } from '../../../packages/ar-lib-core/src/utils/jwt';
import {
  EXPECTED_PROTO_CASE_COUNT,
  PROTO_CASE_TABLE,
  PROTO_CONSTRAINTS,
  PROTO_DIMENSION_ORDER,
  PROTO_VALUES,
  PROTO_SELECTED_TRIPLES,
  protocolDecisionSignature,
  protocolMutationDecision,
  type ProtocolCase,
} from './protocol-matrix';
import { decideProtocol, type Outcome, type SideEffects } from './decision';
import {
  ATTACKER_REDIRECT,
  CLIENT_A,
  CLIENT_JAR,
  CLIENT_PUBLIC,
  CLIENT_REQUIRES_PKCE,
  TEST_NONCE,
  TEST_SCOPE,
  TEST_STATE,
  FOREIGN_TENANT,
  MALFORMED_REDIRECT,
  PLAIN_CHALLENGE,
  REDIRECT,
  VALID_CHALLENGE,
  buildSignedJar,
  seedAccountStateForTenant,
  seedClient,
  seedConsent,
  seedForeignTenantSession,
  seedJarmRequirement,
  seedPar,
  seedParTenantMismatch,
  seedSession,
  seedSsoSettings,
  sessionCookieHeader,
  sessionStoreInstanceName,
} from './seed';

const MATRIX_TENANT = 'tenant-b';
const CLIENT_SECRET_HASH = 'aa6b73af0f9d3bd6a7ec2f8c9f6b4e3d2a1c0b9e8f7d6c5b4a3f2e1d0c9b8a7';
const PROTO_SESSION_ID = 'g1:enam:0:session_proto_active';
const REDIRECT_ORIGIN_PATH = 'https://client.example/callback';
const JAR_MALFORMED_TOKEN = 'eyJhbGciOiJub25lIn0.e30.';

const CLIENT_IDS: Record<string, string> = {
  public: CLIENT_PUBLIC,
  confidential: CLIENT_A,
  'requires-pkce': CLIENT_REQUIRES_PKCE,
};

const PKCE_QUERY: Record<string, { challenge?: string; method?: string }> = {
  missing: {},
  valid: { challenge: VALID_CHALLENGE, method: 'S256' },
  plain: { challenge: PLAIN_CHALLENGE, method: 'plain' },
  malformed: { challenge: 'short', method: 'S256' },
};

export interface ProtoObservation {
  status: number;
  error: string | null;
  bodyKind: 'redirect' | 'json' | 'html-form' | 'html-error' | 'other';
  htmlMarker: string | null;
  target: string | null;
  formAction: string | null;
  keys: string[];
  hasState: boolean;
  hasIss: boolean;
  hasCode: boolean;
  jarm: boolean;
  jarmKeys: string[];
  jarmValid: boolean;
  jarmCodeMatchesPersisted: boolean;
  codeIssued: boolean;
  challengeType: string | null;
  parReadAttempted: boolean;
  parConsumed: boolean;
  sessionReadAttempted: boolean;
  sessionBindingRejected: boolean;
  foreignTenantAccess: boolean;
  secretLeak: boolean;
}

function observationFromDecision(
  decision: { outcome: Outcome; sideEffects: SideEffects },
  row: Row
): ProtoObservation {
  const { outcome, sideEffects } = decision;
  const observation: ProtoObservation = {
    status: 0,
    error: null,
    bodyKind: 'other',
    htmlMarker: null,
    target: null,
    formAction: null,
    keys: [],
    hasState: false,
    hasIss: false,
    hasCode: false,
    jarm: false,
    jarmKeys: [],
    jarmValid: false,
    jarmCodeMatchesPersisted: false,
    codeIssued: sideEffects.codeIssued,
    challengeType: null,
    // A PAR request_uri is always read before any outcome is decided, except for the
    // request+request_uri conflict which is rejected before the PAR read (authorize.ts:786).
    parReadAttempted: String(row.source) === 'par',
    parConsumed: sideEffects.parConsumed,
    sessionReadAttempted: sideEffects.sessionReadAttempted,
    sessionBindingRejected: sideEffects.sessionBindingRejected,
    foreignTenantAccess: false,
    secretLeak: false,
  };

  const errorKeys = ['error', 'error_description', 'iss', 'state'];
  const successKeys = ['code', 'iss', 'session_state', 'state'];
  const formTarget =
    outcome.kind === 'error-redirect' && outcome.target === 'unvalidated'
      ? ATTACKER_REDIRECT
      : REDIRECT_ORIGIN_PATH;

  switch (outcome.kind) {
    case 'direct-error':
      observation.status = outcome.status;
      observation.bodyKind = 'json';
      observation.error = outcome.error;
      observation.keys = ['error', 'error_description'];
      break;
    case 'html-error':
      observation.status = outcome.status;
      observation.bodyKind = 'html-error';
      observation.htmlMarker = outcome.htmlContains;
      break;
    case 'error-redirect':
      observation.error = outcome.error;
      observation.hasState = true;
      observation.hasIss = true;
      if (outcome.mode === 'form_post') {
        observation.status = 200;
        observation.bodyKind = 'html-form';
        observation.target = formTarget;
        observation.formAction = formTarget;
        observation.keys = [...errorKeys].sort();
      } else if (outcome.mode === 'jwt') {
        observation.status = 302;
        observation.bodyKind = 'redirect';
        observation.target =
          outcome.target === 'unvalidated' ? ATTACKER_REDIRECT : REDIRECT_ORIGIN_PATH;
        observation.keys = ['response'];
        observation.jarm = true;
        observation.jarmValid = true;
        observation.jarmKeys = ['aud', 'error', 'error_description', 'exp', 'iat', 'iss', 'state'];
      } else {
        observation.status = 302;
        observation.bodyKind = 'redirect';
        observation.target =
          outcome.target === 'unvalidated' ? ATTACKER_REDIRECT : REDIRECT_ORIGIN_PATH;
        observation.keys = [...errorKeys].sort();
      }
      break;
    case 'challenge':
      observation.status = 302;
      observation.bodyKind = 'redirect';
      observation.target = `${TEST_ISSUER}/flow/login`;
      observation.keys = ['challenge_id'];
      observation.challengeType = outcome.challengeType;
      break;
    case 'code-success':
      observation.hasCode = true;
      observation.hasState = true;
      observation.hasIss = true;
      if (outcome.mode === 'form_post') {
        observation.status = 200;
        observation.bodyKind = 'html-form';
        observation.target = formTarget;
        observation.formAction = formTarget;
        observation.keys = [...successKeys].sort();
      } else if (outcome.mode === 'jwt') {
        observation.status = 302;
        observation.bodyKind = 'redirect';
        observation.target = REDIRECT_ORIGIN_PATH;
        observation.keys = ['response'];
        observation.jarm = true;
        observation.jarmValid = true;
        observation.jarmCodeMatchesPersisted = true;
        observation.jarmKeys = ['aud', 'code', 'exp', 'iat', 'iss', 'session_state', 'state'];
      } else {
        observation.status = 302;
        observation.bodyKind = 'redirect';
        observation.target = REDIRECT_ORIGIN_PATH;
        observation.keys = [...successKeys].sort();
      }
      break;
    default:
      break;
  }
  return observation;
}

export function observationsMatch(actual: ProtoObservation, expected: ProtoObservation): boolean {
  return (
    actual.status === expected.status &&
    actual.error === expected.error &&
    actual.bodyKind === expected.bodyKind &&
    actual.htmlMarker === expected.htmlMarker &&
    actual.target === expected.target &&
    actual.formAction === expected.formAction &&
    actual.keys.join('\u0000') === expected.keys.join('\u0000') &&
    actual.hasState === expected.hasState &&
    actual.hasIss === expected.hasIss &&
    actual.hasCode === expected.hasCode &&
    actual.jarm === expected.jarm &&
    actual.jarmKeys.join('\u0000') === expected.jarmKeys.join('\u0000') &&
    actual.jarmValid === expected.jarmValid &&
    actual.jarmCodeMatchesPersisted === expected.jarmCodeMatchesPersisted &&
    actual.codeIssued === expected.codeIssued &&
    actual.challengeType === expected.challengeType &&
    actual.parReadAttempted === expected.parReadAttempted &&
    actual.parConsumed === expected.parConsumed &&
    actual.sessionReadAttempted === expected.sessionReadAttempted &&
    actual.sessionBindingRejected === expected.sessionBindingRejected &&
    actual.foreignTenantAccess === expected.foreignTenantAccess &&
    actual.secretLeak === expected.secretLeak
  );
}

function challengeRecordsOf(kit: SecurityMatrixEnvKit): Array<{
  type: string;
  userId: string;
  metadata: Record<string, unknown>;
}> {
  const records: Array<{ type: string; userId: string; metadata: Record<string, unknown> }> = [];
  for (const [, storage] of kit.challengeNamespace.allStorageSnapshots()) {
    for (const [key, value] of storage) {
      if (!key.startsWith('challenge:')) continue;
      const record = value as { type?: unknown; userId?: unknown; metadata?: unknown };
      records.push({
        type: typeof record.type === 'string' ? record.type : '',
        userId: typeof record.userId === 'string' ? record.userId : '',
        metadata: (record.metadata ?? {}) as Record<string, unknown>,
      });
    }
  }
  return records;
}

function codeRecordCountOf(kit: SecurityMatrixEnvKit): number {
  let count = 0;
  for (const [, storage] of kit.authCodeNamespace.allStorageSnapshots()) {
    for (const key of storage.keys()) {
      if (key.startsWith('code:')) count += 1;
    }
  }
  return count;
}

function sessionRecordPresentAfterRequest(
  kit: SecurityMatrixEnvKit,
  sessionId: string | undefined
): boolean {
  if (!sessionId) return false;
  const instanceName = sessionStoreInstanceName(MATRIX_TENANT, sessionId);
  return kit.sessionStoreNamespace.snapshotStorage(instanceName).has(`session:${sessionId}`);
}

interface LedgerProbe {
  parReadAttempted: boolean;
  parConsumed: boolean;
  sessionReadAttempted: boolean;
  sessionReadFailed: boolean;
  revocationRpc: boolean;
  foreignTenantAccess: boolean;
}

function probeLedger(kit: SecurityMatrixEnvKit): LedgerProbe {
  const entries = kit.ledger.all();
  return {
    parReadAttempted: entries.some(
      (entry) =>
        entry.kind === 'do.rpc' &&
        entry.target.includes('par:') &&
        entry.target.includes('getRequestRpc')
    ),
    parConsumed: entries.some(
      (entry) =>
        entry.kind === 'do.rpc' &&
        entry.target.includes('par:') &&
        entry.target.includes('consumeRequestRpc')
    ),
    sessionReadAttempted: entries.some(
      (entry) =>
        entry.kind === 'do.rpc' &&
        entry.target.includes('session:') &&
        entry.target.includes('getSessionRpc')
    ),
    sessionReadFailed: entries.some(
      (entry) =>
        entry.kind === 'do.fetch' &&
        entry.target.includes('session:') &&
        entry.target.includes(':failed')
    ),
    revocationRpc: entries.some(
      (entry) => entry.kind === 'do.rpc' && entry.target.includes('session-revocation')
    ),
    foreignTenantAccess: entries.some((entry) => entry.target.includes(FOREIGN_TENANT)),
  };
}

function safeSerializeLedgerEntry(entry: {
  kind: string;
  target: string;
  detail?: unknown;
}): string {
  let detailText: string;
  try {
    detailText = JSON.stringify(entry.detail) ?? '';
  } catch {
    detailText = String(entry.detail);
  }
  return `${entry.target}\n${detailText}`;
}

/**
 * Secret-leak oracle. Scans the response body, the redirect Location, and EVERY ledger
 * entry's target plus its safely-serializable detail.
 *
 * Legitimate delivery surfaces explicitly excluded:
 * - the redirect Location carrying the issued authorization code and/or the JARM
 *   response token;
 * - the form_post response body carrying the issued authorization code (hidden input);
 * - durable-storage key labels of the AuthorizationCodeStore (`code:${code}`), which the
 *   transport ledger records as part of the storage target.
 *
 * Scan scope note: the ledger secret list covers the authorization-code value, the JARM
 * response token, and the client-secret hash. Session and challenge identifiers are not
 * part of the ledger list because they legitimately appear inside durable-storage key
 * labels (`session:${id}`, `challenge:${id}`) recorded by the transport ledger; they ARE
 * part of the response-surface list (body, Location, form action).
 */
function surfaceLeaks(
  kit: SecurityMatrixEnvKit,
  responseSecrets: string[],
  ledgerSecrets: string[],
  bodyText: string,
  location: string | null,
  issuedCode: string | null,
  jarmToken: string | null
): boolean {
  for (const secret of responseSecrets) {
    if (!secret) continue;
    if (secret === issuedCode || secret === jarmToken) continue;
    if (bodyText.includes(secret)) return true;
  }
  if (location) {
    for (const secret of responseSecrets) {
      if (!secret) continue;
      if (secret === issuedCode || secret === jarmToken) continue;
      if (location.includes(secret)) return true;
    }
  }
  const serialized = kit.ledger.all().map(safeSerializeLedgerEntry).join('\n');
  for (const secret of ledgerSecrets) {
    if (!secret) continue;
    if (!serialized.includes(secret)) continue;
    // The AuthorizationCodeStore durable-storage key label (`code:${code}`) is the
    // legitimate storage label recorded by the transport ledger.
    const onlyStorageLabels = kit.ledger
      .all()
      .filter((entry) => entry.kind === 'do.fetch' && entry.target.includes(`code:${secret}`));
    if (
      onlyStorageLabels.length ===
      kit.ledger.all().filter((entry) => entry.target.includes(secret)).length
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function clientIdFor(row: Row): string {
  return CLIENT_IDS[String(row.clientType)];
}

interface JarmVerification {
  valid: boolean;
  payload: Record<string, unknown> | null;
}

/**
 * Independent JARM oracle: verifies the authorization-response JWT signature against the
 * fixed fixed test public key with jose directly (never the production signer/helper),
 * pins the allowed signing algorithm and token type, and checks the production
 * contract claims: `iss` = issuer, `aud` = client, `state` = request state, and
 * `iat`/`exp` numeric with the production 600s lifetime (authorize.ts:4852-4860).
 */
async function verifyJarmToken(
  token: string,
  clientId: string,
  publicJwk: Record<string, unknown>
): Promise<JarmVerification> {
  try {
    const publicKey = (await importJWK(publicJwk, 'RS256')) as CryptoKey;
    const result = await jwtVerify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: TEST_ISSUER,
      audience: clientId,
      // The production signer uses the frozen test clock; jose's exp check must
      // use the same clock, not the real wall clock.
      currentDate: new Date(frozenNowMs()),
    });
    const payload = result.payload as Record<string, unknown>;
    const alg = result.protectedHeader.alg;
    const typ = result.protectedHeader.typ;
    const iat =
      typeof payload.iat === 'number' && Number.isFinite(payload.iat) ? payload.iat : null;
    const exp =
      typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : null;
    const valid =
      alg === 'RS256' &&
      typ === 'oauth-authz-resp+jwt' &&
      iat !== null &&
      exp !== null &&
      exp - iat === 600 &&
      payload.state === TEST_STATE;
    return { valid, payload };
  } catch {
    return { valid: false, payload: null };
  }
}

/** Authorization codes currently persisted in the auth-code store (`code:${code}` keys). */
function persistedCodesOf(kit: SecurityMatrixEnvKit): string[] {
  const codes: string[] = [];
  for (const [, storage] of kit.authCodeNamespace.allStorageSnapshots()) {
    for (const key of storage.keys()) {
      if (key.startsWith('code:')) codes.push(key.substring('code:'.length));
    }
  }
  return codes;
}

function redirectFor(row: Row): string {
  const redirectValid = String(row.redirectValid);
  if (redirectValid === 'unregistered') return ATTACKER_REDIRECT;
  if (redirectValid === 'malformed') return MALFORMED_REDIRECT;
  return REDIRECT;
}

function responseTypeFor(row: Row): string | null {
  const value = String(row.responseType);
  if (value === 'missing') return null;
  if (value === 'unsupported') return 'token';
  return value;
}

function responseModeFor(row: Row): string | null {
  const value = String(row.responseMode);
  if (value === 'omitted') return null;
  return value;
}

function pkceFor(row: Row): { challenge?: string; method?: string } {
  return PKCE_QUERY[String(row.pkce)] ?? {};
}

function seedRowClient(kit: SecurityMatrixEnvKit, row: Row, jwksJson: string): string {
  const clientId = clientIdFor(row);
  const tenantId = row.clientBinding === 'foreign-tenant' ? FOREIGN_TENANT : MATRIX_TENANT;
  const publicClient = row.clientType === 'public';
  seedClient(kit, {
    clientId,
    tenantId,
    publicClient,
    requirePkce: row.clientType === 'requires-pkce',
    jwks: jwksJson,
  });
  return clientId;
}

async function seedSessionState(
  kit: SecurityMatrixEnvKit,
  clientId: string,
  sessionBinding: string
): Promise<void> {
  if (sessionBinding === 'active-request-tenant') {
    await seedAccountStateForTenant(kit, MATRIX_TENANT);
    await seedSession(kit, {
      sessionId: PROTO_SESSION_ID,
      tenantId: MATRIX_TENANT,
      requestTenantId: MATRIX_TENANT,
    });
    seedSsoSettings(kit, clientId, 'true', 'default', MATRIX_TENANT);
    seedConsent(kit, { tenantId: MATRIX_TENANT, clientId, scope: TEST_SCOPE });
  } else if (sessionBinding === 'foreign-tenant') {
    await seedForeignTenantSession(kit, PROTO_SESSION_ID, FOREIGN_TENANT, MATRIX_TENANT);
  }
}

function sessionIdFor(sessionBinding: string): string | undefined {
  if (sessionBinding === 'n-a') return undefined;
  return PROTO_SESSION_ID;
}

async function buildJarFor(
  fixedKeys: { privatePem: string; kid: string },
  claims: Record<string, unknown>
): Promise<string> {
  const claimsToSign: Record<string, unknown> = {
    iss: claims.iss,
    aud: TEST_ISSUER,
    ...claims,
  };
  return buildSignedJar(fixedKeys.privatePem, fixedKeys.kid, claimsToSign as never);
}

async function buildRequestObjectFor(
  fixedKeys: { privatePem: string; kid: string },
  row: Row,
  clientId: string,
  redirectUri: string,
  jwksJson: string
): Promise<{ jar: string; jarVerified: boolean }> {
  const containerState = String(row.containerState);
  if (containerState === 'jar-malformed') {
    return { jar: JAR_MALFORMED_TOKEN, jarVerified: false };
  }
  const baseClaims = {
    iss: clientId,
    aud: TEST_ISSUER,
    client_id: clientId,
    redirect_uri: redirectUri,
  };
  if (containerState === 'jar-valid') {
    const claims: Record<string, unknown> = { ...baseClaims };
    if (row.responseType === 'missing') {
      claims.response_type = 'code';
    } else if (row.responseType === 'unsupported') {
      claims.response_type = 'token';
    } else {
      claims.response_type = String(row.responseType);
    }
    const jar = await buildJarFor(fixedKeys, claims);
    // Input-construction verification: the valid JAR must genuinely verify against the
    // client's registered JWKS with the production verification path.
    const publicJwk = (JSON.parse(jwksJson) as { keys: Array<Record<string, unknown>> }).keys.find(
      (key) => key.kid === fixedKeys.kid
    );
    if (!publicJwk) throw new Error('fixed key missing from client jwks');
    const publicKey = (await importJWK(publicJwk as never, 'RS256')) as CryptoKey;
    await verifyToken(jar, publicKey, clientId, { audience: TEST_ISSUER });
    return { jar, jarVerified: true };
  }
  if (containerState === 'jar-claims-mismatch') {
    const jar = await buildJarFor(fixedKeys, {
      ...baseClaims,
      client_id: 'matrix-other-client',
    });
    return { jar, jarVerified: true };
  }
  // jar-bad-signature: structurally valid JWT signed with a key the client never registered.
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;
  const privatePem = await exportPKCS8(keyPair.privateKey);
  const jar = await buildSignedJar(privatePem, 'throwaway-kid', baseClaims as never);
  return { jar, jarVerified: false };
}

async function seedParState(
  kit: SecurityMatrixEnvKit,
  row: Row,
  clientId: string
): Promise<string | null> {
  const containerState = String(row.containerState);
  const base = {
    tenantId: MATRIX_TENANT,
    clientId,
    responseType:
      String(row.responseType) === 'missing' ? 'code' : (responseTypeFor(row) ?? 'code'),
    redirectUri: REDIRECT,
    scope: TEST_SCOPE,
    state: TEST_STATE,
    nonce: TEST_NONCE,
  };
  if (containerState === 'par-expired') {
    const result = await seedPar(kit, { ...base, expired: true });
    return result.requestUri;
  }
  if (containerState === 'par-replayed') {
    const result = await seedPar(kit, { ...base, consumed: true });
    return result.requestUri;
  }
  if (containerState === 'par-client-mismatch') {
    const result = await seedPar(kit, { ...base, clientId: 'matrix-other-client' });
    return result.requestUri;
  }
  if (containerState === 'par-tenant-mismatch') {
    const result = await seedParTenantMismatch(kit, {
      ...base,
      storedTenantId: FOREIGN_TENANT,
    });
    return result.requestUri;
  }
  const result = await seedPar(kit, {
    ...base,
    ...pkceFor(row),
    ...(responseModeFor(row) !== null ? { responseMode: responseModeFor(row)! } : {}),
  });
  return result.requestUri;
}

function requestQueryFor(row: Row): Record<string, string> {
  const query: Record<string, string> = {
    client_id: clientIdFor(row),
    redirect_uri: redirectFor(row),
    scope: TEST_SCOPE,
    state: TEST_STATE,
    nonce: TEST_NONCE,
  };
  if (String(row.source) !== 'jar') {
    const responseType = responseTypeFor(row);
    if (responseType !== null) query.response_type = responseType;
  }
  if (String(row.source) !== 'par') {
    const responseMode = responseModeFor(row);
    if (responseMode !== null) query.response_mode = responseMode;
    const pkce = pkceFor(row);
    if (pkce.challenge !== undefined) {
      query.code_challenge = pkce.challenge;
      query.code_challenge_method = pkce.method!;
    }
  }
  return query;
}

interface ProductionRun {
  observation: ProtoObservation;
  bodyText: string;
  location: string | null;
  issuedCode: string | null;
  jarmToken: string | null;
  sessionId: string | undefined;
  codeRecordCount: number;
  challengeRecords: Array<{ type: string; userId: string; metadata: Record<string, unknown> }>;
  parReadAttempted: boolean;
  parConsumed: boolean;
}

async function runProtoRow(
  kit: SecurityMatrixEnvKit,
  app: Hono<{ Bindings: Env }>,
  row: Row,
  fixedKeys: { privatePem: string; kid: string; publicJwk: Record<string, unknown> },
  jwksJson: string
): Promise<ProductionRun> {
  const clientId = seedRowClient(kit, row, jwksJson);
  if (row.jarmRequirement === 'required') seedJarmRequirement(kit, true);
  const sessionBinding = String(row.sessionBinding);
  await seedSessionState(kit, clientId, sessionBinding);
  const sessionId = sessionIdFor(sessionBinding);
  const redirectUri = redirectFor(row);

  let requestUri: string | null = null;
  let jar: string | null = null;
  if (String(row.source) === 'par') {
    requestUri = await seedParState(kit, row, clientId);
  } else if (String(row.source) === 'jar') {
    const built = await buildRequestObjectFor(fixedKeys, row, clientId, redirectUri, jwksJson);
    jar = built.jar;
  } else if (String(row.source) === 'conflict') {
    // The conflict is rejected before either container is processed (authorize.ts:786);
    // both parameters are present but neither store is touched.
    requestUri = 'urn:ietf:params:oauth:request_uri:g1:enam:0:par_conflict';
    jar = JAR_MALFORMED_TOKEN;
  }

  kit.ledger.reset();

  const query = requestQueryFor(row);
  if (requestUri) query.request_uri = requestUri;
  if (jar) query.request = jar;
  const url = new URL(requestUrl('/authorize'));
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  const request = new Request(url.toString(), {
    method: 'GET',
    headers: sessionCookieHeader(sessionId),
  });
  const response = await app.fetch(request, kit.env, new LedgerExecutionContext(kit.ledger));
  await kit.ledger.drain();

  const bodyText = await response.text();
  const location = response.headers.get('location');
  let error: string | null = null;
  let issuedCode: string | null = null;
  let jarmToken: string | null = null;
  let target: string | null = null;
  let formAction: string | null = null;
  let keys: string[] = [];
  let hasState = false;
  let hasIss = false;
  let hasCode = false;
  let jarm = false;
  let jarmKeys: string[] = [];
  let jarmValid = false;
  let jarmPayloadCode: string | null = null;
  let bodyKind: ProtoObservation['bodyKind'] = 'other';
  let htmlMarker: string | null = null;
  const contentType = response.headers.get('content-type');

  const collectParams = async (params: URLSearchParams): Promise<void> => {
    for (const key of params.keys()) keys.push(key);
    if (params.get('error')) error = params.get('error');
    if (params.has('state')) hasState = true;
    if (params.has('iss')) hasIss = true;
    if (params.has('code')) {
      hasCode = true;
      issuedCode = params.get('code');
    }
    const responseParam = params.get('response');
    if (responseParam) {
      jarm = true;
      jarmToken = responseParam;
      const verification = await verifyJarmToken(responseParam, clientId, fixedKeys.publicJwk);
      jarmValid = verification.valid;
      const payload = verification.payload ?? decodeJwtPayloadUnverified(responseParam);
      jarmKeys = Object.keys(payload).sort();
      if (typeof payload.error === 'string') error = payload.error;
      if (payload.state !== undefined) hasState = true;
      if (payload.iss !== undefined) hasIss = true;
      if (typeof payload.code === 'string') {
        hasCode = true;
        issuedCode = payload.code;
        jarmPayloadCode = payload.code;
      }
    }
  };

  if (location) {
    bodyKind = 'redirect';
    const parsed = new URL(location, TEST_ISSUER);
    target = parsed.origin + parsed.pathname;
    await collectParams(parsed.searchParams);
    if (parsed.hash) {
      await collectParams(new URLSearchParams(parsed.hash.replace(/^#/, '')));
    }
    keys = Array.from(new Set(keys)).sort();
  } else if (contentType?.includes('application/json')) {
    bodyKind = 'json';
    try {
      const parsedBody = JSON.parse(bodyText) as Record<string, unknown>;
      error = typeof parsedBody.error === 'string' ? parsedBody.error : null;
      keys = Object.keys(parsedBody).sort();
    } catch {
      bodyKind = 'other';
    }
  } else if (contentType?.includes('text/html')) {
    if (bodyText.includes('name="')) {
      bodyKind = 'html-form';
      const inputNames: string[] = [];
      const inputPattern = /name="([^"]+)"\s+value="([^"]*)"/gu;
      let match: RegExpExecArray | null;
      while ((match = inputPattern.exec(bodyText)) !== null) {
        inputNames.push(match[1]);
        const value = match[2];
        if (match[1] === 'error') error = value;
        if (match[1] === 'state' && value.length > 0) hasState = true;
        if (match[1] === 'iss' && value.length > 0) hasIss = true;
        if (match[1] === 'code' && value.length > 0) {
          hasCode = true;
          issuedCode = value;
        }
      }
      keys = Array.from(new Set(inputNames)).sort();
      // Extract the form submission target without depending on attribute order: find
      // the <form> tag first, then its action attribute (createFormPostResponse emits
      // action="${escapeHtml(redirectUri)}", authorize.ts:4800).
      const formTag = bodyText.match(/<form\b[^>]*>/i)?.[0] ?? null;
      formAction = formTag ? (formTag.match(/\baction="([^"]*)"/i)?.[1] ?? null) : null;
      target = formAction;
    } else {
      bodyKind = 'html-error';
      if (bodyText.includes('Invalid Redirect URI')) htmlMarker = 'Invalid Redirect URI';
      else if (bodyText.includes('Unregistered Redirect URI'))
        htmlMarker = 'Unregistered Redirect URI';
    }
  }

  const challengeRecords = challengeRecordsOf(kit);
  const codeRecordCount = codeRecordCountOf(kit);
  const ledgerProbe = probeLedger(kit);
  const sessionBindingRejected =
    ledgerProbe.sessionReadAttempted &&
    !ledgerProbe.sessionReadFailed &&
    sessionRecordPresentAfterRequest(kit, sessionId) &&
    !ledgerProbe.revocationRpc;

  // The JARM payload's code must equal the authorization code actually persisted.
  const jarmCodeMatchesPersisted =
    jarmPayloadCode !== null && persistedCodesOf(kit).includes(jarmPayloadCode);

  const responseSecrets: string[] = [];
  if (sessionId) responseSecrets.push(sessionId);
  responseSecrets.push(CLIENT_SECRET_HASH);
  const ledgerSecrets: string[] = [];
  if (issuedCode) ledgerSecrets.push(issuedCode);
  if (jarmToken) ledgerSecrets.push(jarmToken);
  ledgerSecrets.push(CLIENT_SECRET_HASH);

  const observation: ProtoObservation = {
    status: response.status,
    error,
    bodyKind,
    htmlMarker,
    target,
    formAction,
    keys,
    hasState,
    hasIss,
    hasCode,
    jarm,
    jarmKeys,
    jarmValid,
    jarmCodeMatchesPersisted,
    codeIssued: codeRecordCount > 0,
    challengeType: challengeRecords.length === 1 ? challengeRecords[0].type : null,
    parReadAttempted: ledgerProbe.parReadAttempted,
    parConsumed: ledgerProbe.parConsumed,
    sessionReadAttempted: ledgerProbe.sessionReadAttempted,
    sessionBindingRejected,
    foreignTenantAccess: ledgerProbe.foreignTenantAccess,
    secretLeak: surfaceLeaks(
      kit,
      responseSecrets,
      ledgerSecrets,
      bodyText,
      location,
      issuedCode,
      jarmToken
    ),
  };

  return {
    observation,
    bodyText,
    location,
    issuedCode,
    jarmToken,
    sessionId,
    codeRecordCount,
    challengeRecords,
    parReadAttempted: ledgerProbe.parReadAttempted,
    parConsumed: ledgerProbe.parConsumed,
  };
}

function assertRowAgainstProduction(
  expected: ProtoObservation,
  run: ProductionRun,
  kit: SecurityMatrixEnvKit
): void {
  const observation = run.observation;
  expect(observation.status).toBe(expected.status);
  expect(observation.error).toBe(expected.error);
  expect(observation.bodyKind).toBe(expected.bodyKind);
  expect(observation.htmlMarker).toBe(expected.htmlMarker);
  expect(observation.target).toBe(expected.target);
  expect(observation.formAction).toBe(expected.formAction);
  expect(observation.keys).toEqual(expected.keys);
  expect(observation.hasState).toBe(expected.hasState);
  expect(observation.hasIss).toBe(expected.hasIss);
  expect(observation.hasCode).toBe(expected.hasCode);
  expect(observation.jarm).toBe(expected.jarm);
  expect(observation.jarmKeys).toEqual(expected.jarmKeys);
  expect(observation.jarmValid).toBe(expected.jarmValid);
  expect(observation.jarmCodeMatchesPersisted).toBe(expected.jarmCodeMatchesPersisted);
  expect(observation.codeIssued).toBe(expected.codeIssued);
  expect(observation.challengeType).toBe(expected.challengeType);
  expect(observation.parReadAttempted).toBe(expected.parReadAttempted);
  expect(observation.parConsumed).toBe(expected.parConsumed);
  expect(observation.sessionReadAttempted).toBe(expected.sessionReadAttempted);
  expect(observation.sessionBindingRejected).toBe(expected.sessionBindingRejected);
  expect(observation.foreignTenantAccess).toBe(expected.foreignTenantAccess);
  expect(observation.secretLeak).toBe(expected.secretLeak);

  expect(run.codeRecordCount).toBe(expected.codeIssued ? 1 : 0);
  expect(run.challengeRecords.length).toBe(expected.challengeType !== null ? 1 : 0);
  if (expected.codeIssued) {
    expect(codeRecordCountOf(kit)).toBe(1);
  }
}

function corruptObservation(observation: ProtoObservation, domain: string): ProtoObservation {
  switch (domain) {
    case 'status':
      return { ...observation, status: observation.status === 400 ? 302 : 400 };
    case 'error':
      return {
        ...observation,
        error: observation.error === null ? 'login_required' : `${observation.error}-mutated`,
      };
    case 'redirect':
      return {
        ...observation,
        target: observation.target === null ? ATTACKER_REDIRECT : `${observation.target}/mutated`,
      };
    case 'form-action':
      return {
        ...observation,
        formAction:
          observation.formAction === null ? ATTACKER_REDIRECT : `${observation.formAction}/mutated`,
        target:
          observation.formAction === null ? ATTACKER_REDIRECT : `${observation.formAction}/mutated`,
      };
    case 'jarm':
      return {
        ...observation,
        jarm: !observation.jarm,
        jarmKeys: observation.jarm ? [] : ['aud', 'exp', 'iat', 'iss'],
        jarmValid: !observation.jarmValid,
      };
    case 'challenge':
      return { ...observation, challengeType: observation.challengeType === null ? 'login' : null };
    case 'code':
      return {
        ...observation,
        codeIssued: !observation.codeIssued,
        hasCode: !observation.hasCode,
        jarmCodeMatchesPersisted: !observation.jarmCodeMatchesPersisted,
      };
    case 'par':
      return { ...observation, parConsumed: !observation.parConsumed };
    case 'tenant-ledger':
      return { ...observation, foreignTenantAccess: !observation.foreignTenantAccess };
    case 'secrets':
      return { ...observation, secretLeak: !observation.secretLeak };
    default:
      throw new Error(`Unknown corruption domain: ${domain}`);
  }
}

describe('authorize-matrix protocol suite (Matrix B)', () => {
  let kit: SecurityMatrixEnvKit;
  let app: Hono<{ Bindings: Env }>;
  let fixedKeys: { privatePem: string; kid: string; publicJwk: Record<string, unknown> };
  let jwksJson: string;

  beforeEach(async () => {
    installFrozenNow(1700000000);
    const ledger = new CallLedger();
    kit = await createSecurityMatrixEnv(ledger);
    seedRegionShardConfig(kit, MATRIX_TENANT);
    (kit.env as unknown as Record<string, unknown>).ENABLE_CONFORMANCE_MODE = 'true';
    app = createMatrixAuthorizeApp(kit, { tenantId: MATRIX_TENANT });
    const keys = await getFixedSigningKeySet();
    fixedKeys = { privatePem: keys.privatePem, kid: keys.kid, publicJwk: keys.publicJwk };
    jwksJson = JSON.stringify({ keys: [keys.publicJwk] });
  });

  afterEach(() => {
    restoreRealClock();
  });

  for (const entry of PROTO_CASE_TABLE) {
    it(`${entry.id} ${entry.title}`, async () => {
      expect.hasAssertions();
      const row = entry.dimensions as Row;
      const expected = observationFromDecision(decideProtocol(row), row);
      const run = await runProtoRow(kit, app, row, fixedKeys, jwksJson);
      assertRowAgainstProduction(expected, run, kit);
    });
  }

  it('proto-boundary-001 a valid PAR is consumed only after the user authorizes', async () => {
    expect.hasAssertions();
    const row: Row = {
      source: 'par',
      containerState: 'par-valid',
      clientType: 'confidential',
      clientBinding: 'request-tenant',
      pkce: 'valid',
      responseType: 'code',
      responseMode: 'query',
      redirectValid: 'registered',
      jarmRequirement: 'none',
      phase: 'post-validation',
      sessionBinding: 'active-request-tenant',
    };
    const expected = observationFromDecision(decideProtocol(row), row);
    expect(expected.codeIssued).toBe(true);
    const run = await runProtoRow(kit, app, row, fixedKeys, jwksJson);
    assertRowAgainstProduction(expected, run, kit);
    expect(run.parReadAttempted).toBe(true);
    expect(run.parConsumed).toBe(true);
    expect(run.issuedCode).not.toBeNull();
  });

  it('proto-boundary-002 displaying login UI does not consume a valid PAR', async () => {
    expect.hasAssertions();
    const row: Row = {
      source: 'par',
      containerState: 'par-valid',
      clientType: 'confidential',
      clientBinding: 'request-tenant',
      pkce: 'valid',
      responseType: 'code',
      responseMode: 'query',
      redirectValid: 'registered',
      jarmRequirement: 'none',
      phase: 'post-validation',
      sessionBinding: 'n-a',
    };
    const expected = observationFromDecision(decideProtocol(row), row);
    expect(expected.challengeType).toBe('login');
    const run = await runProtoRow(kit, app, row, fixedKeys, jwksJson);
    assertRowAgainstProduction(expected, run, kit);
    expect(run.parReadAttempted).toBe(true);
    expect(run.parConsumed).toBe(false);
  });

  it('proto-boundary-003 a valid signed JAR reaches the authorization flow', async () => {
    expect.hasAssertions();
    const row: Row = {
      source: 'jar',
      containerState: 'jar-valid',
      clientType: 'confidential',
      clientBinding: 'request-tenant',
      pkce: 'valid',
      responseType: 'code',
      responseMode: 'query',
      redirectValid: 'registered',
      jarmRequirement: 'none',
      phase: 'post-validation',
      sessionBinding: 'active-request-tenant',
    };
    const expected = observationFromDecision(decideProtocol(row), row);
    expect(expected.codeIssued).toBe(true);
    const run = await runProtoRow(kit, app, row, fixedKeys, jwksJson);
    assertRowAgainstProduction(expected, run, kit);
    expect(run.issuedCode).not.toBeNull();
    expect(run.parReadAttempted).toBe(false);
    expect(run.parConsumed).toBe(false);
  });

  it('proto-boundary-004 JARM requirement is enforced and honored', async () => {
    expect.hasAssertions();
    // Required + non-JWT mode: the JARM gate rejects before any session read.
    const rejected: Row = {
      source: 'direct',
      containerState: 'n-a',
      clientType: 'confidential',
      clientBinding: 'request-tenant',
      pkce: 'valid',
      responseType: 'code',
      responseMode: 'query',
      redirectValid: 'registered',
      jarmRequirement: 'required',
      phase: 'post-validation',
      sessionBinding: 'active-request-tenant',
    };
    const rejectedRun = await runProtoRow(kit, app, rejected, fixedKeys, jwksJson);
    expect(rejectedRun.observation.status).toBe(302);
    expect(rejectedRun.observation.error).toBe('invalid_request');
    expect(rejectedRun.observation.codeIssued).toBe(false);
    expect(rejectedRun.observation.sessionReadAttempted).toBe(false);

    // Required + JWT mode: the JARM response carries the authorization response as a JWT.
    const honored: Row = {
      source: 'direct',
      containerState: 'n-a',
      clientType: 'confidential',
      clientBinding: 'request-tenant',
      pkce: 'valid',
      responseType: 'code',
      responseMode: 'jwt',
      redirectValid: 'registered',
      jarmRequirement: 'required',
      phase: 'post-validation',
      sessionBinding: 'active-request-tenant',
    };
    const honoredRun = await runProtoRow(kit, app, honored, fixedKeys, jwksJson);
    expect(honoredRun.observation.status).toBe(302);
    expect(honoredRun.observation.jarm).toBe(true);
    // The JARM response carries the authorization response as a signed JWT in the
    // `response` parameter; the code is inside the JWT payload, never in query params.
    expect(honoredRun.observation.keys).toEqual(['response']);
    expect(honoredRun.observation.jarmKeys).toContain('code');
    expect(honoredRun.observation.jarmKeys).toContain('state');
    expect(honoredRun.observation.jarmKeys).toContain('iss');
    expect(honoredRun.observation.codeIssued).toBe(true);
  });

  it('proto-boundary-005 PAR failure error redirects are always query-encoded', async () => {
    expect.hasAssertions();
    const row: Row = {
      source: 'par',
      containerState: 'par-expired',
      clientType: 'confidential',
      clientBinding: 'request-tenant',
      pkce: 'valid',
      responseType: 'code',
      responseMode: 'jwt',
      redirectValid: 'registered',
      jarmRequirement: 'none',
      phase: 'request-source',
      sessionBinding: 'n-a',
    };
    const expected = observationFromDecision(decideProtocol(row), row);
    expect(expected.error).toBe('invalid_request_uri');
    expect(expected.jarm).toBe(false);
    const run = await runProtoRow(kit, app, row, fixedKeys, jwksJson);
    assertRowAgainstProduction(expected, run, kit);
    expect(run.observation.jarm).toBe(false);
    expect(run.observation.keys).toEqual(['error', 'error_description', 'iss', 'state']);
  });

  it('proto-boundary-006 form_post success posts exactly to the registered redirect', async () => {
    expect.hasAssertions();
    const row: Row = {
      source: 'direct',
      containerState: 'n-a',
      clientType: 'confidential',
      clientBinding: 'request-tenant',
      pkce: 'valid',
      responseType: 'code',
      responseMode: 'form_post',
      redirectValid: 'registered',
      jarmRequirement: 'none',
      phase: 'post-validation',
      sessionBinding: 'active-request-tenant',
    };
    const expected = observationFromDecision(decideProtocol(row), row);
    expect(expected.bodyKind).toBe('html-form');
    expect(expected.formAction).toBe(REDIRECT_ORIGIN_PATH);
    const run = await runProtoRow(kit, app, row, fixedKeys, jwksJson);
    assertRowAgainstProduction(expected, run, kit);
    // The form submission target must be exactly the registered redirect URI.
    expect(run.observation.formAction).toBe(REDIRECT_ORIGIN_PATH);
    expect(run.observation.keys).toEqual(['code', 'iss', 'session_state', 'state']);
    expect(run.observation.codeIssued).toBe(true);
  });

  it('proto-boundary-007 form_post error responses never post to an unregistered URI', async () => {
    expect.hasAssertions();
    const row: Row = {
      source: 'direct',
      containerState: 'n-a',
      clientType: 'confidential',
      clientBinding: 'request-tenant',
      pkce: 'malformed',
      responseType: 'code',
      responseMode: 'form_post',
      redirectValid: 'registered',
      jarmRequirement: 'none',
      phase: 'post-validation',
      sessionBinding: 'n-a',
    };
    const expected = observationFromDecision(decideProtocol(row), row);
    expect(expected.error).toBe('invalid_request');
    expect(expected.bodyKind).toBe('html-form');
    expect(expected.formAction).toBe(REDIRECT_ORIGIN_PATH);
    const run = await runProtoRow(kit, app, row, fixedKeys, jwksJson);
    assertRowAgainstProduction(expected, run, kit);
    expect(run.observation.formAction).toBe(REDIRECT_ORIGIN_PATH);
    expect(run.observation.keys).toEqual(['error', 'error_description', 'iss', 'state']);
    expect(run.observation.hasCode).toBe(false);
    expect(run.observation.codeIssued).toBe(false);
  });

  it('covers every legal 2-way tuple of the proto dimensions', () => {
    expect.hasAssertions();
    const covered = new Set<string>();
    for (const entry of PROTO_CASE_TABLE) {
      for (let left = 0; left < PROTO_DIMENSION_ORDER.length - 1; left += 1) {
        for (let right = left + 1; right < PROTO_DIMENSION_ORDER.length; right += 1) {
          const a = PROTO_DIMENSION_ORDER[left];
          const b = PROTO_DIMENSION_ORDER[right];
          covered.add(`${a}=${entry.dimensions[a]}|${b}=${entry.dimensions[b]}`);
        }
      }
    }
    const missing: string[] = [];
    for (let left = 0; left < PROTO_DIMENSION_ORDER.length - 1; left += 1) {
      for (let right = left + 1; right < PROTO_DIMENSION_ORDER.length; right += 1) {
        const a = PROTO_DIMENSION_ORDER[left];
        const b = PROTO_DIMENSION_ORDER[right];
        for (const av of PROTO_VALUES[a]) {
          for (const bv of PROTO_VALUES[b]) {
            if (!isPartialLegal({ [a]: av, [b]: bv }, a, b)) continue;
            const key = `${a}=${av}|${b}=${bv}`;
            if (!covered.has(key)) missing.push(key);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('covers every legal selected triple of the proto dimensions', () => {
    expect.hasAssertions();
    const covered = new Set<string>();
    for (const entry of PROTO_CASE_TABLE) {
      for (const [a, b, c] of PROTO_SELECTED_TRIPLES) {
        covered.add(
          `${a}=${entry.dimensions[a]}|${b}=${entry.dimensions[b]}|${c}=${entry.dimensions[c]}`
        );
      }
    }
    const missing: string[] = [];
    for (const [a, b, c] of PROTO_SELECTED_TRIPLES) {
      for (const av of PROTO_VALUES[a]) {
        for (const bv of PROTO_VALUES[b]) {
          for (const cv of PROTO_VALUES[c]) {
            if (!isPartialLegal({ [a]: av, [b]: bv, [c]: cv }, a, b, c)) continue;
            const key = `${a}=${av}|${b}=${bv}|${c}=${cv}`;
            if (!covered.has(key)) missing.push(key);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('assigns unique case ids and unique semantic fingerprints', () => {
    expect.hasAssertions();
    const ids = PROTO_CASE_TABLE.map((entry) => entry.id);
    expect(findDuplicateIds(ids)).toEqual([]);
    const fingerprints = PROTO_CASE_TABLE.map((entry) => entry.fingerprint);
    expect(findDuplicateIds(fingerprints)).toEqual([]);
  });

  it('pins the expected covering-array case count', () => {
    expect.hasAssertions();
    expect(PROTO_CASE_TABLE.length).toBe(EXPECTED_PROTO_CASE_COUNT);
  });

  it('every case carries a substantive oracle and a discriminating mutation witness', () => {
    expect.hasAssertions();
    for (const entry of PROTO_CASE_TABLE) {
      const row = entry.dimensions as Row;
      const base = decideProtocol(row);
      const baseSignature = protocolDecisionSignature(base);
      const expected = observationFromDecision(base, row);
      expect(entry.id.length).toBeGreaterThan(0);
      expect(expected.status).toBeGreaterThan(0);
      expect(
        expected.error !== null ||
          expected.challengeType !== null ||
          expected.hasCode ||
          expected.bodyKind !== 'other'
      ).toBe(true);
      expect(entry.mutationIds.length).toBeGreaterThan(0);
      for (const mutationId of entry.mutationIds) {
        const mutant = protocolMutationDecision(row, mutationId);
        expect(
          protocolDecisionSignature(mutant),
          `${entry.id} (${entry.title}) mutation ${mutationId} must change the expected observation`
        ).not.toBe(baseSignature);
      }
    }
  });

  it('oracle sensitivity: locally corrupted observations are rejected for every outcome family', async () => {
    expect.hasAssertions();
    const families = new Map<string, ProtocolCase>();
    for (const entry of PROTO_CASE_TABLE) {
      const decision = decideProtocol(entry.dimensions as Row);
      const family =
        decision.outcome.kind === 'challenge'
          ? `challenge:${decision.outcome.challengeType}`
          : decision.outcome.kind === 'error-redirect'
            ? `error-redirect:${decision.outcome.error}`
            : decision.outcome.kind;
      if (!families.has(family)) families.set(family, entry);
    }
    // Preflight rows extend the representative set to outcome families the covering
    // array never places (code-success via PAR/JAR, the JARM success path, and the
    // PAR-failure redirect path).
    const preflightRows: Array<Row & { name: string }> = [
      {
        name: 'par-code',
        source: 'par',
        containerState: 'par-valid',
        clientType: 'confidential',
        clientBinding: 'request-tenant',
        pkce: 'valid',
        responseType: 'code',
        responseMode: 'query',
        redirectValid: 'registered',
        jarmRequirement: 'none',
        phase: 'post-validation',
        sessionBinding: 'active-request-tenant',
      },
      {
        name: 'jar-code',
        source: 'jar',
        containerState: 'jar-valid',
        clientType: 'confidential',
        clientBinding: 'request-tenant',
        pkce: 'valid',
        responseType: 'code',
        responseMode: 'query',
        redirectValid: 'registered',
        jarmRequirement: 'none',
        phase: 'post-validation',
        sessionBinding: 'active-request-tenant',
      },
      {
        name: 'jarm-code',
        source: 'direct',
        containerState: 'n-a',
        clientType: 'confidential',
        clientBinding: 'request-tenant',
        pkce: 'valid',
        responseType: 'code',
        responseMode: 'jwt',
        redirectValid: 'registered',
        jarmRequirement: 'required',
        phase: 'post-validation',
        sessionBinding: 'active-request-tenant',
      },
      {
        name: 'par-login-ui',
        source: 'par',
        containerState: 'par-valid',
        clientType: 'confidential',
        clientBinding: 'request-tenant',
        pkce: 'valid',
        responseType: 'code',
        responseMode: 'query',
        redirectValid: 'registered',
        jarmRequirement: 'none',
        phase: 'post-validation',
        sessionBinding: 'n-a',
      },
      {
        name: 'par-error-redirect',
        source: 'par',
        containerState: 'par-expired',
        clientType: 'confidential',
        clientBinding: 'request-tenant',
        pkce: 'valid',
        responseType: 'code',
        responseMode: 'jwt',
        redirectValid: 'registered',
        jarmRequirement: 'none',
        phase: 'request-source',
        sessionBinding: 'n-a',
      },
      {
        name: 'form-post-code',
        source: 'direct',
        containerState: 'n-a',
        clientType: 'confidential',
        clientBinding: 'request-tenant',
        pkce: 'valid',
        responseType: 'code',
        responseMode: 'form_post',
        redirectValid: 'registered',
        jarmRequirement: 'none',
        phase: 'post-validation',
        sessionBinding: 'active-request-tenant',
      },
      {
        name: 'form-post-error',
        source: 'direct',
        containerState: 'n-a',
        clientType: 'confidential',
        clientBinding: 'request-tenant',
        pkce: 'malformed',
        responseType: 'code',
        responseMode: 'form_post',
        redirectValid: 'registered',
        jarmRequirement: 'none',
        phase: 'post-validation',
        sessionBinding: 'n-a',
      },
    ];
    const representatives: Array<Row> = [
      ...Array.from(families.values()).map((entry) => entry.dimensions as Row),
      ...preflightRows,
    ];
    const domains = [
      'status',
      'error',
      'redirect',
      'form-action',
      'jarm',
      'challenge',
      'code',
      'par',
      'tenant-ledger',
      'secrets',
    ];
    let verified = 0;
    for (const row of representatives) {
      const fresh = await createFreshKitApp();
      const expected = observationFromDecision(decideProtocol(row), row);
      const run = await runProtoRow(fresh.kit, fresh.app, row, fixedKeys, jwksJson);
      expect(observationsMatch(run.observation, expected)).toBe(true);
      for (const domain of domains) {
        const corrupted = corruptObservation(expected, domain);
        expect(observationsMatch(corrupted, expected)).toBe(false);
      }
      verified += 1;
    }
    expect(verified).toBeGreaterThanOrEqual(7);
  });

  it('jarm oracle sensitivity: broken signatures and claims are rejected', async () => {
    expect.hasAssertions();
    const row: Row = {
      source: 'direct',
      containerState: 'n-a',
      clientType: 'confidential',
      clientBinding: 'request-tenant',
      pkce: 'valid',
      responseType: 'code',
      responseMode: 'jwt',
      redirectValid: 'registered',
      jarmRequirement: 'required',
      phase: 'post-validation',
      sessionBinding: 'active-request-tenant',
    };
    const fresh = await createFreshKitApp();
    const run = await runProtoRow(fresh.kit, fresh.app, row, fixedKeys, jwksJson);
    expect(run.jarmToken).not.toBeNull();
    const token = run.jarmToken!;
    expect(run.observation.jarmValid).toBe(true);
    expect(run.observation.jarmCodeMatchesPersisted).toBe(true);

    const verify = (candidate: string): Promise<JarmVerification> =>
      verifyJarmToken(candidate, CLIENT_A, fixedKeys.publicJwk);
    const signWith = async (claims: Record<string, unknown>): Promise<string> => {
      const privateKey = (await importPKCS8(fixedKeys.privatePem, 'RS256')) as CryptoKey;
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', typ: 'oauth-authz-resp+jwt', kid: fixedKeys.kid })
        .sign(privateKey);
    };
    const parts = token.split('.');
    expect(parts).toHaveLength(3);

    // Broken signature: tamper the signature segment (flip the first base64url
    // character so the decoded signature bytes actually change).
    const tamperedSignature = `${parts[0]}.${parts[1]}.${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
    expect((await verify(tamperedSignature)).valid).toBe(false);

    // Broken header alg: resign with ES256 while keeping RS256 claims.
    const ecKeyPair = (await crypto.subtle.generateKey(
      {
        name: 'ECDSA',
        namedCurve: 'P-256',
      },
      true,
      ['sign', 'verify']
    )) as CryptoKeyPair;
    const ecPem = await exportPKCS8(ecKeyPair.privateKey);
    const ecKey = (await importPKCS8(ecPem, 'ES256')) as CryptoKey;
    const wrongAlg = await new SignJWT(
      JSON.parse(
        Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
      ) as Record<string, unknown>
    )
      .setProtectedHeader({ alg: 'ES256', typ: 'oauth-authz-resp+jwt', kid: 'ec-kid' })
      .sign(ecKey);
    expect((await verify(wrongAlg)).valid).toBe(false);

    // Wrong iss, wrong aud, wrong state, and expiry anomalies: correctly signed with the
    // fixed key but carrying claims that violate the production contract.
    const baseClaims = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    ) as Record<string, unknown>;
    expect(
      (await verify(await signWith({ ...baseClaims, iss: 'https://evil.example' }))).valid
    ).toBe(false);
    expect(
      (await verify(await signWith({ ...baseClaims, aud: 'matrix-other-client' }))).valid
    ).toBe(false);
    expect((await verify(await signWith({ ...baseClaims, state: 'st_wrong' }))).valid).toBe(false);
    expect(
      (await verify(await signWith({ ...baseClaims, exp: baseClaims.iat as number }))).valid
    ).toBe(false);
    expect(
      (await verify(await signWith({ ...baseClaims, exp: (baseClaims.iat as number) - 1 }))).valid
    ).toBe(false);
    expect(
      (await verify(await signWith({ ...baseClaims, exp: (baseClaims.iat as number) + 1 }))).valid
    ).toBe(false);
    // The unmodified real token still verifies.
    expect((await verify(token)).valid).toBe(true);
  });

  it('reproduces the reviewer binary coverage golden counts independently', () => {
    expect.hasAssertions();
    const issues = runBinaryGoldenChecks();
    expect(issues).toEqual([]);
  });
});

/** Create a fresh kit and app so multiple rows can run independently in one test. */
async function createFreshKitApp(): Promise<{
  kit: SecurityMatrixEnvKit;
  app: Hono<{ Bindings: Env }>;
}> {
  const freshKit = await createSecurityMatrixEnv(new CallLedger());
  seedRegionShardConfig(freshKit, MATRIX_TENANT);
  (freshKit.env as unknown as Record<string, unknown>).ENABLE_CONFORMANCE_MODE = 'true';
  return { kit: freshKit, app: createMatrixAuthorizeApp(freshKit, { tenantId: MATRIX_TENANT }) };
}

/**
 * Independent legality check for partial rows (pair/triple coverage meta tests).
 * The uncovered dimensions are varied over their full domains: a partial row is legal
 * when at least one completion satisfies every constraint.
 */
function isPartialLegal(partial: Row, ...fixed: string[]): boolean {
  const free = PROTO_DIMENSION_ORDER.filter((dimension) => !fixed.includes(dimension));
  return walk(0);
  function walk(depth: number): boolean {
    if (depth === free.length) {
      return PROTO_CONSTRAINTS.every((constraint) => constraint(partial));
    }
    const dimension = free[depth];
    for (const value of PROTO_VALUES[dimension]) {
      const previous = partial[dimension];
      partial[dimension] = value;
      if (walk(depth + 1)) {
        partial[dimension] = previous;
        return true;
      }
      partial[dimension] = previous;
    }
    return false;
  }
}
