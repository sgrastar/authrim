import { describe, expect, it, vi } from 'vitest';
import {
  evaluateSessionAssurance,
  type EvaluateSessionAssuranceInput,
  type SessionAssuranceStore,
} from '../assurance-session';

const NOW = 1_800_000_000_000;

interface FakeSession {
  userId: string;
  expiresAt: number;
  data: Record<string, unknown>;
}

/** A store of sessions that applies `ifDataMatches` the way the SessionStore does. */
function fakeStore(sessions: Record<string, FakeSession>) {
  const writes: Array<{ id: string; updates: Record<string, unknown> }> = [];
  const store: SessionAssuranceStore = {
    async getSessionRpc(id) {
      return sessions[id] ?? null;
    },
    async updateSessionDataRpc(id, updates, options) {
      const current = sessions[id];
      if (!current) return null;
      const expected = (options?.ifDataMatches ?? {}) as Record<string, unknown>;
      const matches = Object.entries(expected).every(
        ([field, value]) => JSON.stringify(current.data[field]) === JSON.stringify(value)
      );
      if (matches) {
        writes.push({ id, updates: { ...updates } });
        current.data = { ...current.data, ...updates };
      }
      return current;
    },
  };
  return { store, writes };
}

const PRIOR: FakeSession = {
  userId: 'user-1',
  expiresAt: NOW + 60_000,
  data: { amr: ['pwd'], proven_at: NOW - 3_600_000 },
};

function stepUpInput(
  sessions: Record<string, FakeSession>,
  overrides: Partial<EvaluateSessionAssuranceInput> = {}
) {
  const { store, writes } = fakeStore(sessions);
  const input: EvaluateSessionAssuranceInput = {
    sessionId: 'new',
    sessionData: sessions.new?.data,
    sessionDataUserId: 'user-1',
    sessionUserId: 'user-1',
    upstreamAcrMappings: {},
    reauthIssuedAt: NOW - 1_000,
    stepUp: { issuedAt: NOW - 1_000, priorSessionId: 'prior' },
    getSessionStore: () => store,
    now: () => NOW,
    ...overrides,
  };
  return { input, writes };
}

