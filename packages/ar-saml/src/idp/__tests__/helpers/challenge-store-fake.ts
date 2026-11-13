/**
 * An in-memory stand-in for the ChallengeStore Durable Object stub, serving the three calls the
 * SAML IdP makes for the consent screen: it stores a challenge (`storeChallengeRpc`), reads it
 * back (`getChallengeRpc`) and uses it up (`consumeChallengeRpc`, which with `requireDecided`
 * refuses a challenge nobody answered, as the real one does). `decide` stands for the consent
 * screen writing its answer onto the challenge.
 */
import { vi } from 'vitest';

export interface FakeChallenge {
  id: string;
  tenantId: string;
  type: string;
  userId: string;
  consumed: boolean;
  notAfterMs?: number;
  metadata?: Record<string, unknown>;
  decision?: Record<string, unknown>;
}

export interface ChallengeStoreFake {
  challenges: Map<string, FakeChallenge>;
  /** The stub the test environment's CHALLENGE_STORE namespace returns. */
  stub: {
    storeChallengeRpc: ReturnType<typeof vi.fn>;
    getChallengeRpc: ReturnType<typeof vi.fn>;
    consumeChallengeRpc: ReturnType<typeof vi.fn>;
  };
  /** The challenges stored for the consent screen (not the Login UI's). */
  consentChallenges: () => FakeChallenge[];
  /** The consent screen's answer, as `decideChallengeRpc` records it. */
  decide: (id: string, decision: Record<string, unknown>) => void;
  reset: () => void;
}

export function createChallengeStoreFake(): ChallengeStoreFake {
  const challenges = new Map<string, FakeChallenge>();
  const fake: ChallengeStoreFake = {
    challenges,
    stub: {
      storeChallengeRpc: vi.fn(async (request: Record<string, unknown>) => {
        challenges.set(
          request.id as string,
          {
            id: request.id as string,
            tenantId: request.tenantId as string,
            type: request.type as string,
            userId: request.userId as string,
            consumed: false,
            ...(typeof request.notAfterMs === 'number' ? { notAfterMs: request.notAfterMs } : {}),
            ...(request.metadata ? { metadata: structuredClone(request.metadata) } : {}),
          } as FakeChallenge
        );
        return { success: true };
      }),
      getChallengeRpc: vi.fn(async (id: string) => {
        const challenge = challenges.get(id);
        return challenge ? structuredClone(challenge) : null;
      }),
      consumeChallengeRpc: vi.fn(async (request: Record<string, unknown>) => {
        const challenge = challenges.get(request.id as string);
        if (!challenge || challenge.consumed) throw new Error('Challenge not found or consumed');
        if (request.requireDecided && !challenge.decision) throw new Error('Challenge not decided');
        challenge.consumed = true;
        return structuredClone(challenge);
      }),
    },
    consentChallenges: () => [...challenges.values()].filter((entry) => entry.type === 'consent'),
    decide(id, decision) {
      const challenge = challenges.get(id);
      if (!challenge) throw new Error(`no challenge ${id}`);
      challenge.decision = structuredClone(decision);
    },
    reset() {
      challenges.clear();
      for (const fn of Object.values(fake.stub)) fn.mockClear();
    },
  };
  return fake;
}
