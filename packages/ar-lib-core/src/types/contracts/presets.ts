/**
 * Contract Presets
 *
 * Pre-configured policy templates for common use cases.
 * All contracts start from a preset and can be customized.
 */

import type { TenantContract } from './tenant';
import type { ClientContract } from './client';

// =============================================================================
// Tenant Policy Presets
// =============================================================================

/**
 * Tenant policy preset identifiers.
 */
export type TenantPolicyPreset =
  | 'startup-minimal' // Minimal config for startups/MVPs
  | 'b2c-standard' // Standard B2C (consumer-facing)
  | 'b2b-standard' // Standard B2B (business)
  | 'b2b-enterprise' // Enterprise B2B (large organizations)
  | 'fapi2-security-profile' // FAPI 2.0 Security Profile (PAR, PKCE, sender-constrained)
  | 'fapi2-message-signing' // FAPI 2.0 + Message Signing (JAR, JARM)
  | 'regulated-finance' // Financial regulations (PCI-DSS, SOX) + FAPI 2.0
  | 'regulated-healthcare' // Healthcare regulations (HIPAA)
  | 'high-security' // High security for critical infrastructure
  | 'custom'; // Fully custom configuration

/**
 * Tenant policy preset definition.
 */
export interface TenantPolicyPresetDefinition {
  /** Preset identifier */
  id: TenantPolicyPreset;
  /** Display name */
  name: string;
  /** Description */
  description: string;
  /** Target audience */
  targetAudience: string;

  /** Default values for this preset */
  defaults: Partial<TenantContract>;

  /** Customizable items with descriptions */
  customizable: TenantPresetCustomizableItem[];

  /** Locked items that cannot be changed */
  locked: TenantPresetLockedItem[];

  /** Recommended client presets for this tenant preset */
  recommendedClientPresets: ClientProfilePreset[];
}

/**
 * Customizable item in a preset.
 */
export interface TenantPresetCustomizableItem {
  /** Key path (e.g., 'oauth.maxAccessTokenExpiry') */
  key: string;
  /** Display label */
  label: string;
  /** Description */
  description: string;
}

/**
 * Locked item in a preset.
 */
export interface TenantPresetLockedItem {
  /** Key path */
  key: string;
  /** Reason for locking */
  reason: string;
}

// =============================================================================
// Client Profile Presets
// =============================================================================

/**
 * Client profile preset identifiers.
 */
export type ClientProfilePreset =
  | 'spa-public' // Single Page Application (public client)
  | 'mobile-native' // Native mobile app
  | 'server-confidential' // Server-side application (confidential)
  | 'first-party-web' // First-party web application
  | 'first-party-mobile' // First-party mobile application
  | 'm2m-service' // Machine-to-machine (client_credentials)
  | 'iot-device' // IoT device
  | 'custom'; // Fully custom configuration

/**
 * Client profile preset definition.
 */
export interface ClientProfilePresetDefinition {
  /** Preset identifier */
  id: ClientProfilePreset;
  /** Display name */
  name: string;
  /** Description */
  description: string;

  /** Default values for this preset */
  defaults: Partial<ClientContract>;

  /** Items inherited from tenant policy */
  inheritFromTenant: string[];

  /** Customizable items */
  customizable: ClientPresetCustomizableItem[];

  /** Required items with validators */
  required: ClientPresetRequiredItem[];
}

/**
 * Customizable item in a client preset.
 */
export interface ClientPresetCustomizableItem {
  /** Key path */
  key: string;
  /** Display label */
  label: string;
  /** Description */
  description: string;
}

/**
 * Required item in a client preset.
 */
export interface ClientPresetRequiredItem {
  /** Key path */
  key: string;
  /** Validation rule name */
  validator?: string;
}

// =============================================================================
// Flow Template Presets
// =============================================================================

/**
 * Flow template identifiers.
 */
export type FlowTemplateId =
  | 'standard-login' // Standard username/password login
  | 'passwordless' // Passwordless (passkey, email code)
  | 'enterprise-sso' // Enterprise SSO
  | 'b2b-org-selection' // B2B with organization selection
  | 'high-security' // High security with MFA
  | 'custom'; // Custom flow

/**
 * Flow template definition.
 */
export interface FlowTemplateDefinition {
  /** Template identifier */
  id: FlowTemplateId;
  /** Display name */
  name: string;
  /** Description */
  description: string;
  /** Required tenant policy settings */
  requiredTenantSettings: string[];
  /** Required client profile settings */
  requiredClientSettings: string[];
}

// =============================================================================
// Preset Registry (for type checking)
// =============================================================================

/**
 * Type guard for TenantPolicyPreset.
 */
