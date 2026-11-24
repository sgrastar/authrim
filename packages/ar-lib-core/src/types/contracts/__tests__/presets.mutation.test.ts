import { describe, expect, it } from 'vitest';
import {
  CLIENT_PROFILE_PRESETS,
  TENANT_POLICY_PRESETS,
  isClientProfilePreset,
  isFlowTemplateId,
  isTenantPolicyPreset,
} from '../presets';
import * as D from '../defaults';

const T = {
  oauth: D.DEFAULT_TENANT_OAUTH_POLICY,
  session: D.DEFAULT_TENANT_SESSION_POLICY,
  security: D.DEFAULT_TENANT_SECURITY_POLICY,
  encryption: D.DEFAULT_TENANT_ENCRYPTION_POLICY,
  scopes: D.DEFAULT_TENANT_SCOPE_POLICY,
  authMethods: D.DEFAULT_TENANT_AUTH_METHOD_POLICY,
  consent: D.DEFAULT_TENANT_CONSENT_POLICY,
  ciba: D.DEFAULT_TENANT_CIBA_POLICY,
  deviceFlow: D.DEFAULT_TENANT_DEVICE_FLOW_POLICY,
  externalIdp: D.DEFAULT_TENANT_EXTERNAL_IDP_POLICY,
  federation: D.DEFAULT_TENANT_FEDERATION_POLICY,
  scim: D.DEFAULT_TENANT_SCIM_POLICY,
  rateLimit: D.DEFAULT_TENANT_RATE_LIMIT_POLICY,
  tokens: D.DEFAULT_TENANT_TOKENS_POLICY,
  credentials: D.DEFAULT_TENANT_CREDENTIALS_POLICY,
  dataResidency: D.DEFAULT_TENANT_DATA_RESIDENCY_POLICY,
  audit: D.DEFAULT_TENANT_AUDIT_POLICY,
};

const C = {
  clientType: D.DEFAULT_CLIENT_TYPE_CONFIG,
  oauth: D.DEFAULT_CLIENT_OAUTH_CONFIG,
  encryption: D.DEFAULT_CLIENT_ENCRYPTION_CONFIG,
  scopes: D.DEFAULT_CLIENT_SCOPE_CONFIG,
  authMethods: D.DEFAULT_CLIENT_AUTH_METHOD_CONFIG,
  consent: D.DEFAULT_CLIENT_CONSENT_CONFIG,
  redirect: D.DEFAULT_CLIENT_REDIRECT_CONFIG,
  tokens: D.DEFAULT_CLIENT_TOKEN_CONFIG,
};

function tenantPreset(id: string) {
  const preset = TENANT_POLICY_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`missing preset ${id}`);
  return preset;
}
function clientPreset(id: string) {
  const preset = CLIENT_PROFILE_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`missing preset ${id}`);
  return preset;
}

const AUTH_STD = {
  passkey: 'enabled',
  emailCode: 'enabled',
  password: 'enabled',
  externalIdp: 'enabled',
  did: 'disabled',
};

