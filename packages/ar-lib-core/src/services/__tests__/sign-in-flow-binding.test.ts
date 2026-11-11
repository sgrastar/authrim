import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import type { Env } from '../../types/env';

const store = vi.hoisted(() => ({
  challenges: new Map<string, Record<string, unknown>>(),
  fail: false,
}));

vi.mock('../../utils/challenge-sharding', () => ({
  getChallengeStoreByChallengeId: async () => ({
    getChallengeRpc: async (id: string) => {
      if (store.fail) throw new Error('challenge store unavailable');
      return store.challenges.get(id) ?? null;
    },
  }),
}));

const {
  assertInteractionAnswersChallenge,
  InteractionChallengeMismatchError,
  isInteractionChallengeMismatchError,
  readChallengeFlowTarget,
  resolveSignInFlowProfileRefs,
  sessionAnswersSAMLRequest,
} = await import('../sign-in-flow-binding');

const env = {} as Env;
const NOW = Math.floor(Date.now() / 1000);

function runtime(methodRef: string, sessionRef: string): string {
  return JSON.stringify({
    flow_kind: 'login',
    ui: {
      steps: [
        {
          id: 's1',
          component: 'authentication_method_selector',
          config: { authentication_profile_ref: methodRef, session_profile_ref: sessionRef },
        },
      ],
    },
  });
}

interface InteractionRow {
  challengeId: string | null;
  samlRequestId?: string;
  clientId?: string;
  samlSpId?: string;
  live?: boolean;
  methodRef?: string;
  sessionRef?: string;
}

/**
 * A core database with interactions by id and the sign-in Flow assigned to apps (by OIDC client
 * id or SAML SP entity id; `tenant` for the tenant's own).
 */
function db(
  interactions: Record<string, InteractionRow>,
  assigned: Record<string, { methodRef: string; sessionRef: string }> = {}
): DatabaseAdapter & { assignmentLookups: unknown[][] } {
  const assignmentLookups: unknown[][] = [];
  return {
    assignmentLookups,
    queryOne: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM flow_interactions')) {
        const row = interactions[params[1] as string];
        if (!row) return null;
        return {
          runtime_snapshot_json: runtime(row.methodRef ?? 'default', row.sessionRef ?? 'default'),
          kind: 'login',
          state: row.live === false ? 'expired' : 'active',
          expires_at: NOW + 600,
          client_id: row.clientId ?? null,
          saml_sp_id: row.samlSpId ?? null,
          context_json: JSON.stringify({
            ...(row.challengeId ? { authorization_challenge_id: row.challengeId } : {}),
            ...(row.samlRequestId ? { saml_request_id: row.samlRequestId } : {}),
          }),
        };
      }
      if (sql.includes('FROM flow_assignments')) {
        assignmentLookups.push(params);
        const key = sql.includes('target_id = ?') ? (params[2] as string) : 'tenant';
        const flow = assigned[key];
        return flow ? { runtime_snapshot_json: runtime(flow.methodRef, flow.sessionRef) } : null;
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  } as unknown as DatabaseAdapter & { assignmentLookups: unknown[][] };
}

beforeEach(() => {
  store.challenges.clear();
  store.fail = false;
  store.challenges.set('ch-a', {
    tenantId: 'tenant-a',
    type: 'login',
    consumed: false,
    metadata: { client_id: 'app-a' },
  });
  store.challenges.set('ch-b', {
    tenantId: 'tenant-a',
    type: 'login',
    consumed: false,
    metadata: { client_id: 'app-b' },
  });
});

