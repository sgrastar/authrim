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
import {
  installFrozenNow,
  restoreRealClock,
  frozenNowEpochSeconds,
} from '../fixtures/deterministic-clock';
import { findDuplicateIds } from '../fixtures/case-fingerprint';
import { runBinaryGoldenChecks } from '../fixtures/coverage-verifier';
import type { Row, Scalar } from '../fixtures/covering-array';
import {
  AUTHN_CASE_TABLE,
  AUTHN_CONSTRAINTS,
  AUTHN_DIMENSION_ORDER,
  AUTHN_VALUES,
  AUTHN_SELECTED_TRIPLES,
  authnDecisionSignature,
  authnMutationDecision,
  type AuthnCase,
} from './authn-matrix';
import { decideAuthn, type Outcome, type SideEffects } from './decision';
import {
  AUTH_TIME_EPOCH_SECONDS,
  CLIENT_A,
  TEST_NONCE,
  TEST_SCOPE_WIDE,
  TEST_STATE,
  FOREIGN_TENANT,
  REDIRECT,
  REQUEST_TENANT,
  VALID_CHALLENGE,
  seedClient,
  seedConsentDimension,
  seedSessionDimension,
  seedSsoSettings,
  sessionCookieHeader,
  sessionStoreInstanceName,
} from './seed';

const CLIENT_SECRET_HASH = 'aa6b73af0f9d3bd6a7ec2f8c9f6b4e3d2a1c0b9e8f7d6c5b4a3f2e1d0c9b8a7';
const REDIRECT_ORIGIN_PATH = 'https://client.example/callback';
const SESSION_ACTIVE_ID = 'g1:enam:0:session_matrix_active';
const SESSION_EXPIRED_ID = 'g1:enam:0:session_matrix_expired';
const SESSION_REVOKED_ID = 'g1:enam:0:session_matrix_revoked';
const SESSION_LEGACY_ID = 'g1:enam:0:session_matrix_legacy';
const SESSION_WRONG_TENANT_ID = 'g1:enam:0:session_matrix_wrong_tenant';
const SESSION_STORE_FAILURE_ID = 'g1:enam:0:session_matrix_store_failure';

const AUTHN_SESSION_IDS: Record<string, string> = {
  active: SESSION_ACTIVE_ID,
  expired: SESSION_EXPIRED_ID,
  revoked: SESSION_REVOKED_ID,
  legacy: SESSION_LEGACY_ID,
  'wrong-tenant': SESSION_WRONG_TENANT_ID,
  'store-failure': SESSION_STORE_FAILURE_ID,
};

const PROMPT_REQUEST_VALUES: Record<string, string> = {
  none: 'none',
  login: 'login',
  consent: 'consent',
  select_account: 'select_account',
  'none-invalid': 'none login',
};

const MAX_AGE_REQUEST_VALUES: Record<string, string> = {
  zero: '0',
  within: '120',
  boundary: '60',
  exceeded: '30',
  malformed: 'abc',
};

export interface AuthnObservation {
  status: number;
  error: string | null;
  locationOriginPath: string | null;
  locationQueryKeys: string[];
  state: string | null;
  hasIss: boolean;
  hasChallengeId: boolean;
  codePresent: boolean;
  challengeType: string | null;
  challengeUserId: string | null;
  challengeMetadata: string;
  codeIssued: boolean;
  consentLookup: boolean;
  consentWrite: boolean;
  sessionReadAttempted: boolean;
  sessionReadFailed: boolean;
  sessionBindingRejected: boolean;
  clientSsoReadFailed: boolean;
  tenantSsoReadFailed: boolean;
  foreignTenantAccess: boolean;
  secretLeak: boolean;
}

function rowToDimensions(row: Row): Record<string, Scalar> {
  const result: Record<string, Scalar> = {};
  for (const dimension of AUTHN_DIMENSION_ORDER) {
    result[dimension] = row[dimension];
  }
  return result;
}

