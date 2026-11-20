/**
 * The sign-in methods a method selector step offers (its output handles): the tenant's
 * authentication-methods settings, per sign-in or sign-up, and its external providers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowRuntimeContract } from '@authrim/ar-lib-core';
import {
  clearLoginRuntimeFlowVersionCacheForTests,
  loginRuntimeInteractionStartHandler,
} from '../login-runtime-flow';
import {
  assignmentRow,
  contractStep,
  createContext,
  loginRuntime,
  mocks,
  readJson,
  resetHarness,
  versionRow,
} from './helpers/mut-runtime1-harness';
import { handlesOf, none, registrationRuntime } from './helpers/mut-runtime1-handles';

vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).libCoreMock(await importOriginal())
);
vi.mock('@authrim/ar-lib-core/services/log-iceberg-emitter', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).icebergMock(await importOriginal())
);
vi.mock('../direct-auth', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).directAuthMock(await importOriginal())
);

beforeEach(() => {
  resetHarness();
  clearLoginRuntimeFlowVersionCacheForTests();
});

describe('the methods of the tenant settings', () => {
  it('offers email codes and passkeys by default, not TOTP', async () => {
    expect(await handlesOf()).toEqual(['mail_otp', 'passkey']);
  });

  it('reads the legacy switch of each method, also written as text', async () => {
    expect(
      await handlesOf({
        methods: {
          'authentication-methods.email_otp.enabled': ' FALSE ',
          'authentication-methods.passkey.enabled': 'false',
          'authentication-methods.totp.enabled': 'True',
        },
      })
    ).toEqual(['totp']);
  });

  it('ignores a switch that is neither a boolean nor true/false text', async () => {
    expect(
      await handlesOf({
        methods: {
          'authentication-methods.email_otp.enabled': 'off',
          'authentication-methods.passkey.enabled': 0,
          'authentication-methods.totp.enabled': 'yes',
        },
      })
    ).toEqual(['mail_otp', 'passkey']);
  });

  it('lets the sign-in switch of a method win over its legacy one', async () => {
    expect(
      await handlesOf({
        methods: {
          'authentication-methods.email_otp.enabled': false,
          'authentication-methods.email_otp.login_enabled': true,
          'authentication-methods.passkey.login_enabled': false,
          'authentication-methods.totp.login_enabled': 'true',
          'authentication-methods.email_otp.signup_enabled': false,
        },
      })
    ).toEqual(['mail_otp', 'totp']);
  });

  it('offers a directory password and guest sign-in when turned on, for a sign-in', async () => {
    expect(
      await handlesOf({
        methods: {
          ...none,
          'authentication-methods.directory_password.enabled': true,
          'authentication-methods.guest.login_enabled': true,
        },
      })
    ).toEqual(['directory_password', 'guest']);
  });

  it('reads the sign-up switches for a registration, without a password or guest', async () => {
    expect(
      await handlesOf({
        runtime: registrationRuntime,
        methods: {
          'authentication-methods.email_otp.login_enabled': false,
          'authentication-methods.email_otp.signup_enabled': true,
          'authentication-methods.passkey.signup_enabled': false,
          'authentication-methods.totp.signup_enabled': true,
          'authentication-methods.directory_password.enabled': true,
          'authentication-methods.guest.login_enabled': true,
        },
      })
    ).toEqual(['mail_otp', 'totp']);
  });

  it('reads the sign-up switches for a registration selector in a sign-in Flow', async () => {
    const runtime: FlowRuntimeContract = {
      ...loginRuntime,
      ui: {
        steps: [{ ...registrationRuntime.ui.steps[0] }, loginRuntime.ui.steps[1]],
      },
    };
    expect(
      await handlesOf({
        runtime,
        methods: {
          'authentication-methods.passkey.signup_enabled': false,
          'authentication-methods.guest.login_enabled': true,
        },
      })
    ).toEqual(['mail_otp']);
  });

  it('reads settings that are not JSON as none', async () => {
    const settings = {
      get: vi.fn(async (key: string) =>
        key === 'settings:tenant:tenant_test:authentication-methods' ? '{oops' : null
      ),
    };
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce(assignmentRow())
      .mockResolvedValueOnce(versionRow());
    const response = await loginRuntimeInteractionStartHandler(
      createContext({ body: { flow_kind: 'login' }, env: { SETTINGS: settings } })
    );
    const step = contractStep(await readJson(response), 'auth:step');
    expect((step?.config as Record<string, unknown>).output_handles).toEqual([
      'mail_otp',
      'passkey',
    ]);
  });
});

describe('a guest sign-in', () => {
  const methods = { ...none, 'authentication-methods.guest.login_enabled': true };
  const editor = (handles: string[]) => ({
    nodes: [
      { id: 'auth', type: 'authentication' },
      { id: 'complete', type: 'complete' },
    ],
    edges: handles.map((handle) => ({
      id: `edge_${handle}`,
      source: 'auth',
      target: 'complete',
      source_handle: handle,
    })),
  });

  it('is not offered when the published Flow has no route for it', async () => {
    expect(await handlesOf({ methods, editor: editor(['passkey']) })).toEqual([]);
    clearLoginRuntimeFlowVersionCacheForTests();
    expect(
      await handlesOf({
        methods: { ...methods, 'authentication-methods.passkey.enabled': true },
        editor: editor(['passkey']),
      })
    ).toEqual(['passkey']);
  });

  it('is offered when the Flow routes it, or has no editor to tell', async () => {
    expect(await handlesOf({ methods, editor: editor(['guest']) })).toEqual(['guest']);
    clearLoginRuntimeFlowVersionCacheForTests();
    expect(await handlesOf({ methods })).toEqual(['guest']);
  });
});

describe('the external providers of the settings', () => {
  it('offers each provider its usage turns on, under a handle made of its id', async () => {
    const handles = await handlesOf({
      methods: {
        ...none,
        'authentication-methods.external_provider_usage': [
          { id: '  Google Workspace!! ' },
          { id: 'GitHub', enabled: 'false' },
          { id: 'okta', loginEnabled: false, signupEnabled: true },
          { id: 'azure', enabled: false, loginEnabled: true },
          { providerId: 'only-provider-id' },
          { id: '!!!' },
          'not-an-object',
          ['nested'],
          null,
          { id: 'google_workspace' },
        ],
      },
    });
    expect(handles).toEqual(['google_workspace', 'method']);
  });

  it('reads the usage written as JSON text', async () => {
    expect(
      await handlesOf({
        methods: {
          ...none,
          'authentication-methods.external_provider_usage': JSON.stringify([
            { id: 'line' },
            7,
            { id: 'x', loginEnabled: 'False' },
          ]),
        },
      })
    ).toEqual(['line']);
  });

  it('offers the sign-up usage of a provider for a registration', async () => {
    expect(
      await handlesOf({
        runtime: registrationRuntime,
        methods: {
          ...none,
          'authentication-methods.external_provider_usage': [
            { id: 'okta', loginEnabled: false, signupEnabled: true },
            { id: 'line', signupEnabled: false },
          ],
        },
      })
    ).toEqual(['okta']);
  });
});
