/**
 * Provider Registry
 * Central registry for external IdP provider configurations
 */

export {
  GOOGLE_ISSUER,
  GOOGLE_DEFAULT_CONFIG,
  GOOGLE_CLAIM_MAPPINGS,
  validateGoogleConfig,
} from './google';

export {
  MICROSOFT_ISSUER,
  MICROSOFT_DEFAULT_CONFIG,
  MICROSOFT_CLAIM_MAPPINGS,
  MICROSOFT_TENANT_LABELS,
  validateMicrosoftConfig,
  getMicrosoftIssuer,
  getMicrosoftEffectiveIssuer,
  createMicrosoftConfig,
  type MicrosoftTenantType,
  type MicrosoftProviderQuirks,
} from './microsoft';

export {
  GITHUB_DEFAULT_CONFIG,
  GITHUB_CLAIM_MAPPINGS,
  GITHUB_AUTHORIZATION_ENDPOINT,
  GITHUB_TOKEN_ENDPOINT,
  GITHUB_USERINFO_ENDPOINT,
  GITHUB_USER_EMAILS_ENDPOINT,
  validateGitHubConfig,
  getGitHubEffectiveEndpoints,
  getGitHubEnterpriseEndpoints,
  createGitHubConfig,
  type GitHubProviderQuirks,
  type GitHubEmail,
} from './github';

/**
 * Known provider types with their default configurations
 */
export const KNOWN_PROVIDERS = {
  google: {
    name: 'Google',
    issuer: 'https://accounts.google.com',
    providerType: 'oidc' as const,
  },
  microsoft: {
    name: 'Microsoft',
    issuer: 'https://login.microsoftonline.com/common/v2.0',
    providerType: 'oidc' as const,
  },
  github: {
    name: 'GitHub',
    providerType: 'oauth2' as const,
  },
} as const;

export type KnownProviderId = keyof typeof KNOWN_PROVIDERS;
