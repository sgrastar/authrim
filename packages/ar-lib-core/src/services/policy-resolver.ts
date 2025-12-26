/**
 * Policy Resolver Service
 *
 * Resolves TenantContract + ClientContract into ResolvedPolicy.
 * This service is responsible for:
 * 1. Merging tenant policy with client profile
 * 2. Validating client settings against tenant constraints
 * 3. Validating flows against resolved policies
 * 4. Providing available options for flow designer
 *
 * Resolution Strategy:
 * - Tenant Policy defines constraints (maximums, allowed values)
 * - Client Profile selects values within those constraints
 * - ResolvedPolicy is the effective runtime configuration
 */

import type {
  TenantContract,
  TenantOAuthPolicy,
  TenantSecurityPolicy,
  TenantAuthMethodPolicy,
  TenantScopePolicy,
  TenantConsentPolicy,
  TenantEncryptionPolicy,
  TenantSessionPolicy,
} from '../types/contracts/tenant';
import type {
  ClientContract,
  ClientOAuthConfig,
  ClientAuthMethodConfig,
  ClientScopeConfig,
  ClientConsentConfig,
  ClientEncryptionConfig,
} from '../types/contracts/client';
import type {
  ResolvedPolicy,
  EffectiveOAuthSettings,
  EffectiveEncryptionSettings,
  EffectiveSessionSettings,
  EffectiveConsentSettings,
  EffectiveAuthMethodSettings,
  EffectiveMfaSettings,
  EffectiveScopeSettings,
  EffectiveSecuritySettings,
  FlowConstraints,
  AvailableCapability,
  ForbiddenCapability,
  RequiredCapability,
  ResolvedClientInfo,
} from '../types/contracts/resolved';
import type {
  PolicyResolver,
  PolicyResolutionOptions,
  PolicyResolutionResult,
  PolicyResolutionSuccess,
  PolicyResolutionFailure,
  PolicyResolutionDebug,
  PolicyResolutionStep,
  ContractValidationResult,
  FlowPolicyValidationResult,
  PolicyViolation,
  FlowDesignerOptions,
  AuthMethodOption,
  CapabilityOption,
  ScopeOption,
  RequiredNode,
  ForbiddenNode,
  SecurityConstraint,
  PolicyChangeImpact,
  BreakingChange,
  AffectedClientSummary,
} from '../types/contracts/resolver';
import type { ContractError, ContractWarning } from '../types/contracts/errors';
import { CONTRACT_ERROR_CODES } from '../types/contracts/errors';
import type { SigningAlgorithm, GrantType } from '../types/contracts';

// =============================================================================
// Constants
// =============================================================================

/** Default cache TTL for resolved policies (5 minutes) */
const DEFAULT_CACHE_TTL_SECONDS = 300;

/** Cache key prefix for policies */
const POLICY_CACHE_PREFIX = 'resolved_policy:';

// =============================================================================
// Policy Resolver Implementation
// =============================================================================

/**
 * Policy Resolver Service
 *
 * Implements the PolicyResolver interface for runtime policy resolution.
 */
export class PolicyResolverService implements PolicyResolver {
  private cache?: KVNamespace;
  private cacheTtl: number;

  constructor(cache?: KVNamespace, cacheTtlSeconds?: number) {
    this.cache = cache;
    this.cacheTtl = cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
  }

  // ===========================================================================
  // Main Resolution Method
  // ===========================================================================

