import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import type { Env } from '../../types/env';
import {
  applyLoginFlowSpec,
  buildLoginFlowEditor,
  readLoginFlowEditor,
} from '../../types/login-flow-graph';
import {
  buildRegistrationFlowEditor,
  defaultRegistrationFlowSpec,
  readRegistrationFlowEditor,
} from '../../types/registration-flow-graph';
import {
  flowProfileRefsOfRuntime,
  loadAssignedLoginFlowProfileRefs,
  loadInteractionFlowProfileRefs,
} from '../flow-profile-refs';
import { profileAllowsHandle } from '../registration/authentication-profile';

const profiles = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  fail: false,
}));

vi.mock('../admin-database-adapter', () => ({
  requireDedicatedAdminDatabaseAdapter: () => ({}),
}));
vi.mock('../../repositories/admin/authentication-method-profile', () => ({
  // A tenant's own profiles (services/platform-profiles.ts reads them through this class).
  NamedProfileRepository: class {
    async find(_tenantId: string, id: string) {
      if (profiles.fail) throw new Error('d1 unavailable');
      const values = profiles.rows.get(id);
      return values ? { id, values } : null;
    }
  },
}));

const {
  readSessionProfile,
  resolveProfiledSessionTtl,
  sessionExtensionPolicyOfData,
  sessionProfileSso,
  sessionSettingsWithProfile,
  SessionProfileUnavailableError,
} = await import('../session-profile');

const HOUR = 60 * 60 * 1000;

function envWith(session: Record<string, unknown>): Env {
  return {
    SETTINGS: {
      get: vi.fn(async (key: string) =>
        key === 'settings:tenant:tenant-a:session' ? JSON.stringify(session) : null
      ),
    },
  } as unknown as Env;
}

describe('a session profile', () => {
  it('lays its values over the tenant’s, and leaves the rest to the tenant', () => {
    const tenant = { 'session.default_ttl': 24 * HOUR, 'session.max_ttl': 30 * 24 * HOUR };
    const settings = sessionSettingsWithProfile(tenant, {
      kind: 'profile',
      id: 'short',
      values: { 'session.default_ttl': HOUR, 'oauth.sso_enabled': false, 'session.other': 1 },
    });
    expect(settings).toEqual({ 'session.default_ttl': HOUR, 'session.max_ttl': 30 * 24 * HOUR });
    expect(sessionSettingsWithProfile(tenant, { kind: 'default' })).toBe(tenant);
  });

  it('makes no session for a profile that is not there', () => {
    expect(() => sessionSettingsWithProfile({}, { kind: 'missing', id: 'gone' })).toThrow(
      SessionProfileUnavailableError
    );
  });

  it('sets single sign-on only where it says so, and turns it off when missing', () => {
    expect(sessionProfileSso({ kind: 'default' })).toBeNull();
    expect(sessionProfileSso({ kind: 'profile', id: 'p', values: {} })).toBeNull();
    expect(
      sessionProfileSso({ kind: 'profile', id: 'p', values: { 'oauth.sso_enabled': true } })
    ).toBe(true);
    expect(sessionProfileSso({ kind: 'missing', id: 'p' })).toBe(false);
  });

  it('reads Default without the database, and a failed read as missing', async () => {
    const env = envWith({});
    expect(await readSessionProfile(env, 'tenant-a', 'default')).toEqual({ kind: 'default' });
    expect(await readSessionProfile(env, 'tenant-a', null)).toEqual({ kind: 'default' });
    profiles.fail = true;
    try {
      expect(await readSessionProfile(env, 'tenant-a', 'short')).toEqual({
        kind: 'missing',
        id: 'short',
      });
    } finally {
      profiles.fail = false;
    }
  });

  it('gives a new session the profile’s lifetime and keeps its extension rules', async () => {
    profiles.rows.set('short', {
      'session.ttl.direct_auth': 2 * HOUR,
      'session.max_ttl': 24 * HOUR,
      'session.refresh_default': false,
    });
    const env = envWith({ 'session.ttl.direct_auth': 12 * HOUR });
    const profiled = await resolveProfiledSessionTtl(env, 'tenant-a', 'direct_auth', 'short');
    expect(profiled.ttl.milliseconds).toBe(2 * HOUR);
    expect(profiled.snapshot).toEqual({
      session_profile_id: 'short',
      session_extension: { enabled: false, max_lifetime_ms: 24 * HOUR },
    });
    const plain = await resolveProfiledSessionTtl(env, 'tenant-a', 'direct_auth', 'default');
    expect(plain.ttl.milliseconds).toBe(12 * HOUR);
    expect(plain.snapshot.session_profile_id).toBeUndefined();
    await expect(
      resolveProfiledSessionTtl(env, 'tenant-a', 'direct_auth', 'gone')
    ).rejects.toBeInstanceOf(SessionProfileUnavailableError);
  });

  it('reads the extension rules a session kept, and none from older sessions', () => {
    expect(
      sessionExtensionPolicyOfData({
        session_extension: { enabled: true, max_lifetime_ms: 3 * HOUR },
      })
    ).toEqual({ enabled: true, maxLifetimeMs: 3 * HOUR });
    expect(sessionExtensionPolicyOfData({})).toBeNull();
    expect(sessionExtensionPolicyOfData(undefined)).toBeNull();
    expect(
      sessionExtensionPolicyOfData({ session_extension: { enabled: 'yes', max_lifetime_ms: 1 } })
    ).toBeNull();
    expect(
      sessionExtensionPolicyOfData({ session_extension: { enabled: true, max_lifetime_ms: 0 } })
    ).toBeNull();
  });
});

