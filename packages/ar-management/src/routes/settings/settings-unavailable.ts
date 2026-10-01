/**
 * Tenant settings views for the older settings endpoints.
 *
 * Runtime refuses requests whose settings cannot be read, so these endpoints must not answer
 * with env or default values as if they were the ones in effect: they answer 503 instead.
 */

import type { Context } from 'hono';
import { getTenantSystemSettings, type Env } from '@authrim/ar-lib-core';

/** A tenant's settings could not be read, so the values in effect are unknown. */
export class SettingsUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Tenant settings cannot be read', { cause });
    this.name = 'SettingsUnavailableError';
  }
}

/**
 * The tenant's `system_settings` view with Settings API values for the given sections, as runtime
 * reads it; throws SettingsUnavailableError when it cannot be read.
 */
export async function readTenantSettingsView<T>(
  env: Env,
  tenantId: string,
  sections: readonly string[]
): Promise<T | null> {
  try {
    return (await getTenantSystemSettings(env.SETTINGS, tenantId, {
      failOnError: true,
      sections,
    })) as T | null;
  } catch (error) {
    throw new SettingsUnavailableError(error);
  }
}

export function settingsUnavailableResponse(c: Context) {
  return c.json(
    {
      error: 'temporarily_unavailable',
      error_description: 'Settings cannot be read, so the values in effect are unknown; try again',
    },
    503
  );
}