function expectedChallengeMetadata(challengeType: string, sessionId: string | undefined): string {
  if (challengeType === 'login') {
    return JSON.stringify({
      clientId: CLIENT_A,
      redirectUri: REDIRECT,
      scope: TEST_SCOPE_WIDE,
      sessionUserId: null,
      authTime: null,
      sessionId: null,
    });
  }
  if (challengeType === 'consent') {
    return JSON.stringify({
      clientId: CLIENT_A,
      redirectUri: REDIRECT,
      scope: TEST_SCOPE_WIDE,
      sessionUserId: TEST_USER,
      authTime: AUTH_TIME_EPOCH_SECONDS,
      sessionId: sessionId ?? null,
    });
  }
  return JSON.stringify({
    clientId: CLIENT_A,
    redirectUri: REDIRECT,
    scope: TEST_SCOPE_WIDE,
    sessionUserId: TEST_USER,
    authTime: AUTH_TIME_EPOCH_SECONDS,
    sessionId: null,
  });
}

/** Expected observation derived ONLY from the independent decision table. */
export function observationFromDecision(
  decision: { outcome: Outcome; sideEffects: SideEffects },
  row: Row,
  sessionId: string | undefined
): AuthnObservation {
  const { outcome, sideEffects } = decision;
  const observation: AuthnObservation = {
    status: 0,
    error: null,
    locationOriginPath: null,
    locationQueryKeys: [],
    state: null,
    hasIss: false,
    hasChallengeId: false,
    codePresent: false,
    challengeType: null,
    challengeUserId: null,
    challengeMetadata: '',
    codeIssued: sideEffects.codeIssued,
    consentLookup: sideEffects.consentLookup,
    consentWrite: sideEffects.consentWrite,
    sessionReadAttempted: sideEffects.sessionReadAttempted,
    sessionReadFailed: sideEffects.sessionReadFailed,
    sessionBindingRejected: sideEffects.sessionBindingRejected,
    clientSsoReadFailed: sideEffects.clientSsoReadFailed,
    tenantSsoReadFailed: sideEffects.tenantSsoReadFailed,
    foreignTenantAccess: false,
    secretLeak: false,
  };
  switch (outcome.kind) {
    case 'direct-error':
      observation.status = outcome.status;
      observation.error = outcome.error;
      break;
    case 'error-redirect':
      observation.status = 302;
      observation.error = outcome.error;
      observation.locationOriginPath = REDIRECT_ORIGIN_PATH;
      observation.locationQueryKeys = ['error', 'error_description', 'iss', 'state'];
      observation.state = TEST_STATE;
      observation.hasIss = true;
      break;
    case 'challenge':
      observation.status = 302;
      observation.locationOriginPath = `${TEST_ISSUER}${outcome.path}`;
      observation.locationQueryKeys = ['challenge_id'];
      observation.hasChallengeId = true;
      observation.challengeType = outcome.challengeType;
      observation.challengeUserId = outcome.challengeType === 'login' ? 'anonymous' : TEST_USER;
      observation.challengeMetadata = expectedChallengeMetadata(outcome.challengeType, sessionId);
      break;
    case 'code-success':
      observation.status = 302;
      observation.locationOriginPath = REDIRECT_ORIGIN_PATH;
      observation.locationQueryKeys =
        row.session === 'active'
          ? ['code', 'iss', 'session_state', 'state']
          : ['code', 'iss', 'state'];
      observation.codePresent = true;
      observation.state = TEST_STATE;
      observation.hasIss = true;
      break;
    case 'html-error':
      observation.status = outcome.status;
      break;
  }
  return observation;
}

function canonicalChallengeMetadata(metadata: Record<string, unknown> | undefined): string {
  const clientId = typeof metadata?.client_id === 'string' ? metadata.client_id : null;
  const redirectUri = typeof metadata?.redirect_uri === 'string' ? metadata.redirect_uri : null;
  const scope = typeof metadata?.scope === 'string' ? metadata.scope : null;
  // Production stores the subject under the camelCase key `sessionUserId` for reauth and
  // consent challenges (authorize.ts:3259, 3722); the login challenge has none.
  const sessionUserId = typeof metadata?.sessionUserId === 'string' ? metadata.sessionUserId : null;
  const authTime = typeof metadata?.authTime === 'number' ? metadata.authTime : null;
  const sessionId = typeof metadata?.session_id === 'string' ? metadata.session_id : null;
  return JSON.stringify({ clientId, redirectUri, scope, sessionUserId, authTime, sessionId });
}

