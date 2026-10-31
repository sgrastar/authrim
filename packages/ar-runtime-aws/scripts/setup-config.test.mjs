import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSetupConfiguration } from './setup-config.mjs';
import { normalizeSetupUi } from './setup-ui-config.mjs';
import { executionAuthState, normalizeSetupAuthState } from './setup-auth-state.mjs';
import { runExecutionCommand } from './setup-execute.mjs';
import { normalizeExecutionConfig } from './setup-execution-plan.mjs';

const input = () => ({
  database: 'postgresql',
  accountId: '123456789012',
  region: 'ap-northeast-1',
  name: 'new-test',
  mode: 'browser-rehearsal',
  role: 'secondary',
  bootstrapProfile: 'bootstrap',
  bootstrapPrincipalArn: 'arn:aws:iam::123456789012:user/operator',
  operatorProfile: 'operator',
  caBundlePath: '/tmp/ca.pem',
  s3GatewayPrefixListId: 'pl-12345678',
  components: { loginUi: false, adminUi: false },
  ui: { login: { mode: 'disabled' }, admin: { mode: 'disabled' } },
});
test('authentication state selection is explicit, pins the deployment table and rejects fallback', () => {
  const config = createSetupConfiguration(
    { ...input(), authState: { backend: 'dynamodb' }, dynamoDbGatewayPrefixListId: 'pl-87654321' },
    '/tmp/config.json'
  );
  assert.deepEqual(config.authState, { backend: 'dynamodb' });
  assert.equal(config.stacks.foundation.parameters.DynamoDbGatewayPrefixListId, 'pl-87654321');
  const tableArn = 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/new-test-auth-state';
  const state = { stages: { foundation: { outputs: { AuthStateTableArn: tableArn } } } };
  const restoreId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.deepEqual(executionAuthState(config, state, restoreId), {
    backend: 'dynamodb',
    region: 'ap-northeast-1',
    tableArn,
    namespace: restoreId,
  });
  for (const authState of [{ backend: 'other' }, { backend: 'dynamodb', tableArn }, null])
    assert.throws(() => normalizeSetupAuthState(authState));
  assert.throws(() => executionAuthState(config, { stages: {} }, restoreId));
  state.stages.foundation.outputs.AuthStateTableArn = tableArn.replace(
    '123456789012',
    '999999999999'
  );
  assert.throws(() => executionAuthState(config, state, restoreId));
  assert.throws(() =>
    createSetupConfiguration({ ...input(), authState: { backend: 'dynamodb' } }, '/tmp/config.json')
  );
  assert.throws(() =>
    createSetupConfiguration(
      { ...input(), dynamoDbGatewayPrefixListId: 'pl-87654321' },
      '/tmp/config.json'
    )
  );
});
test('form configuration derives scoped create-only stacks and never changes explicit role or UI', () => {
  for (const role of ['primary', 'secondary']) {
    const config = createSetupConfiguration({ ...input(), role }, '/tmp/config-id/config.json');
    assert.equal(config.role, role);
    assert.deepEqual(config.ui, input().ui);
    assert.equal(config.fixture.directory, '/tmp/config-id/fixture');
    assert.equal(
      config.identities.operator.principalArn,
      'arn:aws:iam::123456789012:role/authrim-dr/operator/new-test-bootstrap-operator'
    );
    assert.ok(Object.values(config.stacks).every((stack) => stack.disposition === 'create'));
  }
});
test('rejects foundation names that cannot form the derived S3 bucket before planning', () => {
  for (const name of ['New-test', 'new_Test', 'a'.repeat(29)]) {
    assert.throws(() => createSetupConfiguration({ ...input(), name }, '/tmp/config.json'));
    const config = createSetupConfiguration(input(), '/tmp/config.json');
    config.stacks.foundation.name = name;
    assert.throws(() => normalizeExecutionConfig(config));
  }
});
test('configuration cannot override stacks, target identity, credential fields or fixture destination', () => {
  for (const key of ['password', 'statePath', 'stacks', 'script'])
    assert.throws(() =>
      createSetupConfiguration({ ...input(), [key]: 'extra' }, '/tmp/config.json')
    );
  assert.throws(() =>
    createSetupConfiguration(
      { ...input(), bootstrapPrincipalArn: 'arn:aws:iam::999999999999:user/operator' },
      '/tmp/config.json'
    )
  );
  assert.throws(() =>
    createSetupConfiguration(
      { ...input(), fixture: { directory: '/tmp/other' } },
      '/tmp/config.json'
    )
  );
});
test('disabled and external UI selections remain independent and unsafe origin/path inputs fail', () => {
  const components = input().components;
  const external = {
    mode: 'external',
    baseUrl: 'https://ui.example.test',
    clientId: 'browser',
    paths: { login: '/login', reauth: '/reauth' },
  };
  for (const clientId of [123, [123], null])
    assert.throws(() =>
      normalizeSetupUi(
        components,
        { login: { ...external, clientId }, admin: { mode: 'disabled' } },
        'existing-issuer'
      )
    );
  for (const login of [{ mode: 'disabled' }, external])
    for (const admin of [
      { mode: 'disabled' },
      { mode: 'external', baseUrl: 'https://admin.example.test' },
    ])
      assert.deepEqual(normalizeSetupUi(components, { login, admin }, 'existing-issuer'), {
        components,
        ui: { login, admin },
      });
  for (const path of [
    '//evil.test',
    '/a//b',
    '/%2f%2fevil.test',
    '/a/../b',
    '/a?x=1',
    `/${'a'.repeat(256)}`,
  ])
    assert.throws(() =>
      normalizeSetupUi(
        components,
        {
          login: { ...external, paths: { login: path, reauth: '/reauth' } },
          admin: { mode: 'disabled' },
        },
        'existing-issuer'
      )
    );
  assert.throws(
    () => normalizeSetupUi({ loginUi: true, adminUi: false }, input().ui, 'browser-rehearsal'),
    /packaged_ui_unsupported/u
  );
  assert.throws(() =>
    normalizeSetupUi(
      components,
      { ...input().ui, login: { mode: 'embedded-rehearsal' } },
      'existing-issuer'
    )
  );
  assert.equal(normalizeSetupUi(undefined, undefined, 'existing-issuer'), undefined);
});
test('configure command creates a private public-config file once and cannot overwrite it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'authrim-config-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'input.json');
  const out = join(directory, 'config.json');
  await writeFile(source, JSON.stringify(input()));
  const result = await runExecutionCommand(['configure', '--input', source, '--out', out]);
  assert.equal(result.status, 'configured');
  assert.equal((await stat(out)).mode & 0o077, 0);
  const before = await readFile(out, 'utf8');
  await assert.rejects(runExecutionCommand(['configure', '--input', source, '--out', out]));
  assert.equal(await readFile(out, 'utf8'), before);
});
