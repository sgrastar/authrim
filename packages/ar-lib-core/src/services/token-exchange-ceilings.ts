/**
 * The tenant's ceilings on token exchange (RFC 8693): an app's `delegation_mode` can use
 * delegation or impersonation only where the tenant has allowed it
 * (`tokens.exchange_delegation_enabled`, `tokens.exchange_impersonation_enabled`; both off
 * unless set). A ceiling is checked before the app's own mode.
 */

import { resolveEffectiveSettings, type EffectiveSettingsEnv } from './effective-settings';

export interface TokenExchangeCeilingRefusal {
  /** The tenant setting that has to be turned on. */
  setting: 'tokens.exchange_delegation_enabled' | 'tokens.exchange_impersonation_enabled';
  message: string;
}

/**
 * Whether the tenant's ceiling refuses an app with this `delegation_mode`, given the tenant's
 * resolved `tokens` settings: null when it does not (including mode `none`, which the app's own
 * mode already refuses).
 */
export function tokenExchangeCeilingRefusal(
  delegationMode: string,
  tokens: Record<string, unknown>
): TokenExchangeCeilingRefusal | null {
  if (delegationMode === 'delegation' && tokens['tokens.exchange_delegation_enabled'] !== true) {
    return {
      setting: 'tokens.exchange_delegation_enabled',
      message: 'Delegation is not enabled for this tenant (tokens.exchange_delegation_enabled)',
    };
  }
  if (
    delegationMode === 'impersonation' &&
    tokens['tokens.exchange_impersonation_enabled'] !== true
  ) {
    return {
      setting: 'tokens.exchange_impersonation_enabled',
      message:
        'Impersonation is not enabled for this tenant (tokens.exchange_impersonation_enabled)',
    };
  }
  return null;
}

/**
 * Like tokenExchangeCeilingRefusal, reading the tenant's settings. For advice to admins, not
 * for a decision: where the settings cannot be read it says nothing.
 */
export async function resolveTokenExchangeCeilingRefusal(
  env: EffectiveSettingsEnv,
  tenantId: string,
  delegationMode: string
): Promise<TokenExchangeCeilingRefusal | null> {
  try {
    const tokens = await resolveEffectiveSettings(env, 'tokens', { tenantId });
    return tokenExchangeCeilingRefusal(delegationMode, tokens);
  } catch {
    return null;
  }
}