export function isTenantPolicyPreset(value: string): value is TenantPolicyPreset {
  const presets: TenantPolicyPreset[] = [
    'startup-minimal',
    'b2c-standard',
    'b2b-standard',
    'b2b-enterprise',
    'fapi2-security-profile',
    'fapi2-message-signing',
    'regulated-finance',
    'regulated-healthcare',
    'high-security',
    'custom',
  ];
  return presets.includes(value as TenantPolicyPreset);
}

/**
 * Type guard for ClientProfilePreset.
 */
export function isClientProfilePreset(value: string): value is ClientProfilePreset {
  const presets: ClientProfilePreset[] = [
    'spa-public',
    'mobile-native',
    'server-confidential',
    'first-party-web',
    'first-party-mobile',
    'm2m-service',
    'iot-device',
    'custom',
  ];
  return presets.includes(value as ClientProfilePreset);
}

/**
 * Type guard for FlowTemplateId.
 */
export function isFlowTemplateId(value: string): value is FlowTemplateId {
  const templates: FlowTemplateId[] = [
    'standard-login',
    'passwordless',
    'enterprise-sso',
    'b2b-org-selection',
    'high-security',
    'custom',
  ];
  return templates.includes(value as FlowTemplateId);
}

// =============================================================================
// Preset Definitions (Runtime Constants)
// =============================================================================

import type { SecurityTier } from './common';
import {
  DEFAULT_TENANT_OAUTH_POLICY,
  DEFAULT_TENANT_SESSION_POLICY,
  DEFAULT_TENANT_SECURITY_POLICY,
  DEFAULT_TENANT_ENCRYPTION_POLICY,
  DEFAULT_TENANT_SCOPE_POLICY,
  DEFAULT_TENANT_AUTH_METHOD_POLICY,
  DEFAULT_TENANT_CONSENT_POLICY,
  DEFAULT_TENANT_CIBA_POLICY,
  DEFAULT_TENANT_DEVICE_FLOW_POLICY,
  DEFAULT_TENANT_EXTERNAL_IDP_POLICY,
  DEFAULT_TENANT_FEDERATION_POLICY,
  DEFAULT_TENANT_SCIM_POLICY,
  DEFAULT_TENANT_RATE_LIMIT_POLICY,
  DEFAULT_TENANT_TOKENS_POLICY,
  DEFAULT_TENANT_CREDENTIALS_POLICY,
  DEFAULT_TENANT_DATA_RESIDENCY_POLICY,
  DEFAULT_TENANT_AUDIT_POLICY,
  DEFAULT_CLIENT_TYPE_CONFIG,
  DEFAULT_CLIENT_OAUTH_CONFIG,
  DEFAULT_CLIENT_ENCRYPTION_CONFIG,
  DEFAULT_CLIENT_SCOPE_CONFIG,
  DEFAULT_CLIENT_AUTH_METHOD_CONFIG,
  DEFAULT_CLIENT_CONSENT_CONFIG,
  DEFAULT_CLIENT_REDIRECT_CONFIG,
  DEFAULT_CLIENT_TOKEN_CONFIG,
} from './defaults';

/**
 * Runtime tenant policy preset definition.
 */
export interface TenantPolicyPresetRuntime {
  id: TenantPolicyPreset;
  name: string;
  description: string;
  targetAudience: string;
  securityTier: SecurityTier;
  defaults: Partial<TenantContract>;
}

/**
 * Runtime client profile preset definition.
 */
export interface ClientProfilePresetRuntime {
  id: ClientProfilePreset;
  name: string;
  description: string;
  clientType: 'public' | 'confidential';
  defaults: Partial<ClientContract>;
}

/**
 * Tenant Policy Presets - runtime constant array.
 */