describe('a sign-in held to the authorization request it answers', () => {
  it('runs under the interaction that was started for the request', async () => {
    const resolved = await resolveSignInFlowProfileRefs(
      env,
      db({ 'int-a': { challengeId: 'ch-a', methodRef: 'strict', sessionRef: 'short' } }),
      'tenant-a',
      { interactionId: 'int-a', challengeId: 'ch-a' }
    );
    expect(resolved).toEqual({
      refs: { methodProfileRef: 'strict', sessionProfileRef: 'short' },
      interactionId: 'int-a',
    });
  });

  it('refuses an interaction started for another request, or for none', async () => {
    const core = db({
      'int-b': { challengeId: 'ch-b', methodRef: 'wide', sessionRef: 'long' },
      'int-free': { challengeId: null, methodRef: 'wide', sessionRef: 'long' },
    });
    for (const interactionId of ['int-b', 'int-free']) {
      const attempt = resolveSignInFlowProfileRefs(env, core, 'tenant-a', {
        interactionId,
        challengeId: 'ch-a',
      });
      await expect(attempt).rejects.toBeInstanceOf(InteractionChallengeMismatchError);
    }
    // Even one no longer live: it was another request's.
    await expect(
      resolveSignInFlowProfileRefs(
        env,
        db({ 'int-b': { challengeId: 'ch-b', live: false } }),
        'tenant-a',
        { interactionId: 'int-b', challengeId: 'ch-a' }
      )
    ).rejects.toSatisfy(isInteractionChallengeMismatchError);
  });

  it('takes the app’s own sign-in Flow when it names no interaction', async () => {
    const core = db({}, { 'app-a': { methodRef: 'strict', sessionRef: 'short' } });
    const resolved = await resolveSignInFlowProfileRefs(env, core, 'tenant-a', {
      challengeId: 'ch-a',
    });
    expect(resolved).toEqual({
      refs: { methodProfileRef: 'strict', sessionProfileRef: 'short' },
      interactionId: null,
    });
    expect(core.assignmentLookups[0]).toEqual(['tenant-a', 'oidc_client', 'app-a']);
  });

  it('takes the app’s Flow for an interaction gone or no longer live', async () => {
    const assigned = { 'app-a': { methodRef: 'strict', sessionRef: 'short' } };
    for (const interactions of [{}, { 'int-a': { challengeId: 'ch-a', live: false } }]) {
      const resolved = await resolveSignInFlowProfileRefs(
        env,
        db(interactions, assigned),
        'tenant-a',
        { interactionId: 'int-a', challengeId: 'ch-a' }
      );
      expect(resolved.refs).toEqual({ methodProfileRef: 'strict', sessionProfileRef: 'short' });
      expect(resolved.interactionId).toBeNull();
    }
  });

  it('falls back to the tenant’s sign-in Flow, then the Default profiles', async () => {
    const tenantFlow = await resolveSignInFlowProfileRefs(
      env,
      db({}, { tenant: { methodRef: 'tenant-methods', sessionRef: 'tenant-session' } }),
      'tenant-a',
      { challengeId: 'ch-a' }
    );
    expect(tenantFlow.refs).toEqual({
      methodProfileRef: 'tenant-methods',
      sessionProfileRef: 'tenant-session',
    });
    const none = await resolveSignInFlowProfileRefs(env, db({}), 'tenant-a', {
      challengeId: 'ch-a',
    });
    expect(none.refs).toEqual({ methodProfileRef: 'default', sessionProfileRef: 'default' });
  });

  it('keeps a sign-up and a sign-in that answers no request as before', async () => {
    const assigned = { 'app-a': { methodRef: 'strict', sessionRef: 'short' } };
    const signUp = await resolveSignInFlowProfileRefs(env, db({}, assigned), 'tenant-a', {
      challengeId: 'ch-a',
      assignedFallback: false,
    });
    expect(signUp.refs).toEqual({ methodProfileRef: 'default', sessionProfileRef: 'default' });
    const free = await resolveSignInFlowProfileRefs(
      env,
      db({ 'int-free': { challengeId: null, methodRef: 'wide', sessionRef: 'long' } }),
      'tenant-a',
      { interactionId: 'int-free' }
    );
    expect(free).toEqual({
      refs: { methodProfileRef: 'wide', sessionProfileRef: 'long' },
      interactionId: 'int-free',
    });
  });

  it('keeps the Default profiles for a re-authentication request with no interaction', async () => {
    store.challenges.set('ch-reauth', {
      tenantId: 'tenant-a',
      type: 'reauth',
      consumed: false,
      metadata: { client_id: 'app-a' },
    });
    const core = db({}, { 'app-a': { methodRef: 'strict', sessionRef: 'short' } });
    const resolved = await resolveSignInFlowProfileRefs(env, core, 'tenant-a', {
      challengeId: 'ch-reauth',
    });
    expect(resolved.refs).toEqual({ methodProfileRef: 'default', sessionProfileRef: 'default' });
    expect(core.assignmentLookups).toEqual([]);
  });

  it('throws when the request cannot be read', async () => {
    store.fail = true;
    await expect(
      resolveSignInFlowProfileRefs(env, db({}), 'tenant-a', { challengeId: 'ch-a' })
    ).rejects.toThrow('challenge store unavailable');
  });
});

