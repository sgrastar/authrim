/**
 * Microsoft Provider Configuration
 * Pre-configured settings for Microsoft (Entra ID / MSA) OIDC authentication
 *
 * Supports:
 * - Microsoft Entra ID (formerly Azure AD) - organizational accounts
 * - Microsoft Account (MSA) - personal accounts (Xbox, OneDrive, Outlook.com)
 */

import type { UpstreamProvider } from '../types';

/**
 * Microsoft tenant types
 * Determines which account types are allowed to sign in
 */
export type MicrosoftTenantType =
  | 'common' // Both personal and organizational accounts
  | 'organizations' // Only organizational accounts (Entra ID)
  | 'consumers' // Only personal Microsoft accounts
  | string; // Specific tenant ID (GUID or domain)

/**
 * Build Microsoft issuer URL based on tenant type
 */
export function getMicrosoftIssuer(tenantType: MicrosoftTenantType = 'common'): string {
  return `https://login.microsoftonline.com/${tenantType}/v2.0`;
}

/**
 * Default issuer for common tenant (both personal and organizational)
 */
export const MICROSOFT_ISSUER = getMicrosoftIssuer('common');

/**
 * Microsoft-specific quirks configuration
 */
export interface MicrosoftProviderQuirks {
  /**
   * Tenant type configuration
   * - 'common': Allow both personal and organizational accounts (default)
   * - 'organizations': Only organizational accounts (Entra ID)
   * - 'consumers': Only personal Microsoft accounts (Xbox, OneDrive, etc.)
   * - '{tenant-id}': Specific tenant ID (GUID) or domain
   */
  tenantType?: MicrosoftTenantType;

  /**
   * Whether to allow personal Microsoft accounts
   * Only applicable when tenantType is 'common'
   */
  allowPersonalAccounts?: boolean;

  /**
   * Whether to require email verification
   * Microsoft accounts are generally verified, but this adds extra check
   */
  requireVerifiedEmail?: boolean;
}

/**
 * Default configuration for Microsoft provider
 * Use this as a template when creating a new Microsoft provider via Admin API
 */
export const MICROSOFT_DEFAULT_CONFIG: Partial<UpstreamProvider> = {
  name: 'Microsoft',
  providerType: 'oidc',
  issuer: MICROSOFT_ISSUER,
  scopes: 'openid email profile',
  attributeMapping: {
    sub: 'sub',
    email: 'email',
    email_verified: 'email_verified',
    name: 'name',
    given_name: 'given_name',
    family_name: 'family_name',
    picture: 'picture',
    preferred_username: 'preferred_username',
  },
  autoLinkEmail: true,
  jitProvisioning: true,
  requireEmailVerified: true,
  iconUrl: 'https://learn.microsoft.com/favicon.ico',
  buttonColor: '#2F2F2F',
  buttonText: 'Continue with Microsoft',
  providerQuirks: {
    tenantType: 'common',
  },
};

/**
 * Microsoft-specific claim mappings
 * Microsoft follows OIDC standard with some additional claims
 */
export const MICROSOFT_CLAIM_MAPPINGS = {
  // Standard OIDC claims
  sub: 'sub',
  email: 'email',
  email_verified: 'email_verified',
  name: 'name',
  given_name: 'given_name',
  family_name: 'family_name',
  picture: 'picture',
  preferred_username: 'preferred_username',

  // Microsoft-specific claims
  oid: 'oid', // Object ID (unique within tenant)
  tid: 'tid', // Tenant ID
  upn: 'upn', // User Principal Name (for organizational accounts)
  idp: 'idp', // Identity provider (for federated accounts)
};

/**
 * Tenant type display labels for Admin UI
 */
export const MICROSOFT_TENANT_LABELS: Record<string, { label: string; description: string }> = {
  common: {
    label: 'All accounts',
    description: 'Allow both personal Microsoft accounts and organizational accounts',
  },
  organizations: {
    label: 'Organizational accounts only',
    description: 'Only allow Microsoft Entra ID (work/school) accounts',
  },
  consumers: {
    label: 'Personal accounts only',
    description: 'Only allow personal Microsoft accounts (Xbox, OneDrive, Outlook.com)',
  },
  custom: {
    label: 'Specific tenant',
    description: 'Only allow accounts from a specific organization (enter tenant ID)',
  },
};

/**
 * Validate Microsoft-specific requirements
 */
export function validateMicrosoftConfig(provider: Partial<UpstreamProvider>): string[] {
  const errors: string[] = [];

  if (!provider.clientId) {
    errors.push('clientId is required');
  }

  if (!provider.clientSecretEncrypted) {
    errors.push('clientSecret is required');
  }

  // Microsoft requires specific scopes
  const scopes = provider.scopes?.split(/[\s,]+/) || [];
  if (!scopes.includes('openid')) {
    errors.push('openid scope is required for OIDC');
  }

  // Validate tenant type if specified
  const quirks = provider.providerQuirks as MicrosoftProviderQuirks | undefined;
  if (quirks?.tenantType) {
    const validTenantTypes = ['common', 'organizations', 'consumers'];
    const isValidBuiltIn = validTenantTypes.includes(quirks.tenantType);
    // Check if it looks like a GUID (tenant ID)
    const isValidGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      quirks.tenantType
    );
    // Check if it looks like a domain
    const isValidDomain = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(quirks.tenantType);

    if (!isValidBuiltIn && !isValidGuid && !isValidDomain) {
      errors.push(
        'tenantType must be "common", "organizations", "consumers", a valid tenant ID (GUID), or domain'
      );
    }
  }

  return errors;
}

/**
 * Get the effective issuer URL for a Microsoft provider
 * Takes into account the tenantType from providerQuirks
 */
export function getMicrosoftEffectiveIssuer(provider: Partial<UpstreamProvider>): string {
  const quirks = provider.providerQuirks as MicrosoftProviderQuirks | undefined;
  const tenantType = quirks?.tenantType || 'common';
  return getMicrosoftIssuer(tenantType);
}

/**
 * Create Microsoft provider config with specific tenant
 */
export function createMicrosoftConfig(
  tenantType: MicrosoftTenantType = 'common',
  overrides?: Partial<UpstreamProvider>
): Partial<UpstreamProvider> {
  return {
    ...MICROSOFT_DEFAULT_CONFIG,
    issuer: getMicrosoftIssuer(tenantType),
    providerQuirks: {
      ...(MICROSOFT_DEFAULT_CONFIG.providerQuirks as MicrosoftProviderQuirks),
      tenantType,
    },
    ...overrides,
  };
}
