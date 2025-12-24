/**
 * Capability Registry
 *
 * Central registry for plugin capabilities. Plugins register their handlers
 * here during initialization, and the application retrieves them when needed.
 */

import type {
  PluginCapability,
  NotifierHandler,
  Notification,
  SendResult,
  NotificationOptions,
} from './types';

// =============================================================================
// IdP Handler Types
// =============================================================================

/**
 * Identity Provider handler interface
 */
export interface IdPHandler {
  /** Get authorization URL */
  getAuthorizationUrl(params: IdPAuthParams): Promise<string>;

  /** Exchange code for tokens */
  exchangeCode(code: string, params: IdPExchangeParams): Promise<IdPTokenResult>;

  /** Get user info from tokens */
  getUserInfo(accessToken: string): Promise<IdPUserInfo>;

  /** Validate ID token (optional) */
  validateIdToken?(idToken: string): Promise<IdPClaims>;
}

export interface IdPAuthParams {
  redirectUri: string;
  state: string;
  nonce?: string;
  scope?: string[];
  prompt?: string;
  loginHint?: string;
}

export interface IdPExchangeParams {
  redirectUri: string;
  codeVerifier?: string;
}

export interface IdPTokenResult {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
}

export interface IdPUserInfo {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  picture?: string;
  [key: string]: unknown;
}

export interface IdPClaims {
  sub: string;
  iss: string;
  aud: string | string[];
  exp: number;
  iat: number;
  [key: string]: unknown;
}

// =============================================================================
// Authenticator Handler Types
// =============================================================================

/**
 * Authenticator handler interface
 */
export interface AuthenticatorHandler {
  /** Start authentication challenge */
  startChallenge(params: AuthChallengeParams): Promise<AuthChallengeResult>;

  /** Verify authentication response */
  verifyResponse(params: AuthVerifyParams): Promise<AuthVerifyResult>;

  /** Check if method is available for user */
  isAvailable?(userId: string): Promise<boolean>;
}

export interface AuthChallengeParams {
  userId: string;
  credentialId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuthChallengeResult {
  challengeId: string;
  challenge: unknown; // Method-specific challenge data
  expiresAt: number;
}

export interface AuthVerifyParams {
  challengeId: string;
  response: unknown; // Method-specific response data
}

export interface AuthVerifyResult {
  success: boolean;
  userId?: string;
  credentialId?: string;
  error?: string;
}

// =============================================================================
// Capability Registry Implementation
// =============================================================================

/**
 * Central registry for plugin capabilities
 *
 * Design Decisions:
 * - Each channel/provider can only have ONE handler (collision throws error)
 * - Future composite notifiers (multi-provider) should use aggregator plugin pattern
 * - Tenant-level switching is handled by PluginConfigStore, not registry
 */
export class CapabilityRegistry {
  private notifiers = new Map<string, NotifierHandler>();
  private idps = new Map<string, IdPHandler>();
  private authenticators = new Map<string, AuthenticatorHandler>();

  // Track which plugin registered each capability
  private capabilityOwners = new Map<string, string>();

  // ==========================================================================
  // Notifier Registration
  // ==========================================================================

  /**
   * Register a notifier handler
   *
   * Design:
   * - One notifier per channel (collision throws error)
   * - Future composite notifiers use aggregator plugin pattern
   * - Tenant-level switching via PluginConfigStore
   *
   * @param channel - Notification channel (email, sms, push)
   * @param handler - Notifier handler implementation
   * @param pluginId - ID of the plugin registering this capability
   */
  registerNotifier(channel: string, handler: NotifierHandler, pluginId?: string): void {
    const capabilityKey = `notifier.${channel}`;

    if (this.notifiers.has(channel)) {
      const existingOwner = this.capabilityOwners.get(capabilityKey);
      throw new Error(
        `Notifier for channel '${channel}' already registered` +
          (existingOwner ? ` by plugin '${existingOwner}'` : '')
      );
    }

    this.notifiers.set(channel, handler);
    if (pluginId) {
      this.capabilityOwners.set(capabilityKey, pluginId);
    }
  }

  /**
   * Get a notifier handler by channel
   */
  getNotifier(channel: string): NotifierHandler | undefined {
    return this.notifiers.get(channel);
  }

  /**
   * Check if a notifier supports given options
   */
  notifierSupports(channel: string, options: NotificationOptions): boolean {
    const handler = this.notifiers.get(channel);
    if (!handler) return false;
    if (!handler.supports) return true; // No supports check = supports all
    return handler.supports(options);
  }

  /**
   * Send notification through registered handler
   *
   * Convenience method that handles lookup and error wrapping.
   */
  async sendNotification(notification: Notification): Promise<SendResult> {
    const handler = this.notifiers.get(notification.channel);

    if (!handler) {
      return {
        success: false,
        error: `No notifier registered for channel '${notification.channel}'`,
      };
    }

    try {
      return await handler.send(notification);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error sending notification',
      };
    }
  }