describe('the app an authorization request is for', () => {
  it('reads an OIDC client and a SAML SP, and nothing from a used or foreign one', async () => {
    store.challenges.set('ch-saml', {
      tenantId: 'tenant-a',
      type: 'reauth',
      consumed: false,
      metadata: {
        protocol: 'saml',
        tenant_id: 'tenant-a',
        saml_request_id: 'req-1',
        saml_sp_entity_id: 'https://sp.example',
      },
    });
    store.challenges.set('ch-used', {
      tenantId: 'tenant-a',
      type: 'login',
      consumed: true,
      metadata: { client_id: 'app-a' },
    });
    store.challenges.set('ch-other', {
      tenantId: 'tenant-b',
      type: 'login',
      consumed: false,
      metadata: { client_id: 'app-a' },
    });
    expect(await readChallengeFlowTarget(env, 'tenant-a', 'ch-a')).toEqual({
      clientId: 'app-a',
      samlSpId: null,
      kind: 'login',
    });
    expect(await readChallengeFlowTarget(env, 'tenant-a', 'ch-saml')).toEqual({
      clientId: null,
      samlSpId: 'https://sp.example',
      kind: 'reauth',
    });
    expect(await readChallengeFlowTarget(env, 'tenant-a', 'ch-used')).toBeNull();
    expect(await readChallengeFlowTarget(env, 'tenant-a', 'ch-other')).toBeNull();
    expect(await readChallengeFlowTarget(env, 'tenant-a', 'ch-missing')).toBeNull();
  });
});

describe('an interaction named at the start of a sign-in', () => {
  it('must have been started for the request; one not there lends nothing', async () => {
    const core = db({
      'int-a': { challengeId: 'ch-a' },
      'int-b': { challengeId: 'ch-b' },
    });
    await expect(
      assertInteractionAnswersChallenge(core, 'tenant-a', 'int-a', 'ch-a')
    ).resolves.toBeUndefined();
    await expect(
      assertInteractionAnswersChallenge(core, 'tenant-a', 'int-b', 'ch-a')
    ).rejects.toBeInstanceOf(InteractionChallengeMismatchError);
    await expect(
      assertInteractionAnswersChallenge(core, 'tenant-a', 'int-gone', 'ch-a')
    ).resolves.toBeUndefined();
    await expect(
      assertInteractionAnswersChallenge(core, 'tenant-a', 'int-b', null)
    ).resolves.toBeUndefined();
  });
});

describe('a session answering a SAML request the IdP sent the person to sign in for', () => {
  const SENT = 1_800_000_000_000;
  const base = { sentToSignInAt: SENT, requestId: 'req-1', spEntityId: 'https://sp.example' };
  const core = () =>
    db(
      {
        'int-for-req': {
          challengeId: null,
          samlRequestId: 'req-1',
          samlSpId: 'https://sp.example',
        },
        'int-other': { challengeId: null, samlRequestId: 'req-2', samlSpId: 'https://sp.example' },
        // Another app's interaction that only says it is for the request.
        'int-app': {
          challengeId: null,
          samlRequestId: 'req-1',
          clientId: 'app-a',
          samlSpId: 'https://sp.example',
        },
        'int-other-sp': {
          challengeId: null,
          samlRequestId: 'req-1',
          samlSpId: 'https://sp2.example',
        },
      },
      { 'https://sp.example': { methodRef: 'strict', sessionRef: 'short' } }
    );

  it('takes one from before (single sign-on) and one made for the request', async () => {
    expect(
      await sessionAnswersSAMLRequest(core(), 'tenant-a', {
        ...base,
        sessionCreatedAt: SENT - 1,
        sessionData: { runtime_interaction_id: 'int-other' },
      })
    ).toBe(true);
    expect(
      await sessionAnswersSAMLRequest(core(), 'tenant-a', {
        ...base,
        sessionCreatedAt: SENT + 1,
        sessionData: { runtime_interaction_id: 'int-for-req' },
      })
    ).toBe(true);
  });

  it('refuses one made since in another interaction, or by a route that records none', async () => {
    for (const sessionData of [
      { runtime_interaction_id: 'int-other' },
      { runtime_interaction_id: 'int-app' },
      { runtime_interaction_id: 'int-other-sp' },
      {},
    ]) {
      expect(
        await sessionAnswersSAMLRequest(core(), 'tenant-a', {
          ...base,
          sessionCreatedAt: SENT + 1,
          sessionData,
        })
      ).toBe(false);
    }
  });

  it('takes one from a route that records none while the SP’s Flow sets nothing', async () => {
    expect(
      await sessionAnswersSAMLRequest(db({}), 'tenant-a', {
        ...base,
        sessionCreatedAt: SENT + 1,
        sessionData: {},
      })
    ).toBe(true);
  });
});
