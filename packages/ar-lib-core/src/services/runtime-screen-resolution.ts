/**
 * Which screen a Flow step shows: the one resolution the login runtime (ar-auth) draws and the
 * lite Login UI compatibility guard (ar-management) checks, so the guard judges exactly what a
 * person would see.
 *
 * Order: the tenant's active screen whose id or key is the step's `screen_ref`; for the generic
 * `basic_profile` ref, the tenant's screen for the step's component; then, for the built-in keys,
 * the `default` tenant's system screen (so a tenant that deleted or deactivated its own `login`
 * screen falls back to the system one).
 */
import type { DatabaseAdapter } from '../db/adapter';
import { EDITABLE_DEFAULT_SCREEN_KEYS } from '../types/screens';

/** Screen keys a tenant without its own screen falls back to the `default` tenant's system screen for. */
export const DEFAULT_RUNTIME_SCREEN_KEYS: ReadonlySet<string> = new Set([
  'login',
  'registration',
  'profile_completion',
  'code_input',
  'consent',
]);
const EDITABLE_DEFAULT_KEYS = new Set<string>(EDITABLE_DEFAULT_SCREEN_KEYS);

export interface RuntimeScreenRow {
  id: string;
  screen_key: string;
  display_name: string;
  description: string | null;
  screen_kind: string;
  fields_json: string | null;
  localizations_json: string | null;
  settings_json: string | null;
}

/** The built-in screen key a step's component shows for the generic `basic_profile` ref. */
export function defaultScreenKeyForRuntimeComponent(component?: string): string {
  if (component === 'registration_method_selector') return 'registration';
  if (component === 'authentication_method_selector') return 'login';
  if (component === 'email_verification') return 'code_input';
  if (component === 'screen') return 'profile_completion';
  if (component === 'consent_policy') return 'consent';
  return 'profile_completion';
}

/** The screen row a step with `screenRef` shows, or null when none resolves. */
export async function resolveRuntimeScreenRow(
  db: DatabaseAdapter,
  tenantId: string,
  screenRef: string | null,
  component: string | undefined
): Promise<RuntimeScreenRow | null> {
  if (!screenRef) return null;
  const queryScreen = (scopeTenantId: string, ref: string, systemOnly = false) =>
    db.queryOne<RuntimeScreenRow>(
      `SELECT id, screen_key, display_name, description, screen_kind, fields_json,
            localizations_json, settings_json
       FROM screens
      WHERE tenant_id = ?
        AND is_active = 1
        ${systemOnly ? 'AND is_system = 1' : ''}
        AND (id = ? OR screen_key = ?)
      LIMIT 1`,
      [scopeTenantId, ref, ref]
    );
  const fallbackScreenRef =
    screenRef === 'basic_profile' ? defaultScreenKeyForRuntimeComponent(component) : screenRef;
  const tenantScreen =
    (await queryScreen(tenantId, screenRef)) ??
    (screenRef === 'basic_profile' ? await queryScreen(tenantId, fallbackScreenRef) : null);
  if (tenantScreen || !DEFAULT_RUNTIME_SCREEN_KEYS.has(fallbackScreenRef)) return tenantScreen;
  // During migration the original default-tenant row may still be system-owned. Once it becomes
  // editable, its separate immutable template supplies the same runtime fallback.
  const originalSystemScreen = await queryScreen('default', fallbackScreenRef, true);
  if (originalSystemScreen) return originalSystemScreen;
  if (!EDITABLE_DEFAULT_KEYS.has(fallbackScreenRef)) return null;
  const template = await queryScreen('default', `${fallbackScreenRef}_template`, true);
  // Runtime behavior and the response still use the requested built-in key. In particular,
  // login's default divider conditions depend on the canonical `login` screen key.
  return template ? { ...template, screen_key: fallbackScreenRef } : null;
}
