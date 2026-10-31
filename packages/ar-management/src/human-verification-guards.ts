import {
  HUMAN_VERIFICATION_FLOWS,
  HUMAN_VERIFICATION_SETTING_PREFIX,
  humanVerificationSelectionFromSettings,
  humanVerificationSettingsKey,
  isHumanVerificationRequired,
  listEnvironmentTenantDefaultStores,
  parseHumanVerificationSettingsDocument,
  requiredHumanVerificationFlows,
  requireDedicatedAdminDatabaseAdapter,
  type Env,
  type HumanVerificationUnavailableReason,
} from '@authrim/ar-lib-core';
import { DatabaseSettingsCanonicalStore } from '@authrim/ar-lib-core/services/settings-canonical-store';
import { resolveHumanVerificationProviderAvailability } from './authentication-methods';
import { BUILTIN_HUMAN_VERIFICATION_PROVIDER_IDS } from './human-verification-provider-projection';

/**
 * The admin side of "the widget and the server agree": a human verification provider is never
 * switched off under a flow that requires it (plugin disable, 409), and a flow is never made to
 * require one that cannot verify (settings PATCH, 400). Both ask the same functions the login UI
 * and the token check use (ar-lib-core human-verification-policy.ts).
 *
 * Both only refuse a change that CREATES the mismatch; a tenant already in one can still save
 * its other settings and can still turn flows off.
 *
 * Known limit: a PATCH that makes a flow required and a disable of the same provider that run at
 * the same time can both pass their checks (each reads the state before the other's write, and
 * the settings `ifMatch` does not detect a change of the plugin flag). Serialising them needs a
 * shared coordinator; this is not one.
 */

/** A read the guard depends on failed (not a malformed document): the caller must not proceed. */
export class HumanVerificationGuardUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super('human_verification_guard_unavailable');
    this.name = 'HumanVerificationGuardUnavailableError';
  }
}

export function humanVerificationSettingKey(flow: string): string {
  return `${HUMAN_VERIFICATION_SETTING_PREFIX}${flow}_enabled`;
}

/**
 * The tenant's `authentication-methods` documents that decide what a flow requires: the canonical
 * one (D1, when DB_ADMIN is configured) and the KV copy the servers read, which can lag it in
 * either direction while a projection is pending. Both are returned; a malformed KV document is
 * left out (a broken document must not stop an admin from switching a provider off), but a read
 * that FAILS throws {@link HumanVerificationGuardUnavailableError}.
 */
async function readRequirementDocuments(
  env: Env,
  tenantId: string
): Promise<Record<string, unknown>[]> {
  const documents: Record<string, unknown>[] = [];
  let raw: string | null | undefined;
  try {
    raw = await env.SETTINGS?.get(humanVerificationSettingsKey(tenantId));
  } catch (error) {
    throw new HumanVerificationGuardUnavailableError(error);
  }
  try {
    const kvDocument = parseHumanVerificationSettingsDocument(raw);
    if (kvDocument) documents.push(kvDocument);
  } catch {
    // Malformed: counts as requiring nothing.
  }
  if (env.DB_ADMIN) {
    try {
      const canonical = await new DatabaseSettingsCanonicalStore(
        requireDedicatedAdminDatabaseAdapter(env, 'settings-canonical')
      ).load('authentication-methods', { type: 'tenant', id: tenantId });
      if (canonical) documents.push(canonical.data);
    } catch (error) {
      throw new HumanVerificationGuardUnavailableError(error);
    }
  }
  return documents;
}

/**
 * The settings that make the tenant's flows require this provider ([] when the provider is not the
 * tenant's, or no flow asks for a token). The canonical document and the KV copy are both read and
 * either one requiring it counts: a pending projection in either direction must not let the
 * provider be switched off. Throws {@link HumanVerificationGuardUnavailableError} when a read fails.
 */
export async function humanVerificationSettingsRequiring(
  env: Env,
  tenantId: string,
  pluginId: string
): Promise<string[]> {
  if (!BUILTIN_HUMAN_VERIFICATION_PROVIDER_IDS.has(pluginId)) return [];
  const requiring = new Set<string>();
  for (const document of await readRequirementDocuments(env, tenantId)) {
    const selection = humanVerificationSelectionFromSettings(document);
    if (selection.pluginId !== pluginId) continue;
    for (const flow of requiredHumanVerificationFlows(selection)) {
      requiring.add(flow);
    }
  }
  return HUMAN_VERIFICATION_FLOWS.filter((flow) => requiring.has(flow)).map(
    humanVerificationSettingKey
  );
}

/** The most tenants a platform-wide disable looks at; more are refused (see below). */
export const GLOBAL_DISABLE_MAX_TENANTS = 200;
const TENANT_PAGE_SIZE = 100;

export interface HumanVerificationTenantUse {
  tenantId: string;
  settings: string[];
}

export type GlobalDisableCheck =
  | { outcome: 'allowed' }
  | { outcome: 'in_use'; tenants: HumanVerificationTenantUse[] }
  /** More tenants than a single request can inspect: refused, the safe side. */
  | { outcome: 'scope_too_large' }
  /**
   * No tenant list is configured in this environment: retrying does not help, so the caller says
   * so (reason `tenant_directory_unavailable`).
   */
  | { outcome: 'directory_unavailable' }
  /** A read failed (the tenant list, a flag or a settings document): refused, retry may work. */
  | { outcome: 'scope_unavailable' };