export function observationsMatch(actual: AuthnObservation, expected: AuthnObservation): boolean {
  return (
    actual.status === expected.status &&
    actual.error === expected.error &&
    actual.locationOriginPath === expected.locationOriginPath &&
    actual.locationQueryKeys.join('\u0000') === expected.locationQueryKeys.join('\u0000') &&
    actual.state === expected.state &&
    actual.hasIss === expected.hasIss &&
    actual.hasChallengeId === expected.hasChallengeId &&
    actual.codePresent === expected.codePresent &&
    actual.challengeType === expected.challengeType &&
    actual.challengeUserId === expected.challengeUserId &&
    actual.challengeMetadata === expected.challengeMetadata &&
    actual.codeIssued === expected.codeIssued &&
    actual.consentLookup === expected.consentLookup &&
    actual.consentWrite === expected.consentWrite &&
    actual.sessionReadAttempted === expected.sessionReadAttempted &&
    actual.sessionReadFailed === expected.sessionReadFailed &&
    actual.sessionBindingRejected === expected.sessionBindingRejected &&
    actual.clientSsoReadFailed === expected.clientSsoReadFailed &&
    actual.tenantSsoReadFailed === expected.tenantSsoReadFailed &&
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
      const record = value as {
        type?: unknown;
        userId?: unknown;
        metadata?: unknown;
      };
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
  const instanceName = sessionStoreInstanceName(REQUEST_TENANT, sessionId);
  return kit.sessionStoreNamespace.snapshotStorage(instanceName).has(`session:${sessionId}`);
}

interface LedgerProbe {
  sessionReadAttempted: boolean;
  sessionReadFailed: boolean;
  revocationRpc: boolean;
  clientSsoReadFailed: boolean;
  tenantSsoReadFailed: boolean;
  consentLookup: boolean;
  consentWrite: boolean;
  codeStored: boolean;
  foreignTenantAccess: boolean;
}

function probeLedger(kit: SecurityMatrixEnvKit): LedgerProbe {
  const entries = kit.ledger.all();
  return {
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
    clientSsoReadFailed: entries.some(
      (entry) =>
        entry.kind === 'kv.get' &&
        entry.target.includes('settings:client:') &&
        entry.target.includes(':failed')
    ),
    tenantSsoReadFailed: entries.some(
      (entry) =>
        entry.kind === 'kv.get' &&
        entry.target.includes('settings:tenant:') &&
        entry.target.includes(':failed')
    ),
    consentLookup: entries.some(
      (entry) => entry.kind === 'd1.queryOne' && entry.target.includes('oauth_client_consents')
    ),
    consentWrite: entries.some(
      (entry) =>
        entry.kind === 'd1.execute' && entry.target.includes('INSERT INTO oauth_client_consents')
    ),
    codeStored: entries.some(
      (entry) =>
        entry.kind === 'do.rpc' &&
        entry.target.includes('auth_code') &&
        entry.target.includes('storeCodeRpc')
    ),
    foreignTenantAccess: entries.some((entry) => entry.target.includes(FOREIGN_TENANT)),
  };
}

function surfaceLeaks(
  kit: SecurityMatrixEnvKit,
  secrets: string[],
  bodyText: string,
  location: string | null,
  issuedCode: string | null,
  challengeValue: string | null
): boolean {
  // The response body must never carry any secret. The redirect Location is the only
  // legitimate delivery surface: the issued code (code-success) and the challenge value
  // (challenge_id) are expected there by the protocol and are excluded from that check.
  for (const secret of secrets) {
    if (!secret) continue;
    if (bodyText.includes(secret)) return true;
  }
  if (location) {
    for (const secret of secrets) {
      if (!secret) continue;
      if (secret === issuedCode || secret === challengeValue) continue;
      if (location.includes(secret)) return true;
    }
  }
  const serialized = kit.ledger
    .all()
    .filter((entry) => ['d1.execute', 'kv.put', 'queue.send', 'r2.put'].includes(entry.kind))
    .map((entry) => {
      try {
        return JSON.stringify(entry.detail);
      } catch {
        return String(entry.detail);
      }
    })
    .join('\n');
  for (const secret of secrets) {
    if (!secret) continue;
    if (serialized.includes(secret)) return true;
  }
  return false;
}

interface ProductionRun {
  observation: AuthnObservation;
  bodyText: string;
  location: string | null;
  issuedCode: string | null;
  challengeValue: string | null;
  sessionId: string | undefined;
  codeRecordCount: number;
  challengeRecords: Array<{ type: string; userId: string; metadata: Record<string, unknown> }>;
}

function requestQueryFor(row: Row): Record<string, string> {
  const query: Record<string, string> = {
    client_id: CLIENT_A,
    response_type: 'code',
    redirect_uri: REDIRECT,
    scope: TEST_SCOPE_WIDE,
    state: TEST_STATE,
    nonce: TEST_NONCE,
    code_challenge: VALID_CHALLENGE,
    code_challenge_method: 'S256',
  };
  const prompt = String(row.prompt);
  if (prompt !== 'omitted') {
    query.prompt = PROMPT_REQUEST_VALUES[prompt] ?? prompt;
  }
  const maxAge = String(row.maxAge);
  if (maxAge !== 'omitted') {
    query.max_age = MAX_AGE_REQUEST_VALUES[maxAge] ?? maxAge;
  }
  return query;
}

function seedRowState(kit: SecurityMatrixEnvKit, row: Row): void {
  seedClient(kit, { clientId: CLIENT_A, scope: TEST_SCOPE_WIDE });
  seedSsoSettings(kit, CLIENT_A, String(row.clientSso), String(row.tenantSso));
  seedConsentDimension(kit, CLIENT_A, String(row.consent));
}

function sessionIdFor(session: string): string | undefined {
  return AUTHN_SESSION_IDS[session] ?? undefined;
}

/** Seed the row state and run the real authorizeHandler, returning the observed outcome. */
async function runAuthnRow(
  kit: SecurityMatrixEnvKit,
  app: Hono<{ Bindings: Env }>,
  row: Row
): Promise<ProductionRun> {
  seedRowState(kit, row);
  const session = String(row.session);
  const sessionId = sessionIdFor(session);
  if (sessionId) {
    await seedSessionDimension(kit, session);
  }
  kit.ledger.reset();

  const query = requestQueryFor(row);
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
  let challengeValue: string | null = null;
  let locationOriginPath: string | null = null;
  const locationQueryKeys: string[] = [];
  let state: string | null = null;
  let hasIss = false;
  let hasChallengeId = false;
  let codePresent = false;

  if (location) {
    const parsed = new URL(location, TEST_ISSUER);
    locationOriginPath = parsed.origin + parsed.pathname;
    for (const key of parsed.searchParams.keys()) locationQueryKeys.push(key);
    error = parsed.searchParams.get('error');
    state = parsed.searchParams.get('state');
    hasIss = parsed.searchParams.has('iss');
    hasChallengeId = parsed.searchParams.has('challenge_id');
    codePresent = parsed.searchParams.has('code');
    issuedCode = parsed.searchParams.get('code');
    challengeValue = parsed.searchParams.get('challenge_id');
  } else if (response.headers.get('content-type')?.includes('application/json')) {
    try {
      const parsedBody = JSON.parse(bodyText) as { error?: string };
      error = parsedBody.error ?? null;
    } catch {
      error = null;
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

  const secrets: string[] = [];
  if (issuedCode) secrets.push(issuedCode);
  if (challengeValue) secrets.push(challengeValue);
  if (sessionId) secrets.push(sessionId);
  secrets.push(CLIENT_SECRET_HASH);

  const observation: AuthnObservation = {
    status: response.status,
    error,
    locationOriginPath,
    locationQueryKeys: locationQueryKeys.sort(),
    state,
    hasIss,
    hasChallengeId,
    codePresent,
    challengeType: challengeRecords.length === 1 ? challengeRecords[0].type : null,
    challengeUserId: challengeRecords.length === 1 ? challengeRecords[0].userId : null,
    challengeMetadata:
      challengeRecords.length === 1 ? canonicalChallengeMetadata(challengeRecords[0].metadata) : '',
    codeIssued: codeRecordCount > 0,
    consentLookup: ledgerProbe.consentLookup,
    consentWrite: ledgerProbe.consentWrite,
    sessionReadAttempted: ledgerProbe.sessionReadAttempted,
    sessionReadFailed: ledgerProbe.sessionReadFailed,
    sessionBindingRejected,
    clientSsoReadFailed: ledgerProbe.clientSsoReadFailed,
    tenantSsoReadFailed: ledgerProbe.tenantSsoReadFailed,
    foreignTenantAccess: ledgerProbe.foreignTenantAccess,
    secretLeak: surfaceLeaks(kit, secrets, bodyText, location, issuedCode, challengeValue),
  };

  return {
    observation,
    bodyText,
    location,
    issuedCode,
    challengeValue,
    sessionId,
    codeRecordCount,
    challengeRecords,
  };
}

function assertRowAgainstProduction(
  expected: AuthnObservation,
  run: ProductionRun,
  kit: SecurityMatrixEnvKit
): void {
  const observation = run.observation;
  expect(observation.status).toBe(expected.status);
  expect(observation.error).toBe(expected.error);
  expect(observation.locationOriginPath).toBe(expected.locationOriginPath);
  expect(observation.locationQueryKeys).toEqual(expected.locationQueryKeys);
  expect(observation.state).toBe(expected.state);
  expect(observation.hasIss).toBe(expected.hasIss);
  expect(observation.hasChallengeId).toBe(expected.hasChallengeId);
  expect(observation.codePresent).toBe(expected.codePresent);
  expect(observation.challengeType).toBe(expected.challengeType);
  expect(observation.challengeUserId).toBe(expected.challengeUserId);
  expect(observation.challengeMetadata).toBe(expected.challengeMetadata);
  expect(observation.codeIssued).toBe(expected.codeIssued);
  expect(observation.consentLookup).toBe(expected.consentLookup);
  expect(observation.consentWrite).toBe(expected.consentWrite);
  expect(observation.sessionReadAttempted).toBe(expected.sessionReadAttempted);
  expect(observation.sessionReadFailed).toBe(expected.sessionReadFailed);
  expect(observation.sessionBindingRejected).toBe(expected.sessionBindingRejected);
  expect(observation.clientSsoReadFailed).toBe(expected.clientSsoReadFailed);
  expect(observation.tenantSsoReadFailed).toBe(expected.tenantSsoReadFailed);
  expect(observation.foreignTenantAccess).toBe(expected.foreignTenantAccess);
  expect(observation.secretLeak).toBe(expected.secretLeak);

  // Durable side-effect counts: an authorization code record exists exactly when issued,
  // and a challenge record exists exactly when a challenge was stored.
  expect(run.codeRecordCount).toBe(expected.codeIssued ? 1 : 0);
  expect(run.challengeRecords.length).toBe(expected.challengeType !== null ? 1 : 0);

  if (expected.codeIssued) {
    // The code was stored exactly once in the session-sticky auth-code shard.
    expect(codeRecordCountOf(kit)).toBe(1);
  }
}

function corruptObservation(observation: AuthnObservation, domain: string): AuthnObservation {
  switch (domain) {
    case 'status':
      return { ...observation, status: observation.status === 400 ? 302 : 400 };
    case 'error':
      return {
        ...observation,
        error: observation.error === null ? 'login_required' : `${observation.error}-mutated`,
      };
    case 'location':
      return {
        ...observation,
        locationOriginPath:
          observation.locationOriginPath === null
            ? 'https://attacker.example/callback'
            : `${observation.locationOriginPath}/mutated`,
      };
    case 'challenge':
      return {
        ...observation,
        challengeType: observation.challengeType === 'login' ? 'consent' : 'login',
      };
    case 'code':
      return {
        ...observation,
        codeIssued: !observation.codeIssued,
        codePresent: !observation.codePresent,
      };
    case 'consent':
      return { ...observation, consentLookup: !observation.consentLookup };
    case 'session':
      return { ...observation, sessionReadAttempted: !observation.sessionReadAttempted };
    case 'tenant-ledger':
      return { ...observation, foreignTenantAccess: !observation.foreignTenantAccess };
    case 'secrets':
      return { ...observation, secretLeak: !observation.secretLeak };
    default:
      throw new Error(`Unknown corruption domain: ${domain}`);
  }
}

/** Create a fresh kit and app so multiple rows can run independently in one test. */
async function createFreshKitApp(): Promise<{
  kit: SecurityMatrixEnvKit;
  app: Hono<{ Bindings: Env }>;
}> {
  const freshKit = await createSecurityMatrixEnv(new CallLedger());
  seedRegionShardConfig(freshKit);
  (freshKit.env as unknown as Record<string, unknown>).ENABLE_CONFORMANCE_MODE = 'true';
  return { kit: freshKit, app: createMatrixAuthorizeApp(freshKit) };
}

describe('authorize-matrix authn protocol suite', () => {
  let kit: SecurityMatrixEnvKit;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(async () => {
    installFrozenNow(1700000000);
    const ledger = new CallLedger();
    kit = await createSecurityMatrixEnv(ledger);
    seedRegionShardConfig(kit);
    (kit.env as unknown as Record<string, unknown>).ENABLE_CONFORMANCE_MODE = 'true';
    app = createMatrixAuthorizeApp(kit);
  });

  afterEach(() => {
    restoreRealClock();
  });

  for (const entry of AUTHN_CASE_TABLE) {
    it(`${entry.id} ${entry.title}`, async () => {
      expect.hasAssertions();
      const row = entry.dimensions as Row;
      const expected = observationFromDecision(
        decideAuthn(row),
        row,
        sessionIdFor(String(row.session))
      );
      const run = await runAuthnRow(kit, app, row);
      assertRowAgainstProduction(expected, run, kit);
    });
  }

  it('authn-boundary-001 max_age exact boundary is judged by an independent time computation', async () => {
    expect.hasAssertions();
    // Independent arithmetic: the seeded authTime is 60s before the frozen epoch, so a
    // boundary max_age of 60s is exactly the auth age and MUST NOT force reauthentication.
    const authAge = frozenNowEpochSeconds() - AUTH_TIME_EPOCH_SECONDS;
    expect(authAge).toBe(60);

    const row: Row = {
      clientSso: 'true',
      tenantSso: 'default',
      session: 'active',
      prompt: 'omitted',
      maxAge: 'boundary',
      consent: 'sufficient',
    };
    const expected = observationFromDecision(decideAuthn(row), row, SESSION_ACTIVE_ID);
    expect(expected.challengeType).toBeNull();
    const run = await runAuthnRow(kit, app, row);
    expect(run.observation.challengeType).toBeNull();
    expect(run.observation.status).toBe(302);
    expect(run.observation.locationOriginPath).toBe(REDIRECT_ORIGIN_PATH);
    expect(run.observation.codePresent).toBe(true);
    expect(run.observation.codeIssued).toBe(true);
  });

  it('authn-boundary-002 tenant SSO inheritance and client explicit priority', async () => {
    expect.hasAssertions();
    // clientSso=default inherits the tenant setting: tenant SSO enabled yields an SSO
    // session (code issued on a usable session with sufficient consent).
    const inherited: Row = {
      clientSso: 'default',
      tenantSso: 'true',
      session: 'active',
      prompt: 'omitted',
      maxAge: 'omitted',
      consent: 'sufficient',
    };
    const inheritedEnv = await createFreshKitApp();
    const inheritedRun = await runAuthnRow(inheritedEnv.kit, inheritedEnv.app, inherited);
    expect(inheritedRun.observation.codeIssued).toBe(true);
    expect(inheritedRun.observation.sessionReadAttempted).toBe(true);

    // A client-explicit false overrides the tenant true: the session is NOT reused.
    const overridden: Row = {
      clientSso: 'false',
      tenantSso: 'true',
      session: 'active',
      prompt: 'omitted',
      maxAge: 'omitted',
      consent: 'sufficient',
    };
    const overriddenEnv = await createFreshKitApp();
    const overriddenRun = await runAuthnRow(overriddenEnv.kit, overriddenEnv.app, overridden);
    expect(overriddenRun.observation.codeIssued).toBe(false);
    expect(overriddenRun.observation.challengeType).toBe('login');
    expect(overriddenRun.observation.sessionReadAttempted).toBe(true);
  });

  it('authn-boundary-003 prompt=consent always forces the consent challenge', async () => {
    expect.hasAssertions();
    // Sufficient consent is ignored under prompt=consent: a consent challenge is stored
    // and no code is issued.
    const sufficient: Row = {
      clientSso: 'true',
      tenantSso: 'default',
      session: 'active',
      prompt: 'consent',
      maxAge: 'omitted',
      consent: 'sufficient',
    };
    const sufficientEnv = await createFreshKitApp();
    const sufficientRun = await runAuthnRow(sufficientEnv.kit, sufficientEnv.app, sufficient);
    expect(sufficientRun.observation.challengeType).toBe('consent');
    expect(sufficientRun.observation.codeIssued).toBe(false);
    expect(sufficientRun.observation.consentLookup).toBe(true);
    expect(sufficientRun.observation.consentWrite).toBe(false);

    // Trusted auto-grant is suppressed under prompt=consent: no consent write, no code.
    const trusted: Row = {
      clientSso: 'true',
      tenantSso: 'default',
      session: 'active',
      prompt: 'consent',
      maxAge: 'omitted',
      consent: 'auto-grant',
    };
    const trustedEnv = await createFreshKitApp();
    const trustedRun = await runAuthnRow(trustedEnv.kit, trustedEnv.app, trusted);
    expect(trustedRun.observation.challengeType).toBe('consent');
    expect(trustedRun.observation.codeIssued).toBe(false);
    expect(trustedRun.observation.consentWrite).toBe(false);
  });

  it('authn-boundary-004 tenant SSO lookup failure is ledger-observable and fails to default', async () => {
    expect.hasAssertions();
    // tenantSso=failure behaves like the tenant default (disabled) while the failed KV
    // read stays observable in the settings ledger.
    const row: Row = {
      clientSso: 'default',
      tenantSso: 'failure',
      session: 'active',
      prompt: 'omitted',
      maxAge: 'omitted',
      consent: 'sufficient',
    };
    const fresh = await createFreshKitApp();
    const run = await runAuthnRow(fresh.kit, fresh.app, row);
    expect(run.observation.tenantSsoReadFailed).toBe(true);
    expect(run.observation.codeIssued).toBe(false);
    expect(run.observation.challengeType).toBe('login');
  });

  it('covers every legal 2-way tuple of the authn dimensions', () => {
    expect.hasAssertions();
    const covered = new Set<string>();
    for (const entry of AUTHN_CASE_TABLE) {
      for (let left = 0; left < AUTHN_DIMENSION_ORDER.length - 1; left += 1) {
        for (let right = left + 1; right < AUTHN_DIMENSION_ORDER.length; right += 1) {
          const a = AUTHN_DIMENSION_ORDER[left];
          const b = AUTHN_DIMENSION_ORDER[right];
          covered.add(`${a}=${entry.dimensions[a]}|${b}=${entry.dimensions[b]}`);
        }
      }
    }
    const missing: string[] = [];
    for (let left = 0; left < AUTHN_DIMENSION_ORDER.length - 1; left += 1) {
      for (let right = left + 1; right < AUTHN_DIMENSION_ORDER.length; right += 1) {
        const a = AUTHN_DIMENSION_ORDER[left];
        const b = AUTHN_DIMENSION_ORDER[right];
        for (const av of AUTHN_VALUES[a]) {
          for (const bv of AUTHN_VALUES[b]) {
            const partial: Row = { [a]: av, [b]: bv };
            if (!isPartialLegal(partial, a, b)) continue;
            const key = `${a}=${av}|${b}=${bv}`;
            if (!covered.has(key)) missing.push(key);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('covers every legal selected triple of the authn dimensions', () => {
    expect.hasAssertions();
    const covered = new Set<string>();
    for (const entry of AUTHN_CASE_TABLE) {
      for (const [a, b, c] of AUTHN_SELECTED_TRIPLES) {
        covered.add(
          `${a}=${entry.dimensions[a]}|${b}=${entry.dimensions[b]}|${c}=${entry.dimensions[c]}`
        );
      }
    }
    const missing: string[] = [];
    for (const [a, b, c] of AUTHN_SELECTED_TRIPLES) {
      for (const av of AUTHN_VALUES[a]) {
        for (const bv of AUTHN_VALUES[b]) {
          for (const cv of AUTHN_VALUES[c]) {
            const partial: Row = { [a]: av, [b]: bv, [c]: cv };
            if (!isPartialLegal(partial, a, b, c)) continue;
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
    const ids = AUTHN_CASE_TABLE.map((entry) => entry.id);
    expect(findDuplicateIds(ids)).toEqual([]);
    const fingerprints = AUTHN_CASE_TABLE.map((entry) => entry.fingerprint);
    expect(findDuplicateIds(fingerprints)).toEqual([]);
  });

  it('every case carries a substantive oracle and a discriminating mutation witness', () => {
    expect.hasAssertions();
    for (const entry of AUTHN_CASE_TABLE) {
      const row = entry.dimensions as Row;
      const base = decideAuthn(row);
      const baseSignature = authnDecisionSignature(base);
      const expected = observationFromDecision(base, row, sessionIdFor(String(row.session)));
      // Substantive oracle: every row pins a concrete observable outcome.
      expect(entry.id.length).toBeGreaterThan(0);
      expect(expected.status).toBeGreaterThan(0);
      expect(
        expected.error !== null ||
          expected.challengeType !== null ||
          expected.codePresent ||
          expected.hasChallengeId
      ).toBe(true);
      // Mutation witness: each declared mutation id changes the expected observation.
      expect(entry.mutationIds.length).toBeGreaterThan(0);
      for (const mutationId of entry.mutationIds) {
        const mutant = authnMutationDecision(row, mutationId);
        expect(
          authnDecisionSignature(mutant),
          `${entry.id} (${entry.title}) mutation ${mutationId} must change the expected observation`
        ).not.toBe(baseSignature);
      }
    }
  });

  it('oracle sensitivity: locally corrupted observations are rejected for every outcome family', async () => {
    expect.hasAssertions();
    const families = new Map<string, AuthnCase>();
    for (const entry of AUTHN_CASE_TABLE) {
      const decision = decideAuthn(entry.dimensions as Row);
      const family =
        decision.outcome.kind === 'challenge'
          ? `challenge:${decision.outcome.challengeType}`
          : decision.outcome.kind === 'error-redirect'
            ? `error-redirect:${decision.outcome.error}`
            : decision.outcome.kind;
      if (!families.has(family)) families.set(family, entry);
    }
    const domains = [
      'status',
      'error',
      'location',
      'challenge',
      'code',
      'consent',
      'session',
      'tenant-ledger',
      'secrets',
    ];
    let verified = 0;
    for (const entry of families.values()) {
      const row = entry.dimensions as Row;
      const fresh = await createFreshKitApp();
      const expected = observationFromDecision(
        decideAuthn(row),
        row,
        sessionIdFor(String(row.session))
      );
      const run = await runAuthnRow(fresh.kit, fresh.app, row);
      // The oracle accepts the real observation...
      expect(observationsMatch(run.observation, expected)).toBe(true);
      // ...and rejects every locally corrupted domain.
      for (const domain of domains) {
        const corrupted = corruptObservation(expected, domain);
        expect(observationsMatch(corrupted, expected)).toBe(false);
      }
      verified += 1;
    }
    expect(verified).toBeGreaterThanOrEqual(7);
  });

  it('reproduces the reviewer binary coverage golden counts independently', () => {
    expect.hasAssertions();
    const issues = runBinaryGoldenChecks();
    expect(issues).toEqual([]);
  });
});

/**
 * Independent legality check for partial rows (pair/triple coverage meta tests).
 * The uncovered dimensions are varied over their full domains: a partial row is legal
 * when at least one completion satisfies every constraint.
 */
function isPartialLegal(partial: Row, ...fixed: string[]): boolean {
  const free = AUTHN_DIMENSION_ORDER.filter((dimension) => !fixed.includes(dimension));
  return walk(0);
  function walk(depth: number): boolean {
    if (depth === free.length) {
      return AUTHN_CONSTRAINTS.every((constraint) => constraint(partial));
    }
    const dimension = free[depth];
    for (const value of AUTHN_VALUES[dimension]) {
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
