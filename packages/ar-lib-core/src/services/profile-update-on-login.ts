/**
 * Which profile fields a login from an external IdP (OIDC or SAML) updates.
 *
 * The tenant chooses a default (`external_idp.jit_update_fields`) and each IdP may override it
 * (an OIDC provider's `profile_update_fields`, a SAML IdP's `profileUpdateFields`). Updates happen
 * only with `external_idp.jit_update_on_login` and `external_idp.jit_provisioning_enabled` on.
 * The fields are Authrim's standard profile claims, after any attribute mapping; contacts (email,
 * phone) and the account state are never updated this way.
 */

import { resolveEffectiveSettings, type EffectiveSettingsEnv } from './effective-settings';
import { createLogger } from '../utils/logger';
import {
  profileValuesFromClaims,
  resolveProfileUpdateFields,
  type ProfileUpdateField,
} from './profile-update-fields';

export * from './profile-update-fields';

/**
 * Update a linked user's profile from an external IdP's claims on login: with
 * `external_idp.jit_update_on_login` and `external_idp.jit_provisioning_enabled` on, the fields the
 * IdP chooses (`providerFields`; null or absent follows the tenant's
 * `external_idp.jit_update_fields`), only those the claims carry as strings. A failure, settings
 * that cannot be read included, is logged and never fails the login (nothing is updated).
 */
export async function updateProfileOnLogin(input: {
  env: EffectiveSettingsEnv;
  tenantId: string;
  userId: string;
  claims: Record<string, unknown>;
  providerFields?: unknown;
  users: {
    updateProfileFields(
      userId: string,
      values: Partial<Record<ProfileUpdateField, string>>
    ): Promise<boolean>;
  };
}): Promise<void> {
  try {
    const values = await resolveEffectiveSettings(input.env, 'external-idp', {
      tenantId: input.tenantId,
    });
    if (
      values['external_idp.jit_update_on_login'] !== true ||
      values['external_idp.jit_provisioning_enabled'] !== true
    ) {
      return;
    }
    const fields = resolveProfileUpdateFields(
      values['external_idp.jit_update_fields'],
      input.providerFields
    );
    const profile = profileValuesFromClaims(input.claims, fields);
    if (Object.keys(profile).length === 0) return;
    // Only these profile fields: the account state, contacts and other attributes stay as they are.
    await input.users.updateProfileFields(input.userId, profile);
  } catch (error) {
    createLogger()
      .module('PROFILE-UPDATE-ON-LOGIN')
      .warn('Profile update from the identity provider failed', {
        action: 'profile_update_on_login',
        errorName: error instanceof Error ? error.name : 'Unknown error',
      });
  }
}
