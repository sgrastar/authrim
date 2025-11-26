/**
 * Profile Manager for OIDC Conformance Tests
 *
 * Manages certification profile switching via the Admin API
 */

import type {
  CertificationProfileName,
  CertificationProfile,
  DiscoveryMetadata,
} from './types.js';

export interface ProfileManagerOptions {
  adminApiUrl: string;
  issuer: string;
  timeout?: number;
}

export class ProfileManager {
  private readonly adminApiUrl: string;
  private readonly issuer: string;
  private readonly timeout: number;

  constructor(options: ProfileManagerOptions) {
    this.adminApiUrl = options.adminApiUrl.replace(/\/$/, '');
    this.issuer = options.issuer.replace(/\/$/, '');
    this.timeout = options.timeout ?? 10000;
  }

  /**
   * Get list of available certification profiles
   */
  async listProfiles(): Promise<Array<{ name: string; description: string }>> {
    const response = await fetch(`${this.adminApiUrl}/settings/profiles`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to list profiles: ${response.status}`);
    }

    const data = await response.json();
    return data.profiles;
  }

  /**
   * Switch to a specific certification profile
   */
  async switchProfile(profileName: CertificationProfileName): Promise<CertificationProfile> {
    console.log(`[ProfileManager] Switching to profile: ${profileName}`);

    const response = await fetch(`${this.adminApiUrl}/settings/profile/${profileName}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to switch profile: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    console.log(`[ProfileManager] Profile switched successfully: ${data.profile?.name}`);

    return data;
  }

  /**
   * Get current settings
   */
  async getCurrentSettings(): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.adminApiUrl}/settings`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get settings: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Get discovery metadata from the issuer
   */
  async getDiscoveryMetadata(): Promise<DiscoveryMetadata> {
    const response = await fetch(`${this.issuer}/.well-known/openid-configuration`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get discovery metadata: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Verify that the configuration matches the expected profile
   */
  async verifyConfiguration(profileName: CertificationProfileName): Promise<{
    isValid: boolean;
    errors: string[];
    metadata: DiscoveryMetadata;
  }> {
    const metadata = await this.getDiscoveryMetadata();
    const errors: string[] = [];

    switch (profileName) {
      case 'basic-op':
        // Basic OP should support standard auth methods
        if (!metadata.token_endpoint_auth_methods_supported?.includes('client_secret_basic')) {
          errors.push('Missing client_secret_basic in token_endpoint_auth_methods_supported');
        }
        break;

      case 'fapi-2':
      case 'fapi-2-dpop':
        // FAPI 2.0 requires PAR
        if (!metadata.require_pushed_authorization_requests) {
          errors.push('require_pushed_authorization_requests should be true for FAPI 2.0');
        }
        // FAPI 2.0 requires private_key_jwt
        if (!metadata.token_endpoint_auth_methods_supported?.includes('private_key_jwt')) {
          errors.push('Missing private_key_jwt in token_endpoint_auth_methods_supported');
        }
        // FAPI 2.0 requires PKCE S256
        if (!metadata.code_challenge_methods_supported?.includes('S256')) {
          errors.push('Missing S256 in code_challenge_methods_supported');
        }
        break;

      case 'hybrid-op':
        // Hybrid OP should support hybrid response types
        const hasHybridResponseTypes = metadata.response_types_supported?.some(
          (rt) => rt.includes('code') && (rt.includes('id_token') || rt.includes('token'))
        );
        if (!hasHybridResponseTypes) {
          errors.push('Missing hybrid response types (code id_token, code token, etc.)');
        }
        break;
    }

    return {
      isValid: errors.length === 0,
      errors,
      metadata,
    };
  }

  /**
   * Wait for configuration to propagate (handles caching)
   */
  async waitForConfigPropagation(
    profileName: CertificationProfileName,
    maxWaitMs: number = 10000
  ): Promise<void> {
    console.log(`[ProfileManager] Waiting for configuration propagation...`);

    const startTime = Date.now();
    const pollIntervalMs = 1000;

    while (Date.now() - startTime < maxWaitMs) {
      const { isValid, errors } = await this.verifyConfiguration(profileName);

      if (isValid) {
        console.log(`[ProfileManager] Configuration propagated successfully`);
        return;
      }

      console.log(`[ProfileManager] Configuration not yet propagated: ${errors.join(', ')}`);
      await this.sleep(pollIntervalMs);
    }

    console.log(
      `[ProfileManager] Warning: Configuration may not have fully propagated within ${maxWaitMs}ms`
    );
  }

  /**
   * Switch profile and wait for propagation
   */
  async switchProfileAndVerify(
    profileName: CertificationProfileName,
    options: {
      waitForPropagation?: boolean;
      maxWaitMs?: number;
    } = {}
  ): Promise<{
    profile: CertificationProfile;
    metadata: DiscoveryMetadata;
    verified: boolean;
  }> {
    const { waitForPropagation = true, maxWaitMs = 10000 } = options;

    // Switch the profile
    const profile = await this.switchProfile(profileName);

    if (waitForPropagation) {
      // Wait a bit for settings to propagate
      await this.sleep(2000);

      // Verify the configuration
      await this.waitForConfigPropagation(profileName, maxWaitMs);
    }

    // Get final metadata
    const { isValid, metadata } = await this.verifyConfiguration(profileName);

    return {
      profile,
      metadata,
      verified: isValid,
    };
  }

  /**
   * Map short profile name to conformance test plan name
   */
  static getTestPlanName(
    profileName: CertificationProfileName
  ): string | null {
    const mapping: Record<string, string> = {
      'basic-op': 'oidcc-basic-certification-test-plan',
      'config-op': 'oidcc-config-certification-test-plan',
      'dynamic-op': 'oidcc-dynamic-certification-test-plan',
      'hybrid-op': 'oidcc-hybrid-certification-test-plan',
      'fapi-2': 'fapi2-security-profile-id2-test-plan',
      'fapi-2-dpop': 'fapi2-security-profile-id2-test-plan',
    };

    return mapping[profileName] || null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create a ProfileManager from environment variables
 */
export function createProfileManagerFromEnv(): ProfileManager {
  const adminApiUrl = process.env.ADMIN_API_URL;
  const issuer = process.env.ISSUER;

  if (!adminApiUrl) {
    throw new Error('ADMIN_API_URL environment variable is required');
  }

  if (!issuer) {
    throw new Error('ISSUER environment variable is required');
  }

  return new ProfileManager({
    adminApiUrl,
    issuer,
  });
}
