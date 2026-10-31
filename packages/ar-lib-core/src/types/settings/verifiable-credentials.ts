/**
 * Verifiable Credentials Settings Category
 *
 * Settings related to OpenID4VC and Verifiable Credentials.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/vc
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Verifiable Credentials Settings Interface
 */
export interface VerifiableCredentialsSettings {}

/**
 * Verifiable Credentials Settings Metadata
 */
export const VC_SETTINGS_META: Record<keyof VerifiableCredentialsSettings, SettingMeta> = {};

/**
 * Verifiable Credentials Category Metadata
 */
export const VC_CATEGORY_META: CategoryMeta = {
  category: 'vc',
  label: 'Verifiable Credentials',
  description:
    'Holds no settings: OpenID4VP/VCI timings (request, nonce and offer lifetimes, proof-of-possession skew, DID cache) are fixed by the protocols and set in code. Nothing is planned here.',
  settings: VC_SETTINGS_META,
};

/**
 * Default Verifiable Credentials settings values
 */
export const VC_DEFAULTS: VerifiableCredentialsSettings = {};
