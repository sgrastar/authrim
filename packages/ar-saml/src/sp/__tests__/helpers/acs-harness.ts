/**
 * Response builder, environment and caller for exercising handleSPACS. The module mocks live in
 * each test file; this module only builds inputs.
 */

import { vi } from 'vitest';
import { buildPolicyConstrainedRegionShardConfig, type Env } from '@authrim/ar-lib-core';
import { handleSPACS } from '../../acs';
import { buildSAMLRequestBindingCookie } from '../../request-browser-binding';

export const REQUEST_ID = `_${'a'.repeat(32)}`;
export const ACS_URL = 'https://auth.example.com/saml/sp/acs';
export const SP_AUDIENCE = 'https://auth.example.com/saml/sp/metadata';
export const IDP_ENTITY = 'https://idp.example.com';
export const NOW = Date.parse('2026-06-01T12:00:00Z');
export const SKEW_MS = 60_000;

export const TEST_REGION_CONFIG = buildPolicyConstrainedRegionShardConfig({
  residency: {
    version: 1,
    residencyPolicyId: 'test-residency',
    residencyPartition: 'default',
    policyGeneration: 1,
    allowedRegions: ['apac'],
    jurisdiction: null,
  },
  totalShards: 1,
  now: 1,
  updatedBy: 'test',
});