  // ==========================================================================
  // IdP Registration
  // ==========================================================================

  /**
   * Register an Identity Provider handler
   *
   * @param providerId - Provider identifier (google, saml, etc.)
   * @param handler - IdP handler implementation
   * @param pluginId - ID of the plugin registering this capability
   */
  registerIdP(providerId: string, handler: IdPHandler, pluginId?: string): void {
    const capabilityKey = `idp.${providerId}`;

    if (this.idps.has(providerId)) {
      const existingOwner = this.capabilityOwners.get(capabilityKey);
      throw new Error(
        `IdP '${providerId}' already registered` +
          (existingOwner ? ` by plugin '${existingOwner}'` : '')
      );
    }

    this.idps.set(providerId, handler);
    if (pluginId) {
      this.capabilityOwners.set(capabilityKey, pluginId);
    }
  }

  /**
   * Get an IdP handler by provider ID
   */
  getIdP(providerId: string): IdPHandler | undefined {
    return this.idps.get(providerId);
  }

  // ==========================================================================
  // Authenticator Registration
  // ==========================================================================

  /**
   * Register an Authenticator handler
   *
   * @param method - Authentication method (passkey, otp, etc.)
   * @param handler - Authenticator handler implementation
   * @param pluginId - ID of the plugin registering this capability
   */
  registerAuthenticator(method: string, handler: AuthenticatorHandler, pluginId?: string): void {
    const capabilityKey = `authenticator.${method}`;

    if (this.authenticators.has(method)) {
      const existingOwner = this.capabilityOwners.get(capabilityKey);
      throw new Error(
        `Authenticator '${method}' already registered` +
          (existingOwner ? ` by plugin '${existingOwner}'` : '')
      );
    }

    this.authenticators.set(method, handler);
    if (pluginId) {
      this.capabilityOwners.set(capabilityKey, pluginId);
    }
  }

  /**
   * Get an Authenticator handler by method
   */
  getAuthenticator(method: string): AuthenticatorHandler | undefined {
    return this.authenticators.get(method);
  }

  // ==========================================================================
  // Query Methods
  // ==========================================================================

  /**
   * List all registered capabilities
   */
  listCapabilities(): PluginCapability[] {
    return [
      ...Array.from(this.notifiers.keys()).map((k) => `notifier.${k}` as PluginCapability),
      ...Array.from(this.idps.keys()).map((k) => `idp.${k}` as PluginCapability),
      ...Array.from(this.authenticators.keys()).map(
        (k) => `authenticator.${k}` as PluginCapability
      ),
    ];
  }

  /**
   * Check if a capability is registered
   */
  hasCapability(capability: PluginCapability): boolean {
    const [category, name] = capability.split('.', 2);

    switch (category) {
      case 'notifier':
        return this.notifiers.has(name);
      case 'idp':
        return this.idps.has(name);
      case 'authenticator':
        return this.authenticators.has(name);
      default:
        return false;
    }
  }

  /**
   * Get the plugin that registered a capability
   */
  getCapabilityOwner(capability: PluginCapability): string | undefined {
    return this.capabilityOwners.get(capability);
  }

  /**
   * Get capabilities by category
   */
  getCapabilitiesByCategory(category: 'notifier' | 'idp' | 'authenticator'): string[] {
    switch (category) {
      case 'notifier':
        return Array.from(this.notifiers.keys());
      case 'idp':
        return Array.from(this.idps.keys());
      case 'authenticator':
        return Array.from(this.authenticators.keys());
      default:
        return [];
    }
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Unregister all capabilities from a plugin
   *
   * Called when a plugin is being unloaded.
   */
  unregisterPlugin(pluginId: string): void {
    // Find all capabilities owned by this plugin
    const toRemove: string[] = [];
    for (const [capability, owner] of this.capabilityOwners) {
      if (owner === pluginId) {
        toRemove.push(capability);
      }
    }

    // Remove each capability
    for (const capability of toRemove) {
      const [category, name] = capability.split('.', 2);

      switch (category) {
        case 'notifier':
          this.notifiers.delete(name);
          break;
        case 'idp':
          this.idps.delete(name);
          break;
        case 'authenticator':
          this.authenticators.delete(name);
          break;
      }

      this.capabilityOwners.delete(capability);
    }
  }

  /**
   * Clear all registrations
   *
   * Mainly for testing.
   */
  clear(): void {
    this.notifiers.clear();
    this.idps.clear();
    this.authenticators.clear();
    this.capabilityOwners.clear();
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

/**
 * Global capability registry instance
 *
 * In most cases, use this singleton. For testing, create new instances.
 */
export const globalRegistry = new CapabilityRegistry();
