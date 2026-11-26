/**
 * The AAL gate of SAML SSO: what it audits, logs, redirects to and answers for each outcome of
 * the assurance check.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { STATUS_CODES } from '../../common/constants';

const mocks = vi.hoisted(() => ({
  check: vi.fn(
    async (..._args: unknown[]): Promise<Record<string, unknown>> => ({ outcome: 'not_required' })
  ),
  redirect: vi.fn(async (..._args: unknown[]) => new Response(null, { status: 302 })),
  carry: vi.fn((context: unknown) => ({ carried: context })),
  audit: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuditLog: mocks.audit,
    scheduleAuditLog: vi.fn(),
  };
});
vi.mock('../authn-assurance', () => ({ checkSAMLAuthnAssurance: mocks.check }));
vi.mock('../sso-stored-request', () => ({
  redirectToSAMLLogin: mocks.redirect,
  carrySAMLRequestContext: mocks.carry,
}));

import { gateSAMLAuthnAssurance } from '../sso-authn-assurance-gate';

const NOW = Date.parse('2026-06-01T12:00:00Z');
const c = { env: {}, req: { header: () => undefined }, executionCtx: {} } as unknown as Context<{
  Bindings: Env;
}>;

function setup(extra: Record<string, unknown> = {}) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const refuse = vi.fn(async (_answer: unknown) => new Response('refused', { status: 200 }));
  const input = {
    env: {} as Env,
    tenantId: 'tenant-a',
    authnRequest: { id: '_req' },
    spConfig: { entityId: 'https://sp.example.test' },
    session: { userId: 'user-a', sessionId: 'sess_1', data: {} },
    log,
    refuse,
    ...extra,
  };
  return { input, log, refuse };
}

function gate(input: ReturnType<typeof setup>['input']) {
  return gateSAMLAuthnAssurance(
    c,
    input as unknown as Parameters<typeof gateSAMLAuthnAssurance>[1]
  );
}

function auditMetadata(): Record<string, unknown> | undefined {
  const call = mocks.audit.mock.calls[0];
  return call
    ? (JSON.parse(String((call[1] as { metadata: string }).metadata)) as Record<string, unknown>)
    : undefined;
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.check.mockResolvedValue({ outcome: 'not_required' });
});

describe('proceeding', () => {
  it.each([[{ outcome: 'not_required' }], [{ outcome: 'met', aal: 'AAL2' }]])(
    'returns the check for %o without auditing or refusing',
    async (check) => {
      mocks.check.mockResolvedValue(check);
      const { input, refuse } = setup();

      expect(await gate(input)).toEqual({ check });
      expect(mocks.audit).not.toHaveBeenCalled();
      expect(refuse).not.toHaveBeenCalled();
    }
  );

  it('hands the request, SP, session and stored context to the check, with a warning hook', async () => {
    const { input, log } = setup({ requestContext: { relay: 'x' } });

    await gate(input);

    const args = mocks.check.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args).toMatchObject({
      env: input.env,
      tenantId: 'tenant-a',
      authnRequest: input.authnRequest,
      spConfig: input.spConfig,
      session: input.session,
      requestContext: { relay: 'x' },
    });
    (args.onUnrecorded as () => void)();
    expect(log.warn).toHaveBeenCalledWith('The step-up could not be recorded in the session', {
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example.test',
      authnRequestId: '_req',
    });
  });
});

describe('step-up', () => {
  const stepUp = {
    outcome: 'step_up',
    requiredAal: 'AAL2',
    priorSessionId: 'sess_1',
    actual: 'AAL1',
  };

  it('audits the shortfall and sends the person to sign in again, recording the step-up', async () => {
    mocks.check.mockResolvedValue(stepUp);
    const { input } = setup({
      relayState: 'relay',
      requestContext: { prior: true },
      resumedLogin: { nonce: 'n' },
      storedRevision: 3,
    });

    const result = await gate(input);

    expect(result).toHaveProperty('response');
    expect(auditMetadata()).toMatchObject({
      failure_kind: 'authn_assurance_insufficient',
      sp_entity_id: 'https://sp.example.test',
      request_id: '_req',
      policy_details: { required_aal: 'AAL2', actual_aal: 'AAL1', step_up: true },
    });
    const [, redirectInput] = mocks.redirect.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(redirectInput).toEqual({
      env: input.env,
      tenantId: 'tenant-a',
      authnRequest: input.authnRequest,
      relayState: 'relay',
      forceReauthentication: true,
      requiredAal: 'AAL2',
      signInAgain: { subjectUserId: 'user-a', issuedAt: NOW },
      resumedLogin: { nonce: 'n' },
      storedRevision: 3,
      context: {
        carried: { prior: true },
        assuranceStepUp: { issuedAt: NOW, priorSessionId: 'sess_1', requiredAal: 'AAL2' },
      },
    });
    expect(mocks.carry).toHaveBeenCalledWith({ prior: true });
  });

  it('omits the stored revision when the request was not resumed', async () => {
    mocks.check.mockResolvedValue(stepUp);
    const { input } = setup();

    await gate(input);

    const [, redirectInput] = mocks.redirect.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(redirectInput).not.toHaveProperty('storedRevision');
  });
});

describe('unavailable settings', () => {
  it('logs the failure, audits it and answers the SP without detail', async () => {
    mocks.check.mockResolvedValue({ outcome: 'unavailable', error: new Error('kv down') });
    const { input, log, refuse } = setup();

    await gate(input);

    expect(log.error).toHaveBeenCalledWith(
      'Failed to read assurance settings',
      { tenantId: 'tenant-a', spEntityId: 'https://sp.example.test', authnRequestId: '_req' },
      expect.objectContaining({ message: 'kv down' })
    );
    expect(auditMetadata()).toMatchObject({
      failure_kind: 'authn_assurance_unavailable',
      policy_details: {},
    });
    expect(refuse).toHaveBeenCalledWith({
      statusMessage: 'The request could not be processed right now',
      failureKind: 'authn_assurance_unavailable',
    });
  });

  it('wraps a non-Error failure', async () => {
    mocks.check.mockResolvedValue({ outcome: 'unavailable', error: 'plain' });
    const { input, log } = setup();

    await gate(input);

    expect(log.error.mock.calls[0]?.[2]).toEqual(new Error('plain'));
  });
});

describe('refusals', () => {
  it('answers NoPassive for a passive request and audits is_passive with the levels', async () => {
    mocks.check.mockResolvedValue({ outcome: 'no_passive', requiredAal: 'AAL2', actual: 'AAL1' });
    const { input, log, refuse } = setup();

    await gate(input);

    expect(log.info).toHaveBeenCalledWith(
      'SAML sign-in refused: authentication assurance level not met',
      { tenantId: 'tenant-a', spEntityId: 'https://sp.example.test', authnRequestId: '_req' }
    );
    expect(auditMetadata()).toMatchObject({
      failure_kind: 'authn_request_no_passive',
      policy_details: { required_aal: 'AAL2', actual_aal: 'AAL1', is_passive: true },
    });
    expect(auditMetadata()?.policy_details).not.toHaveProperty('reason');
    expect(refuse).toHaveBeenCalledWith({
      secondLevelStatusCode: STATUS_CODES.NO_PASSIVE,
      statusMessage: 'Passive authentication could not be completed',
      failureKind: 'authn_request_no_passive',
    });
  });

  it('answers NoAuthnContext when the requirement cannot be met, auditing the reason', async () => {
    mocks.check.mockResolvedValue({
      outcome: 'insufficient',
      reason: 'step_up_unmet',
      requiredAal: 'AAL2',
      actual: 'AAL1',
    });
    const { input, refuse } = setup();

    await gate(input);

    expect(auditMetadata()).toMatchObject({
      failure_kind: 'authn_assurance_insufficient',
      policy_details: { required_aal: 'AAL2', actual_aal: 'AAL1', reason: 'step_up_unmet' },
    });
    expect(auditMetadata()?.policy_details).not.toHaveProperty('is_passive');
    expect(refuse).toHaveBeenCalledWith({
      secondLevelStatusCode: STATUS_CODES.NO_AUTHN_CONTEXT,
      statusMessage: 'Requested authentication context could not be satisfied',
      failureKind: 'authn_assurance_insufficient',
    });
  });

  it('leaves the actual level out of the audit when none was determined', async () => {
    mocks.check.mockResolvedValue({
      outcome: 'insufficient',
      reason: 'unsatisfiable',
      requiredAal: null,
    });
    const { input } = setup();

    await gate(input);

    expect(auditMetadata()?.policy_details).toEqual({
      required_aal: null,
      reason: 'unsatisfiable',
    });
  });

  it('returns the response the refusal produced', async () => {
    mocks.check.mockResolvedValue({
      outcome: 'insufficient',
      reason: 'session_ended',
      requiredAal: 'AAL2',
    });
    const { input, refuse } = setup();
    const answer = new Response('answer', { status: 200 });
    refuse.mockResolvedValue(answer);

    expect(await gate(input)).toEqual({ response: answer });
  });
});
