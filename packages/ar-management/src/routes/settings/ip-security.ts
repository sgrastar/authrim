/**
 * IP Security Settings Admin API
 *
 * GET    /api/admin/settings/ip-security  - Get settings
 * PUT    /api/admin/settings/ip-security  - Update settings
 * DELETE /api/admin/settings/ip-security  - Clear override
 *
 * Multi-cloud IP extraction settings for rate limiting and security.
 *
 * Supported Cloud Providers:
 * - cloudflare (default): Uses CF-Connecting-IP header (most secure)
 * - aws: Uses X-Forwarded-For, takes last IP (ALB behavior)
 * - azure: Uses X-Forwarded-For, takes last IP (App Gateway behavior)
 * - gcp: Uses X-Forwarded-For, takes 2nd from last IP (GCP LB behavior)
 * - none: Uses X-Forwarded-For first IP (WARNING: spoofable!)
 *
 * Settings stored in AUTHRIM_CONFIG KV:
 * - security_cloud_provider: "cloudflare" | "aws" | "azure" | "gcp" | "none"
 */

import type { Context } from 'hono';
import {
  getCloudProviderKVKey,
  getDefaultCloudProvider,
  VALID_CLOUD_PROVIDERS,
  clearCloudProviderCache,
  getLogger,
  type CloudProvider,
  type Env,
} from '@authrim/ar-lib-core';

type SettingSource = 'kv' | 'default';

interface IpSecuritySettings {
  cloudProvider: CloudProvider;
}

interface IpSecuritySettingsSources {
  cloudProvider: SettingSource;
}

/**
 * Cloud provider descriptions for UI
 */
const CLOUD_PROVIDER_INFO: Record<
  CloudProvider,
  {
    name: string;
    description: string;
    ipExtraction: string;
    securityLevel: 'high' | 'medium' | 'low';
    warning?: string;
  }
> = {
  cloudflare: {
    name: 'Cloudflare',
    description: 'Uses CF-Connecting-IP header which cannot be spoofed',
    ipExtraction: 'CF-Connecting-IP or True-Client-IP header',
    securityLevel: 'high',
  },
  aws: {
    name: 'AWS (ALB/ELB)',
    description: 'Uses X-Forwarded-For header, takes the last IP added by ALB',
    ipExtraction: 'Last IP in X-Forwarded-For',
    securityLevel: 'medium',
  },
  azure: {
    name: 'Azure (Application Gateway)',
    description: 'Uses X-Forwarded-For header, takes the last IP added by App Gateway',
    ipExtraction: 'Last IP in X-Forwarded-For',
    securityLevel: 'medium',
  },
  gcp: {
    name: 'Google Cloud (Load Balancer)',
    description: 'Uses X-Forwarded-For header, takes 2nd from last IP (GCP adds client_ip + lb_ip)',
    ipExtraction: '2nd from last IP in X-Forwarded-For',
    securityLevel: 'medium',
  },
  none: {
    name: 'None / Direct',
    description: 'No trusted proxy, uses first IP from X-Forwarded-For',
    ipExtraction: 'First IP in X-Forwarded-For or X-Real-IP',
    securityLevel: 'low',
    warning:
      'WARNING: X-Forwarded-For can be spoofed by clients! ' +
      'Consider using a Web Application Firewall (WAF) or reverse proxy for additional protection.',
  },
};

/**
 * Get current IP security settings (KV > default)
 */
export async function getIpSecuritySettings(env: Env): Promise<{
  settings: IpSecuritySettings;
  sources: IpSecuritySettingsSources;
}> {
  const defaultProvider = getDefaultCloudProvider();

  const settings: IpSecuritySettings = {
    cloudProvider: defaultProvider,
  };

  const sources: IpSecuritySettingsSources = {
    cloudProvider: 'default',
  };

  // Check KV
  if (env.AUTHRIM_CONFIG) {
    try {
      const kvValue = await env.AUTHRIM_CONFIG.get(getCloudProviderKVKey());
      if (kvValue && VALID_CLOUD_PROVIDERS.includes(kvValue as CloudProvider)) {
        settings.cloudProvider = kvValue as CloudProvider;
        sources.cloudProvider = 'kv';
      }
    } catch {
      // Ignore KV errors
    }
  }

  return { settings, sources };
}

