import type { AuthrimConfig } from '../../packages/setup/src/core/config.js';
import { resolveIssuerUrl } from '../../packages/setup/src/core/url-config.js';

export function resolvePhase0cTenantApiBaseUrl(
  config: Partial<AuthrimConfig>,
  environment: string
): string {
  return resolveIssuerUrl(config, { env: environment });
}
