/**
 * Picking an interaction up again (a resume): the request context read back from what the
 * interaction stored (getRequestContextFromInteraction), and the guarded write of its contract in
 * each database dialect.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLoginRuntimeFlowVersionCacheForTests,
  loginRuntimeInteractionStartHandler,
} from '../login-runtime-flow';
import {
  createContext,
  mocks,
  mockStart,
  readJson,
  resetHarness,
  versionRow,
  written,
} from './helpers/mut-runtime1-harness';

vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).libCoreMock(await importOriginal())
);
vi.mock('@authrim/ar-lib-core/services/log-iceberg-emitter', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).icebergMock(await importOriginal())
);
vi.mock('../direct-auth', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).directAuthMock(await importOriginal())
);

let signed: { contract_hash: string; signature: string; expires_at: number };

beforeEach(async () => {
  resetHarness();
  clearLoginRuntimeFlowVersionCacheForTests();
  if (!signed) {
    mockStart();
    const data = await readJson(
      await loginRuntimeInteractionStartHandler(createContext({ body: { flow_kind: 'login' } }))
    );
    signed = {
      contract_hash: String(data.contract_hash),
      signature: String(data.signature),
      expires_at: (data.interaction as { expires_at: number }).expires_at,
    };
    resetHarness();
  }
});

interface Stored {
  context?: Record<string, unknown> | string | null;
  clientId?: string | null;
  samlSpId?: string | null;
}

function mockResume(stored: Stored = {}, parts = { version: true, visit: true }) {
  mocks.coreAdapter.queryOne.mockResolvedValueOnce({
    id: 'interaction_1',
    flow_id: 'flow_login',
    flow_version_id: 'fv_1',
    user_id: null,
    client_id: stored.clientId ?? null,
    saml_sp_id: stored.samlSpId ?? null,
    state: 'active',
    current_node_id: 'auth',
    current_step_id: 'auth:step',
    context_json:
      stored.context === null
        ? null
        : typeof stored.context === 'string'
          ? stored.context
          : JSON.stringify(stored.context ?? {}),
    contract_hash: signed.contract_hash,
    signature: signed.signature,
    expires_at: signed.expires_at,
    submit_claim_expires_at: null,
  });
  if (parts.version) mocks.coreAdapter.queryOne.mockResolvedValueOnce(versionRow());
  if (parts.visit) mocks.coreAdapter.queryOne.mockResolvedValueOnce({ id: 'visit_1' });
}

async function resume(stored: Stored = {}, body: Record<string, unknown> = {}) {
  clearLoginRuntimeFlowVersionCacheForTests();
  mockResume(stored);
  const response = await loginRuntimeInteractionStartHandler(
    createContext({
      body: {
        resume_interaction_id: 'interaction_1',
        contract_hash: signed.contract_hash,
        signature: signed.signature,
        ...body,
      },
    })
  );
  const data = await readJson(response);
  expect(response.status).toBe(200);
  expect(data.resumed).toBe(true);
  return data;
}

function protocolContext(data: Record<string, unknown>) {
  return (data.contract as { protocol_context: Record<string, unknown> }).protocol_context;
}

describe('the request context of a resumed interaction', () => {
  it.each([
    ['an OIDC client', { clientId: 'client_1' }, 'oidc', 'oidc_client', 'client_1'],
    ['a SAML SP', { samlSpId: 'sp_1' }, 'saml', 'saml_sp', 'sp_1'],
    [
      'a SAML SP and a client',
      { samlSpId: 'sp_1', clientId: 'client_1' },
      'saml',
      'saml_sp',
      'sp_1',
    ],
    ['no app', {}, 'direct', 'tenant', null],
  ])(
    'is told by %s when the stored context does not say',
    async (_label, app, protocol, targetType, targetId) => {
      const data = await resume({
        ...app,
        context: { protocol: 'bogus', target_type: 'device' },
      });
      expect(protocolContext(data)).toMatchObject({
        protocol,
        request: { target_type: targetType, target_id: targetId },
      });
    }
  );

  it('keeps what the stored context says over the app of the interaction', async () => {
    const data = await resume({
      clientId: 'client_1',
      context: { protocol: 'direct', target_type: 'tenant', target_id: 'named_target' },
    });
    expect(protocolContext(data)).toMatchObject({
      protocol: 'direct',
      request: { target_type: 'tenant', target_id: 'named_target' },
    });
  });

  it.each([
    ['saml', 'saml_sp'],
    ['oidc', 'oidc_client'],
  ])('keeps a stored %s protocol and %s target', async (protocol, targetType) => {
    const data = await resume({ context: { protocol, target_type: targetType } });
    expect(protocolContext(data)).toMatchObject({
      protocol,
      request: { target_type: targetType, target_id: null },
    });
  });

  it('reads the stored request back, bounded as it was written', async () => {
    const data = await resume({
      samlSpId: 'sp_1',
      context: {
        protocol: 'saml',
        target_type: 'saml_sp',
        target_id: 'sp_1',
        authorization_challenge_id: 'x'.repeat(129),
        saml_request_id: ' req_1 ',
        return_to: '/account',
        requested_scope: 'openid  email',
        locale: 'ja',
      },
    });
    expect(protocolContext(data)).toEqual({
      protocol: 'saml',
      request: {
        target_type: 'saml_sp',
        target_id: 'sp_1',
        requested_scope: ['openid', 'email'],
        locale: 'ja',
        authorization_challenge_id: null,
        saml_request_id: 'req_1',
        saml_sp_entity_id: 'sp_1',
        return_to: '/account',
      },
      oidc: {
        client_id: null,
        authorization_challenge_id: null,
        requested_scope: ['openid', 'email'],
      },
      saml: { saml_sp_id: 'sp_1', saml_request_id: 'req_1', saml_sp_entity_id: 'sp_1' },
    });
  });

  it('takes the SP entity id stored, else the SP id stored, else the SP of the interaction', async () => {
    const entity = (data: Record<string, unknown>) =>
      (protocolContext(data).request as Record<string, unknown>).saml_sp_entity_id;
    expect(
      entity(
        await resume({
          samlSpId: 'sp_1',
          context: { saml_sp_entity_id: 'https://sp.example.test', saml_sp_id: 'stored_sp' },
        })
      )
    ).toBe('https://sp.example.test');
    expect(entity(await resume({ samlSpId: 'sp_1', context: { saml_sp_id: 'stored_sp' } }))).toBe(
      'stored_sp'
    );
  });

  it('reads a stored context that is not an object as empty', async () => {
    for (const context of ['[1,2]', 'not json', null]) {
      const data = await resume({ clientId: 'client_1', context });
      expect(protocolContext(data)).toMatchObject({
        protocol: 'oidc',
        oidc: { client_id: 'client_1' },
      });
    }
  });

  it('shows the locale asked for on the resume, and stores it', async () => {
    const data = await resume(
      { context: { locale: 'en', note: 'kept' } },
      { requested_locale: 'fr' }
    );
    expect(protocolContext(data)).toMatchObject({ request: { locale: 'fr' } });
    const update = written.find((entry) => entry.sql.includes('UPDATE flow_interactions'));
    expect(JSON.parse(String(update?.params[0]))).toMatchObject({ locale: 'fr', note: 'kept' });
  });
});

describe('the guarded write of a resume', () => {
  it.each([
    ['postgres', 'IS NOT DISTINCT FROM'],
    ['aurora-dsql', 'IS NOT DISTINCT FROM'],
    ['d1', 'IS'],
  ])('compares nullable columns null-safely on %s', async (type, operator) => {
    mocks.coreAdapter.getType.mockReturnValue(type);
    await resume();
    const update = written.find((entry) => entry.sql.includes('UPDATE flow_interactions'));
    const sql = String(update?.sql).replace(/\s+/g, ' ');
    expect(sql).toContain(`AND current_step_id ${operator} ? AND context_json ${operator} ?`);
  });

  it('reads the interaction again when a concurrent write refused this one', async () => {
    {
      mockResume({}, { version: true, visit: false });
      mocks.coreAdapter.execute.mockRejectedValueOnce(
        Object.assign(new Error('serialization failure'), { code: '40001' })
      );
      mockResume({}, { version: false, visit: true });
      const pending = loginRuntimeInteractionStartHandler(
        createContext({
          body: {
            resume_interaction_id: 'interaction_1',
            contract_hash: signed.contract_hash,
            signature: signed.signature,
          },
        })
      );
      // Read again after the first delay (100 ms); the version is cached by then.
      const response = await pending;
      expect(response.status).toBe(200);
      expect(mocks.coreAdapter.execute).toHaveBeenCalledTimes(2);
    }
  });

  it('lets any other failure of the write through', async () => {
    mockResume();
    mocks.coreAdapter.execute.mockRejectedValueOnce(
      Object.assign(new Error('unique violation'), { code: '23505' })
    );
    await expect(
      loginRuntimeInteractionStartHandler(
        createContext({
          body: {
            resume_interaction_id: 'interaction_1',
            contract_hash: signed.contract_hash,
            signature: signed.signature,
          },
        })
      )
    ).rejects.toThrow('unique violation');
  });
});