  /**
   * Resolve policy from tenant and client contracts.
   */
  async resolve(
    tenant: TenantContract,
    client: ClientContract,
    options?: PolicyResolutionOptions
  ): Promise<PolicyResolutionResult> {
    const startTime = Date.now();
    const steps: PolicyResolutionStep[] = [];
    const warnings: ContractWarning[] = [];

    try {
      // Check cache first
      if (options?.useCache !== false && this.cache) {
        const cacheKey = this.buildCacheKey(tenant, client);
        const cached = await this.getCachedPolicy(cacheKey);
        if (cached && !options?.forceRefresh) {
          return {
            success: true,
            policy: cached,
            debug: options?.includeDebug
              ? {
                  steps: [],
                  durationMs: Date.now() - startTime,
                  cacheHit: true,
                  cacheKey,
                }
              : undefined,
          };
        }
      }

      // Step 1: Validate version compatibility
      const versionStep = this.validateVersions(tenant, client);
      steps.push(versionStep);
      if (!versionStep.output.valid) {
        return this.createFailure('VERSION_MISMATCH', versionStep.output.error as string);
      }

      // Step 2: Resolve OAuth settings
      const oauthStep = this.resolveOAuthSettings(tenant.oauth, client.oauth, warnings);
      steps.push(oauthStep);

      // Step 3: Resolve encryption settings
      const encryptionStep = this.resolveEncryptionSettings(
        tenant.encryption,
        client.encryption,
        client.oauth.idTokenSigningAlg,
        warnings
      );
      steps.push(encryptionStep);

      // Step 4: Resolve session settings
      const sessionStep = this.resolveSessionSettings(tenant.session, warnings);
      steps.push(sessionStep);

      // Step 5: Resolve consent settings
      const consentStep = this.resolveConsentSettings(
        tenant.consent,
        client.consent,
        client.clientType.isFirstParty,
        warnings
      );
      steps.push(consentStep);

      // Step 6: Resolve auth methods
      const authMethodsStep = this.resolveAuthMethods(
        tenant.authMethods,
        client.authMethods,
        warnings
      );
      steps.push(authMethodsStep);

      // Step 7: Resolve MFA settings
      const mfaStep = this.resolveMfaSettings(tenant.security, warnings);
      steps.push(mfaStep);

      // Step 8: Resolve scopes
      const scopesStep = this.resolveScopeSettings(tenant.scopes, client.scopes, warnings);
      steps.push(scopesStep);

      // Step 9: Resolve security settings
      const securityStep = this.resolveSecuritySettings(tenant, client, warnings);
      steps.push(securityStep);

      // Step 10: Resolve flow constraints
      const flowConstraintsStep = this.resolveFlowConstraints(tenant, warnings);
      steps.push(flowConstraintsStep);

      // Build resolved policy
      const policy: ResolvedPolicy = {
        resolutionId: this.generateResolutionId(tenant, client),
        resolvedAt: new Date().toISOString(),
        tenantPolicyVersion: tenant.version,
        clientProfileVersion: client.version,
        tenantId: tenant.tenantId,
        clientId: client.clientId,
        oauth: oauthStep.output.settings as EffectiveOAuthSettings,
        encryption: encryptionStep.output.settings as EffectiveEncryptionSettings,
        session: sessionStep.output.settings as EffectiveSessionSettings,
        consent: consentStep.output.settings as EffectiveConsentSettings,
        authMethods: authMethodsStep.output.settings as EffectiveAuthMethodSettings,
        mfa: mfaStep.output.settings as EffectiveMfaSettings,
        scopes: scopesStep.output.settings as EffectiveScopeSettings,
        security: securityStep.output.settings as EffectiveSecuritySettings,
        flowConstraints: flowConstraintsStep.output.settings as FlowConstraints,
        clientInfo: this.buildClientInfo(client),
      };

      // Cache the result
      if (this.cache) {
        const cacheKey = this.buildCacheKey(tenant, client);
        await this.cachePolicy(cacheKey, policy);
      }

      const result: PolicyResolutionSuccess = {
        success: true,
        policy,
        warnings: warnings.length > 0 ? warnings : undefined,
      };

      if (options?.includeDebug) {
        result.debug = {
          steps,
          durationMs: Date.now() - startTime,
          cacheHit: false,
        };
      }

      return result;
    } catch (error) {
      return this.createFailure(
        'RESOLUTION_FAILED',
        error instanceof Error ? error.message : 'Unknown error during resolution'
      );
    }
  }

  // ===========================================================================
  // Validation Methods
  // ===========================================================================