export const TENANT_POLICY_PRESETS: TenantPolicyPresetRuntime[] = [
  {
    id: 'startup-minimal',
    name: 'スタートアップ向け最小構成',
    description: 'MVP開発やプロトタイプに最適。必要最低限のセキュリティ設定。',
    targetAudience: '小規模スタートアップ、個人開発者',
    securityTier: 'standard',
    defaults: {
      oauth: DEFAULT_TENANT_OAUTH_POLICY,
      session: DEFAULT_TENANT_SESSION_POLICY,
      security: { ...DEFAULT_TENANT_SECURITY_POLICY, tier: 'standard' },
      encryption: DEFAULT_TENANT_ENCRYPTION_POLICY,
      scopes: DEFAULT_TENANT_SCOPE_POLICY,
      authMethods: DEFAULT_TENANT_AUTH_METHOD_POLICY,
      consent: DEFAULT_TENANT_CONSENT_POLICY,
      ciba: DEFAULT_TENANT_CIBA_POLICY,
      deviceFlow: DEFAULT_TENANT_DEVICE_FLOW_POLICY,
      externalIdp: DEFAULT_TENANT_EXTERNAL_IDP_POLICY,
      federation: DEFAULT_TENANT_FEDERATION_POLICY,
      scim: DEFAULT_TENANT_SCIM_POLICY,
      rateLimit: DEFAULT_TENANT_RATE_LIMIT_POLICY,
      tokens: DEFAULT_TENANT_TOKENS_POLICY,
      credentials: DEFAULT_TENANT_CREDENTIALS_POLICY,
      dataResidency: DEFAULT_TENANT_DATA_RESIDENCY_POLICY,
      audit: DEFAULT_TENANT_AUDIT_POLICY,
    },
  },
  {
    id: 'b2c-standard',
    name: 'B2C標準',
    description: 'コンシューマー向けアプリケーションに最適。バランスの取れたセキュリティ設定。',
    targetAudience: 'コンシューマー向けWebアプリ、モバイルアプリ',
    securityTier: 'standard',
    defaults: {
      oauth: DEFAULT_TENANT_OAUTH_POLICY,
      session: DEFAULT_TENANT_SESSION_POLICY,
      security: {
        ...DEFAULT_TENANT_SECURITY_POLICY,
        tier: 'standard',
        mfa: { ...DEFAULT_TENANT_SECURITY_POLICY.mfa, requirement: 'optional' },
      },
      encryption: DEFAULT_TENANT_ENCRYPTION_POLICY,
      scopes: DEFAULT_TENANT_SCOPE_POLICY,
      authMethods: {
        passkey: 'enabled',
        emailCode: 'enabled',
        password: 'enabled',
        externalIdp: 'enabled',
        did: 'disabled',
      },
      consent: DEFAULT_TENANT_CONSENT_POLICY,
      ciba: DEFAULT_TENANT_CIBA_POLICY,
      deviceFlow: DEFAULT_TENANT_DEVICE_FLOW_POLICY,
      externalIdp: DEFAULT_TENANT_EXTERNAL_IDP_POLICY,
      federation: DEFAULT_TENANT_FEDERATION_POLICY,
      scim: DEFAULT_TENANT_SCIM_POLICY,
      rateLimit: DEFAULT_TENANT_RATE_LIMIT_POLICY,
      tokens: DEFAULT_TENANT_TOKENS_POLICY,
      credentials: DEFAULT_TENANT_CREDENTIALS_POLICY,
      dataResidency: DEFAULT_TENANT_DATA_RESIDENCY_POLICY,
      audit: DEFAULT_TENANT_AUDIT_POLICY,
    },
  },
  {
    id: 'b2b-standard',
    name: 'B2B標準',
    description: '企業向けアプリケーションに最適。組織管理とSSO対応。',
    targetAudience: '中小企業向けSaaS',
    securityTier: 'enhanced',
    defaults: {
      oauth: { ...DEFAULT_TENANT_OAUTH_POLICY, pkceRequirement: 'required' },
      session: DEFAULT_TENANT_SESSION_POLICY,
      security: {
        ...DEFAULT_TENANT_SECURITY_POLICY,
        tier: 'enhanced',
        mfa: { ...DEFAULT_TENANT_SECURITY_POLICY.mfa, requirement: 'conditional' },
      },
      encryption: DEFAULT_TENANT_ENCRYPTION_POLICY,
      scopes: DEFAULT_TENANT_SCOPE_POLICY,
      authMethods: {
        passkey: 'enabled',
        emailCode: 'enabled',
        password: 'enabled',
        externalIdp: 'enabled',
        did: 'disabled',
      },
      consent: DEFAULT_TENANT_CONSENT_POLICY,
      ciba: DEFAULT_TENANT_CIBA_POLICY,
      deviceFlow: DEFAULT_TENANT_DEVICE_FLOW_POLICY,
      externalIdp: { ...DEFAULT_TENANT_EXTERNAL_IDP_POLICY, enabled: true },
      federation: { ...DEFAULT_TENANT_FEDERATION_POLICY, enabled: true, oidcEnabled: true },
      scim: { ...DEFAULT_TENANT_SCIM_POLICY, enabled: true },
      rateLimit: DEFAULT_TENANT_RATE_LIMIT_POLICY,
      tokens: DEFAULT_TENANT_TOKENS_POLICY,
      credentials: DEFAULT_TENANT_CREDENTIALS_POLICY,
      dataResidency: DEFAULT_TENANT_DATA_RESIDENCY_POLICY,
      audit: { ...DEFAULT_TENANT_AUDIT_POLICY, detailLevel: 'detailed' },
    },
  },
  {
    id: 'b2b-enterprise',
    name: 'B2Bエンタープライズ',
    description: '大企業向け。高度なセキュリティ、コンプライアンス対応。',
    targetAudience: '大企業、エンタープライズSaaS',
    securityTier: 'enhanced',
    defaults: {
      oauth: {
        ...DEFAULT_TENANT_OAUTH_POLICY,
        pkceRequirement: 'required',
        parRequirement: 'recommended',
      },
      session: { ...DEFAULT_TENANT_SESSION_POLICY, maxSessionAge: 28800 }, // 8 hours
      security: {
        ...DEFAULT_TENANT_SECURITY_POLICY,
        tier: 'enhanced',
        mfa: { ...DEFAULT_TENANT_SECURITY_POLICY.mfa, requirement: 'required' },
      },
      encryption: { ...DEFAULT_TENANT_ENCRYPTION_POLICY, piiEncryptionRequired: true },
      scopes: DEFAULT_TENANT_SCOPE_POLICY,
      authMethods: {
        passkey: 'enabled',
        emailCode: 'enabled',
        password: 'enabled',
        externalIdp: 'enabled',
        did: 'enabled',
      },
      consent: DEFAULT_TENANT_CONSENT_POLICY,
      ciba: { ...DEFAULT_TENANT_CIBA_POLICY, enabled: true },
      deviceFlow: DEFAULT_TENANT_DEVICE_FLOW_POLICY,
      externalIdp: { ...DEFAULT_TENANT_EXTERNAL_IDP_POLICY, enabled: true },
      federation: {
        ...DEFAULT_TENANT_FEDERATION_POLICY,
        enabled: true,
        samlEnabled: true,
        oidcEnabled: true,
      },
      scim: { ...DEFAULT_TENANT_SCIM_POLICY, enabled: true, autoProvisioningEnabled: true },
      rateLimit: DEFAULT_TENANT_RATE_LIMIT_POLICY,
      tokens: DEFAULT_TENANT_TOKENS_POLICY,
      credentials: { ...DEFAULT_TENANT_CREDENTIALS_POLICY, clientSecretRotationRequired: true },
      dataResidency: DEFAULT_TENANT_DATA_RESIDENCY_POLICY,
      audit: { ...DEFAULT_TENANT_AUDIT_POLICY, retentionDays: 365, detailLevel: 'detailed' },
    },
  },
  {
    id: 'fapi2-security-profile',
    name: 'FAPI 2.0 Security Profile',
    description:
      'OpenID Foundation FAPI 2.0準拠。PAR必須、sender-constrainedトークン、機密クライアント専用。',
    targetAudience: '金融API、ヘルスケアAPI、オープンバンキング',
    securityTier: 'regulated',
    defaults: {
      oauth: {
        ...DEFAULT_TENANT_OAUTH_POLICY,
        pkceRequirement: 'required',
        parRequirement: 'required',
        jarmEnabled: false, // FAPI 2.0 Security Profile does not require JARM
        maxAuthCodeTtl: 60, // 60 seconds per FAPI 2.0
        allowedResponseTypes: ['code'], // code only
        refreshTokenRotation: true,
      },
      session: DEFAULT_TENANT_SESSION_POLICY,
      security: {
        ...DEFAULT_TENANT_SECURITY_POLICY,
        tier: 'regulated',
        mfa: { ...DEFAULT_TENANT_SECURITY_POLICY.mfa, requirement: 'conditional' },
      },
      encryption: DEFAULT_TENANT_ENCRYPTION_POLICY,
      scopes: DEFAULT_TENANT_SCOPE_POLICY,
      authMethods: DEFAULT_TENANT_AUTH_METHOD_POLICY,
      consent: DEFAULT_TENANT_CONSENT_POLICY,
      ciba: DEFAULT_TENANT_CIBA_POLICY,
      deviceFlow: DEFAULT_TENANT_DEVICE_FLOW_POLICY,
      externalIdp: DEFAULT_TENANT_EXTERNAL_IDP_POLICY,
      federation: DEFAULT_TENANT_FEDERATION_POLICY,
      scim: DEFAULT_TENANT_SCIM_POLICY,
      rateLimit: DEFAULT_TENANT_RATE_LIMIT_POLICY,
      tokens: DEFAULT_TENANT_TOKENS_POLICY,
      credentials: {
        ...DEFAULT_TENANT_CREDENTIALS_POLICY,
        // FAPI 2.0: mTLS or private_key_jwt required, public clients not allowed
        allowedClientAuthMethods: ['private_key_jwt', 'tls_client_auth'],
        publicClientsAllowed: false,
      },
      dataResidency: DEFAULT_TENANT_DATA_RESIDENCY_POLICY,
      audit: { ...DEFAULT_TENANT_AUDIT_POLICY, detailLevel: 'detailed' },
    },
  },
  {
    id: 'fapi2-message-signing',
    name: 'FAPI 2.0 Message Signing',
    description: 'FAPI 2.0 Security Profile + JAR/JARM。否認防止が必要な決済・取引API向け。',
    targetAudience: '決済API、株式取引API、契約締結システム',
    securityTier: 'regulated',
    defaults: {
      oauth: {
        ...DEFAULT_TENANT_OAUTH_POLICY,
        pkceRequirement: 'required',
        parRequirement: 'required',
        jarmEnabled: true, // FAPI 2.0 Message Signing requires JARM
        jarEnabled: true, // JAR for request signing
        maxAuthCodeTtl: 60,
        allowedResponseTypes: ['code'],
        refreshTokenRotation: true,
      },
      session: DEFAULT_TENANT_SESSION_POLICY,
      security: {
        ...DEFAULT_TENANT_SECURITY_POLICY,
        tier: 'regulated',
        mfa: { ...DEFAULT_TENANT_SECURITY_POLICY.mfa, requirement: 'required' },
      },
      encryption: DEFAULT_TENANT_ENCRYPTION_POLICY,
      scopes: DEFAULT_TENANT_SCOPE_POLICY,
      authMethods: {
        passkey: 'enabled',
        emailCode: 'enabled',
        password: 'enabled',
        externalIdp: 'disabled', // Typically disabled for high-assurance
        did: 'enabled',
      },
      consent: { ...DEFAULT_TENANT_CONSENT_POLICY, thirdPartyDefault: 'always' },
      ciba: DEFAULT_TENANT_CIBA_POLICY,
      deviceFlow: DEFAULT_TENANT_DEVICE_FLOW_POLICY,
      externalIdp: { ...DEFAULT_TENANT_EXTERNAL_IDP_POLICY, enabled: false },
      federation: DEFAULT_TENANT_FEDERATION_POLICY,
      scim: DEFAULT_TENANT_SCIM_POLICY,
      rateLimit: DEFAULT_TENANT_RATE_LIMIT_POLICY,
      tokens: DEFAULT_TENANT_TOKENS_POLICY,
      credentials: {
        ...DEFAULT_TENANT_CREDENTIALS_POLICY,
        allowedClientAuthMethods: ['private_key_jwt', 'tls_client_auth'],
        publicClientsAllowed: false,
      },
      dataResidency: DEFAULT_TENANT_DATA_RESIDENCY_POLICY,
      audit: {
        ...DEFAULT_TENANT_AUDIT_POLICY,
        detailLevel: 'detailed',
        flowReplayEnabled: true, // For non-repudiation audit trail
      },
    },
  },
  {
    id: 'regulated-finance',
    name: '金融規制対応',
    description: 'PCI-DSS、SOX等の金融規制に準拠。最高レベルのセキュリティ。',
    targetAudience: '金融機関、フィンテック企業',
    securityTier: 'regulated',
    defaults: {
      oauth: {
        ...DEFAULT_TENANT_OAUTH_POLICY,
        pkceRequirement: 'required',
        parRequirement: 'required',
        maxAccessTokenExpiry: 900, // 15 minutes
      },
      session: { ...DEFAULT_TENANT_SESSION_POLICY, maxSessionAge: 14400, idleTimeout: 900 }, // 4h, 15min
      security: {
        ...DEFAULT_TENANT_SECURITY_POLICY,
        tier: 'regulated',
        complianceModules: ['pci-dss'],
        mfa: {
          ...DEFAULT_TENANT_SECURITY_POLICY.mfa,
          requirement: 'required',
          allowedMethods: ['totp', 'passkey'],
        },
      },
      encryption: { ...DEFAULT_TENANT_ENCRYPTION_POLICY, piiEncryptionRequired: true },
      scopes: DEFAULT_TENANT_SCOPE_POLICY,
      authMethods: {
        passkey: 'required',
        emailCode: 'enabled',
        password: 'disabled',
        externalIdp: 'disabled',
        did: 'enabled',
      },
      consent: { ...DEFAULT_TENANT_CONSENT_POLICY, thirdPartyDefault: 'always' },
      ciba: DEFAULT_TENANT_CIBA_POLICY,
      deviceFlow: DEFAULT_TENANT_DEVICE_FLOW_POLICY,
      externalIdp: { ...DEFAULT_TENANT_EXTERNAL_IDP_POLICY, enabled: false },
      federation: DEFAULT_TENANT_FEDERATION_POLICY,
      scim: DEFAULT_TENANT_SCIM_POLICY,
      rateLimit: { ...DEFAULT_TENANT_RATE_LIMIT_POLICY, loginAttemptsPerMinute: 5 },
      tokens: DEFAULT_TENANT_TOKENS_POLICY,
      credentials: {
        ...DEFAULT_TENANT_CREDENTIALS_POLICY,
        clientSecretRotationRequired: true,
        maxClientSecretAgeDays: 90,
      },
      dataResidency: { ...DEFAULT_TENANT_DATA_RESIDENCY_POLICY, enabled: true },
      audit: {
        ...DEFAULT_TENANT_AUDIT_POLICY,
        retentionDays: 2555,
        detailLevel: 'detailed',
        flowReplayEnabled: true,
      }, // 7 years
    },
  },
  {
    id: 'regulated-healthcare',
    name: '医療規制対応',
    description: 'HIPAA等の医療規制に準拠。PHI保護に最適化。',
    targetAudience: '医療機関、ヘルスケア企業',
    securityTier: 'regulated',
    defaults: {
      oauth: {
        ...DEFAULT_TENANT_OAUTH_POLICY,
        pkceRequirement: 'required',
        maxAccessTokenExpiry: 1800, // 30 minutes
      },
      session: { ...DEFAULT_TENANT_SESSION_POLICY, maxSessionAge: 28800, idleTimeout: 1800 },
      security: {
        ...DEFAULT_TENANT_SECURITY_POLICY,
        tier: 'regulated',
        complianceModules: ['hipaa'],
        mfa: { ...DEFAULT_TENANT_SECURITY_POLICY.mfa, requirement: 'required' },
      },
      encryption: { ...DEFAULT_TENANT_ENCRYPTION_POLICY, piiEncryptionRequired: true },
      scopes: DEFAULT_TENANT_SCOPE_POLICY,
      authMethods: {
        passkey: 'enabled',
        emailCode: 'enabled',
        password: 'enabled',
        externalIdp: 'disabled',
        did: 'disabled',
      },
      consent: { ...DEFAULT_TENANT_CONSENT_POLICY, thirdPartyDefault: 'always' },
      ciba: DEFAULT_TENANT_CIBA_POLICY,
      deviceFlow: DEFAULT_TENANT_DEVICE_FLOW_POLICY,
      externalIdp: { ...DEFAULT_TENANT_EXTERNAL_IDP_POLICY, enabled: false },
      federation: DEFAULT_TENANT_FEDERATION_POLICY,
      scim: DEFAULT_TENANT_SCIM_POLICY,
      rateLimit: DEFAULT_TENANT_RATE_LIMIT_POLICY,
      tokens: DEFAULT_TENANT_TOKENS_POLICY,
      credentials: DEFAULT_TENANT_CREDENTIALS_POLICY,
      dataResidency: {
        ...DEFAULT_TENANT_DATA_RESIDENCY_POLICY,
        enabled: true,
        piiStoragePolicy: 'local_only',
      },
      audit: { ...DEFAULT_TENANT_AUDIT_POLICY, retentionDays: 2190, detailLevel: 'detailed' }, // 6 years
    },
  },
  {
    id: 'high-security',
    name: '高セキュリティ',
    description: '機密性の高いシステム向け。パスキー必須、短期トークン。',
    targetAudience: '重要インフラ、機密データを扱う企業システム',
    securityTier: 'regulated',
    defaults: {
      oauth: {
        ...DEFAULT_TENANT_OAUTH_POLICY,
        pkceRequirement: 'required',
        parRequirement: 'required',
        jarmEnabled: true,
        maxAccessTokenExpiry: 300, // 5 minutes
      },
      session: { ...DEFAULT_TENANT_SESSION_POLICY, maxSessionAge: 3600, idleTimeout: 300 },
      security: {
        ...DEFAULT_TENANT_SECURITY_POLICY,
        tier: 'regulated',
        mfa: {
          ...DEFAULT_TENANT_SECURITY_POLICY.mfa,
          requirement: 'required',
          allowedMethods: ['passkey'],
        },
      },
      encryption: { ...DEFAULT_TENANT_ENCRYPTION_POLICY, piiEncryptionRequired: true },
      scopes: DEFAULT_TENANT_SCOPE_POLICY,
      authMethods: {
        passkey: 'required',
        emailCode: 'disabled',
        password: 'disabled',
        externalIdp: 'disabled',
        did: 'enabled',
      },
      consent: { ...DEFAULT_TENANT_CONSENT_POLICY, thirdPartyDefault: 'always' },
      ciba: DEFAULT_TENANT_CIBA_POLICY,
      deviceFlow: DEFAULT_TENANT_DEVICE_FLOW_POLICY,
      externalIdp: { ...DEFAULT_TENANT_EXTERNAL_IDP_POLICY, enabled: false },
      federation: DEFAULT_TENANT_FEDERATION_POLICY,
      scim: DEFAULT_TENANT_SCIM_POLICY,
      rateLimit: { ...DEFAULT_TENANT_RATE_LIMIT_POLICY, loginAttemptsPerMinute: 3 },
      tokens: DEFAULT_TENANT_TOKENS_POLICY,
      credentials: {
        ...DEFAULT_TENANT_CREDENTIALS_POLICY,
        clientSecretRotationRequired: true,
        maxClientSecretAgeDays: 30,
      },
      dataResidency: {
        ...DEFAULT_TENANT_DATA_RESIDENCY_POLICY,
        enabled: true,
        piiStoragePolicy: 'local_only',
      },
      audit: {
        ...DEFAULT_TENANT_AUDIT_POLICY,
        retentionDays: 3650,
        detailLevel: 'detailed',
        flowReplayEnabled: true,
      }, // 10 years
    },
  },
  {
    id: 'custom',
    name: 'カスタム',
    description: '完全にカスタマイズ可能な設定。',
    targetAudience: '特殊要件を持つ組織',
    securityTier: 'standard',
    defaults: {},
  },
];

