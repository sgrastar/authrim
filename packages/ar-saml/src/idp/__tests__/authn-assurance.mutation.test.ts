/**
 * SAML IdP authentication assurance: reading the stored step-up, the session's proof time and
 * every outcome of checkSAMLAuthnAssurance (required AAL, step-up, passive, unmet, class ref).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  settings: {},
  settingsThrows: false,
  evaluate: vi.fn(
    async (..._args: unknown[]): Promise<{ aal: string; sessionEnded?: boolean }> => ({
      aal: 'AAL1',
    })
  ),
  resolveSettings: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    isShardedSessionId: (id: string) => id.startsWith('sess_'),
    resolveEffectiveSettings: mocks.resolveSettings,
    evaluateSessionAssurance: mocks.evaluate,
    getSessionStoreBySessionId: vi.fn(() => ({ stub: { marker: 'stub' } })),
  };
});

import {
  checkSAMLAuthnAssurance,
  readSAMLAssuranceStepUp,
  sessionProvenAt,
} from '../authn-assurance';

const env = {} as Env;
const TABLE = {
  'urn:x:aal1': 'AAL1',
  'urn:x:aal2': 'AAL2',
  'urn:x:aal3': 'AAL3',
};
const session = { userId: 'user-a', sessionId: 'sess_1', data: { amr: ['pwd'] } };

type Input = Parameters<typeof checkSAMLAuthnAssurance>[0];

function check(overrides: Record<string, unknown> = {}) {
  const input = {
    env,
    tenantId: 'tenant-a',
    authnRequest: {},
    spConfig: {},
    session,
    ...overrides,
  };
  return checkSAMLAuthnAssurance(input);
}

const requested = (refs: string[], comparison?: string, isPassive?: boolean) => ({
  requestedAuthnContext: { authnContextClassRef: refs, ...(comparison ? { comparison } : {}) },
  ...(isPassive !== undefined ? { isPassive } : {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = {};
  mocks.settingsThrows = false;
  mocks.resolveSettings.mockImplementation(async () => {
    if (mocks.settingsThrows) throw new Error('settings down');
    return mocks.settings;
  });
  mocks.evaluate.mockResolvedValue({ aal: 'AAL1' });
});

describe('sessionProvenAt', () => {
  it.each([
    ['nothing recorded', undefined, undefined],
    ['an empty record', {}, undefined],
    ['only proven_at', { proven_at: 100 }, 100],
    ['only reauth_proven_at', { reauth_proven_at: 300 }, 300],
    ['the later of both', { proven_at: 100, reauth_proven_at: 300 }, 300],
    ['the later when proven_at is later', { proven_at: 500, reauth_proven_at: 300 }, 500],
    ['numbers only', { proven_at: '100', reauth_proven_at: 7 }, 7],
    ['safe integers only', { proven_at: 1.5, reauth_proven_at: 2 ** 60 }, undefined],
  ])('reads %s', (_label, data, expected) => {
    expect(sessionProvenAt(data as Record<string, unknown> | undefined)).toBe(expected);
  });
});

describe('readSAMLAssuranceStepUp', () => {
  const read = (stepUp: unknown) =>
    readSAMLAssuranceStepUp({ assuranceStepUp: stepUp } as Parameters<
      typeof readSAMLAssuranceStepUp
    >[0]);

  it.each([
    ['no context', undefined],
    ['no step-up', {}],
    ['a non-object step-up', 'x'],
    ['a step-up without issuedAt', { requiredAal: 'AAL2' }],
    ['a non-numeric issuedAt', { issuedAt: '5' }],
    ['an unsafe issuedAt', { issuedAt: 2 ** 60 }],
    ['a fractional issuedAt', { issuedAt: 1.5 }],
  ])('rejects %s', (_label, stepUp) => {
    expect(
      stepUp === undefined ? readSAMLAssuranceStepUp(undefined) : read(stepUp)
    ).toBeUndefined();
  });

  it('keeps a valid step-up, defaulting an unreadable AAL to the highest', () => {
    expect(read({ issuedAt: 5, requiredAal: 'AAL2', priorSessionId: 'sess_prior' })).toEqual({
      issuedAt: 5,
      priorSessionId: 'sess_prior',
      requiredAal: 'AAL2',
    });
    expect(read({ issuedAt: 5, requiredAal: 'AAL9', priorSessionId: 'legacy' })).toEqual({
      issuedAt: 5,
      priorSessionId: undefined,
      requiredAal: 'AAL3',
    });
    expect(read({ issuedAt: 5 })?.requiredAal).toBe('AAL3');
    expect(read({ issuedAt: 5, priorSessionId: 7 })?.priorSessionId).toBeUndefined();
  });

  it('keeps the completed target only when both its session and AAL are readable', () => {
    expect(
      read({ issuedAt: 5, completed: { sessionId: 'sess_c', aal: 'AAL2' } })?.completed
    ).toEqual({
      sessionId: 'sess_c',
      aal: 'AAL2',
    });
    for (const completed of [
      { sessionId: 'sess_c', aal: 'bogus' },
      { sessionId: 5, aal: 'AAL2' },
      { aal: 'AAL2' },
      null,
    ]) {
      expect(read({ issuedAt: 5, completed })).not.toHaveProperty('completed');
    }
  });
});

describe('checkSAMLAuthnAssurance: when nothing is required', () => {
  it('reads no settings when neither the SP nor the request asks for anything', async () => {
    expect(await check()).toEqual({ outcome: 'not_required' });
    expect(mocks.resolveSettings).not.toHaveBeenCalled();
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });

  it('is not required for requested references the table does not list', async () => {
    mocks.settings = { 'assurance.enabled': true, 'assurance.saml_authn_context_aal': TABLE };

    expect(await check({ authnRequest: requested(['urn:other']) })).toEqual({
      outcome: 'not_required',
    });
  });

  it('is not required for requested references while assurance is off, even with a table', async () => {
    mocks.settings = { 'assurance.enabled': false, 'assurance.saml_authn_context_aal': TABLE };

    expect(await check({ authnRequest: requested(['urn:x:aal3']) })).toEqual({
      outcome: 'not_required',
    });
  });

  it('reports the settings as unavailable when they cannot be read', async () => {
    mocks.settingsThrows = true;

    const result = await check({ spConfig: { minimumAal: 'AAL2' } });

    expect(result).toMatchObject({ outcome: 'unavailable' });
    expect(result.outcome === 'unavailable' && (result.error as Error).message).toBe(
      'settings down'
    );
  });
});

describe('checkSAMLAuthnAssurance: the SP minimum', () => {
  const sp = { minimumAal: 'AAL2' };

  it('is met when the session reached the minimum', async () => {
    mocks.evaluate.mockResolvedValue({ aal: 'AAL2' });

    const result = await check({ spConfig: sp });

    expect(result).toEqual({
      outcome: 'met',
      aal: 'AAL2',
      guard: { reached: 'AAL2', classRefAal: {}, request: { kind: 'unmapped' } },
    });
  });

  it('asks for a step-up from the current session when the session fell short', async () => {
    expect(await check({ spConfig: sp })).toEqual({
      outcome: 'step_up',
      requiredAal: 'AAL2',
      priorSessionId: 'sess_1',
      actual: 'AAL1',
    });
  });

  it('refuses a step-up for a passive request', async () => {
    expect(await check({ spConfig: sp, authnRequest: { isPassive: true } })).toEqual({
      outcome: 'no_passive',
      requiredAal: 'AAL2',
      actual: 'AAL1',
    });
  });

  it('treats a stored minimum that is not a level as the highest', async () => {
    mocks.evaluate.mockResolvedValue({ aal: 'AAL2' });

    expect(await check({ spConfig: { minimumAal: 'bogus' } })).toMatchObject({
      outcome: 'step_up',
      requiredAal: 'AAL3',
    });
  });

  it('answers insufficient, not another step-up, when the person already stepped up once', async () => {
    const result = await check({
      spConfig: sp,
      requestContext: {
        assuranceStepUp: { issuedAt: 5, requiredAal: 'AAL2' },
      },
    });

    expect(result).toEqual({
      outcome: 'insufficient',
      reason: 'step_up_unmet',
      requiredAal: 'AAL2',
      actual: 'AAL1',
    });
  });

  it('answers insufficient when the session has ended', async () => {
    mocks.evaluate.mockResolvedValue({ aal: 'AAL0', sessionEnded: true });

    expect(await check({ spConfig: sp })).toEqual({
      outcome: 'insufficient',
      reason: 'session_ended',
      requiredAal: 'AAL2',
    });
  });

  it('judges the session by its recorded evidence and the tenant mappings', async () => {
    mocks.settings = {
      'assurance.enabled': true,
      'assurance.upstream_acr_mappings': { 'urn:idp:strong': 'AAL2' },
    };
    mocks.evaluate.mockResolvedValue({ aal: 'AAL2' });
    const onUnrecorded = vi.fn();
    const now = () => 42;

    await check({ spConfig: sp, onUnrecorded, now });

    const args = mocks.evaluate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args).toMatchObject({
      sessionId: 'sess_1',
      sessionData: { amr: ['pwd'] },
      sessionDataUserId: 'user-a',
      sessionUserId: 'user-a',
      upstreamAcrMappings: { 'urn:idp:strong': 'AAL2' },
      reauthIssuedAt: undefined,
      stepUp: undefined,
      onUnrecorded,
      now,
    });
    expect((args.getSessionStore as (id: string) => unknown)('sess_1')).toEqual({ marker: 'stub' });
  });

  it('ignores upstream mappings while assurance is off', async () => {
    mocks.settings = {
      'assurance.enabled': false,
      'assurance.upstream_acr_mappings': { 'urn:idp:strong': 'AAL2' },
    };
    mocks.evaluate.mockResolvedValue({ aal: 'AAL2' });

    await check({ spConfig: sp });

    expect(
      (mocks.evaluate.mock.calls[0]?.[0] as Record<string, unknown>).upstreamAcrMappings
    ).toEqual({});
  });
});

describe('checkSAMLAuthnAssurance: step-up bookkeeping', () => {
  const sp = { minimumAal: 'AAL1' };
  const context = (extra: Record<string, unknown> = {}) =>
    ({
      assuranceStepUp: { issuedAt: 5, requiredAal: 'AAL2', priorSessionId: 'sess_prior', ...extra },
    }) as Input['requestContext'];

  it('records the session and AAL the step-up was verified against, and passes the step-up on', async () => {
    mocks.evaluate.mockResolvedValue({ aal: 'AAL2' });

    const result = await check({ spConfig: sp, requestContext: context() });

    expect(result).toMatchObject({
      outcome: 'met',
      assuranceStepUp: {
        issuedAt: 5,
        requiredAal: 'AAL2',
        priorSessionId: 'sess_prior',
        completed: { sessionId: 'sess_1', aal: 'AAL2' },
      },
    });
    const args = mocks.evaluate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.reauthIssuedAt).toBe(5);
    expect(args.stepUp).toEqual({ issuedAt: 5, priorSessionId: 'sess_prior' });
  });

  it('does not record an AAL0 result as the completed step-up', async () => {
    mocks.evaluate.mockResolvedValue({ aal: 'AAL0' });

    const result = await check({
      spConfig: { minimumAal: undefined },
      requestContext: context(),
      authnRequest: requested(['urn:x']),
    });

    expect(result).toEqual({ outcome: 'not_required' });

    mocks.settings = { 'assurance.enabled': true, 'assurance.saml_authn_context_aal': TABLE };
    const mapped = await check({
      requestContext: context(),
      authnRequest: requested(['urn:x:aal1'], 'maximum'),
    });
    expect(mapped).toMatchObject({ outcome: 'met', aal: 'AAL0' });
    expect(mapped.outcome === 'met' && mapped.assuranceStepUp).toEqual({
      issuedAt: 5,
      priorSessionId: 'sess_prior',
      requiredAal: 'AAL2',
    });
  });

  it('trusts a step-up already verified for this very session without judging the session again', async () => {
    const result = await check({
      spConfig: { minimumAal: 'AAL2' },
      requestContext: context({ completed: { sessionId: 'sess_1', aal: 'AAL3' } }),
    });

    expect(mocks.evaluate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: 'met', aal: 'AAL3' });
    expect(result.outcome === 'met' && result.assuranceStepUp?.completed).toEqual({
      sessionId: 'sess_1',
      aal: 'AAL3',
    });
  });

  it('judges a different session than the one the step-up was verified for', async () => {
    mocks.evaluate.mockResolvedValue({ aal: 'AAL2' });

    await check({
      spConfig: { minimumAal: 'AAL2' },
      requestContext: context({ completed: { sessionId: 'sess_other', aal: 'AAL3' } }),
    });

    expect(mocks.evaluate).toHaveBeenCalledTimes(1);
  });
});

describe('checkSAMLAuthnAssurance: the tenant table', () => {
  beforeEach(() => {
    mocks.settings = { 'assurance.enabled': true, 'assurance.saml_authn_context_aal': TABLE };
  });

  it('requires the AAL of a requested reference', async () => {
    expect(await check({ authnRequest: requested(['urn:x:aal2']) })).toMatchObject({
      outcome: 'step_up',
      requiredAal: 'AAL2',
    });
  });

  it('takes the higher of the SP minimum and the requested reference', async () => {
    expect(
      await check({ spConfig: { minimumAal: 'AAL3' }, authnRequest: requested(['urn:x:aal2']) })
    ).toMatchObject({ outcome: 'step_up', requiredAal: 'AAL3' });
    expect(
      await check({ spConfig: { minimumAal: 'AAL1' }, authnRequest: requested(['urn:x:aal2']) })
    ).toMatchObject({ outcome: 'step_up', requiredAal: 'AAL2' });
  });

  it('cannot satisfy a request for something better than the highest level', async () => {
    expect(await check({ authnRequest: requested(['urn:x:aal3'], 'better') })).toEqual({
      outcome: 'insufficient',
      reason: 'unsatisfiable',
      requiredAal: null,
    });
  });

  it('judges a mapped request that needs no AAL (maximum) and passes it on in the guard', async () => {
    const result = await check({ authnRequest: requested(['urn:x:aal1'], 'maximum') });

    expect(result).toMatchObject({
      outcome: 'met',
      aal: 'AAL1',
      guard: { reached: 'AAL1', classRefAal: TABLE },
    });
    expect(result.outcome === 'met' && result.guard.request).toMatchObject({
      kind: 'mapped',
      comparison: 'maximum',
    });
  });

  it('does not read the table for a request that names no reference', async () => {
    mocks.evaluate.mockResolvedValue({ aal: 'AAL2' });

    const result = await check({ spConfig: { minimumAal: 'AAL2' } });

    expect(result).toMatchObject({ outcome: 'met', guard: { request: { kind: 'unmapped' } } });
  });
});

describe('checkSAMLAuthnAssurance: assurance-mode class reference', () => {
  const sp = { authnContextClassRefMode: 'assurance' } as const;

  beforeEach(() => {
    mocks.settings = { 'assurance.enabled': true, 'assurance.saml_authn_context_aal': TABLE };
    mocks.evaluate.mockResolvedValue({ aal: 'AAL2' });
  });

  it('puts the class reference of the AAL reached in the assertion', async () => {
    const result = await check({ spConfig: sp });

    expect(result).toMatchObject({ outcome: 'met', aal: 'AAL2', classRef: 'urn:x:aal2' });
  });

  it('judges requests even without a minimum, and keeps the requested reference in play', async () => {
    const result = await check({ spConfig: sp, authnRequest: requested(['urn:x:aal1'], 'exact') });

    expect(result).toMatchObject({ outcome: 'met', classRef: 'urn:x:aal1' });
  });

  it('leaves a request for unlisted references to the existing handling', async () => {
    const result = await check({ spConfig: sp, authnRequest: requested(['urn:other']) });

    expect(result).toMatchObject({ outcome: 'met', guard: { request: { kind: 'unmapped' } } });
    expect(result.outcome === 'met' && result.classRef).toBeUndefined();
  });

  it('refuses when a mapped request leaves no reference the AAL reached can carry', async () => {
    mocks.evaluate.mockResolvedValue({ aal: 'AAL3' });

    const result = await check({
      spConfig: sp,
      authnRequest: requested(['urn:x:aal1'], 'maximum'),
    });

    expect(result).toMatchObject({ outcome: 'met' });

    mocks.settings = {
      'assurance.enabled': true,
      'assurance.saml_authn_context_aal': { 'urn:x:aal2': 'AAL2' },
    };
    mocks.evaluate.mockResolvedValue({ aal: 'AAL1' });
    expect(
      await check({ spConfig: sp, authnRequest: requested(['urn:x:aal2'], 'maximum') })
    ).toEqual({
      outcome: 'insufficient',
      reason: 'no_class_ref',
      requiredAal: null,
      actual: 'AAL1',
    });
  });

  it('requires nothing in assurance mode while assurance is off or the table is empty', async () => {
    mocks.settings = { 'assurance.enabled': false, 'assurance.saml_authn_context_aal': TABLE };
    const off = await check({ spConfig: sp });
    mocks.settings = { 'assurance.enabled': true, 'assurance.saml_authn_context_aal': {} };
    const empty = await check({ spConfig: sp });

    expect(off).toEqual({ outcome: 'not_required' });
    expect(empty).toEqual({ outcome: 'not_required' });
  });
});
