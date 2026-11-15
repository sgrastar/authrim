/**
 * The Login UI's OAuth client for a tenant made through the Admin API.
 *
 * The deployed Login UI sends one client id for every tenant (`PUBLIC_LOGIN_UI_CLIENT_ID` at its
 * build, else `login-ui`), and a client is read by (tenant, client id) only. @authrim/setup
 * registers that client for the initial tenant; a tenant made later gets its own here, under the
 * same id, with redirect URIs and web origins that are exactly that tenant's Login UI origin.
 *
 * Nothing is shared between tenants: the row, its web origin registry and its audience are the
 * tenant's. The id is not announced to the app-hint discovery directory, so it never maps one id
 * to several tenants.
 */

import {
  ClientRepository,
  buildIssuerUrl,
  getPrimaryTenantId,
  isReservedUiHost,
  createLogger,
  ensureDatabaseAdapter,
  readInformationReleaseConsentSetting,
  replaceWebOriginRegistry,
  resolveTenantDatabaseSourceFromRegistry,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import {
  DEFAULT_LOGIN_UI_CLIENT_ID,
  LOGIN_UI_CLIENT_DESCRIPTION,
  LOGIN_UI_CLIENT_NAME,
  buildLoginUiClientMetadata,
  isValidLoginUiClientId,
} from './login-ui-client-metadata';

const getLog = () => createLogger().module('TENANT-LOGIN-UI-CLIENT');

export type EnsureTenantLoginUiClientResult =
  | { status: 'created' | 'exists'; clientId: string; origin: string }
  | { status: 'skipped'; reason: 'origin_unavailable' };

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * The Login UI origin of a tenant made through the Admin API: its own host under BASE_DOMAIN,
 * from the deployment configuration and the tenant id. Nothing comes from a request. A tenant
 * that has no host of its own (no BASE_DOMAIN) has none to register. A host that is a configured
 * UI or API host (the common Login UI, the Admin UI, the issuer) is refused: a tenant whose id
 * maps onto it would otherwise register that host as its own origin.
 */
export function resolveTenantLoginUiOrigin(env: Env, tenantId: string): string | null {
  if (!env.BASE_DOMAIN?.trim()) return null;
  let url: URL;
  try {
    url = new URL(buildIssuerUrl(env, tenantId));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const issuerHost = hostnameOf(env.ISSUER_URL);
  if (isReservedUiHost(env, host) || (issuerHost !== null && issuerHost === host)) {
    throw new Error('tenant_login_ui_host_reserved');
  }
  return url.origin;
}

function hostnameOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The client id the deployed Login UI sends:
 * 1. the deployment variable LOGIN_UI_CLIENT_ID;
 * 2. else the one Login UI client of the initial tenant (the one @authrim/setup registered and
 *    wrote into the Login UI build, found by its fixed name and description);
 * 3. `login-ui`, the Login UI's own default, only when that lookup worked and found none.
 * It fails, and provisioning is retried, rather than guess: on an invalid variable, a lookup that
 * cannot be read, and two or more candidates (the initial tenant's administrators can create a
 * client with the same name).
 */
export async function resolveLoginUiClientId(env: Env): Promise<string> {
  const configured = (env as unknown as { LOGIN_UI_CLIENT_ID?: string }).LOGIN_UI_CLIENT_ID?.trim();
  if (configured) {
    if (!isValidLoginUiClientId(configured)) throw new Error('login_ui_client_id_invalid');
    return configured;
  }
  const initialTenantId = getPrimaryTenantId(env).trim();
  let rows: Array<{ client_id: string }>;
  try {
    const store = await resolveTenantDatabaseSourceFromRegistry(env, {
      tenantId: initialTenantId,
      role: 'tenant_core',
      shardGroup: 'default',
      shardIndex: 0,
    });
    rows = await ensureDatabaseAdapter(store.source, 'tenant-login-ui-client').query<{
      client_id: string;
    }>(
      `SELECT client_id FROM oauth_clients
        WHERE tenant_id = ? AND client_name = ? AND description = ?
          AND token_endpoint_auth_method = 'none' AND is_trusted = 1 AND require_pkce = 1
        LIMIT 2`,
      [initialTenantId, LOGIN_UI_CLIENT_NAME, LOGIN_UI_CLIENT_DESCRIPTION]
    );
  } catch (error) {
    getLog().error(
      'The initial tenant Login UI client could not be read',
      { tenantId: initialTenantId },
      error as Error
    );
    throw new Error('login_ui_client_id_lookup_failed');
  }
  if (rows.length > 1) {
    getLog().error('The initial tenant has several Login UI clients; set LOGIN_UI_CLIENT_ID', {
      tenantId: initialTenantId,
    });
    throw new Error('login_ui_client_id_ambiguous');
  }
  if (rows.length === 0) return DEFAULT_LOGIN_UI_CLIENT_ID;
  if (!isValidLoginUiClientId(rows[0].client_id)) throw new Error('login_ui_client_id_invalid');
  return rows[0].client_id;
}

/**
 * Make sure the tenant has its Login UI client. Safe to run again: an existing client that is
 * exactly this definition is kept (its web origin registry is completed if a retry stopped before
 * writing it); a client with the same id and anything else is never overwritten, and fails.
 */
export async function ensureTenantLoginUiClient(
  env: Env,
  adapter: DatabaseAdapter,
  tenantId: string,
  clientId?: string
): Promise<EnsureTenantLoginUiClientResult> {
  const origin = resolveTenantLoginUiOrigin(env, tenantId);
  if (!origin) {
    getLog().warn('The tenant has no Login UI origin; its Login UI client was not created', {
      tenantId,
    });
    return { status: 'skipped', reason: 'origin_unavailable' };
  }
  const id = clientId ?? (await resolveLoginUiClientId(env));
  if (!isValidLoginUiClientId(id)) throw new Error('tenant_login_ui_client_id_invalid');

  const metadata = buildLoginUiClientMetadata(origin);
  const repository = new ClientRepository(adapter, tenantId);
  const existing = await repository.findByClientId(id);

  if (existing) {
    const matches =
      existing.client_name === metadata.client_name &&
      existing.description === metadata.description &&
      existing.token_endpoint_auth_method === 'none' &&
      existing.require_pkce === true &&
      existing.is_trusted === true &&
      existing.browser_refresh_token_policy === 'disabled' &&
      sameSet(parseStringArray(existing.redirect_uris), metadata.redirect_uris) &&
      sameSet(parseStringArray(existing.grant_types), metadata.grant_types);
    if (!matches) throw new Error('tenant_login_ui_client_conflict');
    await replaceWebOriginRegistry(adapter, tenantId, id, metadata.web_origin_registry);
    return { status: 'exists', clientId: id, origin };
  }

  await repository.create({
    client_id: id,
    tenant_id: tenantId,
    client_name: metadata.client_name,
    description: metadata.description,
    application_type: 'web',
    redirect_uris: metadata.redirect_uris,
    grant_types: metadata.grant_types,
    response_types: metadata.response_types,
    scope: metadata.scope,
    is_trusted: metadata.is_trusted,
    skip_consent: metadata.skip_consent,
    token_endpoint_auth_method: metadata.token_endpoint_auth_method,
    require_pkce: metadata.require_pkce,
    browser_public_client_mode: metadata.browser_public_client_mode,
    browser_refresh_token_policy: metadata.browser_refresh_token_policy,
    information_release_consent: readInformationReleaseConsentSetting(null),
  });
  await replaceWebOriginRegistry(adapter, tenantId, id, metadata.web_origin_registry);
  return { status: 'created', clientId: id, origin };
}
