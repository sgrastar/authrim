import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HUMAN_VERIFICATION_PLUGIN_ID,
  HUMAN_VERIFICATION_FLOWS,
  decideHumanVerification,
  humanVerificationConfigValid,
  humanVerificationCredentialsConfigured,
  humanVerificationProviderAvailability,
  humanVerificationSelectionFromSettings,
  isHumanVerificationPluginEnabled,
  parseHumanVerificationSettingsDocument,
  readHumanVerificationSelection,
  requiredHumanVerificationFlows,
  type HumanVerificationFlow,
} from '../human-verification-policy';

function env(values: Record<string, string>) {
  return {
    SETTINGS: { get: async (key: string) => values[key] ?? null } as unknown as KVNamespace,
  };
}

const PLUGIN = 'human-verification-hcaptcha';

describe('human verification policy', () => {
  describe('selection', () => {
    it('defaults to Turnstile with no flow required', () => {
      const selection = humanVerificationSelectionFromSettings(null);
      expect(selection.pluginId).toBe(DEFAULT_HUMAN_VERIFICATION_PLUGIN_ID);
      expect(requiredHumanVerificationFlows(selection)).toEqual([]);
    });

    it('reads booleans and the strings "true"/"false", trimming the provider', () => {
      const selection = humanVerificationSelectionFromSettings({
        'authentication-methods.human_verification.provider': `  ${PLUGIN} `,
        'authentication-methods.human_verification.login_enabled': 'TRUE',
        'authentication-methods.human_verification.signup_enabled': 'false',
        'authentication-methods.human_verification.reauth_enabled': true,
      });
      expect(selection.pluginId).toBe(PLUGIN);
      expect(requiredHumanVerificationFlows(selection)).toEqual(['login', 'reauth']);
    });

    it('falls back to the default provider for an empty or non-string provider', () => {
      for (const provider of ['', '   ', 5, null]) {
        expect(
          humanVerificationSelectionFromSettings({
            'authentication-methods.human_verification.provider': provider,
          }).pluginId
        ).toBe(DEFAULT_HUMAN_VERIFICATION_PLUGIN_ID);
      }
    });

    it('throws on a settings document that is not an object, and reads none as empty', async () => {
      expect(() => parseHumanVerificationSettingsDocument('[]')).toThrow(
        'human_verification_settings_invalid'
      );
      expect(() => parseHumanVerificationSettingsDocument('{bad')).toThrow();
      expect(parseHumanVerificationSettingsDocument(null)).toBeNull();
      await expect(readHumanVerificationSelection(env({}), 't1')).resolves.toMatchObject({
        pluginId: DEFAULT_HUMAN_VERIFICATION_PLUGIN_ID,
      });
    });
  });

  describe('plugin switch', () => {
    it('is off when it was never written (the plugin admin API default)', async () => {
      await expect(isHumanVerificationPluginEnabled(env({}), 't1', PLUGIN)).resolves.toBe(false);
      await expect(
        isHumanVerificationPluginEnabled({ SETTINGS: undefined }, 't1', PLUGIN)
      ).resolves.toBe(false);
    });

    it('takes the tenant flag over the global one', async () => {
      const key = `plugins:enabled:${PLUGIN}`;
      await expect(
        isHumanVerificationPluginEnabled(env({ [key]: 'true' }), 't1', PLUGIN)
      ).resolves.toBe(true);
      await expect(
        isHumanVerificationPluginEnabled(
          env({ [key]: 'true', [`${key}:tenant:t1`]: 'false' }),
          't1',
          PLUGIN
        )
      ).resolves.toBe(false);
      await expect(
        isHumanVerificationPluginEnabled(
          env({ [key]: 'false', [`${key}:tenant:t1`]: 'true' }),
          't1',
          PLUGIN
        )
      ).resolves.toBe(true);
    });

    it('treats any value other than "true" as off', async () => {
      await expect(
        isHumanVerificationPluginEnabled(
          env({ [`plugins:enabled:${PLUGIN}:tenant:t1`]: 'yes' }),
          't1',
          PLUGIN
        )
      ).resolves.toBe(false);
    });
  });

  describe('availability', () => {
    it.each([
      [{ pluginEnabled: true, configured: true }, true, null],
      [{ pluginEnabled: true }, true, null],
      [{ pluginEnabled: true, configured: false }, false, 'provider_unconfigured'],
      [{ pluginEnabled: false, configured: true }, false, 'provider_disabled'],
      [{ pluginEnabled: false, configured: false }, false, 'provider_disabled'],
      [{ pluginEnabled: false }, false, 'provider_disabled'],
    ])('%j -> available %s (%s)', (input, available, reason) => {
      expect(humanVerificationProviderAvailability(input)).toEqual({ available, reason });
    });
  });

  describe('decision: required x provider x flow', () => {
    const flows: HumanVerificationFlow[] = [...HUMAN_VERIFICATION_FLOWS];
    const providerStates = [
      { name: 'enabled', pluginEnabled: true, configured: true, available: true, reason: null },
      {
        name: 'disabled',
        pluginEnabled: false,
        configured: true,
        available: false,
        reason: 'provider_disabled',
      },
      {
        name: 'unconfigured',
        pluginEnabled: true,
        configured: false,
        available: false,
        reason: 'provider_unconfigured',
      },
    ] as const;

    for (const requiredFlow of [null, ...flows]) {
      for (const asked of flows) {
        for (const state of providerStates) {
          const required = requiredFlow === asked;
          it(`settings require ${requiredFlow ?? 'nothing'}; ${asked} flow; provider ${state.name}`, () => {
            const selection = humanVerificationSelectionFromSettings(
              requiredFlow
                ? { [`authentication-methods.human_verification.${requiredFlow}_enabled`]: true }
                : {}
            );
            expect(
              decideHumanVerification({
                selection,
                flows: [asked],
                pluginEnabled: state.pluginEnabled,
                configured: state.configured,
              })
            ).toEqual({ required, available: state.available, reason: state.reason });
          });
        }
      }
    }

    it("requires a token when any of an operation's flows asks for one", () => {
      const selection = humanVerificationSelectionFromSettings({
        'authentication-methods.human_verification.signup_enabled': true,
      });
      expect(
        decideHumanVerification({ selection, flows: ['login', 'signup'], pluginEnabled: true })
          .required
      ).toBe(true);
      expect(
        decideHumanVerification({ selection, flows: ['login'], pluginEnabled: true }).required
      ).toBe(false);
    });
  });

  describe('credentials', () => {
    it.each([
      [{ siteKey: 'a', secretKey: 'b' }, true],
      [{ siteKey: ' a ', secretKey: ' b ' }, true],
      [{ siteKey: 'a', secretKey: '   ' }, false],
      [{ siteKey: '', secretKey: 'b' }, false],
      [{ siteKey: ' \t\n', secretKey: 'b' }, false],
      [{ siteKey: 'a' }, false],
      [{ siteKey: 1, secretKey: 'b' }, false],
      [{}, false],
      [null, false],
      [undefined, false],
    ])('%j -> %s', (config, expected) => {
      expect(humanVerificationCredentialsConfigured(config)).toBe(expected);
    });
  });

  describe('configuration the runner accepts', () => {
    const TURNSTILE = 'human-verification-cloudflare-turnstile';
    const HCAPTCHA = 'human-verification-hcaptcha';
    const RECAPTCHA = 'human-verification-google-recaptcha';
    const keys = { siteKey: 'site', secretKey: 'secret' };

    it.each([
      [TURNSTILE, keys, true],
      [TURNSTILE, { siteKey: ' site ', secretKey: ' secret ' }, true],
      [TURNSTILE, { ...keys, siteKey: 'a'.repeat(2_048) }, true],
      [TURNSTILE, { ...keys, siteKey: 'a'.repeat(2_049) }, false],
      [TURNSTILE, { ...keys, siteKey: ` ${'a'.repeat(2_048)} ` }, true],
      [TURNSTILE, { ...keys, secretKey: 'a'.repeat(8_192) }, true],
      [TURNSTILE, { ...keys, secretKey: 'a'.repeat(8_193) }, false],
      [TURNSTILE, { ...keys, secretKey: '   ' }, false],
      [TURNSTILE, { ...keys, expectedHostname: ' Login.Example.com ' }, true],
      [TURNSTILE, { ...keys, expectedHostname: '   ' }, true],
      [TURNSTILE, { ...keys, expectedHostname: 'localhost' }, false],
      [TURNSTILE, { ...keys, expectedHostname: 'a b.example.com' }, false],
      [TURNSTILE, { ...keys, expectedHostname: 'https://a.example.com' }, false],
      [TURNSTILE, { ...keys, expectedHostname: 5 }, false],
      [TURNSTILE, { ...keys, widgetMode: 'managed' }, true],
      [TURNSTILE, { ...keys, widgetMode: 'checkbox' }, false],
      [TURNSTILE, { ...keys, widgetMode: '  ' }, true],
      [HCAPTCHA, { ...keys, widgetMode: 'invisible' }, true],
      [HCAPTCHA, { ...keys, widgetMode: 'score' }, false],
      [HCAPTCHA, { ...keys, widgetMode: 'managed' }, false],
      [RECAPTCHA, { ...keys, widgetMode: 'score', scoreThreshold: 0.7 }, true],
      [RECAPTCHA, { ...keys, scoreThreshold: 0 }, true],
      [RECAPTCHA, { ...keys, scoreThreshold: 1 }, true],
      [RECAPTCHA, { ...keys, scoreThreshold: 1.01 }, false],
      [RECAPTCHA, { ...keys, scoreThreshold: -0.01 }, false],
      [RECAPTCHA, { ...keys, scoreThreshold: Number.NaN }, false],
      [RECAPTCHA, { ...keys, scoreThreshold: '0.5' }, false],
      [TURNSTILE, { ...keys, failurePolicy: 'fail_closed' }, true],
      [TURNSTILE, { ...keys, failurePolicy: 'fail_open' }, false],
      ['some-other-plugin', keys, false],
    ])('%s %j -> %s', (pluginId, config, expected) => {
      expect(humanVerificationConfigValid(pluginId, config)).toBe(expected);
    });

    it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf'])(
      'does not take the inherited property %s for a provider',
      (name) => {
        expect(humanVerificationConfigValid(name, keys)).toBe(false);
      }
    );

    it('is false without a configuration', () => {
      expect(humanVerificationConfigValid(TURNSTILE, null)).toBe(false);
      expect(humanVerificationConfigValid(TURNSTILE, undefined)).toBe(false);
    });
  });
});