describe('evaluateSessionAssurance', () => {
  it('reads the AAL of the evidence a session records, and writes nothing', async () => {
    const { store, writes } = fakeStore({});
    const result = await evaluateSessionAssurance({
      sessionId: 's',
      sessionData: { amr: ['pwd', 'totp'], proven_at: NOW },
      sessionDataUserId: 'user-1',
      sessionUserId: 'user-1',
      upstreamAcrMappings: {},
      getSessionStore: () => store,
    });
    expect(result).toMatchObject({ ownSession: true, evidenceSession: true, aal: 'AAL2' });
    expect(writes).toEqual([]);
  });

  it("counts for nothing another user's session", async () => {
    const result = await evaluateSessionAssurance({
      sessionId: 's',
      sessionData: { amr: ['pwd', 'totp'], proven_at: NOW },
      sessionDataUserId: 'someone-else',
      sessionUserId: 'user-1',
      upstreamAcrMappings: {},
      getSessionStore: () => fakeStore({}).store,
    });
    expect(result).toMatchObject({ ownSession: false, evidenceSession: false, aal: 'AAL0' });
  });

  it.each([
    ['proven before the re-authentication was asked for', { amr: ['pwd'], proven_at: NOW - 5 }],
    ['recording no proof time', { amr: ['pwd'] }],
  ])('counts for nothing a session %s', async (_name, data) => {
    const result = await evaluateSessionAssurance({
      sessionId: 's',
      sessionData: data,
      sessionDataUserId: 'user-1',
      sessionUserId: 'user-1',
      upstreamAcrMappings: {},
      reauthIssuedAt: NOW,
      getSessionStore: () => fakeStore({}).store,
    });
    expect(result).toMatchObject({ evidenceSession: false, aal: 'AAL0' });
  });

  it('counts a session proven after the re-authentication was asked for', async () => {
    const result = await evaluateSessionAssurance({
      sessionId: 's',
      sessionData: { amr: ['pwd'], proven_at: NOW },
      sessionDataUserId: 'user-1',
      sessionUserId: 'user-1',
      upstreamAcrMappings: {},
      reauthIssuedAt: NOW,
      getSessionStore: () => fakeStore({}).store,
    });
    expect(result).toMatchObject({ evidenceSession: true, aal: 'AAL1' });
  });

  describe('a step-up', () => {
    const totpLogin = (): FakeSession => ({
      userId: 'user-1',
      expiresAt: NOW + 60_000,
      data: { amr: ['totp'], proven_at: NOW - 500 },
    });

    it("combines the earlier session's password with the TOTP of the step-up and records it", async () => {
      const sessions = { prior: structuredClone(PRIOR), new: totpLogin() };
      const { input, writes } = stepUpInput(sessions);
      const result = await evaluateSessionAssurance(input);
      expect(result).toMatchObject({ aal: 'AAL2', combinedAmr: ['pwd', 'totp'] });
      expect(writes).toHaveLength(1);
      expect(sessions.new.data).toMatchObject({
        amr: ['pwd', 'totp'],
        // As old as the oldest proof, so it cannot pass for a later step-up's own authentication;
        // the step-up's own login stays what a later re-authentication can take.
        proven_at: PRIOR.data.proven_at,
        reauth_proven_amr: ['totp'],
        reauth_proven_at: NOW - 500,
      });
    });

    // TOTP alone is AAL1, and the password of the earlier session is not added to it.
    it.each([
      ['a session that records no proof time', { amr: ['totp'] }],
      ['a session proven before the step-up began', { amr: ['totp'], proven_at: NOW - 2_000 }],
    ])('does not combine %s', async (_name, data) => {
      const sessions = {
        prior: structuredClone(PRIOR),
        new: { ...totpLogin(), data },
      };
      const { input, writes } = stepUpInput(sessions, { reauthIssuedAt: undefined });
      const result = await evaluateSessionAssurance(input);
      expect(result).toMatchObject({ aal: 'AAL1' });
      expect(result).not.toHaveProperty('combinedAmr');
      expect(writes).toEqual([]);
    });

    it.each([
      ['another user', { ...PRIOR, userId: 'user-2' }],
      ['an expired session', { ...PRIOR, expiresAt: NOW - 1 }],
    ])('does not combine with the session of %s', async (_name, prior) => {
      const sessions = { prior: structuredClone(prior), new: totpLogin() };
      const { input, writes } = stepUpInput(sessions);
      const result = await evaluateSessionAssurance(input);
      expect(result).toMatchObject({ aal: 'AAL1' });
      expect(writes).toEqual([]);
    });

    it('does not combine a session with itself, or with a missing one', async () => {
      const sessions = { new: totpLogin() };
      for (const priorSessionId of ['new', 'gone', undefined]) {
        const { input, writes } = stepUpInput(sessions, {
          stepUp: { issuedAt: NOW - 1_000, priorSessionId },
        });
        const result = await evaluateSessionAssurance(input);
        expect(result).toMatchObject({ aal: 'AAL1' });
        expect(writes).toEqual([]);
      }
    });

    it('ends the evaluation when the session ended while it was being recorded', async () => {
      const sessions = { prior: structuredClone(PRIOR), new: totpLogin() };
      const { input } = stepUpInput(sessions, {
        getSessionStore: () => ({
          getSessionRpc: async () => sessions.prior,
          updateSessionDataRpc: async () => null,
        }),
      });
      expect(await evaluateSessionAssurance(input)).toEqual({ sessionEnded: true });
    });

    it('merges over what a concurrent step-up of the same session recorded, instead of replacing it', async () => {
      const sessions = { prior: structuredClone(PRIOR), new: totpLogin() };
      const { store } = fakeStore(sessions);
      let first = true;
      const { input } = stepUpInput(sessions, {
        getSessionStore: () => ({
          getSessionRpc: store.getSessionRpc,
          async updateSessionDataRpc(id, updates, options) {
            if (first) {
              // Another step-up of the session lands between the read and this write.
              first = false;
              sessions.new.data = {
                ...sessions.new.data,
                amr: ['totp', 'did'],
                proven_at: NOW - 400,
              };
            }
            return store.updateSessionDataRpc(id, updates, options);
          },
        }),
      });
      const result = await evaluateSessionAssurance(input);
      expect(result).toMatchObject({ aal: 'AAL2', combinedAmr: ['pwd', 'totp'] });
      // The second attempt merged the concurrent factor in rather than overwriting it.
      expect(sessions.new.data.amr).toEqual(expect.arrayContaining(['pwd', 'totp', 'did']));
    });

    it('keeps its own evidence, and says so, when the session keeps changing underneath it', async () => {
      const sessions = { prior: structuredClone(PRIOR), new: totpLogin() };
      const onUnrecorded = vi.fn();
      let counter = 0;
      const { input } = stepUpInput(sessions, {
        onUnrecorded,
        getSessionStore: () => ({
          getSessionRpc: async () => sessions.prior,
          // Never matches what was read, never writes.
          updateSessionDataRpc: async () => ({
            userId: 'user-1',
            expiresAt: NOW + 1,
            data: { amr: ['x'], proven_at: ++counter },
          }),
        }),
      });
      const result = await evaluateSessionAssurance(input);
      expect(result).toMatchObject({ aal: 'AAL2' });
      expect(onUnrecorded).toHaveBeenCalledTimes(1);
    });
  });
});
