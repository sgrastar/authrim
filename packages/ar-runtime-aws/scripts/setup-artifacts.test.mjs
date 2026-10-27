import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSyntheticExecutionProfile } from './setup-artifacts.mjs';

const origin = 'https://abcdefghij.execute-api.ap-northeast-1.amazonaws.com';
const legacy = {
  kind: 'aws-browser',
  issuer: origin,
  spEntityId: `${origin}/test-sp/metadata`,
  acsUrl: `${origin}/test-sp/acs`,
};
test('generated source profile preserves legacy defaults and explicit UI absence', () => {
  assert.deepEqual(createSyntheticExecutionProfile({ mode: 'browser-rehearsal' }, origin), legacy);
  assert.deepEqual(
    createSyntheticExecutionProfile(
      {
        mode: 'browser-rehearsal',
        components: { loginUi: false, adminUi: false },
        ui: {
          login: { mode: 'disabled' },
          admin: { mode: 'external', baseUrl: 'https://admin.example.test' },
        },
      },
      origin
    ),
    legacy
  );
});
test('generated source receives the exact external client and origin without changing issuer or SP', () => {
  const login = {
    mode: 'external',
    baseUrl: 'https://login.example.test',
    clientId: 'custom-browser-client',
    paths: { login: '/sign-in', reauth: '/again' },
  };
  const config = {
    mode: 'browser-rehearsal',
    components: { loginUi: false, adminUi: false },
    ui: { login, admin: { mode: 'disabled' } },
  };
  assert.deepEqual(createSyntheticExecutionProfile(config, origin), {
    ...legacy,
    externalLogin: login,
  });
  assert.throws(
    () =>
      createSyntheticExecutionProfile(
        {
          ...config,
          ui: { ...config.ui, login: { ...login, baseUrl: 'http://untrusted.example.test' } },
        },
        origin
      ),
    /aws_setup_ui_invalid/u
  );
});
