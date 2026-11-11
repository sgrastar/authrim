/**
 * Single sign-on for a silent external sign-in, decided as authorize decides it: the app's own
 * setting, then its sign-in Flow's session profile, then the tenant's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ refs: vi.fn(), profile: vi.fn() }));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  loadAssignedLoginFlowProfileRefs: mocks.refs,
  readSessionProfile: mocks.profile,
}));

import { clientSsoOverride, signInFlowProfileSso } from '../services/silent-sso';

const env = {} as never;
const db = {} as never;

beforeEach(() => {
  mocks.refs.mockReset();
  mocks.profile.mockReset();
});

describe('the app’s own single sign-on setting', () => {
  it('counts only a value set for the app, not its category default', () => {
    expect(
      clientSsoOverride({
        values: { 'client.sso_enabled': false },
        sources: { 'client.sso_enabled': 'default' },
      })
    ).toBeNull();
    expect(
      clientSsoOverride({
        values: { 'client.sso_enabled': true },
        sources: { 'client.sso_enabled': 'kv' },
      })
    ).toBe(true);
    expect(clientSsoOverride({ values: {}, sources: {} })).toBeNull();
  });
});

describe('the sign-in Flow’s session profile', () => {
  it('sets single sign-on where the profile says so', async () => {
    mocks.refs.mockResolvedValue({ methodProfileRef: 'default', sessionProfileRef: 'shared' });
    mocks.profile.mockResolvedValue({
      kind: 'profile',
      id: 'shared',
      values: { 'oauth.sso_enabled': true },
    });
    expect(await signInFlowProfileSso(env, db, 't', 'client-a')).toBe(true);
    expect(mocks.refs).toHaveBeenCalledWith(db, 't', { clientId: 'client-a' });
  });

  it('leaves it to the tenant with no Flow, Default, or a profile that sets nothing', async () => {
    mocks.refs.mockResolvedValue(null);
    expect(await signInFlowProfileSso(env, db, 't', 'client-a')).toBeNull();
    mocks.refs.mockResolvedValue({ methodProfileRef: 'default', sessionProfileRef: 'default' });
    expect(await signInFlowProfileSso(env, db, 't', 'client-a')).toBeNull();
    mocks.refs.mockResolvedValue({ methodProfileRef: 'default', sessionProfileRef: 'p' });
    mocks.profile.mockResolvedValue({ kind: 'profile', id: 'p', values: {} });
    expect(await signInFlowProfileSso(env, db, 't', 'client-a')).toBeNull();
  });

  it('turns it off when the Flow or its profile cannot be read', async () => {
    mocks.refs.mockRejectedValue(new Error('d1 down'));
    expect(await signInFlowProfileSso(env, db, 't', 'client-a')).toBe(false);
    mocks.refs.mockResolvedValue({ methodProfileRef: 'default', sessionProfileRef: 'gone' });
    mocks.profile.mockResolvedValue({ kind: 'missing', id: 'gone' });
    expect(await signInFlowProfileSso(env, db, 't', 'client-a')).toBe(false);
  });
});
