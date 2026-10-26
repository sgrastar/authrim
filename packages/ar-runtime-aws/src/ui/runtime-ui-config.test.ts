import { describe, expect, it } from 'vitest';
import {
  awsRuntimeUiConfigurationEvidence,
  normalizeAwsRuntimeUiConfig,
  type AwsRuntimeUiConfig,
} from './runtime-ui-config';
import { restoreEvidenceDigest } from '../import/restore-evidence';

const disabled: AwsRuntimeUiConfig = {
  components: { loginUi: false, adminUi: false },
  ui: { login: { mode: 'disabled' }, admin: { mode: 'disabled' } },
};

describe('independent AWS UI configuration', () => {
  it.each(['disabled', 'external'] as const)('keeps Login UI disabled with admin %s', (mode) => {
    const input = {
      ...disabled,
      ui: {
        login: disabled.ui.login,
        admin: mode === 'external' ? { mode, baseUrl: 'https://admin.example.test' } : { mode },
      },
    };
    expect(normalizeAwsRuntimeUiConfig(input)).toEqual(input);
  });

  it.each(['disabled', 'external'] as const)(
    'keeps external login independent from admin %s',
    (mode) => {
      const input = {
        ...disabled,
        ui: {
          login: {
            mode: 'external',
            baseUrl: 'https://login.example.test',
            clientId: 'custom-ui',
            paths: { login: '/sign-in', reauth: '/re-authenticate' },
          },
          admin: mode === 'external' ? { mode, baseUrl: 'https://admin.example.test' } : { mode },
        },
      };
      expect(normalizeAwsRuntimeUiConfig(input)).toEqual(input);
    }
  );

  it('retains only the absent legacy selection and rejects unsupported packaged apps', () => {
    expect(normalizeAwsRuntimeUiConfig(undefined).ui.login.mode).toBe('embedded-rehearsal');
    expect(awsRuntimeUiConfigurationEvidence(undefined)).toEqual({});
    for (const key of ['loginUi', 'adminUi']) {
      expect(() =>
        normalizeAwsRuntimeUiConfig({
          ...disabled,
          components: { ...disabled.components, [key]: true },
        })
      ).toThrow('aws_packaged_ui_unsupported');
    }
    expect(() => normalizeAwsRuntimeUiConfig(null)).toThrow();
    expect(() =>
      normalizeAwsRuntimeUiConfig({ ...disabled, ui: { login: { mode: 'disabled' } } })
    ).toThrow();
  });

  it.each([
    'http://login.example.test',
    'https://login.example.test/',
    'https://login.example.test/path',
    'https://user:password@login.example.test',
    'https://login.example.test?x=1',
  ])('rejects noncanonical external origin %s', (baseUrl) => {
    expect(() =>
      normalizeAwsRuntimeUiConfig({
        ...disabled,
        ui: {
          ...disabled.ui,
          login: {
            mode: 'external',
            baseUrl,
            clientId: 'custom-ui',
            paths: { login: '/login', reauth: '/reauth' },
          },
        },
      })
    ).toThrow();
  });

  it.each([
    '//evil.example',
    '/..',
    '/%2e%2e/login',
    '/login?next=evil',
    '/%2f/evil.example',
    '/%5cevil',
    '/login#x',
  ])('rejects escaping UI path %s', (path) => {
    expect(() =>
      normalizeAwsRuntimeUiConfig({
        ...disabled,
        ui: {
          ...disabled.ui,
          login: {
            mode: 'external',
            baseUrl: 'https://login.example.test',
            clientId: 'custom-ui',
            paths: { login: path, reauth: '/reauth' },
          },
        },
      })
    ).toThrow();
  });

  it('pins explicit UI absence and either independent setting to activation evidence', () => {
    const legacy = restoreEvidenceDigest({ environmentName: 'test' });
    const absent = restoreEvidenceDigest({
      environmentName: 'test',
      ...awsRuntimeUiConfigurationEvidence(undefined),
    });
    const apiOnly = restoreEvidenceDigest({
      environmentName: 'test',
      ...awsRuntimeUiConfigurationEvidence(disabled),
    });
    expect(absent).toBe(legacy);
    expect(apiOnly).not.toBe(legacy);
    expect(
      restoreEvidenceDigest({
        environmentName: 'test',
        ...awsRuntimeUiConfigurationEvidence({
          ...disabled,
          ui: {
            ...disabled.ui,
            admin: { mode: 'external', baseUrl: 'https://admin.example.test' },
          },
        }),
      })
    ).not.toBe(apiOnly);
  });
});
