import { describe, expect, it } from 'vitest';
import type { AdminAuthContext } from '@authrim/ar-lib-core';
import { ADMIN_FRESH_AUTH_WINDOW_MS, isFreshAdminHuman } from '../agent-fresh-auth';

const now = 1_800_000_000_000;

function context(overrides: Partial<AdminAuthContext> = {}): AdminAuthContext {
  return {
    userId: 'admin-1',
    actorType: 'human',
    authMethod: 'session',
    mfaVerified: true,
    authenticationTimeMs: now,
    roles: [],
    permissions: [],
    ...overrides,
  } as AdminAuthContext;
}

describe('isFreshAdminHuman', () => {
  it('accepts only an MFA-verified human Admin session inside the five-minute window', () => {
    expect(isFreshAdminHuman(context(), now)).toBe(true);
    expect(
      isFreshAdminHuman(context({ authenticationTimeMs: now - ADMIN_FRESH_AUTH_WINDOW_MS }), now)
    ).toBe(true);
  });

  it.each([
    ['stale', context({ authenticationTimeMs: now - ADMIN_FRESH_AUTH_WINDOW_MS - 1 })],
    ['future', context({ authenticationTimeMs: now + 1 })],
    ['not MFA verified', context({ mfaVerified: false })],
    ['machine actor', context({ actorType: 'machine' })],
    ['agent actor', context({ actorType: 'agent' })],
    ['non-session auth', context({ authMethod: 'bearer' })],
  ])('rejects %s confirmation context', (_label, auth) => {
    expect(isFreshAdminHuman(auth, now)).toBe(false);
  });
});