describe('type guards', () => {
  const tenantIds = [
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
  const clientIds = [
    'spa-public',
    'mobile-native',
    'server-confidential',
    'first-party-web',
    'first-party-mobile',
    'm2m-service',
    'iot-device',
    'custom',
  ];
  const flowIds = [
    'standard-login',
    'passwordless',
    'enterprise-sso',
    'b2b-org-selection',
    'high-security',
    'custom',
  ];

  it.each(tenantIds)('isTenantPolicyPreset accepts %s', (id) => {
    expect(isTenantPolicyPreset(id)).toBe(true);
  });
  it.each(clientIds)('isClientProfilePreset accepts %s', (id) => {
    expect(isClientProfilePreset(id)).toBe(true);
  });
  it.each(flowIds)('isFlowTemplateId accepts %s', (id) => {
    expect(isFlowTemplateId(id)).toBe(true);
  });

  it('rejects unknown, empty, and cross-domain ids', () => {
    for (const bad of ['', 'unknown', 'Custom', 'custom ']) {
      expect(isClientProfilePreset(bad)).toBe(false);
    }
    expect(isTenantPolicyPreset('')).toBe(false);
    expect(isTenantPolicyPreset('spa-public')).toBe(false);
    expect(isTenantPolicyPreset('Custom')).toBe(false);
    expect(isClientProfilePreset('b2c-standard')).toBe(false);
    expect(isClientProfilePreset('')).toBe(false);
    expect(isFlowTemplateId('')).toBe(false);
    expect(isFlowTemplateId('startup-minimal')).toBe(false);
    expect(isFlowTemplateId('Standard-Login')).toBe(false);
  });

  it('every runtime preset id satisfies its guard and ids are unique', () => {
    expect(TENANT_POLICY_PRESETS.map((p) => p.id)).toEqual(tenantIds);
    expect(CLIENT_PROFILE_PRESETS.map((p) => p.id)).toEqual(clientIds);
  });
});

describe('TENANT_POLICY_PRESETS', () => {
  it('startup-minimal', () => {
    expect(tenantPreset('startup-minimal')).toEqual({
      id: 'startup-minimal',
      name: 'スタートアップ向け最小構成',
      description: 'MVP開発やプロトタイプに最適。必要最低限のセキュリティ設定。',
      targetAudience: '小規模スタートアップ、個人開発者',
      securityTier: 'standard',
      defaults: { ...T, security: { ...T.security, tier: 'standard' } },
    });
  });

  it('b2c-standard', () => {
    expect(tenantPreset('b2c-standard')).toEqual({
      id: 'b2c-standard',
      name: 'B2C標準',
      description: 'コンシューマー向けアプリケーションに最適。バランスの取れたセキュリティ設定。',
      targetAudience: 'コンシューマー向けWebアプリ、モバイルアプリ',
      securityTier: 'standard',
      defaults: {
        ...T,
        security: {
          ...T.security,
          tier: 'standard',
          mfa: { ...T.security.mfa, requirement: 'optional' },
        },
        authMethods: AUTH_STD,
      },
    });
  });

  it('b2b-standard', () => {
    const p = tenantPreset('b2b-standard');
    expect(p).toEqual({
      id: 'b2b-standard',
      name: 'B2B標準',
      description: '企業向けアプリケーションに最適。組織管理とSSO対応。',
      targetAudience: '中小企業向けSaaS',
      securityTier: 'enhanced',
      defaults: {
        ...T,
        oauth: { ...T.oauth, pkceRequirement: 'required' },
        security: {
          ...T.security,
          tier: 'enhanced',
          mfa: { ...T.security.mfa, requirement: 'conditional' },
        },
        authMethods: AUTH_STD,
        externalIdp: { ...T.externalIdp, enabled: true },
        federation: { ...T.federation, enabled: true, oidcEnabled: true },
        scim: { ...T.scim, enabled: true },
        audit: { ...T.audit, detailLevel: 'detailed' },
      },
    });
    expect(p.defaults.federation?.enabled).toBe(true);
    expect(p.defaults.federation?.oidcEnabled).toBe(true);
    expect(p.defaults.scim?.enabled).toBe(true);
    expect(p.defaults.externalIdp?.enabled).toBe(true);
  });

  it('b2b-enterprise', () => {
    const p = tenantPreset('b2b-enterprise');
    expect(p).toEqual({
      id: 'b2b-enterprise',
      name: 'B2Bエンタープライズ',
      description: '大企業向け。高度なセキュリティ、コンプライアンス対応。',
      targetAudience: '大企業、エンタープライズSaaS',
      securityTier: 'enhanced',
      defaults: {
        ...T,
        oauth: { ...T.oauth, pkceRequirement: 'required', parRequirement: 'recommended' },
        session: { ...T.session, maxSessionAge: 28800 },
        security: {
          ...T.security,
          tier: 'enhanced',
          mfa: { ...T.security.mfa, requirement: 'required' },
        },
        encryption: { ...T.encryption, piiEncryptionRequired: true },
        authMethods: { ...AUTH_STD, did: 'enabled' },
        ciba: { ...T.ciba, enabled: true },
        externalIdp: { ...T.externalIdp, enabled: true },
        federation: { ...T.federation, enabled: true, samlEnabled: true, oidcEnabled: true },
        scim: { ...T.scim, enabled: true, autoProvisioningEnabled: true },
        credentials: { ...T.credentials, clientSecretRotationRequired: true },
        audit: { ...T.audit, retentionDays: 365, detailLevel: 'detailed' },
      },
    });
    expect(p.defaults.session?.maxSessionAge).toBe(28800);
    expect(p.defaults.audit?.retentionDays).toBe(365);
    expect(p.defaults.ciba?.enabled).toBe(true);
    expect(p.defaults.federation?.samlEnabled).toBe(true);
  });

  it('fapi2-security-profile', () => {
    const p = tenantPreset('fapi2-security-profile');
    expect(p).toEqual({
      id: 'fapi2-security-profile',
      name: 'FAPI 2.0 Security Profile',
      description:
        'OpenID Foundation FAPI 2.0準拠。PAR必須、sender-constrainedトークン、機密クライアント専用。',
      targetAudience: '金融API、ヘルスケアAPI、オープンバンキング',
      securityTier: 'regulated',
      defaults: {
        ...T,
        oauth: {
          ...T.oauth,
          pkceRequirement: 'required',
          parRequirement: 'required',
          jarmEnabled: false,
          maxAuthCodeTtl: 60,
          allowedResponseTypes: ['code'],
          refreshTokenRotation: true,
        },
        security: {
          ...T.security,
          tier: 'regulated',
          mfa: { ...T.security.mfa, requirement: 'conditional' },
        },
        credentials: {
          ...T.credentials,
          allowedClientAuthMethods: ['private_key_jwt', 'tls_client_auth'],
          publicClientsAllowed: false,
        },
        audit: { ...T.audit, detailLevel: 'detailed' },
      },
    });
    expect(p.defaults.oauth?.allowedResponseTypes).toEqual(['code']);
    expect(p.defaults.credentials?.allowedClientAuthMethods).toEqual([
      'private_key_jwt',
      'tls_client_auth',
    ]);
    expect(p.defaults.oauth?.maxAuthCodeTtl).toBe(60);
  });

  it('fapi2-message-signing', () => {
    const p = tenantPreset('fapi2-message-signing');
    expect(p).toEqual({
      id: 'fapi2-message-signing',
      name: 'FAPI 2.0 Message Signing',
      description: 'FAPI 2.0 Security Profile + JAR/JARM。否認防止が必要な決済・取引API向け。',
      targetAudience: '決済API、株式取引API、契約締結システム',
      securityTier: 'regulated',
      defaults: {
        ...T,
        oauth: {
          ...T.oauth,
          pkceRequirement: 'required',
          parRequirement: 'required',
          jarmEnabled: true,
          jarEnabled: true,
          maxAuthCodeTtl: 60,
          allowedResponseTypes: ['code'],
          refreshTokenRotation: true,
        },
        security: {
          ...T.security,
          tier: 'regulated',
          mfa: { ...T.security.mfa, requirement: 'required' },
        },
        authMethods: { ...AUTH_STD, externalIdp: 'disabled', did: 'enabled' },
        consent: { ...T.consent, thirdPartyDefault: 'always' },
        externalIdp: { ...T.externalIdp, enabled: false },
        credentials: {
          ...T.credentials,
          allowedClientAuthMethods: ['private_key_jwt', 'tls_client_auth'],
          publicClientsAllowed: false,
        },
        audit: { ...T.audit, detailLevel: 'detailed', flowReplayEnabled: true },
      },
    });
    expect(p.defaults.oauth?.jarmEnabled).toBe(true);
    expect(p.defaults.oauth?.jarEnabled).toBe(true);
    expect(p.defaults.consent?.thirdPartyDefault).toBe('always');
    expect(p.defaults.externalIdp?.enabled).toBe(false);
    expect(p.defaults.audit?.flowReplayEnabled).toBe(true);
  });

  it('regulated-finance', () => {
    const p = tenantPreset('regulated-finance');
    expect(p).toEqual({
      id: 'regulated-finance',
      name: '金融規制対応',
      description: 'PCI-DSS、SOX等の金融規制に準拠。最高レベルのセキュリティ。',
      targetAudience: '金融機関、フィンテック企業',
      securityTier: 'regulated',
      defaults: {
        ...T,
        oauth: {
          ...T.oauth,
          pkceRequirement: 'required',
          parRequirement: 'required',
          maxAccessTokenExpiry: 900,
        },
        session: { ...T.session, maxSessionAge: 14400, idleTimeout: 900 },
        security: {
          ...T.security,
          tier: 'regulated',
          complianceModules: ['pci-dss'],
          mfa: { ...T.security.mfa, requirement: 'required', allowedMethods: ['totp', 'passkey'] },
        },
        encryption: { ...T.encryption, piiEncryptionRequired: true },
        authMethods: {
          passkey: 'required',
          emailCode: 'enabled',
          password: 'disabled',
          externalIdp: 'disabled',
          did: 'enabled',
        },
        consent: { ...T.consent, thirdPartyDefault: 'always' },
        externalIdp: { ...T.externalIdp, enabled: false },
        rateLimit: { ...T.rateLimit, loginAttemptsPerMinute: 5 },
        credentials: {
          ...T.credentials,
          clientSecretRotationRequired: true,
          maxClientSecretAgeDays: 90,
        },
        dataResidency: { ...T.dataResidency, enabled: true },
        audit: {
          ...T.audit,
          retentionDays: 2555,
          detailLevel: 'detailed',
          flowReplayEnabled: true,
        },
      },
    });
    expect(p.defaults.security?.complianceModules).toEqual(['pci-dss']);
    expect(p.defaults.security?.mfa.allowedMethods).toEqual(['totp', 'passkey']);
    expect(p.defaults.oauth?.maxAccessTokenExpiry).toBe(900);
    expect(p.defaults.rateLimit?.loginAttemptsPerMinute).toBe(5);
    expect(p.defaults.audit?.retentionDays).toBe(2555);
  });

  it('regulated-healthcare', () => {
    const p = tenantPreset('regulated-healthcare');
    expect(p).toEqual({
      id: 'regulated-healthcare',
      name: '医療規制対応',
      description: 'HIPAA等の医療規制に準拠。PHI保護に最適化。',
      targetAudience: '医療機関、ヘルスケア企業',
      securityTier: 'regulated',
      defaults: {
        ...T,
        oauth: { ...T.oauth, pkceRequirement: 'required', maxAccessTokenExpiry: 1800 },
        session: { ...T.session, maxSessionAge: 28800, idleTimeout: 1800 },
        security: {
          ...T.security,
          tier: 'regulated',
          complianceModules: ['hipaa'],
          mfa: { ...T.security.mfa, requirement: 'required' },
        },
        encryption: { ...T.encryption, piiEncryptionRequired: true },
        authMethods: { ...AUTH_STD, externalIdp: 'disabled', did: 'disabled' },
        consent: { ...T.consent, thirdPartyDefault: 'always' },
        externalIdp: { ...T.externalIdp, enabled: false },
        dataResidency: { ...T.dataResidency, enabled: true, piiStoragePolicy: 'local_only' },
        audit: { ...T.audit, retentionDays: 2190, detailLevel: 'detailed' },
      },
    });
    expect(p.defaults.security?.complianceModules).toEqual(['hipaa']);
    expect(p.defaults.dataResidency?.piiStoragePolicy).toBe('local_only');
    expect(p.defaults.audit?.retentionDays).toBe(2190);
  });

  it('high-security', () => {
    const p = tenantPreset('high-security');
    expect(p).toEqual({
      id: 'high-security',
      name: '高セキュリティ',
      description: '機密性の高いシステム向け。パスキー必須、短期トークン。',
      targetAudience: '重要インフラ、機密データを扱う企業システム',
      securityTier: 'regulated',
      defaults: {
        ...T,
        oauth: {
          ...T.oauth,
          pkceRequirement: 'required',
          parRequirement: 'required',
          jarmEnabled: true,
          maxAccessTokenExpiry: 300,
        },
        session: { ...T.session, maxSessionAge: 3600, idleTimeout: 300 },
        security: {
          ...T.security,
          tier: 'regulated',
          mfa: { ...T.security.mfa, requirement: 'required', allowedMethods: ['passkey'] },
        },
        encryption: { ...T.encryption, piiEncryptionRequired: true },
        authMethods: {
          passkey: 'required',
          emailCode: 'disabled',
          password: 'disabled',
          externalIdp: 'disabled',
          did: 'enabled',
        },
        consent: { ...T.consent, thirdPartyDefault: 'always' },
        externalIdp: { ...T.externalIdp, enabled: false },
        rateLimit: { ...T.rateLimit, loginAttemptsPerMinute: 3 },
        credentials: {
          ...T.credentials,
          clientSecretRotationRequired: true,
          maxClientSecretAgeDays: 30,
        },
        dataResidency: { ...T.dataResidency, enabled: true, piiStoragePolicy: 'local_only' },
        audit: {
          ...T.audit,
          retentionDays: 3650,
          detailLevel: 'detailed',
          flowReplayEnabled: true,
        },
      },
    });
    expect(p.defaults.security?.mfa.allowedMethods).toEqual(['passkey']);
    expect(p.defaults.rateLimit?.loginAttemptsPerMinute).toBe(3);
    expect(p.defaults.audit?.retentionDays).toBe(3650);
  });

  it('custom has empty defaults', () => {
    expect(tenantPreset('custom')).toEqual({
      id: 'custom',
      name: 'カスタム',
      description: '完全にカスタマイズ可能な設定。',
      targetAudience: '特殊要件を持つ組織',
      securityTier: 'standard',
      defaults: {},
    });
  });
});

describe('CLIENT_PROFILE_PRESETS', () => {
  it('spa-public', () => {
    expect(clientPreset('spa-public')).toEqual({
      id: 'spa-public',
      name: 'SPA (パブリック)',
      description:
        'シングルページアプリケーション向け。PKCEを使用したセキュアなパブリッククライアント。',
      clientType: 'public',
      defaults: {
        ...C,
        clientType: { ...C.clientType, type: 'public' },
        oauth: { ...C.oauth, pkceRequired: true },
        redirect: { ...C.redirect, allowLocalhost: true },
      },
    });
  });

  it('mobile-native', () => {
    const p = clientPreset('mobile-native');
    expect(p).toEqual({
      id: 'mobile-native',
      name: 'モバイルネイティブ',
      description: 'iOS/Androidネイティブアプリ向け。ディープリンク対応。',
      clientType: 'public',
      defaults: {
        ...C,
        clientType: { ...C.clientType, type: 'public' },
        oauth: { ...C.oauth, pkceRequired: true, refreshTokenExpiry: 7776000 },
        scopes: {
          ...C.scopes,
          allowedScopes: ['openid', 'profile', 'email', 'offline_access'],
        },
        authMethods: { ...C.authMethods, passkey: true },
        consent: { ...C.consent, policy: 'remember' },
      },
    });
    expect(p.defaults.scopes?.allowedScopes).toEqual([
      'openid',
      'profile',
      'email',
      'offline_access',
    ]);
  });

  it('server-confidential', () => {
    expect(clientPreset('server-confidential')).toEqual({
      id: 'server-confidential',
      name: 'サーバーサイド',
      description: 'バックエンドサーバーアプリケーション向け。機密クライアント認証。',
      clientType: 'confidential',
      defaults: {
        ...C,
        clientType: {
          ...C.clientType,
          type: 'confidential',
          authenticationMethod: 'client_secret_basic',
        },
      },
    });
  });

  it('first-party-web', () => {
    expect(clientPreset('first-party-web')).toEqual({
      id: 'first-party-web',
      name: 'ファーストパーティWeb',
      description: '自社Webアプリケーション向け。同意画面スキップ可能。',
      clientType: 'confidential',
      defaults: {
        ...C,
        clientType: { ...C.clientType, type: 'confidential', isFirstParty: true },
        consent: { ...C.consent, policy: 'skip' },
      },
    });
  });

  it('first-party-mobile', () => {
    const p = clientPreset('first-party-mobile');
    expect(p).toEqual({
      id: 'first-party-mobile',
      name: 'ファーストパーティモバイル',
      description: '自社モバイルアプリケーション向け。パスキー優先、同意スキップ。',
      clientType: 'public',
      defaults: {
        ...C,
        clientType: { ...C.clientType, type: 'public', isFirstParty: true },
        oauth: { ...C.oauth, pkceRequired: true, refreshTokenExpiry: 7776000 },
        scopes: {
          ...C.scopes,
          allowedScopes: ['openid', 'profile', 'email', 'offline_access'],
        },
        authMethods: { ...C.authMethods, preferredMethod: 'passkey' },
        consent: { ...C.consent, policy: 'skip' },
      },
    });
    expect(p.defaults.scopes?.allowedScopes).toHaveLength(4);
  });

  it('m2m-service', () => {
    const p = clientPreset('m2m-service');
    expect(p).toEqual({
      id: 'm2m-service',
      name: 'M2M (マシン間)',
      description: 'サービス間通信向け。client_credentialsグラント。',
      clientType: 'confidential',
      defaults: {
        ...C,
        clientType: {
          ...C.clientType,
          type: 'confidential',
          authenticationMethod: 'client_secret_basic',
        },
        oauth: { ...C.oauth, allowedGrantTypes: ['client_credentials'], allowedResponseTypes: [] },
        scopes: { ...C.scopes, defaultScopes: [] },
        authMethods: {
          passkey: false,
          emailCode: false,
          password: false,
          externalIdp: false,
          did: false,
        },
        consent: { ...C.consent, policy: 'skip' },
        redirect: { ...C.redirect, allowedRedirectUris: [] },
      },
    });
    expect(p.defaults.oauth?.allowedGrantTypes).toEqual(['client_credentials']);
    expect(p.defaults.oauth?.allowedResponseTypes).toEqual([]);
  });

  it('iot-device', () => {
    const p = clientPreset('iot-device');
    expect(p).toEqual({
      id: 'iot-device',
      name: 'IoTデバイス',
      description: 'IoTデバイス向け。デバイスフロー対応。',
      clientType: 'public',
      defaults: {
        ...C,
        clientType: { ...C.clientType, type: 'public' },
        oauth: {
          ...C.oauth,
          allowedGrantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
        },
        scopes: { ...C.scopes, allowedScopes: ['openid', 'offline_access'] },
        consent: { ...C.consent, policy: 'always' },
        redirect: { ...C.redirect, allowedRedirectUris: [] },
      },
    });
    expect(p.defaults.scopes?.allowedScopes).toEqual(['openid', 'offline_access']);
  });

  it('custom has empty defaults', () => {
    expect(clientPreset('custom')).toEqual({
      id: 'custom',
      name: 'カスタム',
      description: '完全にカスタマイズ可能な設定。',
      clientType: 'public',
      defaults: {},
    });
  });
});
