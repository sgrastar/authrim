import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveSettingsEnv } from '../effective-settings';

const { resolveEffectiveSettings } = vi.hoisted(() => ({ resolveEffectiveSettings: vi.fn() }));

vi.mock('../effective-settings', () => ({ resolveEffectiveSettings }));

import {
  resolveTokenExchangeCeilingRefusal,
  tokenExchangeCeilingRefusal,
} from '../token-exchange-ceilings';

const env = {} as EffectiveSettingsEnv;

describe('token exchange ceilings', () => {
  beforeEach(() => {
    resolveEffectiveSettings.mockReset();
  });

  describe('tokenExchangeCeilingRefusal', () => {
    it('refuses delegation and impersonation unless the tenant allows them', () => {
      expect(tokenExchangeCeilingRefusal('delegation', {})).toEqual({
        setting: 'tokens.exchange_delegation_enabled',
        message: 'Delegation is not enabled for this tenant (tokens.exchange_delegation_enabled)',
      });
      expect(tokenExchangeCeilingRefusal('impersonation', {})).toEqual({
        setting: 'tokens.exchange_impersonation_enabled',
        message:
          'Impersonation is not enabled for this tenant (tokens.exchange_impersonation_enabled)',
      });
    });

    it('allows a mode only for the ceiling that is exactly true', () => {
      const tokens = {
        'tokens.exchange_delegation_enabled': true,
        'tokens.exchange_impersonation_enabled': 'true',
      };
      expect(tokenExchangeCeilingRefusal('delegation', tokens)).toBeNull();
      expect(tokenExchangeCeilingRefusal('impersonation', tokens)).not.toBeNull();
    });

    it('has no ceiling for a client that has token exchange off', () => {
      expect(tokenExchangeCeilingRefusal('none', {})).toBeNull();
    });
  });

  describe('resolveTokenExchangeCeilingRefusal', () => {
    it('reads the tenant tokens settings', async () => {
      resolveEffectiveSettings.mockResolvedValue({ 'tokens.exchange_delegation_enabled': true });
      await expect(resolveTokenExchangeCeilingRefusal(env, 't', 'delegation')).resolves.toBeNull();
      await expect(
        resolveTokenExchangeCeilingRefusal(env, 't', 'impersonation')
      ).resolves.toMatchObject({ setting: 'tokens.exchange_impersonation_enabled' });
      expect(resolveEffectiveSettings).toHaveBeenCalledWith(env, 'tokens', { tenantId: 't' });
    });

    it('says nothing when the settings cannot be read', async () => {
      resolveEffectiveSettings.mockRejectedValue(new Error('settings unavailable'));
      await expect(resolveTokenExchangeCeilingRefusal(env, 't', 'delegation')).resolves.toBeNull();
    });
  });
});