/**
 * Client Profile Presets - runtime constant array.
 */
export const CLIENT_PROFILE_PRESETS: ClientProfilePresetRuntime[] = [
  {
    id: 'spa-public',
    name: 'SPA (パブリック)',
    description:
      'シングルページアプリケーション向け。PKCEを使用したセキュアなパブリッククライアント。',
    clientType: 'public',
    defaults: {
      clientType: { ...DEFAULT_CLIENT_TYPE_CONFIG, type: 'public' },
      oauth: { ...DEFAULT_CLIENT_OAUTH_CONFIG, pkceRequired: true },
      encryption: DEFAULT_CLIENT_ENCRYPTION_CONFIG,
      scopes: DEFAULT_CLIENT_SCOPE_CONFIG,
      authMethods: DEFAULT_CLIENT_AUTH_METHOD_CONFIG,
      consent: DEFAULT_CLIENT_CONSENT_CONFIG,
      redirect: { ...DEFAULT_CLIENT_REDIRECT_CONFIG, allowLocalhost: true },
      tokens: DEFAULT_CLIENT_TOKEN_CONFIG,
    },
  },
  {
    id: 'mobile-native',
    name: 'モバイルネイティブ',
    description: 'iOS/Androidネイティブアプリ向け。ディープリンク対応。',
    clientType: 'public',
    defaults: {
      clientType: { ...DEFAULT_CLIENT_TYPE_CONFIG, type: 'public' },
      oauth: { ...DEFAULT_CLIENT_OAUTH_CONFIG, pkceRequired: true, refreshTokenExpiry: 7776000 }, // 90 days
      encryption: DEFAULT_CLIENT_ENCRYPTION_CONFIG,
      scopes: {
        ...DEFAULT_CLIENT_SCOPE_CONFIG,
        allowedScopes: ['openid', 'profile', 'email', 'offline_access'],
      },
      authMethods: { ...DEFAULT_CLIENT_AUTH_METHOD_CONFIG, passkey: true },
      consent: { ...DEFAULT_CLIENT_CONSENT_CONFIG, policy: 'remember' },
      redirect: DEFAULT_CLIENT_REDIRECT_CONFIG,
      tokens: DEFAULT_CLIENT_TOKEN_CONFIG,
    },
  },
  {
    id: 'server-confidential',
    name: 'サーバーサイド',
    description: 'バックエンドサーバーアプリケーション向け。機密クライアント認証。',
    clientType: 'confidential',
    defaults: {
      clientType: {
        ...DEFAULT_CLIENT_TYPE_CONFIG,
        type: 'confidential',
        authenticationMethod: 'client_secret_basic',
      },
      oauth: DEFAULT_CLIENT_OAUTH_CONFIG,
      encryption: DEFAULT_CLIENT_ENCRYPTION_CONFIG,
      scopes: DEFAULT_CLIENT_SCOPE_CONFIG,
      authMethods: DEFAULT_CLIENT_AUTH_METHOD_CONFIG,
      consent: DEFAULT_CLIENT_CONSENT_CONFIG,
      redirect: DEFAULT_CLIENT_REDIRECT_CONFIG,
      tokens: DEFAULT_CLIENT_TOKEN_CONFIG,
    },
  },
  {
    id: 'first-party-web',
    name: 'ファーストパーティWeb',
    description: '自社Webアプリケーション向け。同意画面スキップ可能。',
    clientType: 'confidential',
    defaults: {
      clientType: { ...DEFAULT_CLIENT_TYPE_CONFIG, type: 'confidential', isFirstParty: true },
      oauth: DEFAULT_CLIENT_OAUTH_CONFIG,
      encryption: DEFAULT_CLIENT_ENCRYPTION_CONFIG,
      scopes: DEFAULT_CLIENT_SCOPE_CONFIG,
      authMethods: DEFAULT_CLIENT_AUTH_METHOD_CONFIG,
      consent: { ...DEFAULT_CLIENT_CONSENT_CONFIG, policy: 'skip' },
      redirect: DEFAULT_CLIENT_REDIRECT_CONFIG,
      tokens: DEFAULT_CLIENT_TOKEN_CONFIG,
    },
  },
  {
    id: 'first-party-mobile',
    name: 'ファーストパーティモバイル',
    description: '自社モバイルアプリケーション向け。パスキー優先、同意スキップ。',
    clientType: 'public',
    defaults: {
      clientType: { ...DEFAULT_CLIENT_TYPE_CONFIG, type: 'public', isFirstParty: true },
      oauth: { ...DEFAULT_CLIENT_OAUTH_CONFIG, pkceRequired: true, refreshTokenExpiry: 7776000 },
      encryption: DEFAULT_CLIENT_ENCRYPTION_CONFIG,
      scopes: {
        ...DEFAULT_CLIENT_SCOPE_CONFIG,
        allowedScopes: ['openid', 'profile', 'email', 'offline_access'],
      },
      authMethods: { ...DEFAULT_CLIENT_AUTH_METHOD_CONFIG, preferredMethod: 'passkey' },
      consent: { ...DEFAULT_CLIENT_CONSENT_CONFIG, policy: 'skip' },
      redirect: DEFAULT_CLIENT_REDIRECT_CONFIG,
      tokens: DEFAULT_CLIENT_TOKEN_CONFIG,
    },
  },
  {
    id: 'm2m-service',
    name: 'M2M (マシン間)',
    description: 'サービス間通信向け。client_credentialsグラント。',
    clientType: 'confidential',
    defaults: {
      clientType: {
        ...DEFAULT_CLIENT_TYPE_CONFIG,
        type: 'confidential',
        authenticationMethod: 'client_secret_basic',
      },
      oauth: {
        ...DEFAULT_CLIENT_OAUTH_CONFIG,
        allowedGrantTypes: ['client_credentials'],
        allowedResponseTypes: [],
      },
      encryption: DEFAULT_CLIENT_ENCRYPTION_CONFIG,
      scopes: { ...DEFAULT_CLIENT_SCOPE_CONFIG, defaultScopes: [] },
      authMethods: {
        passkey: false,
        emailCode: false,
        password: false,
        externalIdp: false,
        did: false,
      },
      consent: { ...DEFAULT_CLIENT_CONSENT_CONFIG, policy: 'skip' },
      redirect: { ...DEFAULT_CLIENT_REDIRECT_CONFIG, allowedRedirectUris: [] },
      tokens: DEFAULT_CLIENT_TOKEN_CONFIG,
    },
  },
  {
    id: 'iot-device',
    name: 'IoTデバイス',
    description: 'IoTデバイス向け。デバイスフロー対応。',
    clientType: 'public',
    defaults: {
      clientType: { ...DEFAULT_CLIENT_TYPE_CONFIG, type: 'public' },
      oauth: {
        ...DEFAULT_CLIENT_OAUTH_CONFIG,
        allowedGrantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
      },
      encryption: DEFAULT_CLIENT_ENCRYPTION_CONFIG,
      scopes: { ...DEFAULT_CLIENT_SCOPE_CONFIG, allowedScopes: ['openid', 'offline_access'] },
      authMethods: DEFAULT_CLIENT_AUTH_METHOD_CONFIG,
      consent: { ...DEFAULT_CLIENT_CONSENT_CONFIG, policy: 'always' },
      redirect: { ...DEFAULT_CLIENT_REDIRECT_CONFIG, allowedRedirectUris: [] },
      tokens: DEFAULT_CLIENT_TOKEN_CONFIG,
    },
  },
  {
    id: 'custom',
    name: 'カスタム',
    description: '完全にカスタマイズ可能な設定。',
    clientType: 'public',
    defaults: {},
  },
];