const runtimeWith = (component: string, config: Record<string, unknown>) =>
  JSON.stringify({
    ui: {
      steps: [
        { id: 's', component: 'session_check' },
        { component, config },
      ],
    },
  });

describe('the profiles a Flow names', () => {
  it('reads them from the sign-in or sign-up step, Default where it names none', () => {
    expect(
      flowProfileRefsOfRuntime(
        JSON.parse(
          runtimeWith('authentication_method_selector', {
            authentication_profile_ref: 'members',
            session_profile_ref: 'short',
          })
        )
      )
    ).toEqual({ methodProfileRef: 'members', sessionProfileRef: 'short' });
    expect(
      flowProfileRefsOfRuntime(JSON.parse(runtimeWith('registration_method_selector', {})))
    ).toEqual({ methodProfileRef: 'default', sessionProfileRef: 'default' });
    expect(flowProfileRefsOfRuntime(null)).toEqual({
      methodProfileRef: 'default',
      sessionProfileRef: 'default',
    });
  });

  it('reads an interaction’s Flow, and throws for a broken runtime', async () => {
    const db = (snapshot: string | null, found = true) =>
      ({
        queryOne: async () =>
          found
            ? {
                runtime_snapshot_json: snapshot,
                kind: 'login',
                state: 'active',
                expires_at: Math.floor(Date.now() / 1000) + 600,
              }
            : null,
      }) as unknown as DatabaseAdapter;
    expect(
      await loadInteractionFlowProfileRefs(
        db(
          runtimeWith('authentication_method_selector', {
            session_profile_ref: 'short',
            completion: { behavior: 'service_site', service_site_path: '/portal' },
          })
        ),
        'tenant-a',
        'i-1'
      )
    ).toEqual({
      methodProfileRef: 'default',
      sessionProfileRef: 'short',
      flowKind: 'login',
      completion: { behavior: 'service_site', service_site_path: '/portal' },
      live: true,
      authorizationChallengeId: null,
      samlRequestId: null,
      clientId: null,
      samlSpId: null,
    });
    // A completion that does not read as one is the tenant's destination.
    expect(
      (
        await loadInteractionFlowProfileRefs(
          db(runtimeWith('authentication_method_selector', { completion: { behavior: 'x' } })),
          'tenant-a',
          'i-1'
        )
      )?.completion
    ).toBeNull();
    expect(await loadInteractionFlowProfileRefs(db(null, false), 'tenant-a', 'i-1')).toBeNull();
    await expect(
      loadInteractionFlowProfileRefs(db('{"ui":{}}'), 'tenant-a', 'i-1')
    ).rejects.toThrow();
  });

  it('prefers the sign-in Flow assigned to the app, then the tenant’s', async () => {
    const calls: unknown[][] = [];
    const db = (appHas: boolean) =>
      ({
        queryOne: async (sql: string, params: unknown[]) => {
          calls.push(params);
          if (sql.includes("target_type = 'tenant'")) {
            return {
              runtime_snapshot_json: runtimeWith('authentication_method_selector', {
                session_profile_ref: 'tenant-wide',
              }),
            };
          }
          return appHas
            ? {
                runtime_snapshot_json: runtimeWith('authentication_method_selector', {
                  session_profile_ref: 'app',
                }),
              }
            : null;
        },
      }) as unknown as DatabaseAdapter;
    expect(
      (await loadAssignedLoginFlowProfileRefs(db(true), 'tenant-a', { clientId: 'c-1' }))
        ?.sessionProfileRef
    ).toBe('app');
    expect(calls[0]).toEqual(['tenant-a', 'oidc_client', 'c-1']);
    expect(
      (await loadAssignedLoginFlowProfileRefs(db(false), 'tenant-a', { clientId: 'c-1' }))
        ?.sessionProfileRef
    ).toBe('tenant-wide');
  });
});

