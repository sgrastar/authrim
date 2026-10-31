import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveSettingsEnv } from '../effective-settings';

const { resolveEffectiveSettings } = vi.hoisted(() => ({ resolveEffectiveSettings: vi.fn() }));

vi.mock('../effective-settings', () => ({ resolveEffectiveSettings }));

import {
  resolveSamlAssertionTtlSeconds,
  resolveSamlEnabled,
  resolveSamlProvisioningDefaults,
  resolveSamlRequestTtlSeconds,
} from '../saml-settings';

const env = {} as EffectiveSettingsEnv;

describe('SAML settings', () => {
  beforeEach(() => {
    resolveEffectiveSettings.mockReset();
  });

  describe('resolveSamlEnabled', () => {
    it('is on where nothing turns it off', async () => {
      resolveEffectiveSettings.mockResolvedValue({});
      await expect(resolveSamlEnabled(env, 't')).resolves.toBe(true);
      resolveEffectiveSettings.mockResolvedValue({ 'federation.saml_enabled': true });
      await expect(resolveSamlEnabled(env, 't')).resolves.toBe(true);
      expect(resolveEffectiveSettings).toHaveBeenCalledWith(env, 'federation', { tenantId: 't' });
    });

    it('is off only for an explicit false', async () => {
      resolveEffectiveSettings.mockResolvedValue({ 'federation.saml_enabled': false });
      await expect(resolveSamlEnabled(env, 't')).resolves.toBe(false);
    });

    it('reads without the per-isolate cache when asked to', async () => {
      resolveEffectiveSettings.mockResolvedValue({ 'federation.saml_enabled': false });
      await expect(resolveSamlEnabled(env, 't', { fresh: true })).resolves.toBe(false);
      expect(resolveEffectiveSettings).toHaveBeenCalledWith(env, 'federation', {
        tenantId: 't',
        fresh: true,
      });
    });

    it('throws when the settings cannot be read, so the caller can refuse', async () => {
      resolveEffectiveSettings.mockRejectedValue(new Error('settings unavailable'));
      await expect(resolveSamlEnabled(env, 't')).rejects.toThrow('settings unavailable');
    });
  });

  describe('resolveSamlRequestTtlSeconds', () => {
    it('reads the tenant value', async () => {
      resolveEffectiveSettings.mockResolvedValue({ 'federation.saml_request_ttl': 120 });
      await expect(resolveSamlRequestTtlSeconds(env, 't')).resolves.toBe(120);
    });

    it.each([59, 601, 90.5, '120', null, Infinity])(
      'keeps the five minutes it always used for %j',
      async (value) => {
        resolveEffectiveSettings.mockResolvedValue({ 'federation.saml_request_ttl': value });
        await expect(resolveSamlRequestTtlSeconds(env, 't')).resolves.toBe(300);
      }
    );

    it('keeps five minutes when the settings cannot be read', async () => {
      resolveEffectiveSettings.mockRejectedValue(new Error('settings unavailable'));
      await expect(resolveSamlRequestTtlSeconds(env, 't')).resolves.toBe(300);
    });
  });

  describe('resolveSamlAssertionTtlSeconds', () => {
    it("takes the provider's own value first", async () => {
      resolveEffectiveSettings.mockResolvedValue({ 'federation.saml_assertion_ttl': 120 });
      await expect(resolveSamlAssertionTtlSeconds(env, 't', 90)).resolves.toBe(90);
    });

    it("takes the tenant's value when the provider has none", async () => {
      resolveEffectiveSettings.mockResolvedValue({ 'federation.saml_assertion_ttl': 120 });
      await expect(resolveSamlAssertionTtlSeconds(env, 't')).resolves.toBe(120);
      await expect(resolveSamlAssertionTtlSeconds(env, 't', undefined)).resolves.toBe(120);
      await expect(resolveSamlAssertionTtlSeconds(env, 't', 0)).resolves.toBe(120);
    });

    it.each([-5, NaN, Infinity, '300', null, {}])(
      'does not take %j as the provider value',
      async (value) => {
        resolveEffectiveSettings.mockResolvedValue({ 'federation.saml_assertion_ttl': 120 });
        await expect(resolveSamlAssertionTtlSeconds(env, 't', value)).resolves.toBe(120);
      }
    );

    it.each([59, 601, 90.5])(
      'falls back to five minutes for the tenant value %j',
      async (value) => {
        resolveEffectiveSettings.mockResolvedValue({ 'federation.saml_assertion_ttl': value });
        await expect(resolveSamlAssertionTtlSeconds(env, 't')).resolves.toBe(300);
      }
    );

    it('does not read the settings when the provider has its own value', async () => {
      await expect(resolveSamlAssertionTtlSeconds(env, 't', 45)).resolves.toBe(45);
      expect(resolveEffectiveSettings).not.toHaveBeenCalled();
    });

    it('keeps five minutes when the settings cannot be read', async () => {
      resolveEffectiveSettings.mockRejectedValue(new Error('settings unavailable'));
      await expect(resolveSamlAssertionTtlSeconds(env, 't')).resolves.toBe(300);
    });
  });

  describe('resolveSamlProvisioningDefaults', () => {
    it('gives the behaviour providers always had where nothing is set', async () => {
      resolveEffectiveSettings.mockResolvedValue({});
      await expect(resolveSamlProvisioningDefaults(env, 't')).resolves.toEqual({
        ssoBinding: 'redirect',
        sloBinding: 'redirect',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      });
    });

    it('reads the tenant bindings and NameID format', async () => {
      resolveEffectiveSettings.mockResolvedValue({
        'federation.saml_sso_binding': 'HTTP-POST',
        'federation.saml_slo_binding': 'HTTP-POST',
        'federation.saml_nameid_format': 'persistent',
      });
      await expect(resolveSamlProvisioningDefaults(env, 't')).resolves.toEqual({
        ssoBinding: 'post',
        sloBinding: 'post',
        nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
      });
    });

    it.each([
      ['transient', 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient'],
      ['unspecified', 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified'],
      ['emailAddress', 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'],
    ])('maps the NameID format %s to its URI', async (value, uri) => {
      resolveEffectiveSettings.mockResolvedValue({ 'federation.saml_nameid_format': value });
      await expect(resolveSamlProvisioningDefaults(env, 't')).resolves.toMatchObject({
        nameIdFormat: uri,
      });
    });

    it('takes each value that is not one of the allowed choices as its default', async () => {
      resolveEffectiveSettings.mockResolvedValue({
        'federation.saml_sso_binding': 'HTTP-Artifact',
        'federation.saml_slo_binding': 'HTTP-POST',
        'federation.saml_nameid_format': 'urn:made:up',
      });
      await expect(resolveSamlProvisioningDefaults(env, 't')).resolves.toEqual({
        ssoBinding: 'redirect',
        sloBinding: 'post',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      });
    });

    it('gives the defaults when the settings cannot be read', async () => {
      resolveEffectiveSettings.mockRejectedValue(new Error('settings unavailable'));
      await expect(resolveSamlProvisioningDefaults(env, 't')).resolves.toEqual({
        ssoBinding: 'redirect',
        sloBinding: 'redirect',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      });
    });
  });
});
