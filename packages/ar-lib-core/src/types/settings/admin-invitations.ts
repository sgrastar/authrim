/**
 * Admin Invitations Settings Category
 *
 * The platform's switch for the enrollment code handoff of an admin invitation: a global machine
 * principal that holds `admin:admin_invitations:code_handoff` may ask for the code in the API
 * response instead of an e-mail. Off by default. Platform only: a tenant can neither see this as
 * its own nor change it. Turning it on from off (or unset) needs a human with an admin step-up
 * (`admin_invitation.code_handoff.enable`), through every settings write path; turning it off does
 * not. Environment variable and KV value are the usual hybrid (KV, then env, then code default).
 * API: GET/PATCH /api/admin/platform/settings/admin-invitations
 * Config Level: platform
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export interface AdminInvitationsSettings {
  'admin_invitations.code_handoff_enabled': boolean;
}

export const ADMIN_INVITATIONS_CATEGORY = 'admin-invitations';

/** The settings key of the handoff switch. */
export const ADMIN_INVITATION_CODE_HANDOFF_KEY = 'admin_invitations.code_handoff_enabled';

export const ADMIN_INVITATIONS_SETTINGS_META: Record<keyof AdminInvitationsSettings, SettingMeta> =
  {
    'admin_invitations.code_handoff_enabled': {
      key: ADMIN_INVITATION_CODE_HANDOFF_KEY,
      type: 'boolean',
      default: false,
      envKey: 'ADMIN_INVITATIONS_CODE_HANDOFF_ENABLED',
      label: 'Admin invitations: hand the enrollment code over in the API response',
      description:
        'On: a global machine principal holding the code handoff permission may create a tenant-scoped admin invitation and receive the enrollment code in the response instead of by e-mail. Nothing is e-mailed, and the invited address is not verified by the invitation. Humans can never use it. Turning it on needs a human admin step-up; turning it off does not. Default off.',
      scopes: ['platform'],
      visibility: 'admin',
    },
  };

export const ADMIN_INVITATIONS_CATEGORY_META: CategoryMeta = {
  category: ADMIN_INVITATIONS_CATEGORY,
  label: 'Admin Invitations',
  description: 'Platform switch for handing an admin invitation code over in the API response',
  settings: ADMIN_INVITATIONS_SETTINGS_META,
};

export const ADMIN_INVITATIONS_DEFAULTS: AdminInvitationsSettings = {
  'admin_invitations.code_handoff_enabled': false,
};