describe('the sign-in Flow graph', () => {
  const spec = {
    profileRef: 'members',
    sessionProfileRef: 'short',
    completion: { behavior: 'custom_url' as const, redirect_url: '/welcome' },
  };

  it('is read back as the spec it was built from', () => {
    const editor = buildLoginFlowEditor(spec);
    expect(readLoginFlowEditor(JSON.parse(JSON.stringify(editor)))).toEqual(spec);
    const auth = editor.nodes.find((node) => node.type === 'authentication');
    expect(auth?.config).toMatchObject({
      authentication_profile_ref: 'members',
      session_profile_ref: 'short',
      completion: { behavior: 'custom_url', redirect_url: '/welcome' },
    });
    // The sign-in step goes on to the protocol branch, the step after it.
    const order = editor.nodes.map((node) => node.id);
    expect(order[order.indexOf('authentication') + 1]).toBe('protocol');
    expect(editor.edges.some((edge) => edge.source === 'authentication')).toBe(false);
    expect(
      readLoginFlowEditor(buildLoginFlowEditor({ ...spec, completion: null }))?.completion
    ).toBeNull();
  });

  it('applies the settings to an existing Flow’s sign-in step and changes nothing else', () => {
    const standard = {
      nodes: [
        { id: 'request', type: 'entry' },
        { id: 'session-check', type: 'session_check' },
        {
          id: 'auth',
          type: 'authentication',
          config: {
            authentication_profile_ref: 'default',
            screen_ref: 'login',
            outputs: [{ id: 'passkey' }],
            completion: { behavior: 'account' },
          },
        },
        { id: 'done', type: 'complete' },
      ],
      edges: [{ id: 'e', source: 'session-check', source_handle: 'continue', target: 'auth' }],
    };
    const applied = applyLoginFlowSpec(standard, { ...spec, completion: null });
    expect(applied?.edges).toEqual(standard.edges);
    expect(applied?.nodes.find((node) => node.id === 'auth')?.config).toEqual({
      authentication_profile_ref: 'members',
      session_profile_ref: 'short',
      screen_ref: 'login',
      outputs: [{ id: 'passkey' }],
    });
    // The Flow given is not changed.
    expect(standard.nodes[2].config).toHaveProperty('completion');
    expect(readLoginFlowEditor(applied)).toEqual({ ...spec, completion: null });
  });

  it('is not set up here for a Flow without one sign-in step', () => {
    const editor = buildLoginFlowEditor(spec);
    const none = {
      ...editor,
      nodes: editor.nodes.filter((node) => node.type !== 'authentication'),
    };
    const two = { ...editor, nodes: [...editor.nodes, { ...editor.nodes[2], id: 'second' }] };
    expect(readLoginFlowEditor(none)).toBeNull();
    expect(readLoginFlowEditor(two)).toBeNull();
    expect(applyLoginFlowSpec(two, spec)).toBeNull();
    expect(readLoginFlowEditor(null)).toBeNull();
  });

  it('keeps the sign-up Flow’s session profile too', () => {
    const signUp = { ...defaultRegistrationFlowSpec(), sessionProfileRef: 'short' };
    expect(readRegistrationFlowEditor(buildRegistrationFlowEditor(signUp))?.sessionProfileRef).toBe(
      'short'
    );
  });
});

describe('a method profile and DID', () => {
  it('takes DID for sign-in only, and as the profile allows', () => {
    const profile = { kind: 'profile', values: {} } as const;
    expect(profileAllowsHandle(profile, 'did', 'login')).toBe(true);
    expect(profileAllowsHandle(profile, 'did', 'signup')).toBe(false);
    expect(
      profileAllowsHandle(
        { kind: 'profile', values: { 'authentication-methods.did.login_enabled': false } },
        'did',
        'login'
      )
    ).toBe(false);
  });
});