export interface ResponseOptions {
  inResponseTo?: string | null;
  destination?: string | null;
  statusCode?: string;
  statusMessage?: string;
  responseIssuer?: string | null;
  assertionIssuer?: string | null;
  responseId?: string | null;
  assertionId?: string | null;
  /** Raw XML placed in the Subject after the NameID (replaces the default SubjectConfirmation). */
  subjectConfirmation?: string | null;
  confirmationMethod?: string | null;
  recipient?: string | null;
  confirmationNotOnOrAfter?: string | null;
  confirmationInResponseTo?: string | null;
  /** null removes the Conditions element. */
  conditions?: {
    notBefore?: string | null;
    notOnOrAfter?: string | null;
    /** One inner array per AudienceRestriction. */
    audienceGroups?: string[][];
    extra?: string;
  } | null;
  authnContextClassRef?: string | null;
  extraAssertionChildren?: string;
  extraResponseChildren?: string;
  nameId?: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function samlResponseXml(options: ResponseOptions = {}): string {
  const inResponseTo = options.inResponseTo === undefined ? REQUEST_ID : options.inResponseTo;
  const responseId = options.responseId === undefined ? '_response_1' : options.responseId;
  const assertionId = options.assertionId === undefined ? '_assertion_1' : options.assertionId;
  const attr = (name: string, value: string | null | undefined) =>
    value === null || value === undefined ? '' : `${name}="${value}"`;
  const destination = options.destination === undefined ? ACS_URL : options.destination;
  const responseIssuer = options.responseIssuer === undefined ? IDP_ENTITY : options.responseIssuer;
  const assertionIssuer =
    options.assertionIssuer === undefined ? IDP_ENTITY : options.assertionIssuer;
  const method =
    options.confirmationMethod === undefined
      ? 'urn:oasis:names:tc:SAML:2.0:cm:bearer'
      : options.confirmationMethod;
  const recipient = options.recipient === undefined ? ACS_URL : options.recipient;
  const confirmationNotOnOrAfter =
    options.confirmationNotOnOrAfter === undefined
      ? iso(NOW + 300_000)
      : options.confirmationNotOnOrAfter;
  const confirmationInResponseTo =
    options.confirmationInResponseTo === undefined
      ? inResponseTo
      : options.confirmationInResponseTo;
  const subjectConfirmation =
    options.subjectConfirmation !== undefined
      ? (options.subjectConfirmation ?? '')
      : `<saml:SubjectConfirmation ${attr('Method', method)}>
        <saml:SubjectConfirmationData ${attr('Recipient', recipient)} ${attr('NotOnOrAfter', confirmationNotOnOrAfter)} ${attr('InResponseTo', confirmationInResponseTo)}/>
      </saml:SubjectConfirmation>`;
  const conditionOptions = options.conditions === undefined ? {} : options.conditions;
  const audienceGroups = conditionOptions?.audienceGroups ?? [[SP_AUDIENCE]];
  const conditions =
    options.conditions === null
      ? ''
      : `<saml:Conditions ${attr('NotBefore', conditionOptions?.notBefore === undefined ? iso(NOW - 60_000) : conditionOptions.notBefore)} ${attr('NotOnOrAfter', conditionOptions?.notOnOrAfter === undefined ? iso(NOW + 300_000) : conditionOptions.notOnOrAfter)}>
      ${audienceGroups
        .map(
          (group) =>
            `<saml:AudienceRestriction>${group.map((audience) => `<saml:Audience>${audience}</saml:Audience>`).join('')}</saml:AudienceRestriction>`
        )
        .join('\n      ')}
      ${conditionOptions?.extra ?? ''}
    </saml:Conditions>`;
  const classRef =
    options.authnContextClassRef === undefined
      ? 'urn:oasis:names:tc:SAML:2.0:ac:classes:Password'
      : options.authnContextClassRef;
  const nameId = options.nameId === undefined ? 'user@example.com' : options.nameId;
  return `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  ${attr('ID', responseId)} Version="2.0" IssueInstant="${iso(NOW)}"
  ${attr('Destination', destination)}
  ${attr('InResponseTo', inResponseTo)}>
  ${responseIssuer === null ? '' : `<saml:Issuer>${responseIssuer}</saml:Issuer>`}
  <ds:Signature><ds:SignedInfo><ds:Reference URI="#${responseId}"/></ds:SignedInfo></ds:Signature>
  <samlp:Status><samlp:StatusCode Value="${options.statusCode ?? 'urn:oasis:names:tc:SAML:2.0:status:Success'}"/>${options.statusMessage ? `<samlp:StatusMessage>${options.statusMessage}</samlp:StatusMessage>` : ''}</samlp:Status>
  ${options.extraResponseChildren ?? ''}
  <saml:Assertion ${attr('ID', assertionId)} Version="2.0" IssueInstant="${iso(NOW)}">
    ${assertionIssuer === null ? '' : `<saml:Issuer>${assertionIssuer}</saml:Issuer>`}
    <saml:Subject>
      ${nameId === null ? '' : `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID>`}
      ${subjectConfirmation}
    </saml:Subject>
    ${conditions}
    <saml:AuthnStatement AuthnInstant="${iso(NOW)}">
      <saml:AuthnContext>
        ${classRef === null ? '' : `<saml:AuthnContextClassRef>${classRef}</saml:AuthnContextClassRef>`}
      </saml:AuthnContext>
    </saml:AuthnStatement>
    ${options.extraAssertionChildren ?? ''}
  </saml:Assertion>
</samlp:Response>`;
}

export function d1(): D1Database {
  return {
    prepare: vi.fn().mockImplementation(() => ({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn().mockResolvedValue({ success: true }),
    })),
    batch: vi
      .fn()
      .mockImplementation(async (statements: unknown[]) =>
        statements.map(() => ({ success: true, meta: { changes: 1 } }))
      ),
  } as unknown as D1Database;
}

export interface AcsEnvState {
  /** Answer of the SAML request store to /consume/ calls. */
  relayState: string;
  context?: Record<string, unknown>;
  /** Status the request store answers to /assertion/consume. */
  assertionConsumeStatus: number;
  assertionConsumeThrows: boolean;
  /** Set by buildEnv: the session store's fetch. */
  sessionFetch?: ReturnType<typeof vi.fn>;
}

export type AcsEnv = Partial<Env> & {
  TDB_TEST_CORE?: D1Database;
  TDB_TEST_PII?: D1Database;
  SAML_STRICT_INRESPONSETO?: string;
};

export function buildEnv(state: AcsEnvState): AcsEnv {
  const sessionFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
  state.sessionFetch = sessionFetch;
  const storeFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/consume/')) {
      return Response.json({
        requestId: REQUEST_ID,
        relayState: state.relayState,
        ...(state.context ? { context: state.context } : {}),
      });
    }
    if (url.includes('/assertion/consume')) {
      if (state.assertionConsumeThrows) throw new Error('store down');
      return new Response('{}', { status: state.assertionConsumeStatus });
    }
    return Response.json({ success: true });
  });
  const env: AcsEnv = {
    ISSUER_URL: 'https://auth.example.com',
    UI_URL: 'https://ui.example.com',
    SAML_STRICT_INRESPONSETO: 'false',
    AUTHRIM_CONFIG: {
      get: vi.fn(async (key: string) =>
        key.startsWith('region_shard_config:') ? TEST_REGION_CONFIG : null
      ),
    } as unknown as KVNamespace,
    TDB_TEST_CORE: d1(),
    TDB_TEST_PII: d1(),
    SAML_REQUEST_STORE: {
      idFromName: vi.fn().mockReturnValue('mock-store-id'),
      get: vi.fn().mockReturnValue({ fetch: storeFetch }),
    } as unknown as Env['SAML_REQUEST_STORE'],
    SESSION_STORE: {
      idFromName: vi.fn().mockReturnValue('mock-session-store-id'),
      get: vi.fn().mockReturnValue({ fetch: sessionFetch }),
    } as unknown as Env['SESSION_STORE'],
    NONCE_STORE: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as Env['NONCE_STORE'],
  };
  env.DB_ADMIN = env.TDB_TEST_CORE;
  return env;
}

export async function callACS(
  env: AcsEnv,
  pending: Promise<unknown>[],
  options: {
    xml?: string;
    headers?: Record<string, string>;
    inResponseTo?: string;
    relayState?: string;
    url?: string;
  } = {}
): Promise<Response> {
  const inResponseTo = options.inResponseTo ?? REQUEST_ID;
  const formData = new FormData();
  formData.append('SAMLResponse', btoa(options.xml ?? samlResponseXml({ inResponseTo })));
  if (options.relayState !== undefined) formData.append('RelayState', options.relayState);
  const cookie = buildSAMLRequestBindingCookie(inResponseTo, 300);
  const headers: Record<string, string> = { cookie, ...options.headers };
  const context = {
    env,
    req: {
      ...(options.url ? { url: options.url } : {}),
      formData: async () => formData,
      header: vi.fn((name: string) => headers[name.toLowerCase()]),
    },
    json: (data: unknown, status: number) => new Response(JSON.stringify(data), { status }),
    get: vi.fn().mockReturnValue('tenant-a'),
    executionCtx: {
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        pending.push(promise);
      }),
    },
  };
  return handleSPACS(context as unknown as Parameters<typeof handleSPACS>[0]);
}
