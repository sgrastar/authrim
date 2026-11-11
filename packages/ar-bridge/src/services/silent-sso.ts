/**
 * Single sign-on for an external provider's silent sign-in (`prompt=none`), decided as authorize
 * decides it: the app's own setting, then the session profile of the sign-in Flow the app uses,
 * then the tenant's.
 */
import {
  loadAssignedLoginFlowProfileRefs,
  readSessionProfile,
  sessionProfileSso,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';

/**
 * The app's own single sign-on setting: true or false only where it was set for the app (its
 * category default is no override); null otherwise.
 */
export function clientSsoOverride(settings: {
  values: Record<string, unknown>;
  sources: Record<string, string | undefined>;
}): boolean | null {
  const value = settings.values['client.sso_enabled'];
  return settings.sources['client.sso_enabled'] !== 'default' && typeof value === 'boolean'
    ? value
    : null;
}

/**
 * Single sign-on as the session profile of the app's sign-in Flow sets it, or null where it sets
 * nothing (no Flow, Default, or a profile without the setting). A read that fails turns it off.
 */
export async function signInFlowProfileSso(
  env: Env,
  db: DatabaseAdapter,
  tenantId: string,
  clientId: string | null | undefined
): Promise<boolean | null> {
  try {
    const refs = await loadAssignedLoginFlowProfileRefs(db, tenantId, { clientId });
    if (!refs || refs.sessionProfileRef === 'default') return null;
    return sessionProfileSso(await readSessionProfile(env, tenantId, refs.sessionProfileRef));
  } catch {
    return false;
  }
}