const DIRECTORY_NOT_CONFIGURED = 'environment_tenant_directory_unavailable';

/**
 * Whether the provider can be switched off platform-wide (`plugins:enabled:<id>` set to false).
 * Only tenants that inherit the platform flag (no `plugins:enabled:<id>:tenant:<t>` of their own)
 * lose the provider, so those whose settings select it and require it for a flow stop the disable.
 * Nothing changes when the platform flag is not on, so nothing is checked then.
 *
 * Tenants are read in keyset pages, never more than the room left under
 * {@link GLOBAL_DISABLE_MAX_TENANTS} plus one (that one only shows there are more): a request
 * cannot afford more KV/D1 reads, so a larger environment is refused rather than checked in part.
 */
export async function checkGlobalHumanVerificationDisable(
  env: Env,
  pluginId: string
): Promise<GlobalDisableCheck> {
  if (!BUILTIN_HUMAN_VERIFICATION_PROVIDER_IDS.has(pluginId)) return { outcome: 'allowed' };
  const kv = env.SETTINGS;
  if (!kv) return { outcome: 'allowed' };
  try {
    if ((await kv.get(`plugins:enabled:${pluginId}`)) !== 'true') return { outcome: 'allowed' };
  } catch {
    return { outcome: 'scope_unavailable' };
  }

  const using: HumanVerificationTenantUse[] = [];
  try {
    let checked = 0;
    let after: string | undefined;
    for (;;) {
      const remaining = GLOBAL_DISABLE_MAX_TENANTS - checked;
      const limit = Math.min(TENANT_PAGE_SIZE, remaining + 1);
      const page = await listEnvironmentTenantDefaultStores(env, {
        limit,
        ...(after ? { afterTenantId: after } : {}),
      });
      if (page.length > remaining) return { outcome: 'scope_too_large' };
      for (const { tenantId } of page) {
        checked += 1;
        if ((await kv.get(`plugins:enabled:${pluginId}:tenant:${tenantId}`)) !== null) continue;
        const settings = await humanVerificationSettingsRequiring(env, tenantId, pluginId);
        if (settings.length > 0) using.push({ tenantId, settings });
      }
      if (page.length < limit) break;
      after = page[page.length - 1]?.tenantId;
      if (!after) break;
    }
  } catch (error) {
    if (error instanceof Error && error.message === DIRECTORY_NOT_CONFIGURED) {
      return { outcome: 'directory_unavailable' };
    }
    return { outcome: 'scope_unavailable' };
  }
  return using.length > 0 ? { outcome: 'in_use', tenants: using } : { outcome: 'allowed' };
}

export interface HumanVerificationPatchBody {
  set?: Record<string, unknown>;
  clear?: string[];
  disable?: string[];
}

export interface HumanVerificationPatchRefusal {
  pluginId: string;
  reason: HumanVerificationUnavailableReason;
  /** The settings the PATCH newly requires (empty when it only switched the provider). */
  settings: string[];
}

/** Whether the PATCH names a human verification setting (the others need no check). */
export function patchTouchesHumanVerification(body: HumanVerificationPatchBody): boolean {
  return [...Object.keys(body.set ?? {}), ...(body.clear ?? []), ...(body.disable ?? [])].some(
    (key) => key.startsWith(HUMAN_VERIFICATION_SETTING_PREFIX)
  );
}

/**
 * Whether leaving the tenant's settings document as `after` (from `before`) would newly make a
 * flow require a provider that cannot verify: a flow switched from not required to required, or
 * the provider changed while a flow requires it, and the provider is disabled or has no
 * credentials. Returns the refusal, or null to let the save go on.
 *
 * Both documents come from `SettingsManager.patch(..., { dryRun: true })` (`candidate`): the
 * canonical document the save acts on and the one it would leave after the keys the manager
 * rejects are left out, not the KV projection (which may lag) and not the raw request.
 */
export async function humanVerificationDocumentRefusal(
  env: Env,
  tenantId: string,
  before: Readonly<Record<string, unknown>> | null,
  after: Readonly<Record<string, unknown>>
): Promise<HumanVerificationPatchRefusal | null> {
  const was = humanVerificationSelectionFromSettings(before);
  const will = humanVerificationSelectionFromSettings(after);
  if (!isHumanVerificationRequired(will, HUMAN_VERIFICATION_FLOWS)) return null;
  const newlyRequired = HUMAN_VERIFICATION_FLOWS.filter(
    (flow) => will.required[flow] && !was.required[flow]
  );
  if (newlyRequired.length === 0 && was.pluginId === will.pluginId) return null;

  const availability = await resolveHumanVerificationProviderAvailability(
    env,
    tenantId,
    will.pluginId
  );
  if (availability.available || !availability.reason) return null;
  return {
    pluginId: will.pluginId,
    reason: availability.reason,
    settings: newlyRequired.map(humanVerificationSettingKey),
  };
}