  /**
   * Validate client contract against tenant contract.
   */
  async validateClientAgainstTenant(
    tenant: TenantContract,
    client: ClientContract
  ): Promise<ContractValidationResult> {
    const errors: ContractError[] = [];
    const warnings: ContractWarning[] = [];
    const validatedFields: string[] = [];
    const skippedFields: string[] = [];

    // Validate OAuth settings
    this.validateOAuthAgainstTenant(tenant.oauth, client.oauth, errors, validatedFields);

    // Validate encryption settings
    this.validateEncryptionAgainstTenant(
      tenant.encryption,
      client.oauth.idTokenSigningAlg,
      errors,
      validatedFields
    );

    // Validate scope settings
    this.validateScopesAgainstTenant(tenant.scopes, client.scopes, errors, validatedFields);

    // Validate auth methods
    this.validateAuthMethodsAgainstTenant(
      tenant.authMethods,
      client.authMethods,
      errors,
      validatedFields
    );

    // Validate consent settings
    this.validateConsentAgainstTenant(tenant.consent, client.consent, errors, validatedFields);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      validatedFields,
      skippedFields,
    };
  }

  /**
   * Validate a flow against resolved policy.
   */
  async validateFlowAgainstPolicy(
    policy: ResolvedPolicy,
    _flowId: string
  ): Promise<FlowPolicyValidationResult> {
    const violations: PolicyViolation[] = [];
    const warnings: { type: string; nodeId?: string; message: string; suggestion?: string }[] = [];

    // Note: Full implementation requires access to flow definitions
    // This validates against the policy constraints

    return {
      valid: violations.length === 0,
      violations,
      warnings,
    };
  }

  /**
   * Get available options for flow designer based on policy.
   */
  async getAvailableOptions(policy: ResolvedPolicy): Promise<FlowDesignerOptions> {
    const availableAuthMethods: AuthMethodOption[] = [];
    const availableCapabilities: CapabilityOption[] = [];
    const availableScopes: ScopeOption[] = [];
    const requiredNodes: RequiredNode[] = [];
    const forbiddenNodes: ForbiddenNode[] = [];
    const securityConstraints: SecurityConstraint[] = [];

    // Build auth method options
    const authMethods = policy.authMethods;
    availableAuthMethods.push({
      id: 'passkey',
      displayName: 'パスキー（指紋・顔認証）',
      available: authMethods.passkey,
      required: authMethods.preferred === 'passkey',
      priority: authMethods.preferred === 'passkey' ? 1 : 5,
    });
    availableAuthMethods.push({
      id: 'emailCode',
      displayName: 'メール認証コード',
      available: authMethods.emailCode,
      required: false,
      priority: authMethods.preferred === 'emailCode' ? 1 : 4,
    });
    availableAuthMethods.push({
      id: 'password',
      displayName: 'パスワード',
      available: authMethods.password,
      required: false,
      priority: authMethods.preferred === 'password' ? 1 : 3,
    });
    availableAuthMethods.push({
      id: 'externalIdp',
      displayName: 'ソーシャルログイン / SSO',
      available: authMethods.externalIdp,
      required: false,
      priority: authMethods.preferred === 'externalIdp' ? 1 : 2,
    });
    availableAuthMethods.push({
      id: 'did',
      displayName: '分散型ID',
      available: authMethods.did,
      required: false,
      priority: authMethods.preferred === 'did' ? 1 : 6,
    });

    // Build capability options from flow constraints
    for (const cap of policy.flowConstraints.availableCapabilities) {
      availableCapabilities.push({
        type: cap.type,
        displayName: cap.displayName,
        available: true,
        category: cap.category,
      });
    }

    for (const cap of policy.flowConstraints.forbiddenCapabilities) {
      forbiddenNodes.push({
        type: cap.type,
        reason: cap.reason,
        source: cap.source,
      });
    }

    for (const cap of policy.flowConstraints.requiredCapabilities) {
      // Filter to only supported source types for RequiredNode
      const source = cap.source === 'compliance' ? 'tenant' : cap.source;
      requiredNodes.push({
        type: cap.type,
        reason: cap.reason,
        source,
      });
    }

    // Build scope options
    for (const scope of policy.scopes.available) {
      availableScopes.push({
        name: scope,
        displayName: this.getScopeDisplayName(scope),
        available: true,
        default: policy.scopes.default.includes(scope),
        requiresConsent: !policy.consent.implicitScopes.includes(scope),
      });
    }

    // Build security constraints
    securityConstraints.push({
      type: 'pkce_required',
      enforced: policy.security.pkceRequired,
      reason: policy.security.pkceRequired ? 'セキュリティポリシーでPKCE必須' : undefined,
    });
    securityConstraints.push({
      type: 'par_required',
      enforced: policy.security.parRequired,
      reason: policy.security.parRequired ? 'セキュリティポリシーでPAR必須' : undefined,
    });
    securityConstraints.push({
      type: 'mfa_required',
      enforced: policy.mfa.required,
      reason: policy.mfa.required ? 'MFA必須が設定されています' : undefined,
    });

    return {
      availableAuthMethods,
      availableCapabilities,
      availableScopes,
      requiredNodes,
      forbiddenNodes,
      securityConstraints,
    };
  }

  /**
   * Preview the impact of a policy change.
   */
  async previewPolicyChange(
    _currentPolicy: ResolvedPolicy,
    _proposedChanges: Partial<TenantContract | ClientContract>
  ): Promise<PolicyChangeImpact> {
    const breakingChanges: BreakingChange[] = [];
    const affectedClients: AffectedClientSummary[] = [];
    const warnings: string[] = [];
    const recommendations: string[] = [];

    // Note: Full implementation requires database access
    return {
      safe: breakingChanges.length === 0,
      breakingChanges,
      affectedClients,
      estimatedAffectedUsers: 0,
      warnings,
      recommendations,
    };
  }

  // ===========================================================================
  // Resolution Helper Methods
  // ===========================================================================

  private validateVersions(tenant: TenantContract, client: ClientContract): PolicyResolutionStep {
    const startTime = Date.now();
    const valid = client.tenantContractVersion <= tenant.version;

    return {
      step: 'validateVersions',
      input: {
        tenantVersion: tenant.version,
        clientTenantVersion: client.tenantContractVersion,
      },
      output: {
        valid,
        error: valid
          ? undefined
          : `Client references tenant version ${client.tenantContractVersion} but current is ${tenant.version}`,
      },
      durationMs: Date.now() - startTime,
      changed: false,
    };
  }

  private resolveOAuthSettings(
    tenant: TenantOAuthPolicy,
    client: ClientOAuthConfig,
    warnings: ContractWarning[]
  ): PolicyResolutionStep {
    const startTime = Date.now();

    const idTokenSigningAlg = tenant.allowedIdTokenSigningAlgs.includes(client.idTokenSigningAlg)
      ? client.idTokenSigningAlg
      : (tenant.allowedIdTokenSigningAlgs[0] as SigningAlgorithm);

    const settings: EffectiveOAuthSettings = {
      accessTokenExpiry: Math.min(client.accessTokenExpiry, tenant.maxAccessTokenExpiry),
      refreshTokenExpiry: Math.min(client.refreshTokenExpiry, tenant.maxRefreshTokenExpiry),
      idTokenExpiry: Math.min(client.idTokenExpiry, tenant.maxIdTokenExpiry),
      authCodeTtl: Math.min(client.authCodeTtl ?? 600, tenant.maxAuthCodeTtl),
      idTokenSigningAlg,
      allowedResponseTypes: client.allowedResponseTypes.filter((rt) =>
        tenant.allowedResponseTypes.includes(rt)
      ) as ('code' | 'token' | 'id_token')[],
      allowedGrantTypes: client.allowedGrantTypes as GrantType[],
      pkceRequired:
        tenant.pkceRequirement === 'required' ||
        client.pkceRequired ||
        tenant.pkceRequirement === 'recommended',
      parRequired: tenant.parRequirement === 'required' || client.parRequired,
      jarmEnabled: tenant.jarmEnabled,
      refreshTokenRotation: client.refreshTokenRotation ?? tenant.refreshTokenRotation,
      refreshIdTokenReissue: client.refreshIdTokenReissue ?? tenant.refreshIdTokenReissue,
      accessTokenFormat: 'jwt',
      idTokenAudFormat: 'array',
    };

    if (client.accessTokenExpiry > tenant.maxAccessTokenExpiry) {
      warnings.push({
        code: 'OAUTH_EXPIRY_CAPPED',
        message: `Access token expiry capped from ${client.accessTokenExpiry} to ${tenant.maxAccessTokenExpiry}`,
        field: 'oauth.accessTokenExpiry',
        severity: 'warning',
      });
    }

    return {
      step: 'resolveOAuthSettings',
      input: { tenant, client },
      output: { settings },
      durationMs: Date.now() - startTime,
      changed: true,
    };
  }

  private resolveEncryptionSettings(
    tenant: TenantEncryptionPolicy,
    client: ClientEncryptionConfig,
    clientSigningAlg: string,
    _warnings: ContractWarning[]
  ): PolicyResolutionStep {
    const startTime = Date.now();

    const signingAlg = tenant.allowedSigningAlgorithms.includes(
      clientSigningAlg as SigningAlgorithm
    )
      ? (clientSigningAlg as SigningAlgorithm)
      : tenant.allowedSigningAlgorithms[0];

    const settings: EffectiveEncryptionSettings = {
      signingAlgorithm: signingAlg,
      keyEncryptionAlg:
        client.keyEncryptionAlg &&
        tenant.allowedKeyEncryptionAlgorithms.includes(client.keyEncryptionAlg)
          ? client.keyEncryptionAlg
          : undefined,
      contentEncryptionAlg:
        client.contentEncryptionAlg &&
        tenant.allowedContentEncryptionAlgorithms.includes(client.contentEncryptionAlg)
          ? client.contentEncryptionAlg
          : undefined,
      encryptIdToken: client.encryptIdToken,
      encryptUserInfo: client.encryptUserInfo,
      piiEncryptionRequired: tenant.piiEncryptionRequired,
    };

    return {
      step: 'resolveEncryptionSettings',
      input: { tenant, client },
      output: { settings },
      durationMs: Date.now() - startTime,
      changed: true,
    };
  }

  private resolveSessionSettings(
    tenant: TenantSessionPolicy,
    _warnings: ContractWarning[]
  ): PolicyResolutionStep {
    const startTime = Date.now();

    const settings: EffectiveSessionSettings = {
      maxSessionAge: tenant.maxSessionAge,
      idleTimeout: tenant.idleTimeout,
      maxConcurrentSessions: tenant.maxConcurrentSessions,
      slidingSessionEnabled: tenant.slidingSessionEnabled,
    };

    return {
      step: 'resolveSessionSettings',
      input: { tenant },
      output: { settings },
      durationMs: Date.now() - startTime,
      changed: true,
    };
  }

  private resolveConsentSettings(
    tenant: TenantConsentPolicy,
    client: ClientConsentConfig,
    isFirstParty: boolean,
    _warnings: ContractWarning[]
  ): PolicyResolutionStep {
    const startTime = Date.now();

    const rememberDuration = Math.min(
      client.rememberDuration ?? tenant.maxRememberDuration,
      tenant.maxRememberDuration
    );

    const settings: EffectiveConsentSettings = {
      policy: client.policy,
      rememberDuration,
      implicitScopes: client.implicitScopes ?? [],
      allowGranularConsent: client.allowGranularConsent,
      isFirstParty,
    };

    return {
      step: 'resolveConsentSettings',
      input: { tenant, client },
      output: { settings },
      durationMs: Date.now() - startTime,
      changed: true,
    };
  }

  private resolveAuthMethods(
    tenant: TenantAuthMethodPolicy,
    client: ClientAuthMethodConfig,
    warnings: ContractWarning[]
  ): PolicyResolutionStep {
    const startTime = Date.now();

    const settings: EffectiveAuthMethodSettings = {
      passkey: (tenant.passkey === 'enabled' || tenant.passkey === 'required') && client.passkey,
      emailCode:
        (tenant.emailCode === 'enabled' || tenant.emailCode === 'required') && client.emailCode,
      password:
        (tenant.password === 'enabled' || tenant.password === 'required') && client.password,
      externalIdp:
        (tenant.externalIdp === 'enabled' || tenant.externalIdp === 'required') &&
        client.externalIdp,
      did: (tenant.did === 'enabled' || tenant.did === 'required') && client.did,
      preferred: client.preferredMethod,
      availableExternalIdpIds: client.allowedExternalIdpIds,
    };

    if (client.passkey && tenant.passkey === 'disabled') {
      warnings.push({
        code: 'AUTH_METHOD_DISABLED',
        message: 'Passkey is disabled at tenant level',
        field: 'authMethods.passkey',
        severity: 'warning',
      });
    }

    return {
      step: 'resolveAuthMethods',
      input: { tenant, client },
      output: { settings },
      durationMs: Date.now() - startTime,
      changed: true,
    };
  }

  private resolveMfaSettings(
    tenantSecurity: TenantSecurityPolicy,
    _warnings: ContractWarning[]
  ): PolicyResolutionStep {
    const startTime = Date.now();

    const settings: EffectiveMfaSettings = {
      required: tenantSecurity.mfa.requirement === 'required',
      conditional: tenantSecurity.mfa.requirement === 'conditional',
      availableMethods: tenantSecurity.mfa.allowedMethods,
      canRemember: tenantSecurity.mfa.rememberDurationMax > 0,
      rememberDuration: tenantSecurity.mfa.rememberDurationMax,
    };

    return {
      step: 'resolveMfaSettings',
      input: { tenantSecurity: tenantSecurity.mfa },
      output: { settings },
      durationMs: Date.now() - startTime,
      changed: true,
    };
  }

  private resolveScopeSettings(
    tenant: TenantScopePolicy,
    client: ClientScopeConfig,
    warnings: ContractWarning[]
  ): PolicyResolutionStep {
    const startTime = Date.now();

    const available = client.allowedScopes.filter(
      (scope) => tenant.allowedScopes.includes(scope) && !tenant.forbiddenScopes.includes(scope)
    );

    const defaultScopes = client.defaultScopes.filter((scope) => available.includes(scope));

    const settings: EffectiveScopeSettings = {
      available,
      default: defaultScopes,
      dynamicAllowed: client.allowDynamicScopes,
    };

    const filteredFromClient = client.allowedScopes.filter((s) => !available.includes(s));
    if (filteredFromClient.length > 0) {
      warnings.push({
        code: 'SCOPES_FILTERED',
        message: `Scopes filtered by tenant policy: ${filteredFromClient.join(', ')}`,
        field: 'scopes.allowedScopes',
        severity: 'info',
      });
    }

    return {
      step: 'resolveScopeSettings',
      input: { tenant, client },
      output: { settings },
      durationMs: Date.now() - startTime,
      changed: true,
    };
  }

  private resolveSecuritySettings(
    tenant: TenantContract,
    client: ClientContract,
    _warnings: ContractWarning[]
  ): PolicyResolutionStep {
    const startTime = Date.now();

    const settings: EffectiveSecuritySettings = {
      tier: tenant.security.tier,
      pkceRequired: tenant.oauth.pkceRequirement === 'required' || client.oauth.pkceRequired,
      parRequired: tenant.oauth.parRequirement === 'required' || client.oauth.parRequired,
      clientType: client.clientType.type,
      loginAttemptsPerMinute: tenant.rateLimit.loginAttemptsPerMinute,
      tokenRequestsPerMinute: tenant.rateLimit.tokenRequestsPerMinute,
    };

    return {
      step: 'resolveSecuritySettings',
      input: { tenantSecurity: tenant.security, tenantRateLimit: tenant.rateLimit },
      output: { settings },
      durationMs: Date.now() - startTime,
      changed: true,
    };
  }

  private resolveFlowConstraints(
    tenant: TenantContract,
    _warnings: ContractWarning[]
  ): PolicyResolutionStep {
    const startTime = Date.now();

    const availableCapabilities: AvailableCapability[] = [];
    const forbiddenCapabilities: ForbiddenCapability[] = [];
    const requiredCapabilities: RequiredCapability[] = [];

    // Add auth method capabilities
    if (tenant.authMethods.passkey !== 'disabled') {
      availableCapabilities.push({
        type: 'capability.passkey',
        displayName: 'パスキー認証',
        category: 'authentication',
        oidcCore: false,
      });
    } else {
      forbiddenCapabilities.push({
        type: 'capability.passkey',
        reason: 'テナントポリシーで無効化されています',
        source: 'tenant',
      });
    }

    if (tenant.authMethods.emailCode !== 'disabled') {
      availableCapabilities.push({
        type: 'capability.email_code',
        displayName: 'メール認証コード',
        category: 'authentication',
        oidcCore: false,
      });
    } else {
      forbiddenCapabilities.push({
        type: 'capability.email_code',
        reason: 'テナントポリシーで無効化されています',
        source: 'tenant',
      });
    }

    if (tenant.authMethods.password !== 'disabled') {
      availableCapabilities.push({
        type: 'capability.password',
        displayName: 'パスワード認証',
        category: 'authentication',
        oidcCore: false,
      });
    } else {
      forbiddenCapabilities.push({
        type: 'capability.password',
        reason: 'テナントポリシーで無効化されています',
        source: 'tenant',
      });
    }

    if (tenant.authMethods.externalIdp !== 'disabled') {
      availableCapabilities.push({
        type: 'capability.external_idp',
        displayName: 'ソーシャルログイン',
        category: 'authentication',
        oidcCore: false,
      });
    } else {
      forbiddenCapabilities.push({
        type: 'capability.external_idp',
        reason: 'テナントポリシーで無効化されています',
        source: 'tenant',
      });
    }

    // Add MFA capabilities if enabled
    if (tenant.security.mfa.requirement !== 'disabled') {
      if (tenant.security.mfa.allowedMethods.includes('totp')) {
        availableCapabilities.push({
          type: 'capability.totp',
          displayName: 'TOTP (認証アプリ)',
          category: 'verification',
          oidcCore: false,
        });
      }
      if (tenant.security.mfa.allowedMethods.includes('passkey')) {
        availableCapabilities.push({
          type: 'capability.mfa_passkey',
          displayName: 'MFAパスキー',
          category: 'verification',
          oidcCore: false,
        });
      }
    }

    // Always available capabilities
    availableCapabilities.push({
      type: 'capability.consent',
      displayName: '同意画面',
      category: 'consent',
      oidcCore: false,
    });
    availableCapabilities.push({
      type: 'capability.user_registration',
      displayName: 'ユーザー登録',
      category: 'flow_control',
      oidcCore: false,
    });

    // OIDC Core capabilities (always available, read-only)
    availableCapabilities.push({
      type: 'oidc.authorize',
      displayName: '認可エンドポイント',
      category: 'oidc_core',
      oidcCore: true,
    });
    availableCapabilities.push({
      type: 'oidc.token',
      displayName: 'トークンエンドポイント',
      category: 'oidc_core',
      oidcCore: true,
    });

    // Add required capabilities based on policy
    if (tenant.security.mfa.requirement === 'required') {
      requiredCapabilities.push({
        type: 'mfa',
        reason: 'MFA必須ポリシー',
        source: 'tenant',
      });
    }

    const settings: FlowConstraints = {
      availableCapabilities,
      forbiddenCapabilities,
      requiredCapabilities,
      availableIntents: ['login', 'register', 'mfa', 'consent', 'logout'],
    };

    return {
      step: 'resolveFlowConstraints',
      input: { tenantAuthMethods: tenant.authMethods, tenantSecurity: tenant.security },
      output: { settings },
      durationMs: Date.now() - startTime,
      changed: true,
    };
  }

  private buildClientInfo(client: ClientContract): ResolvedClientInfo {
    return {
      clientId: client.clientId,
      displayName: client.metadata.notes,
      isFirstParty: client.clientType.isFirstParty,
      applicationType: client.clientType.type === 'public' ? 'spa' : 'web',
    };
  }

  // ===========================================================================
  // Validation Helper Methods
  // ===========================================================================

  private validateOAuthAgainstTenant(
    tenant: TenantOAuthPolicy,
    client: ClientOAuthConfig,
    errors: ContractError[],
    validatedFields: string[]
  ): void {
    validatedFields.push('oauth.accessTokenExpiry');
    if (client.accessTokenExpiry > tenant.maxAccessTokenExpiry) {
      errors.push({
        code: CONTRACT_ERROR_CODES.EXCEEDS_TENANT_MAX,
        message: `Access token expiry ${client.accessTokenExpiry} exceeds tenant max ${tenant.maxAccessTokenExpiry}`,
        category: 'validation',
        field: 'oauth.accessTokenExpiry',
      });
    }

    validatedFields.push('oauth.refreshTokenExpiry');
    if (client.refreshTokenExpiry > tenant.maxRefreshTokenExpiry) {
      errors.push({
        code: CONTRACT_ERROR_CODES.EXCEEDS_TENANT_MAX,
        message: `Refresh token expiry ${client.refreshTokenExpiry} exceeds tenant max ${tenant.maxRefreshTokenExpiry}`,
        category: 'validation',
        field: 'oauth.refreshTokenExpiry',
      });
    }

    validatedFields.push('oauth.idTokenSigningAlg');
    if (!tenant.allowedIdTokenSigningAlgs.includes(client.idTokenSigningAlg)) {
      errors.push({
        code: CONTRACT_ERROR_CODES.NOT_IN_TENANT_ALLOWED,
        message: `ID token signing algorithm ${client.idTokenSigningAlg} not in allowed list`,
        category: 'validation',
        field: 'oauth.idTokenSigningAlg',
      });
    }
  }

  private validateEncryptionAgainstTenant(
    tenant: TenantEncryptionPolicy,
    clientSigningAlg: string,
    errors: ContractError[],
    validatedFields: string[]
  ): void {
    validatedFields.push('oauth.idTokenSigningAlg');
    if (!tenant.allowedSigningAlgorithms.includes(clientSigningAlg as SigningAlgorithm)) {
      errors.push({
        code: CONTRACT_ERROR_CODES.NOT_IN_TENANT_ALLOWED,
        message: `Signing algorithm ${clientSigningAlg} not allowed`,
        category: 'validation',
        field: 'oauth.idTokenSigningAlg',
      });
    }
  }

  private validateScopesAgainstTenant(
    tenant: TenantScopePolicy,
    client: ClientScopeConfig,
    errors: ContractError[],
    validatedFields: string[]
  ): void {
    validatedFields.push('scopes.allowedScopes');

    const forbiddenUsed = client.allowedScopes.filter((s) => tenant.forbiddenScopes.includes(s));
    if (forbiddenUsed.length > 0) {
      errors.push({
        code: CONTRACT_ERROR_CODES.SCOPE_NOT_ALLOWED,
        message: `Forbidden scopes used: ${forbiddenUsed.join(', ')}`,
        category: 'validation',
        field: 'scopes.allowedScopes',
      });
    }

    const notAllowed = client.allowedScopes.filter(
      (s) => !tenant.allowedScopes.includes(s) && !forbiddenUsed.includes(s)
    );
    if (notAllowed.length > 0) {
      errors.push({
        code: CONTRACT_ERROR_CODES.SCOPE_NOT_ALLOWED,
        message: `Scopes not in tenant allowed list: ${notAllowed.join(', ')}`,
        category: 'validation',
        field: 'scopes.allowedScopes',
      });
    }
  }

  private validateAuthMethodsAgainstTenant(
    tenant: TenantAuthMethodPolicy,
    client: ClientAuthMethodConfig,
    errors: ContractError[],
    validatedFields: string[]
  ): void {
    const methods = ['passkey', 'emailCode', 'password', 'externalIdp', 'did'] as const;

    for (const method of methods) {
      validatedFields.push(`authMethods.${method}`);
      const tenantSetting = tenant[method];
      const clientSetting = client[method];

      if (clientSetting && tenantSetting === 'disabled') {
        errors.push({
          code: CONTRACT_ERROR_CODES.AUTH_METHOD_NOT_ALLOWED,
          message: `Auth method ${method} is disabled at tenant level`,
          category: 'validation',
          field: `authMethods.${method}`,
        });
      }
    }
  }

  private validateConsentAgainstTenant(
    tenant: TenantConsentPolicy,
    client: ClientConsentConfig,
    errors: ContractError[],
    validatedFields: string[]
  ): void {
    validatedFields.push('consent.rememberDuration');

    if ((client.rememberDuration ?? 0) > tenant.maxRememberDuration) {
      errors.push({
        code: CONTRACT_ERROR_CODES.EXCEEDS_TENANT_MAX,
        message: `Consent remember duration ${client.rememberDuration} exceeds tenant max ${tenant.maxRememberDuration}`,
        category: 'validation',
        field: 'consent.rememberDuration',
      });
    }
  }

  // ===========================================================================
  // Cache Methods
  // ===========================================================================

  private buildCacheKey(tenant: TenantContract, client: ClientContract): string {
    return `${POLICY_CACHE_PREFIX}${tenant.tenantId}:${client.clientId}:${tenant.version}:${client.version}`;
  }

  private async getCachedPolicy(key: string): Promise<ResolvedPolicy | null> {
    if (!this.cache) return null;

    try {
      const cached = await this.cache.get(key, 'json');
      return cached as ResolvedPolicy | null;
    } catch {
      return null;
    }
  }

  private async cachePolicy(key: string, policy: ResolvedPolicy): Promise<void> {
    if (!this.cache) return;

    try {
      await this.cache.put(key, JSON.stringify(policy), {
        expirationTtl: this.cacheTtl,
      });
    } catch {
      // Ignore cache errors
    }
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  private generateResolutionId(tenant: TenantContract, client: ClientContract): string {
    const input = `${tenant.tenantId}:${client.clientId}:${tenant.version}:${client.version}:${Date.now()}`;
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return `res_${Math.abs(hash).toString(36)}`;
  }

  private createFailure(
    errorCode: keyof typeof CONTRACT_ERROR_CODES,
    message: string
  ): PolicyResolutionFailure {
    return {
      success: false,
      error: {
        code: CONTRACT_ERROR_CODES[errorCode],
        message,
        category: 'resolution',
      },
    };
  }

  private getScopeDisplayName(scope: string): string {
    const displayNames: Record<string, string> = {
      openid: '基本情報',
      profile: 'プロフィール情報',
      email: 'メールアドレス',
      phone: '電話番号',
      address: '住所',
      offline_access: 'オフラインアクセス',
    };
    return displayNames[scope] ?? scope;
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new PolicyResolver instance.
 */
export function createPolicyResolver(
  cache?: KVNamespace,
  cacheTtlSeconds?: number
): PolicyResolver {
  return new PolicyResolverService(cache, cacheTtlSeconds);
}