/**
 * GET /api/admin/settings/ip-security
 * Get IP security settings with their sources
 */
export async function getIpSecurityConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('IpSecurityAPI');
  try {
    const { settings, sources } = await getIpSecuritySettings(c.env);
    const providerInfo = CLOUD_PROVIDER_INFO[settings.cloudProvider];

    return c.json({
      settings: {
        cloudProvider: {
          value: settings.cloudProvider,
          source: sources.cloudProvider,
          default: getDefaultCloudProvider(),
          description: 'Cloud provider for trusted IP extraction',
          info: providerInfo,
        },
      },
      availableProviders: Object.entries(CLOUD_PROVIDER_INFO).map(([key, info]) => ({
        value: key,
        ...info,
      })),
      note:
        'Select your cloud provider to ensure correct client IP extraction for rate limiting. ' +
        'Incorrect configuration may allow IP spoofing attacks.',
      kv_key: getCloudProviderKVKey(),
    });
  } catch (error) {
    log.error('Error getting settings', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get IP security settings',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/settings/ip-security
 * Update IP security settings (stored in KV)
 *
 * Request body:
 * {
 *   "cloudProvider": "cloudflare" | "aws" | "azure" | "gcp" | "none"
 * }
 */
export async function updateIpSecurityConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('IpSecurityAPI');
  // Check if KV is available
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'kv_not_configured',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
      },
      500
    );
  }

  let body: {
    cloudProvider?: CloudProvider;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Invalid JSON body',
      },
      400
    );
  }

  // Validate cloudProvider
  if (body.cloudProvider !== undefined) {
    if (!VALID_CLOUD_PROVIDERS.includes(body.cloudProvider)) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: `"cloudProvider" must be one of: ${VALID_CLOUD_PROVIDERS.join(', ')}`,
        },
        400
      );
    }
  }

  try {
    // Update KV if value provided
    if (body.cloudProvider !== undefined) {
      await c.env.AUTHRIM_CONFIG.put(getCloudProviderKVKey(), body.cloudProvider);

      // Clear cache to apply changes immediately
      clearCloudProviderCache();
    }

    // Get updated settings
    const { settings, sources } = await getIpSecuritySettings(c.env);
    const providerInfo = CLOUD_PROVIDER_INFO[settings.cloudProvider];

    // Build response with appropriate warnings
    const response: {
      success: boolean;
      settings: IpSecuritySettings;
      sources: IpSecuritySettingsSources;
      providerInfo: (typeof CLOUD_PROVIDER_INFO)[CloudProvider];
      note: string;
      warning?: string;
    } = {
      success: true,
      settings,
      sources,
      providerInfo,
      note: `Cloud provider set to "${settings.cloudProvider}". IP extraction method: ${providerInfo.ipExtraction}`,
    };

    // Add warning for 'none' provider
    if (settings.cloudProvider === 'none') {
      response.warning = providerInfo.warning;
    }

    return c.json(response);
  } catch (error) {
    log.error('Error updating settings', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to update settings',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/settings/ip-security
 * Clear IP security settings override (revert to default: cloudflare)
 */
export async function clearIpSecurityConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('IpSecurityAPI');
  // Check if KV is available
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'kv_not_configured',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
      },
      500
    );
  }

  try {
    // Delete the KV key
    await c.env.AUTHRIM_CONFIG.delete(getCloudProviderKVKey());

    // Clear cache
    clearCloudProviderCache();

    // Get updated settings (will fall back to default)
    const { settings, sources } = await getIpSecuritySettings(c.env);

    return c.json({
      success: true,
      settings,
      sources,
      note: `IP security settings cleared. Using default provider: ${getDefaultCloudProvider()}`,
    });
  } catch (error) {
    log.error('Error clearing settings', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to clear settings',
      },
      500
    );
  }
}
