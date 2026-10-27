import { describe, expect, it } from 'vitest';
import { parseAwsConfigurationInput } from '../web/aws-configuration.js';

const configuration = () => ({
  database: 'postgresql',
  accountId: '123456789012',
  region: 'ap-northeast-1',
  name: 'test-setup',
  mode: 'browser-rehearsal',
  role: 'secondary',
  bootstrapProfile: 'bootstrap',
  bootstrapPrincipalArn: 'arn:aws:iam::123456789012:user/operator',
  operatorProfile: 'operator',
  caBundlePath: '/private/test/ca.pem',
  s3GatewayPrefixListId: 'pl-12345678',
  components: { loginUi: false, adminUi: false },
  ui: { login: { mode: 'disabled' }, admin: { mode: 'disabled' } },
});
describe('AWS public configuration form', () => {
  it('rejects environment names that cannot be used for the generated S3 bucket', () => {
    for (const name of ['New-test', 'new_Test', 'a'.repeat(29)])
      expect(() => parseAwsConfigurationInput({ ...configuration(), name })).toThrow();
  });
  it('selects authentication state independently and requires private DynamoDB access when selected', () => {
    expect(
      parseAwsConfigurationInput({
        ...configuration(),
        authState: { backend: 'dynamodb' },
        dynamoDbGatewayPrefixListId: 'pl-87654321',
      })
    ).toMatchObject({ authState: { backend: 'dynamodb' } });
    for (const extra of [
      { authState: { backend: 'dynamodb' } },
      { authState: { backend: 'unknown' } },
      { authState: { backend: 'postgresql' }, dynamoDbGatewayPrefixListId: 'pl-87654321' },
      {
        authState: { backend: 'dynamodb', tableArn: 'untrusted' },
        dynamoDbGatewayPrefixListId: 'pl-87654321',
      },
    ])
      expect(() => parseAwsConfigurationInput({ ...configuration(), ...extra })).toThrow();
  });
  it('preserves omitted packaged UIs across primary/secondary selection', () => {
    for (const role of ['primary', 'secondary']) {
      const result = parseAwsConfigurationInput({ ...configuration(), role });
      expect(result).toMatchObject({
        role,
        components: { loginUi: false, adminUi: false },
        ui: { login: { mode: 'disabled' } },
      });
    }
  });
  it.each(['password', 'accessKeyId', 'statePath', 'script'])(
    'rejects %s before persistence',
    (key) => {
      expect(() => parseAwsConfigurationInput({ ...configuration(), [key]: 'private' })).toThrow();
    }
  );
  it('rejects unknown nested fields, foreign principals and packaged UI claims', () => {
    expect(() =>
      parseAwsConfigurationInput({
        ...configuration(),
        ui: { ...configuration().ui, secret: 'private' },
      })
    ).toThrow();
    expect(() =>
      parseAwsConfigurationInput({
        ...configuration(),
        bootstrapPrincipalArn: 'arn:aws:iam::999999999999:user/operator',
      })
    ).toThrow();
    expect(() =>
      parseAwsConfigurationInput({
        ...configuration(),
        components: { loginUi: true, adminUi: false },
      })
    ).toThrow();
  });
  it('keeps external login and admin independently selected without weakening URL boundaries', () => {
    const login = {
      mode: 'external',
      baseUrl: 'https://login.example.test',
      clientId: 'browser-client',
      paths: { login: '/login', reauth: '/reauth' },
    };
    expect(
      parseAwsConfigurationInput({ ...configuration(), ui: { login, admin: { mode: 'disabled' } } })
    ).toMatchObject({ ui: { login } });
    for (const baseUrl of [
      'http://login.example.test',
      'https://user:pass@login.example.test',
      'https://login.example.test/path',
      'https://login.example.test?secret=1',
    ])
      expect(() =>
        parseAwsConfigurationInput({
          ...configuration(),
          ui: { login: { ...login, baseUrl }, admin: { mode: 'disabled' } },
        })
      ).toThrow();
    for (const path of ['//evil.test', '/a/../login', '/%2f%2fevil.test', '/a//b'])
      expect(() =>
        parseAwsConfigurationInput({
          ...configuration(),
          ui: {
            login: { ...login, paths: { login: path, reauth: '/reauth' } },
            admin: { mode: 'disabled' },
          },
        })
      ).toThrow();
  });
  it('does not reinterpret browser fixtures as an existing issuer deployment', () => {
    expect(() =>
      parseAwsConfigurationInput({ ...configuration(), mode: 'existing-issuer' })
    ).toThrow();
    expect(() =>
      parseAwsConfigurationInput({
        ...configuration(),
        fixture: { directory: '/tmp/prepared', descriptorSha256: 'a'.repeat(64) },
      })
    ).toThrow();
  });
  it('accepts credential-free DSQL connection settings only for their own region', () => {
    const value = {
      database: 'aurora-dsql',
      accountId: '123456789012',
      region: 'ap-northeast-1',
      hostname: `${'a'.repeat(26)}.dsql.ap-northeast-1.on.aws`,
      user: 'authrim',
    };
    expect(parseAwsConfigurationInput(value)).toEqual(value);
    expect(() => parseAwsConfigurationInput({ ...value, region: 'us-east-1' })).toThrow();
    expect(() => parseAwsConfigurationInput({ ...value, token: 'secret' })).toThrow();
  });
});
