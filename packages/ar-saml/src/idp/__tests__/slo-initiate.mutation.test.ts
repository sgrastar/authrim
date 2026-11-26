/**
 * IdP-initiated logout: building and signing the LogoutRequest, binding selection, query-string
 * assembly for HTTP-Redirect, the fan-out across several SPs and the NameID resolution.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { NAMEID_FORMATS } from '../../common/constants';

const mocks = vi.hoisted(() => ({
  recorded: null as { format: string; value?: string } | null,
  emailNameId: null as string | null,
  userInfo: null as Record<string, unknown> | null,
  persistentValue: 'persistent-value',
  signXml: vi.fn((xml: string, _options: unknown) => `signed(${xml})`),
  signRedirect: vi.fn(async (..._args: unknown[]) => ({
    signedUrl: 'SAMLRequest=enc&SigAlg=alg&Signature=sig',
  })),
  signingThrows: false,
  store: vi.fn(async (..._args: unknown[]) => undefined),
  createFanout: vi.fn(),
  markSent: vi.fn(async (..._args: unknown[]) => undefined),
  markCompleted: vi.fn(async (..._args: unknown[]) => undefined),
  logs: [] as Array<{ level: string; message: string; context: unknown }>,
  PolicyError: class extends Error {},
  resolveNameId: vi.fn(async (..._args: unknown[]): Promise<string> => 'persistent-value'),
  naked: false,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const logger = {
    error: (message: string, context: unknown) =>
      mocks.logs.push({ level: 'error', message, context }),
    warn: (message: string, context: unknown) =>
      mocks.logs.push({ level: 'warn', message, context }),
    info: vi.fn(),
    debug: vi.fn(),
  };
  return {
    ...actual,
    usesNakedDomainIssuer: vi.fn(() => mocks.naked),
    createLogger: () => ({ module: () => logger }),
    getLogger: () => ({ module: () => logger }),
  };
});

vi.mock('../../admin/providers', () => ({ getSPConfig: vi.fn(async () => null) }));
vi.mock('../../common/entity-id', () => ({
  getSAMLLocalEntityIds: vi.fn(async () => ({
    issuerUrl: 'https://tenant.example.test',
    idpEntityId: 'https://tenant.example.test/saml/idp',
  })),
}));
vi.mock('../../common/idp-signing', () => ({
  getSAMLIdPSigningMaterial: vi.fn(async () => {
    if (mocks.signingThrows) throw new Error('signing unavailable');
    return { privateKeyPem: 'private-key', certificate: 'certificate' };
  }),
}));
vi.mock('../../common/signature', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/signature')>();
  return { ...actual, signXml: mocks.signXml, signRedirectBinding: mocks.signRedirect };
});
vi.mock('../../common/user-store', () => ({
  findActiveSamlUserByEmail: vi.fn(async () => null),
  getSamlUserInfoById: vi.fn(async () => mocks.userInfo),
  getSamlUserNameIdById: vi.fn(async () => mocks.emailNameId),
}));
vi.mock('../release-items', () => ({ resolveSAMLMappedNameID: vi.fn(async () => undefined) }));
vi.mock('../subject', () => ({
  readSAMLSessionIndexNameID: vi.fn(async () => mocks.recorded),
  resolveEffectiveSAMLNameIDFormat: () => NAMEID_FORMATS.EMAIL,
  resolveSAMLPersistentNameIDRegistryStore: vi.fn(() => 'registry'),
  resolveSAMLNameIDValue: mocks.resolveNameId,
  resolveSAMLPairwiseSecret: vi.fn(async () => 'pairwise-secret'),
  resolveSAMLSessionIndexToSessionId: vi.fn(async () => null),
  SAMLNameIDPolicyError: mocks.PolicyError,
}));
vi.mock('../slo-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slo-state')>();
  return {
    ...actual,
    storeSAMLOutboundLogoutRequest: mocks.store,
    createSAMLIdPLogoutFanoutTransaction: vi.fn(
      async (
        _store: unknown,
        input: {
          transactionId?: string;
          userId: string;
          sessionIndex?: string;
          relayState?: string;
          targets: string[];
          targetSessionIndexes?: Record<string, string>;
        }
      ) => {
        mocks.createFanout(input);
        return {
          transactionId: input.transactionId ?? 'tx-1',
          userId: input.userId,
          sessionIndex: input.sessionIndex,
          relayState: input.relayState,
          targets: input.targets.map((spEntityId) => ({
            spEntityId,
            ...(input.targetSessionIndexes?.[spEntityId]
              ? { sessionIndex: input.targetSessionIndexes[spEntityId] }
              : {}),
            status: 'pending',
          })),
        };
      }
    ),
    getSAMLIdPLogoutFanoutTransaction: vi.fn(async () => null),
    markSAMLIdPLogoutFanoutTargetSent: mocks.markSent,
    markSAMLIdPLogoutFanoutTargetCompleted: mocks.markCompleted,
  };
});

import {
  SAMLLogoutNameIDUnavailableError,
  initiateIdPLogout,
  initiateIdPLogoutBindingResponse,
  initiateIdPMultiSPLogoutBindingResponse,
  resolveIdPInitiatedLogoutBinding,
  resolveIdPLogoutNameID,
} from '../slo';

const env = { STATE_STORE: {}, SETTINGS: { get: vi.fn(async () => null) } } as unknown as Env;

function sp(overrides: Record<string, unknown> = {}) {
  return {
    entityId: 'https://sp.example.test/entity',
    acsUrl: 'https://sp.example.test/acs',
    sloUrl: 'https://sp.example.test/slo',
    allowedBindings: ['post'],
    ...overrides,
  } as never;
}

function nameIdOf(xml: string): string | undefined {
  return /<saml:NameID[^>]*>([^<]*)<\/saml:NameID>/.exec(xml)?.[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recorded = { format: NAMEID_FORMATS.EMAIL };
  mocks.emailNameId = 'user@example.test';
  mocks.userInfo = { id: 'user-a' };
  mocks.signingThrows = false;
  mocks.logs.length = 0;
  mocks.naked = false;
  mocks.resolveNameId.mockResolvedValue('persistent-value');
});

describe('initiateIdPLogout', () => {
  it('builds, signs and records a LogoutRequest for the SP', async () => {
    const result = await initiateIdPLogout(env, 'user-a', sp(), 'sidx_1', 'tenant-a');

    expect(result.destination).toBe('https://sp.example.test/slo');
    expect(result.logoutRequestXml.startsWith('signed(')).toBe(true);
    expect(result.logoutRequestXml).toContain('<samlp:LogoutRequest ');
    expect(result.logoutRequestXml).toContain('Destination="https://sp.example.test/slo"');
    expect(result.logoutRequestXml).toContain('>user@example.test</saml:NameID>');
    expect(result.logoutRequestXml).toContain('<samlp:SessionIndex>sidx_1</samlp:SessionIndex>');
    expect(result.logoutRequestXml).toContain(
      '<saml:Issuer>https://tenant.example.test/saml/idp</saml:Issuer>'
    );
    const [, options] = mocks.signXml.mock.calls[0] as [string, Record<string, unknown>];
    const id = /ID="(_[0-9a-f]+)"/.exec(result.logoutRequestXml)?.[1];
    expect(options).toEqual({
      privateKey: 'private-key',
      certificate: 'certificate',
      referenceUri: `#${id}`,
      signatureLocation: 'prepend',
      includeKeyInfo: true,
    });
    expect(mocks.store).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        tenantId: 'tenant-a',
        spEntityId: 'https://sp.example.test/entity',
        requestId: id,
        transactionId: undefined,
        ttlSeconds: 300,
      })
    );
  });

  it('falls back to the ACS URL when the SP has no logout endpoint', async () => {
    const result = await initiateIdPLogout(
      env,
      'user-a',
      sp({ sloUrl: undefined }),
      'sidx_1',
      'tenant-a'
    );

    expect(result.destination).toBe('https://sp.example.test/acs');
  });

  it('requires a tenant', async () => {
    await expect(initiateIdPLogout(env, 'user-a', sp(), 'sidx_1', undefined)).rejects.toThrow(
      'IdP-initiated SLO tenant'
    );
  });

  it('logs and rethrows a signing failure without recording a request', async () => {
    mocks.signingThrows = true;

    await expect(initiateIdPLogout(env, 'user-a', sp(), 'sidx_1', 'tenant-a')).rejects.toThrow(
      'signing unavailable'
    );

    expect(mocks.logs).toContainEqual({
      level: 'error',
      message: 'Error signing LogoutRequest',
      context: { action: 'sign_logout_request' },
    });
    expect(mocks.store).not.toHaveBeenCalled();
  });
});

describe('the NameID a logout names', () => {
  it.each([
    ['without a session index', undefined, { format: NAMEID_FORMATS.EMAIL }],
    ['without a record of the sign-in', 'sidx_1', null],
    ['a persistent NameID with no recorded value', 'sidx_1', { format: NAMEID_FORMATS.PERSISTENT }],
    ['a transient NameID with no recorded value', 'sidx_1', { format: NAMEID_FORMATS.TRANSIENT }],
  ])('sends nothing %s', async (_label, sessionIndex, recorded) => {
    mocks.recorded = recorded;

    await expect(initiateIdPLogout(env, 'user-a', sp(), sessionIndex, 'tenant-a')).rejects.toThrow(
      SAMLLogoutNameIDUnavailableError
    );
    expect(mocks.signXml).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it('names the recorded value for any format that has one', async () => {
    mocks.recorded = { format: NAMEID_FORMATS.PERSISTENT, value: 'recorded-id' };

    const { logoutRequestXml } = await initiateIdPLogout(env, 'user-a', sp(), 'sidx_1', 'tenant-a');

    expect(nameIdOf(logoutRequestXml)).toBe('recorded-id');
    expect(logoutRequestXml).toContain(`Format="${NAMEID_FORMATS.PERSISTENT}"`);
  });

  it('names the account email for other formats, and sends nothing when there is none', async () => {
    mocks.emailNameId = null;

    await expect(initiateIdPLogout(env, 'user-a', sp(), 'sidx_1', 'tenant-a')).rejects.toThrow(
      'Logout request could not be processed'
    );
  });

  it('reads the record by tenant, SP and session index', async () => {
    const subject = await import('../subject');

    await initiateIdPLogout(env, 'user-a', sp(), 'sidx_1', 'tenant-a');

    expect(subject.readSAMLSessionIndexNameID).toHaveBeenCalledWith(env.STATE_STORE, {
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example.test/entity',
      sessionIndex: 'sidx_1',
    });
  });
});

describe('resolveIdPLogoutNameID', () => {
  const idpSp = { entityId: 'https://sp.example.test/entity' } as unknown as Parameters<
    typeof resolveIdPLogoutNameID
  >[3];

  it('uses the account NameID for the SP format, email by default', async () => {
    expect(await resolveIdPLogoutNameID(env, 'tenant-a', 'user-a', idpSp)).toBe(
      'user@example.test'
    );
    expect(
      await resolveIdPLogoutNameID(env, 'tenant-a', 'user-a', {
        ...idpSp,
        nameIdFormat: NAMEID_FORMATS.UNSPECIFIED,
      })
    ).toBe('user@example.test');
  });

  it('never names the email of a transient NameID', async () => {
    expect(
      await resolveIdPLogoutNameID(env, 'tenant-a', 'user-a', idpSp, NAMEID_FORMATS.TRANSIENT)
    ).toBeNull();
    expect(
      await resolveIdPLogoutNameID(env, 'tenant-a', 'user-a', {
        ...idpSp,
        nameIdFormat: NAMEID_FORMATS.TRANSIENT,
      })
    ).toBeNull();
  });

  it('prefers the issued format over the configured one', async () => {
    const result = await resolveIdPLogoutNameID(
      env,
      'tenant-a',
      'user-a',
      { ...idpSp, nameIdFormat: NAMEID_FORMATS.EMAIL },
      NAMEID_FORMATS.PERSISTENT
    );

    expect(result).toBe('persistent-value');
    expect(mocks.resolveNameId).toHaveBeenCalledWith({ id: 'user-a' }, NAMEID_FORMATS.PERSISTENT, {
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example.test/entity',
      pairwiseSalt: 'pairwise-secret',
      persistentRegistry: 'registry',
      allowCreate: false,
    });
  });

  it('names nothing for an unknown user and for an SP that was never issued a persistent id', async () => {
    mocks.userInfo = null;
    expect(
      await resolveIdPLogoutNameID(env, 'tenant-a', 'user-a', idpSp, NAMEID_FORMATS.PERSISTENT)
    ).toBeNull();

    mocks.userInfo = { id: 'user-a' };
    mocks.resolveNameId.mockRejectedValue(new mocks.PolicyError('no id'));
    expect(
      await resolveIdPLogoutNameID(env, 'tenant-a', 'user-a', idpSp, NAMEID_FORMATS.PERSISTENT)
    ).toBeNull();
  });

  it('rethrows any other failure', async () => {
    mocks.resolveNameId.mockRejectedValue(new Error('registry down'));

    await expect(
      resolveIdPLogoutNameID(env, 'tenant-a', 'user-a', idpSp, NAMEID_FORMATS.PERSISTENT)
    ).rejects.toThrow('registry down');
  });
});

describe('binding selection', () => {
  it.each([
    [{ sloBinding: 'post' }, 'post'],
    [{ sloBinding: 'redirect', samlProfile: 'legacy' }, 'redirect'],
    [{ samlProfile: 'legacy' }, 'post'],
    [{}, 'redirect'],
    [{ sloBinding: 'auto' }, 'redirect'],
  ])('resolves %o to %s', (config, expected) => {
    expect(resolveIdPInitiatedLogoutBinding(sp(config))).toBe(expected);
  });
});

describe('initiateIdPLogoutBindingResponse', () => {
  it('answers with a signed POST form carrying SAMLRequest and the RelayState', async () => {
    const response = await initiateIdPLogoutBindingResponse(
      env,
      'user-a',
      sp({ sloBinding: 'post' }),
      {
        tenantId: 'tenant-a',
        sessionIndex: 'sidx_1',
        relayState: 'relay-1',
      }
    );

    const html = await response.text();
    expect(html).toContain('<title>SAML Logout</title>');
    expect(html).toContain('action="https://sp.example.test/slo"');
    expect(html).toContain('name="SAMLRequest"');
    expect(html).toContain('name="RelayState" value="relay-1"');
    expect(html).toContain('>Continue</button>');
    const [, options] = mocks.signXml.mock.calls[0] as [string, Record<string, unknown>];
    expect(options).toMatchObject({ signatureLocation: 'prepend', includeKeyInfo: true });
    expect(String(options.referenceUri)).toMatch(/^#_[0-9a-f]+$/);
    expect(mocks.signRedirect).not.toHaveBeenCalled();
    expect(mocks.store).toHaveBeenCalledTimes(1);
  });

  it('omits RelayState from the POST form when none was given', async () => {
    const response = await initiateIdPLogoutBindingResponse(
      env,
      'user-a',
      sp({ sloBinding: 'post' }),
      {
        tenantId: 'tenant-a',
        sessionIndex: 'sidx_1',
      }
    );

    expect(await response.text()).not.toContain('RelayState');
  });

  it('answers with a signed redirect and no cache headers for the redirect binding', async () => {
    const response = await initiateIdPLogoutBindingResponse(env, 'user-a', sp(), {
      tenantId: 'tenant-a',
      sessionIndex: 'sidx_1',
      relayState: 'relay-1',
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://sp.example.test/slo?SAMLRequest=enc&SigAlg=alg&Signature=sig'
    );
    expect(response.headers.get('cache-control')).toBe('no-cache, no-store, must-revalidate');
    const args = mocks.signRedirect.mock.calls[0] ?? [];
    expect(args[0]).toBe('SAMLRequest');
    expect(typeof args[1]).toBe('string');
    expect(args[2]).toBe('relay-1');
    expect(args[3]).toBe('private-key');
    expect(mocks.signXml).not.toHaveBeenCalled();
  });

  it('signs a redirect without RelayState as undefined', async () => {
    await initiateIdPLogoutBindingResponse(env, 'user-a', sp(), {
      tenantId: 'tenant-a',
      sessionIndex: 'sidx_1',
    });

    expect(mocks.signRedirect.mock.calls.map((call) => call[2])).toEqual([undefined]);
  });

  it.each([
    ['https://sp.example.test/slo', 'https://sp.example.test/slo?Q'],
    ['https://sp.example.test/slo?a=1', 'https://sp.example.test/slo?a=1&Q'],
    ['https://sp.example.test/slo?', 'https://sp.example.test/slo?Q'],
    ['https://sp.example.test/slo?a=1&', 'https://sp.example.test/slo?a=1&Q'],
    ['https://sp.example.test/slo#frag', 'https://sp.example.test/slo?Q#frag'],
    ['https://sp.example.test/slo?a=1#frag', 'https://sp.example.test/slo?a=1&Q#frag'],
  ])('appends the signed query to %s', async (sloUrl, expected) => {
    mocks.signRedirect.mockResolvedValue({ signedUrl: 'Q' });

    const response = await initiateIdPLogoutBindingResponse(env, 'user-a', sp({ sloUrl }), {
      tenantId: 'tenant-a',
      sessionIndex: 'sidx_1',
    });

    expect(response.headers.get('location')).toBe(expected);
  });

  it('honours an explicit binding over the SP preference', async () => {
    const response = await initiateIdPLogoutBindingResponse(
      env,
      'user-a',
      sp({ sloBinding: 'post' }),
      {
        tenantId: 'tenant-a',
        sessionIndex: 'sidx_1',
        binding: 'redirect',
      }
    );

    expect(response.status).toBe(302);
  });

  it.each(['post', 'redirect'] as const)(
    'refuses an oversized RelayState for the %s binding without recording a request',
    async (binding) => {
      await expect(
        initiateIdPLogoutBindingResponse(env, 'user-a', sp(), {
          tenantId: 'tenant-a',
          sessionIndex: 'sidx_1',
          relayState: 'x'.repeat(81),
          binding,
        })
      ).rejects.toThrow('RelayState exceeds');

      expect(mocks.store).not.toHaveBeenCalled();
      expect(mocks.logs).toContainEqual({
        level: 'error',
        message: 'Error sending LogoutRequest',
        context: { binding },
      });
    }
  );

  it('logs a signing failure with the binding and rethrows', async () => {
    mocks.signingThrows = true;

    await expect(
      initiateIdPLogoutBindingResponse(env, 'user-a', sp({ sloBinding: 'post' }), {
        tenantId: 'tenant-a',
        sessionIndex: 'sidx_1',
      })
    ).rejects.toThrow('signing unavailable');
    expect(mocks.logs).toContainEqual({
      level: 'error',
      message: 'Error sending LogoutRequest',
      context: { binding: 'post' },
    });
  });
});

describe('initiateIdPMultiSPLogoutBindingResponse', () => {
  const a = sp({ entityId: 'https://a', sloUrl: 'https://a/slo', sloBinding: 'post' });
  const b = sp({ entityId: 'https://b', sloUrl: 'https://b/slo', sloBinding: 'post' });

  it('requires a tenant and at least one target', async () => {
    await expect(initiateIdPMultiSPLogoutBindingResponse(env, 'user-a', [a], {})).rejects.toThrow(
      'IdP-initiated multi-SP SLO tenant'
    );
    await expect(
      initiateIdPMultiSPLogoutBindingResponse(env, 'user-a', [], { tenantId: 'tenant-a' })
    ).rejects.toThrow('IdP-initiated multi-SP SLO requires at least one SP target');
  });

  it('records a transaction over the distinct SPs and sends the first request', async () => {
    const result = await initiateIdPMultiSPLogoutBindingResponse(env, 'user-a', [a, a, b], {
      tenantId: 'tenant-a',
      sessionIndex: 'sidx_1',
      relayState: 'relay',
      transactionId: 'tx-9',
      sessionIndexes: { 'https://b': 'sidx_b' },
    });

    expect(result.transactionId).toBe('tx-9');
    expect(mocks.createFanout).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      userId: 'user-a',
      sessionIndex: 'sidx_1',
      relayState: 'relay',
      transactionId: 'tx-9',
      targets: ['https://a', 'https://b'],
      targetSessionIndexes: { 'https://b': 'sidx_b' },
      ttlSeconds: 300,
    });
    expect(await result.response.text()).toContain('action="https://a/slo"');
    const [, sent] = mocks.markSent.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(sent).toEqual({
      tenantId: 'tenant-a',
      transactionId: 'tx-9',
      spEntityId: 'https://a',
      requestId: sent.requestId,
    });
    expect(String(sent.requestId)).toMatch(/^_[0-9a-f]+$/);
    expect(mocks.store).toHaveBeenCalledWith(
      env.STATE_STORE,
      expect.objectContaining({ transactionId: 'tx-9', spEntityId: 'https://a' })
    );
  });

  it('omits per-SP session indexes when none are given', async () => {
    await initiateIdPMultiSPLogoutBindingResponse(env, 'user-a', [a], {
      tenantId: 'tenant-a',
      sessionIndex: 'sidx_1',
    });

    expect(mocks.createFanout.mock.calls[0]?.[0]).not.toHaveProperty('targetSessionIndexes');
  });

  it('skips an SP whose NameID cannot be named, marks it failed and sends to the next', async () => {
    const subject = await import('../subject');
    vi.mocked(subject.readSAMLSessionIndexNameID).mockResolvedValueOnce(null);

    const result = await initiateIdPMultiSPLogoutBindingResponse(env, 'user-a', [a, b], {
      tenantId: 'tenant-a',
      sessionIndex: 'sidx_1',
    });

    expect(await result.response.text()).toContain('action="https://b/slo"');
    expect(mocks.markCompleted).toHaveBeenCalledWith(env.STATE_STORE, {
      tenantId: 'tenant-a',
      transactionId: 'tx-1',
      spEntityId: 'https://a',
      status: 'failed',
      failureReason: 'nameid_unavailable',
    });
    expect(mocks.logs).toContainEqual({
      level: 'warn',
      message: 'Skipping SP without a nameable NameID during IdP-initiated multi-SP SLO',
      context: { transactionId: 'tx-1', spEntityId: 'https://a' },
    });
  });

  it('fails when no SP can be named', async () => {
    mocks.recorded = null;

    await expect(
      initiateIdPMultiSPLogoutBindingResponse(env, 'user-a', [a, b], {
        tenantId: 'tenant-a',
        sessionIndex: 'sidx_1',
      })
    ).rejects.toThrow(SAMLLogoutNameIDUnavailableError);
    expect(mocks.markCompleted).toHaveBeenCalledTimes(2);
  });

  it('marks the target failed with send_failed and rethrows a delivery error', async () => {
    mocks.signingThrows = true;

    await expect(
      initiateIdPMultiSPLogoutBindingResponse(env, 'user-a', [a, b], {
        tenantId: 'tenant-a',
        sessionIndex: 'sidx_1',
      })
    ).rejects.toThrow('signing unavailable');

    expect(mocks.markCompleted).toHaveBeenCalledTimes(1);
    expect(mocks.markCompleted).toHaveBeenCalledWith(env.STATE_STORE, {
      tenantId: 'tenant-a',
      transactionId: 'tx-1',
      spEntityId: 'https://a',
      status: 'failed',
      failureReason: 'send_failed',
    });
  });
});
