import type { Context } from 'hono';
import type {
  AccountLauncher,
  ApplicationLauncher,
  Env,
  LauncherAttributeRule,
  LauncherVisibility,
  PlatformLauncher,
  SharedLauncherState,
  TenantLauncherListItem,
} from '@authrim/ar-lib-core';
import {
  CanonicalRuntimeUserStore,
  createAccountAuthContextFromHono,
  createAuthContextFromHono,
  createAuditLogFromContext,
  createCustomClaimSchemaResolverFromSources,
  createPIIContextFromHono,
  getLogger,
  getTenantIdFromContext,
  requireDedicatedAdminDatabaseAdapter,
  resolveCustomClaimRuntimeSourcesFromHono,
} from '@authrim/ar-lib-core';
import { requireAccountSession } from './account-page';
import {
  APPLICATION_TYPES,
  ATTRIBUTE_MATCHES,
  ICON_TYPES,
  LAUNCH_TYPES,
  PHOSPHOR_ICON_NAMES,
  VISIBILITY_MODES,
  readAttributeRules,
  readBackgroundImageUrl,
  readBoolean,
  readColor,
  readEnum,
  readHttpsUrl,
  readInteger,
  readNullableColor,
  readRequiredString,
  readSamlSpEntityId,
  readString,
  readSubjectIds,
  storedLauncher,
  validateLauncherBody,
  type NormalizedLauncherInput,
  type Row,
} from './launcher-config';
import {
  PLATFORM_LAUNCHER_ID_PATTERN,
  PLATFORM_LAUNCHER_LIMIT,
  listPlatformLaunchersSharedWith,
} from './platform-launchers-store';
import { recordAccountOperation } from './account-operation-log';
import { getRequestAwareIssuerUrl } from './request-issuer';

type LauncherContext = Context<{ Bindings: Env }>;
type LauncherRow = {
  id: string;
  config_json: string;
  created_at: number;
  updated_at: number;
};

function invalid(c: LauncherContext, description: string): Response {
  return c.json({ error: 'invalid_request', error_description: description }, 400);
}

async function readJsonObject(c: LauncherContext): Promise<Row | Response> {
  try {
    const value = await c.req.json<unknown>();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return invalid(c, 'Request body must be a JSON object');
    }
    return value as Row;
  } catch {
    return invalid(c, 'Request body must be valid JSON');
  }
}

function notFound(c: LauncherContext): Response {
  return c.json({ error: 'not_found', error_description: 'Launcher not found' }, 404);
}

/**
 * `shared`: a launcher every tenant may show (the platform's, `platform`) or a tenant's copy of one
 * (`copy`). Both are plain links (`standalone`): they name no application of a tenant. The
 * platform's is shown to everyone; a tenant's copy may narrow it to its own users, groups or
 * attributes.
 */
export async function normalizeLauncherInput(
  c: LauncherContext,
  body: Row,
  existing?: ApplicationLauncher,
  shared?: 'platform' | 'copy'
): Promise<NormalizedLauncherInput | Response> {
  const validationError = validateLauncherBody(body);
  if (validationError) return invalid(c, validationError);
  if (shared && body.application_type !== undefined && body.application_type !== 'standalone') {
    return invalid(c, 'Shared launchers are links: application_type must be standalone');
  }
  if (
    shared === 'platform' &&
    body.visibility &&
    typeof body.visibility === 'object' &&
    (body.visibility as Row).mode !== undefined &&
    (body.visibility as Row).mode !== 'everyone'
  ) {
    return invalid(c, 'Platform launchers are shown to everyone: visibility.mode must be everyone');
  }
  const applicationType = readEnum(
    body.application_type,
    APPLICATION_TYPES,
    existing?.application_type ?? 'standalone'
  );
  const requestedApplicationId =
    body.application_id === undefined
      ? (existing?.application_id ?? null)
      : readString(body.application_id, 500);
  if (
    applicationType === 'standalone' &&
    body.application_id !== undefined &&
    requestedApplicationId
  ) {
    return invalid(c, 'Standalone launchers must not reference an application');
  }
  const applicationId = applicationType === 'standalone' ? null : requestedApplicationId;
  const name = readRequiredString(body.name ?? existing?.name, 120);
  if (!name) return invalid(c, 'name is required');
  const launchType = readEnum(body.launch_type, LAUNCH_TYPES, existing?.launch_type ?? 'bookmark');
  const iconType = readEnum(body.icon_type, ICON_TYPES, existing?.icon_type ?? 'phosphor');
  const iconValue = readRequiredString(body.icon_value ?? existing?.icon_value, 2048);
  if (iconType === 'phosphor' && !PHOSPHOR_ICON_NAMES.has(iconValue)) {
    return invalid(c, 'icon_value is not an allowed Phosphor icon');
  }
  if (iconType === 'image' && readHttpsUrl(iconValue) === null) {
    return invalid(c, 'Image icons must use an HTTPS URL');
  }

  let launchUrl =
    body.launch_url === undefined ? (existing?.launch_url ?? null) : readHttpsUrl(body.launch_url);
  const deepLinkUrl =
    body.deep_link_url === undefined
      ? (existing?.deep_link_url ?? null)
      : readHttpsUrl(body.deep_link_url);
  if (
    body.launch_url !== undefined &&
    body.launch_url !== null &&
    body.launch_url !== '' &&
    !launchUrl
  ) {
    return invalid(c, 'launch_url must use HTTPS');
  }
  if (
    body.deep_link_url !== undefined &&
    body.deep_link_url !== null &&
    body.deep_link_url !== '' &&
    !deepLinkUrl
  ) {
    return invalid(c, 'deep_link_url must use HTTPS');
  }
  if (
    launchType === 'saml_idp_initiated' &&
    deepLinkUrl &&
    new TextEncoder().encode(deepLinkUrl).byteLength > 80
  ) {
    return invalid(c, 'deep_link_url for SAML IdP-initiated launch must not exceed 80 UTF-8 bytes');
  }
  if (launchType === 'saml_sp_initiated' && deepLinkUrl) {
    return invalid(
      c,
      'SAML SP-initiated launch must include any application deep link in launch_url'
    );
  }
  if (launchType !== 'saml_idp_initiated' && !launchUrl) {
    return invalid(c, 'launch_url is required for this launch type');
  }
  if (applicationType === 'oidc_client') {
    if (!applicationId) return invalid(c, 'OIDC applications require a registered client');
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const client = await authCtx.coreAdapter.queryOne<{ initiate_login_uri: string | null }>(
      `SELECT initiate_login_uri FROM oauth_clients WHERE tenant_id = ? AND client_id = ?`,
      [tenantId, applicationId]
    );
    if (!client) return invalid(c, 'The selected OIDC client is unavailable');
    if (launchType === 'oidc_third_party_initiated') {
      if (!client.initiate_login_uri) {
        return invalid(c, 'The selected OIDC client has no initiate_login_uri');
      }
      const registeredUrl = readHttpsUrl(client.initiate_login_uri);
      if (!registeredUrl || (launchUrl && launchUrl !== registeredUrl)) {
        return invalid(c, 'launch_url must match the OIDC client initiate_login_uri');
      }
      launchUrl = registeredUrl;
    }
  } else if (launchType === 'oidc_third_party_initiated') {
    return invalid(c, 'OIDC third-party initiated launch requires an OIDC application');
  }
  if (
    (launchType === 'saml_sp_initiated' || launchType === 'saml_idp_initiated') &&
    (applicationType !== 'saml_sp' || !applicationId)
  ) {
    return invalid(c, 'SAML launch types require a SAML SP application');
  }
  if (applicationType === 'saml_sp') {
    if (!applicationId)
      return invalid(c, 'SAML applications require a registered service provider');
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const provider = await authCtx.coreAdapter.queryOne<{ config_json: string }>(
      `SELECT config_json FROM identity_providers
        WHERE tenant_id = ? AND id = ? AND provider_type = 'saml_sp' AND enabled = 1`,
      [tenantId, applicationId]
    );
    if (!provider || !readSamlSpEntityId(provider.config_json)) {
      return invalid(c, 'The selected SAML SP application is unavailable');
    }
  }

  const rawVisibility =
    body.visibility && typeof body.visibility === 'object' && !Array.isArray(body.visibility)
      ? (body.visibility as Row)
      : {};
  const existingVisibility = existing?.visibility;
  const visibility: LauncherVisibility = {
    mode: readEnum(rawVisibility.mode, VISIBILITY_MODES, existingVisibility?.mode ?? 'everyone'),
    attribute_match: readEnum(
      rawVisibility.attribute_match,
      ATTRIBUTE_MATCHES,
      existingVisibility?.attribute_match ?? 'all'
    ),
    user_ids:
      rawVisibility.user_ids === undefined
        ? (existingVisibility?.user_ids ?? [])
        : readSubjectIds(rawVisibility.user_ids),
    group_ids:
      rawVisibility.group_ids === undefined
        ? (existingVisibility?.group_ids ?? [])
        : readSubjectIds(rawVisibility.group_ids),
    attribute_rules:
      rawVisibility.attribute_rules === undefined
        ? (existingVisibility?.attribute_rules ?? [])
        : readAttributeRules(rawVisibility.attribute_rules),
  };
  if (visibility.mode === 'users' && visibility.user_ids.length === 0) {
    return invalid(c, 'At least one user is required for user visibility');
  }
  if (visibility.mode === 'groups' && visibility.group_ids.length === 0) {
    return invalid(c, 'At least one group is required for group visibility');
  }
  if (visibility.mode === 'attributes' && visibility.attribute_rules.length === 0) {
    return invalid(c, 'At least one attribute rule is required for attribute visibility');
  }

  return {
    application_type: applicationType,
    application_id: applicationId,
    name,
    description:
      body.description === undefined
        ? (existing?.description ?? null)
        : readString(body.description, 1000),
    category:
      body.category === undefined ? (existing?.category ?? null) : readString(body.category, 100),
    launch_type: launchType,
    launch_url: launchUrl,
    deep_link_url: deepLinkUrl,
    open_in_new_tab: readBoolean(body.open_in_new_tab, existing?.open_in_new_tab ?? false),
    icon_type: iconType,
    icon_value: iconValue,
    icon_color: readColor(body.icon_color, existing?.icon_color ?? '#ffffff'),
    background_color: readColor(body.background_color, existing?.background_color ?? '#2563eb'),
    tile_background_color:
      body.tile_background_color === undefined
        ? (existing?.tile_background_color ?? null)
        : readNullableColor(body.tile_background_color),
    background_image_url:
      body.background_image_url === undefined
        ? (existing?.background_image_url ?? null)
        : readBackgroundImageUrl(body.background_image_url),
    hide_icon: readBoolean(body.hide_icon, existing?.hide_icon ?? false),
    hide_name: readBoolean(body.hide_name, existing?.hide_name ?? false),
    grid_width: readInteger(body.grid_width, existing?.grid_width ?? 2, 1, 8),
    sort_order: readInteger(body.sort_order, existing?.sort_order ?? 0, 0, 1000000),
    enabled: readBoolean(body.enabled, existing?.enabled ?? true),
    allow_favorite: readBoolean(body.allow_favorite, existing?.allow_favorite ?? true),
    visibility,
  };
}

/** The most launchers a tenant may have of its own (the platform's shared ones are not counted). */
const TENANT_LAUNCHER_LIMIT = 500;
const SHARED_PARTITION = 'platform-launchers';

/**
 * A tenant's own state of a platform launcher shared with it (core shared_launcher_states): whether
 * it hides it, its place, and its copy (the tenant changed the launcher) with the platform version
 * the copy was made from. Each is written on its own, so a move does not undo a change.
 */
interface SharedOverlay {
  hidden: boolean;
  sort_order: number | null;
  copy_from_version: number | null;
  copy: ApplicationLauncher | null;
  updated_at: number;
}

interface SharedStateRow {
  launcher_id: string;
  hidden: number;
  sort_order: number | null;
  copy_json: string | null;
  copy_from_version: number | null;
  updated_at: number;
}

interface TenantLaunchers {
  /** The tenant's own launchers. */
  own: ApplicationLauncher[];
  /** The tenant's state of each shared launcher it has one for, by the platform launcher's id. */
  overlays: Map<string, SharedOverlay>;
  /** The platform launchers shared with the tenant. */
  shared: PlatformLauncher[];
  /** False when the platform launchers could not be read (lenient reads only). */
  sharedComplete: boolean;
  /** Every platform launcher shared with the tenant, offered or turned off for now. */
  sharedIds: Set<string>;
  /** What the tenant lists: its own and the shared ones (as the tenant shows them), in order. */
  items: TenantLauncherListItem[];
}

function ownLauncher(row: LauncherRow): ApplicationLauncher {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.config_json);
  } catch {
    throw new Error(`Invalid application launcher JSON: ${row.id}`);
  }
  const launcher = storedLauncher(parsed);
  if (!launcher || launcher.id !== row.id) {
    throw new Error(`Invalid application launcher configuration: ${row.id}`);
  }
  return { ...launcher, created_at: row.created_at, updated_at: row.updated_at };
}

/** A stored state; a copy that cannot be read is left out (the platform's launcher shows). */
function readOverlay(row: SharedStateRow): SharedOverlay {
  let copy: ApplicationLauncher | null = null;
  if (row.copy_json !== null && row.copy_from_version !== null) {
    try {
      const launcher = storedLauncher(JSON.parse(row.copy_json));
      copy = launcher && launcher.application_type === 'standalone' ? launcher : null;
    } catch {
      copy = null;
    }
  }
  const sortOrder = row.sort_order === null ? null : Number(row.sort_order);
  return {
    hidden: Number(row.hidden) === 1,
    sort_order:
      sortOrder !== null && Number.isInteger(sortOrder) && sortOrder >= 0 && sortOrder <= 1_000_000
        ? sortOrder
        : null,
    copy_from_version: copy ? Number(row.copy_from_version) : null,
    copy,
    updated_at: Number(row.updated_at),
  };
}

/** The platform launcher as stored, without the platform's own columns. */
function platformContent(platform: PlatformLauncher): ApplicationLauncher {
  const {
    share_mode: _shareMode,
    tenant_ids: _tenantIds,
    tenant_change_allowed: _changeAllowed,
    version: _version,
    ...launcher
  } = platform;
  return launcher;
}

/**
 * A shared launcher as the tenant shows it. While the platform allows tenants to change it, the
 * tenant's copy (if any) is what is shown and the tenant may hide it; otherwise the platform's is
 * shown as it is (a copy is kept, set aside). The tenant's place for it applies either way. (A
 * launcher the platform turned off is not offered at all.)
 */
function sharedItem(
  platform: PlatformLauncher,
  overlay: SharedOverlay | undefined
): TenantLauncherListItem {
  const changeAllowed = platform.tenant_change_allowed;
  const content = (changeAllowed ? overlay?.copy : null) ?? platformContent(platform);
  const customized = Boolean(overlay?.copy);
  const shared: SharedLauncherState = {
    platform_version: platform.version,
    tenant_change_allowed: changeAllowed,
    customized,
    customized_from_version: customized ? (overlay?.copy_from_version ?? null) : null,
    platform_updated: customized && (overlay?.copy_from_version ?? 0) < platform.version,
  };
  return {
    ...content,
    id: platform.id,
    application_type: 'standalone',
    application_id: null,
    enabled: !(changeAllowed && overlay?.hidden === true),
    sort_order: overlay?.sort_order ?? platform.sort_order,
    created_at: platform.created_at,
    updated_at: Math.max(platform.updated_at, overlay?.updated_at ?? 0),
    shared,
  };
}

function byOrder(left: ApplicationLauncher, right: ApplicationLauncher): number {
  return left.sort_order === right.sort_order
    ? left.created_at - right.created_at || left.id.localeCompare(right.id)
    : left.sort_order - right.sort_order;
}

/**
 * The platform launchers shared with the request's tenant. `lenient` (the account page): when the
 * admin database cannot be read, the tenant's own launchers are shown alone rather than none, and
 * `complete` says so (what depends on knowing every shared launcher must then wait).
 */
async function readSharedLaunchers(
  c: LauncherContext,
  tenantId: string,
  lenient: boolean
): Promise<{ launchers: PlatformLauncher[]; complete: boolean }> {
  if (!c.env?.DB_ADMIN) return { launchers: [], complete: true };
  try {
    return {
      launchers: await listPlatformLaunchersSharedWith(
        requireDedicatedAdminDatabaseAdapter(c.env, SHARED_PARTITION),
        tenantId
      ),
      complete: true,
    };
  } catch (error) {
    if (!lenient) throw error;
    getLogger(c)
      .module('ACCOUNT_LAUNCHERS')
      .warn('Failed to read the platform launchers; showing the tenant’s own', {
        error: error instanceof Error ? error.message : 'unknown',
      });
    return { launchers: [], complete: false };
  }
}

/** The tenant's states of the shared launchers named (only these: a state left behind is not read). */
async function readOverlays(
  c: LauncherContext,
  tenantId: string,
  launcherIds: string[]
): Promise<Map<string, SharedOverlay>> {
  const overlays = new Map<string, SharedOverlay>();
  if (launcherIds.length === 0) return overlays;
  const authCtx = createAuthContextFromHono(c, tenantId);
  for (const ids of chunks(launcherIds)) {
    const rows = await authCtx.coreAdapter.query<SharedStateRow>(
      `SELECT launcher_id, hidden, sort_order, copy_json, copy_from_version, updated_at
         FROM shared_launcher_states
        WHERE tenant_id = ? AND launcher_id IN (${ids.map(() => '?').join(', ')})`,
      [tenantId, ...ids]
    );
    for (const row of rows) overlays.set(row.launcher_id, readOverlay(row));
  }
  return overlays;
}

async function readTenantLaunchers(
  c: LauncherContext,
  options: { lenient?: boolean } = {}
): Promise<TenantLaunchers> {
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const [rows, shared] = await Promise.all([
    authCtx.coreAdapter.query<LauncherRow>(
      `SELECT id, config_json, created_at, updated_at
         FROM application_launchers
        WHERE tenant_id = ?
        ORDER BY updated_at ASC, id ASC
        LIMIT ?`,
      [tenantId, TENANT_LAUNCHER_LIMIT + 1]
    ),
    readSharedLaunchers(c, tenantId, options.lenient === true),
  ]);
  if (rows.length > TENANT_LAUNCHER_LIMIT) {
    throw new Error('Application launcher limit exceeded');
  }
  const own = rows.map(ownLauncher).sort(byOrder);
  // A launcher the platform turned off is not offered to tenants at all (so a tenant's `enabled`
  // says only whether it hides it).
  const offered = shared.launchers.filter((launcher) => launcher.enabled);
  const sharedIds = new Set(shared.launchers.map((launcher) => launcher.id));
  const overlays = await readOverlays(
    c,
    tenantId,
    offered.map((launcher) => launcher.id)
  );
  const items: TenantLauncherListItem[] = [
    ...own.map((launcher) => ({ ...launcher, shared: null })),
    ...offered.map((platform) => sharedItem(platform, overlays.get(platform.id))),
  ].sort(byOrder);
  return { own, overlays, shared: offered, sharedIds, sharedComplete: shared.complete, items };
}

/** The launchers the tenant shows (own and shared, without their sharing state), in order. */
async function readLaunchers(
  c: LauncherContext,
  options: { lenient?: boolean } = {}
): Promise<{ launchers: ApplicationLauncher[]; sharedComplete: boolean; sharedIds: Set<string> }> {
  const collection = await readTenantLaunchers(c, options);
  return {
    launchers: collection.items.map(({ shared: _shared, ...launcher }) => launcher),
    sharedComplete: collection.sharedComplete,
    sharedIds: collection.sharedIds,
  };
}

/**
 * Writes what changed of the tenant's state of a shared launcher, and only that: whether it hides
 * it (`hidden`), and its copy (`copy`, null to drop it). A field left out keeps its stored value,
 * so a hide does not bring back a copy dropped meanwhile, nor a change undo a hide. The place is
 * the order's to write.
 */
async function writeSharedState(
  c: LauncherContext,
  id: string,
  state: {
    hidden?: boolean;
    copy?: { launcher: ApplicationLauncher; fromVersion: number } | null;
  },
  now: number
): Promise<void> {
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const hidden = state.hidden === undefined ? null : state.hidden ? 1 : 0;
  const copyJson = state.copy ? JSON.stringify(state.copy.launcher) : null;
  const fromVersion = state.copy ? state.copy.fromVersion : null;
  const sets = [
    ...(state.hidden === undefined ? [] : ['hidden = excluded.hidden']),
    ...(state.copy === undefined
      ? []
      : ['copy_json = excluded.copy_json', 'copy_from_version = excluded.copy_from_version']),
    'updated_at = excluded.updated_at',
  ];
  await authCtx.coreAdapter.execute(
    `INSERT INTO shared_launcher_states
       (tenant_id, launcher_id, hidden, sort_order, copy_json, copy_from_version,
        created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, launcher_id) DO UPDATE SET ${sets.join(', ')}`,
    [tenantId, id, hidden ?? 0, copyJson, fromVersion, now, now]
  );
}

/** The statement setting a shared launcher's place only (whether it is hidden or copied stays). */
const sharedOrderSql = `INSERT INTO shared_launcher_states
    (tenant_id, launcher_id, hidden, sort_order, copy_json, copy_from_version,
     created_at, updated_at)
  VALUES (?, ?, 0, ?, NULL, NULL, ?, ?)
  ON CONFLICT (tenant_id, launcher_id) DO UPDATE
    SET sort_order = excluded.sort_order, updated_at = excluded.updated_at`;

function chunks<T>(values: T[], size = 90): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function filterAvailableLinkedApplications(
  c: LauncherContext,
  launchers: ApplicationLauncher[]
): Promise<ApplicationLauncher[]> {
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const oidcIds = [
    ...new Set(
      launchers
        .filter((launcher) => launcher.application_type === 'oidc_client')
        .map((launcher) => launcher.application_id)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const samlIds = [
    ...new Set(
      launchers
        .filter((launcher) => launcher.application_type === 'saml_sp')
        .map((launcher) => launcher.application_id)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const oidcClients = new Map<string, string | null>();
  const samlProviders = new Set<string>();

  for (const ids of chunks(oidcIds)) {
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await authCtx.coreAdapter.query<{
      client_id: string;
      initiate_login_uri: string | null;
    }>(
      `SELECT client_id, initiate_login_uri FROM oauth_clients
        WHERE tenant_id = ? AND client_id IN (${placeholders})`,
      [tenantId, ...ids]
    );
    for (const row of rows) oidcClients.set(row.client_id, row.initiate_login_uri);
  }

  for (const ids of chunks(samlIds)) {
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await authCtx.coreAdapter.query<{ id: string; config_json: string }>(
      `SELECT id, config_json FROM identity_providers
        WHERE tenant_id = ? AND id IN (${placeholders})
          AND provider_type = 'saml_sp' AND enabled = 1`,
      [tenantId, ...ids]
    );
    for (const row of rows) {
      if (readSamlSpEntityId(row.config_json)) samlProviders.add(row.id);
    }
  }

  return launchers.filter((launcher) => {
    if (launcher.application_type === 'standalone') return true;
    if (!launcher.application_id) return false;
    if (launcher.application_type === 'saml_sp') {
      return samlProviders.has(launcher.application_id);
    }
    if (!oidcClients.has(launcher.application_id)) return false;
    if (launcher.launch_type !== 'oidc_third_party_initiated') return true;
    return readHttpsUrl(oidcClients.get(launcher.application_id)) === launcher.launch_url;
  });
}

async function recordAdminAudit(
  c: LauncherContext,
  event: string,
  launcherId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    await createAuditLogFromContext(c, event, 'application_launcher', launcherId, metadata);
  } catch (error) {
    getLogger(c)
      .module('ADMIN_LAUNCHERS')
      .warn('Failed to record launcher audit event', {
        event,
        launcher_id: launcherId,
        error: error instanceof Error ? error.message : 'unknown',
      });
  }
}

export async function adminLaunchersListHandler(c: LauncherContext): Promise<Response> {
  try {
    return c.json({ launchers: (await readTenantLaunchers(c)).items });
  } catch (error) {
    getLogger(c)
      .module('ADMIN_LAUNCHERS')
      .error('Failed to list launchers', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to list launchers' }, 500);
  }
}

export async function adminLauncherGetHandler(c: LauncherContext): Promise<Response> {
  try {
    const id = c.req.param('id');
    if (!id) return notFound(c);
    const launcher = (await readTenantLaunchers(c)).items.find((entry) => entry.id === id);
    if (!launcher) return notFound(c);
    return c.json({ launcher });
  } catch (error) {
    getLogger(c)
      .module('ADMIN_LAUNCHERS')
      .error('Failed to read launcher', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to read launcher' }, 500);
  }
}

export async function adminLauncherOptionsHandler(c: LauncherContext): Promise<Response> {
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const [clients, groups, attributeKeys] = await Promise.all([
      authCtx.coreAdapter.query<{
        client_id: string;
        client_name: string;
        initiate_login_uri: string | null;
        logo_uri: string | null;
      }>(
        `SELECT client_id, client_name, initiate_login_uri, logo_uri
           FROM oauth_clients WHERE tenant_id = ? ORDER BY client_name ASC`,
        [tenantId]
      ),
      authCtx.coreAdapter.query<{ id: string; group_key: string; display_name: string }>(
        `SELECT id, group_key, display_name FROM "groups"
          WHERE tenant_id = ? AND lifecycle_state = 'active' ORDER BY display_name ASC`,
        [tenantId]
      ),
      authCtx.coreAdapter.query<{ field_key: string }>(
        `SELECT field_key FROM custom_claim_schemas
          WHERE tenant_id = ? AND is_active = 1 AND operation_status = 'active'
          ORDER BY display_order ASC, field_key ASC LIMIT 200`,
        [tenantId]
      ),
    ]);
    return c.json({
      oidc_clients: clients,
      groups,
      attribute_keys: [
        ...new Set([
          'email',
          'email_verified',
          'name',
          'given_name',
          'family_name',
          'locale',
          'user_id',
          ...attributeKeys.map((entry) => entry.field_key),
        ]),
      ],
      phosphor_icons: [...PHOSPHOR_ICON_NAMES],
    });
  } catch (error) {
    getLogger(c)
      .module('ADMIN_LAUNCHERS')
      .error('Failed to load launcher options', {}, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to load launcher options' },
      500
    );
  }
}

export async function adminLauncherCreateHandler(c: LauncherContext): Promise<Response> {
  try {
    const body = await readJsonObject(c);
    if (body instanceof Response) return body;
    const input = await normalizeLauncherInput(c, body);
    if (input instanceof Response) return input;
    const { own } = await readTenantLaunchers(c);
    if (own.length >= TENANT_LAUNCHER_LIMIT) {
      return invalid(c, `A tenant can have at most ${TENANT_LAUNCHER_LIMIT} launchers`);
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    const launcher: ApplicationLauncher = { id, ...input, created_at: now, updated_at: now };
    const item: TenantLauncherListItem = { ...launcher, shared: null };
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    // The limit is checked in the statement too, so two created at once cannot pass it together.
    const inserted = await authCtx.coreAdapter.execute(
      `INSERT INTO application_launchers
        (tenant_id, id, config_json, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM application_launchers WHERE tenant_id = ?) < ?`,
      [tenantId, id, JSON.stringify(launcher), now, now, tenantId, TENANT_LAUNCHER_LIMIT]
    );
    if (inserted.rowsAffected !== 1) {
      return invalid(c, `A tenant can have at most ${TENANT_LAUNCHER_LIMIT} launchers`);
    }
    await recordAdminAudit(c, 'launcher.created', id, {
      launch_type: input.launch_type,
      application_type: input.application_type,
      visibility_mode: input.visibility.mode,
    });
    return c.json({ launcher: item }, 201);
  } catch (error) {
    getLogger(c)
      .module('ADMIN_LAUNCHERS')
      .error('Failed to create launcher', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to create launcher' }, 500);
  }
}

function sharedLocked(c: LauncherContext): Response {
  return c.json(
    {
      error: 'access_denied',
      error_description: 'The platform does not allow tenants to change this launcher',
    },
    403
  );
}

/** The fields a copy is compared on: what the launcher shows, not whether or where. */
function contentKey(launcher: ApplicationLauncher | NormalizedLauncherInput): string {
  const { enabled: _enabled, sort_order: _sortOrder, ...content } = launcher as ApplicationLauncher;
  const { id: _id, created_at: _created, updated_at: _updated, ...rest } = content;
  return JSON.stringify(
    Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)))
  );
}

/**
 * A tenant's change to a shared launcher (allowed while the platform allows it): `enabled` false
 * hides it; any other change makes the tenant's copy (from the platform version it was made from),
 * and a change back to the platform's launcher drops the copy.
 */
async function updateSharedLauncher(
  c: LauncherContext,
  body: Row,
  platform: PlatformLauncher,
  overlay: SharedOverlay | undefined,
  current: TenantLauncherListItem
): Promise<Response> {
  if (!platform.tenant_change_allowed) return sharedLocked(c);
  const input = await normalizeLauncherInput(c, body, current, 'copy');
  if (input instanceof Response) return input;
  const now = Date.now();
  const base = platformContent(platform);
  let copy: ApplicationLauncher | null = null;
  let copyFromVersion: number | null = null;
  if (contentKey(input) !== contentKey(base)) {
    copy = {
      ...input,
      id: platform.id,
      enabled: true,
      created_at: platform.created_at,
      updated_at: now,
    };
    // A copy keeps the platform version it was first made from: changing it does not take over a
    // later platform change (reverting does). A new copy is made from the version the admin was
    // shown (`platform_version`), never a later one they did not see.
    const shown =
      typeof body.platform_version === 'number' &&
      Number.isSafeInteger(body.platform_version) &&
      body.platform_version >= 1
        ? Math.min(body.platform_version, platform.version)
        : platform.version;
    copyFromVersion = overlay?.copy ? (overlay.copy_from_version ?? shown) : shown;
  }
  // Only what this change changes is written (the place is the order's): whether it is hidden,
  // when that changed, and the copy, when its content changed.
  const hiddenChanged = input.enabled !== current.enabled;
  const copyChanged =
    (copy === null) !== !overlay?.copy ||
    (copy !== null && overlay?.copy != null && contentKey(copy) !== contentKey(overlay.copy));
  const next = {
    hidden: hiddenChanged ? !input.enabled : (overlay?.hidden ?? false),
    sort_order: overlay?.sort_order ?? null,
    copy_from_version: copyChanged ? copyFromVersion : (overlay?.copy_from_version ?? null),
    copy: copyChanged ? copy : (overlay?.copy ?? null),
  };
  if (hiddenChanged || copyChanged) {
    await writeSharedState(
      c,
      platform.id,
      {
        ...(hiddenChanged ? { hidden: next.hidden } : {}),
        ...(copyChanged
          ? {
              copy: copy
                ? { launcher: copy, fromVersion: copyFromVersion ?? platform.version }
                : null,
            }
          : {}),
      },
      now
    );
  }
  await recordAdminAudit(c, 'launcher.shared_updated', platform.id, {
    hidden: next.hidden,
    customized: copy !== null,
    platform_version: platform.version,
    visibility_mode: input.visibility.mode,
  });
  return c.json({ launcher: sharedItem(platform, { ...next, updated_at: now }) });
}

export async function adminLauncherUpdateHandler(c: LauncherContext): Promise<Response> {
  try {
    const id = c.req.param('id');
    if (!id) return notFound(c);
    const collection = await readTenantLaunchers(c);
    const platform = collection.shared.find((entry) => entry.id === id);
    const existing = collection.own.find((entry) => entry.id === id);
    if (!platform && !existing) return notFound(c);
    const body = await readJsonObject(c);
    if (body instanceof Response) return body;
    if (platform) {
      const current = collection.items.find((entry) => entry.id === id);
      if (!current) return notFound(c);
      return await updateSharedLauncher(c, body, platform, collection.overlays.get(id), current);
    }
    if (!existing) return notFound(c);
    const input = await normalizeLauncherInput(c, body, existing);
    if (input instanceof Response) return input;
    const now = Date.now();
    const updated: ApplicationLauncher = {
      id,
      ...input,
      created_at: existing.created_at,
      updated_at: now,
    };
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    await authCtx.coreAdapter.execute(
      `UPDATE application_launchers
          SET config_json = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?`,
      [JSON.stringify(updated), now, tenantId, id]
    );
    await recordAdminAudit(c, 'launcher.updated', id, {
      launch_type: input.launch_type,
      visibility_mode: input.visibility.mode,
    });
    return c.json({ launcher: { ...updated, shared: null } });
  } catch (error) {
    getLogger(c)
      .module('ADMIN_LAUNCHERS')
      .error('Failed to update launcher', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to update launcher' }, 500);
  }
}

/**
 * Drops a tenant's copy of a shared launcher: the platform's launcher shows again (whether the
 * tenant hides it, and its place, are kept). Only while the platform allows changes: otherwise the
 * copy is kept as it is, set aside (403).
 */
export async function adminLauncherCustomizationDeleteHandler(
  c: LauncherContext
): Promise<Response> {
  try {
    const id = c.req.param('id');
    if (!id) return notFound(c);
    const collection = await readTenantLaunchers(c);
    const platform = collection.shared.find((entry) => entry.id === id);
    if (!platform) return notFound(c);
    // While the platform does not allow changes, the tenant's copy is kept as it is (set aside).
    if (!platform.tenant_change_allowed) return sharedLocked(c);
    const overlay = collection.overlays.get(id);
    if (overlay?.copy) {
      const now = Date.now();
      const next = { ...overlay, copy: null, copy_from_version: null };
      const tenantId = getTenantIdFromContext(c);
      await createAuthContextFromHono(c, tenantId).coreAdapter.execute(
        `UPDATE shared_launcher_states
            SET copy_json = NULL, copy_from_version = NULL, updated_at = ?
          WHERE tenant_id = ? AND launcher_id = ?`,
        [now, tenantId, id]
      );
      await recordAdminAudit(c, 'launcher.shared_reverted', id, {
        platform_version: platform.version,
      });
      return c.json({ launcher: sharedItem(platform, { ...next, updated_at: now }) });
    }
    return c.json({ launcher: sharedItem(platform, overlay) });
  } catch (error) {
    getLogger(c)
      .module('ADMIN_LAUNCHERS')
      .error('Failed to revert launcher', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to revert launcher' }, 500);
  }
}

export async function adminLauncherOrderHandler(c: LauncherContext): Promise<Response> {
  try {
    const body = await readJsonObject(c);
    if (body instanceof Response) return body;
    if (!Array.isArray(body.launcher_ids)) {
      return invalid(c, 'launcher_ids must be an array');
    }
    const rawIds: unknown[] = body.launcher_ids;
    if (
      rawIds.length > TENANT_LAUNCHER_LIMIT + PLATFORM_LAUNCHER_LIMIT ||
      rawIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(id)) ||
      new Set(rawIds).size !== rawIds.length
    ) {
      return invalid(c, 'launcher_ids must contain unique safe launcher identifiers');
    }
    const launcherIds = rawIds as string[];

    // The tenant orders its own launchers and the shared ones together (the place of a shared one
    // is the tenant's even when the platform does not allow changing it).
    const collection = await readTenantLaunchers(c);
    const currentIds = new Set(collection.items.map((launcher) => launcher.id));
    if (
      launcherIds.length !== collection.items.length ||
      launcherIds.some((id) => !currentIds.has(id))
    ) {
      return c.json(
        {
          error: 'conflict',
          error_description: 'Launcher collection changed. Refresh and try again.',
        },
        409
      );
    }

    const ownById = new Map(collection.own.map((launcher) => [launcher.id, launcher]));
    const sharedById = new Map(collection.shared.map((launcher) => [launcher.id, launcher]));
    const now = Date.now();
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const ordered: TenantLauncherListItem[] = [];
    launcherIds.forEach((id, index) => {
      const sortOrder = index * 10;
      const own = ownById.get(id);
      if (own) {
        const launcher = { ...own, sort_order: sortOrder, updated_at: now };
        statements.push({
          sql: `UPDATE application_launchers
                   SET config_json = ?, updated_at = ?
                 WHERE tenant_id = ? AND id = ?`,
          params: [JSON.stringify(launcher), now, tenantId, id],
        });
        ordered.push({ ...launcher, shared: null });
        return;
      }
      const platform = sharedById.get(id);
      if (!platform) throw new Error(`Launcher disappeared while reordering: ${id}`);
      const overlay = collection.overlays.get(id);
      // Only the place is written: a hide or copy saved meanwhile stays.
      const next = {
        hidden: overlay?.hidden ?? false,
        sort_order: sortOrder,
        copy_from_version: overlay?.copy_from_version ?? null,
        copy: overlay?.copy ?? null,
      };
      statements.push({ sql: sharedOrderSql, params: [tenantId, id, sortOrder, now, now] });
      ordered.push(sharedItem(platform, { ...next, updated_at: now }));
    });
    await authCtx.coreAdapter.batch(statements);
    await recordAdminAudit(c, 'launcher.reordered', tenantId, {
      launcher_ids: launcherIds,
    });
    return c.json({ launchers: ordered });
  } catch (error) {
    getLogger(c)
      .module('ADMIN_LAUNCHERS')
      .error('Failed to reorder launchers', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to reorder launchers' }, 500);
  }
}

export async function adminLauncherDeleteHandler(c: LauncherContext): Promise<Response> {
  try {
    const id = c.req.param('id');
    if (!id) return notFound(c);
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    // Only the launcher itself is read: a tenant that somehow holds more than its most can still
    // delete its way back under it.
    const row = await authCtx.coreAdapter.queryOne<LauncherRow>(
      `SELECT id, config_json, created_at, updated_at
         FROM application_launchers
        WHERE tenant_id = ? AND id = ?`,
      [tenantId, id]
    );
    if (!row) {
      const shared = await readSharedLaunchers(c, tenantId, false);
      if (shared.launchers.some((entry) => entry.id === id)) {
        return c.json(
          {
            error: 'shared_launcher',
            error_description:
              'A launcher the platform shares cannot be deleted by a tenant; hide it instead',
          },
          409
        );
      }
      return notFound(c);
    }
    const existing = ownLauncher(row);
    await authCtx.coreAdapter.execute(
      'DELETE FROM application_launchers WHERE tenant_id = ? AND id = ?',
      [tenantId, id]
    );
    await recordAdminAudit(c, 'launcher.deleted', id, {
      launch_type: existing.launch_type,
      application_type: existing.application_type,
    });
    return c.body(null, 204);
  } catch (error) {
    getLogger(c)
      .module('ADMIN_LAUNCHERS')
      .error('Failed to delete launcher', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to delete launcher' }, 500);
  }
}

function attributeRuleMatches(
  rule: LauncherAttributeRule,
  attributes: Map<string, string[]>
): boolean {
  const values = attributes.get(rule.attribute_key) ?? [];
  if (rule.operator === 'exists') return values.length > 0;
  const expected = rule.attribute_value ?? '';
  switch (rule.operator) {
    case 'equals':
      return values.some((value) => value === expected);
    case 'not_equals':
      return values.length > 0 && values.every((value) => value !== expected);
    case 'contains':
      return values.some((value) => value.includes(expected));
    case 'starts_with':
      return values.some((value) => value.startsWith(expected));
    case 'ends_with':
      return values.some((value) => value.endsWith(expected));
  }
}

async function resolveAccountAudience(
  c: LauncherContext,
  userId: string,
  launchers: ApplicationLauncher[]
): Promise<{
  groupIds: Set<string>;
  attributes: Map<string, string[]>;
}> {
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAccountAuthContextFromHono(c, tenantId);
  const piiCtx = createPIIContextFromHono(c, tenantId);
  const runtimeUsers = new CanonicalRuntimeUserStore({
    coreAdapter: authCtx.coreAdapter,
    piiAdapter: piiCtx.defaultPiiAdapter,
    tenantId,
  });
  const standardKeys = new Set([
    'email',
    'email_verified',
    'name',
    'given_name',
    'family_name',
    'locale',
    'user_id',
  ]);
  const customFieldKeys = [
    ...new Set(
      launchers
        .flatMap((launcher) => launcher.visibility.attribute_rules)
        .map((rule) => rule.attribute_key)
        .filter((key) => !standardKeys.has(key) && !key.startsWith('verified.'))
        .map((key) => (key.startsWith('custom.') ? key.slice('custom.'.length) : key))
        .filter(Boolean)
    ),
  ];
  const customClaimSources = await resolveCustomClaimRuntimeSourcesFromHono(c, tenantId);
  const customClaimResolver = createCustomClaimSchemaResolverFromSources({
    ...customClaimSources,
    cache: null,
  });
  const now = Date.now();
  const [user, groups, customClaims, verifiedAttributes] = await Promise.all([
    runtimeUsers.findById(userId),
    authCtx.coreAdapter.query<{ group_id: string }>(
      `SELECT group_id FROM group_memberships
        WHERE tenant_id = ? AND (subject_id = ? OR account_id = ?) AND lifecycle_state = 'active'
          AND (starts_at IS NULL OR starts_at <= ?)
          AND (expires_at IS NULL OR expires_at > ?)`,
      [tenantId, userId, userId, now, now]
    ),
    customClaimResolver.resolveFieldValues(tenantId, userId, customFieldKeys),
    authCtx.coreAdapter.query<{ attribute_name: string; attribute_value: string }>(
      `SELECT attribute_name, attribute_value FROM user_verified_attributes
        WHERE tenant_id = ? AND user_id = ? AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`,
      [tenantId, userId]
    ),
  ]);
  const attributes = new Map<string, string[]>();
  const add = (key: string, value: unknown) => {
    if (Array.isArray(value)) {
      for (const entry of value) add(key, entry);
      return;
    }
    if (value === undefined || value === null || value === '') return;
    if (!['boolean', 'number', 'string'].includes(typeof value)) return;
    const normalized = String(value as boolean | number | string);
    attributes.set(key, [...(attributes.get(key) ?? []), normalized]);
  };
  add('user_id', userId);
  add('email', user?.email);
  add('email_verified', user?.email_verified === 1);
  add('name', user?.name);
  add('given_name', user?.given_name);
  add('family_name', user?.family_name);
  add('locale', user?.locale);
  for (const [fieldKey, value] of Object.entries(customClaims.claims)) {
    add(fieldKey, value);
    add(`custom.${fieldKey}`, value);
  }
  for (const attribute of verifiedAttributes) {
    add(attribute.attribute_name, attribute.attribute_value);
    add(`verified.${attribute.attribute_name}`, attribute.attribute_value);
  }
  return { groupIds: new Set(groups.map((entry) => entry.group_id)), attributes };
}

export function launcherVisibleToAccount(
  launcher: ApplicationLauncher,
  userId: string,
  audience: Awaited<ReturnType<typeof resolveAccountAudience>>
): boolean {
  const visibility = launcher.visibility;
  switch (visibility.mode) {
    case 'everyone':
      return true;
    case 'users':
      return visibility.user_ids.includes(userId);
    case 'groups':
      return visibility.group_ids.some((groupId) => audience.groupIds.has(groupId));
    case 'attributes': {
      if (visibility.attribute_rules.length === 0) return false;
      const results = visibility.attribute_rules.map((rule) =>
        attributeRuleMatches(rule, audience.attributes)
      );
      return visibility.attribute_match === 'any' ? results.some(Boolean) : results.every(Boolean);
    }
  }
}

async function visibleAccountLaunchers(
  c: LauncherContext,
  userId: string,
  definitions?: ApplicationLauncher[]
): Promise<ApplicationLauncher[]> {
  const enabledLaunchers = (
    definitions ?? (await readLaunchers(c, { lenient: true })).launchers
  ).filter((launcher) => launcher.enabled);
  const launchers = await filterAvailableLinkedApplications(c, enabledLaunchers);
  if (launchers.every((launcher) => launcher.visibility.mode === 'everyone')) return launchers;
  const audience = await resolveAccountAudience(c, userId, launchers);
  return launchers.filter((launcher) => launcherVisibleToAccount(launcher, userId, audience));
}

export function accountLauncher(launcher: ApplicationLauncher, favorite: boolean): AccountLauncher {
  return {
    id: launcher.id,
    name: launcher.name,
    description: launcher.description,
    category: launcher.category,
    launch_type: launcher.launch_type,
    open_in_new_tab: launcher.open_in_new_tab,
    icon_type: launcher.icon_type,
    icon_value: launcher.icon_value,
    icon_color: launcher.icon_color,
    background_color: launcher.background_color,
    tile_background_color: launcher.tile_background_color,
    background_image_url: launcher.background_image_url,
    hide_icon: launcher.hide_icon,
    hide_name: launcher.hide_name,
    grid_width: launcher.grid_width,
    sort_order: launcher.sort_order,
    enabled: launcher.enabled,
    allow_favorite: launcher.allow_favorite,
    created_at: launcher.created_at,
    updated_at: launcher.updated_at,
    favorite,
    launch_href: `/api/account/launchers/${encodeURIComponent(launcher.id)}/launch`,
  };
}

export async function getAccountLaunchersHandler(c: LauncherContext): Promise<Response> {
  c.header('Cache-Control', 'private, no-store');
  const session = await requireAccountSession(c);
  if (session instanceof Response) return session;
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAccountAuthContextFromHono(c, tenantId);
    const {
      launchers: definitions,
      sharedComplete,
      sharedIds,
    } = await readLaunchers(c, { lenient: true });
    const [launchers, favorites] = await Promise.all([
      visibleAccountLaunchers(c, session.userId, definitions),
      authCtx.coreAdapter.query<{ launcher_id: string }>(
        'SELECT launcher_id FROM launcher_favorites WHERE tenant_id = ? AND user_id = ?',
        [tenantId, session.userId]
      ),
    ]);
    const definitionsById = new Map(definitions.map((launcher) => [launcher.id, launcher]));
    const staleFavoriteIds = [
      ...new Set(
        favorites
          .map((entry) => entry.launcher_id)
          .filter((id) => {
            const launcher = definitionsById.get(id);
            // Without the platform's launchers (their database could not be read), a shared one's
            // favourite is not known to be stale: it is kept.
            if (!launcher && !sharedComplete && PLATFORM_LAUNCHER_ID_PATTERN.test(id)) return false;
            // One the platform turned off for now is still shared: its favourite waits for it.
            if (!launcher && sharedIds.has(id)) return false;
            return !launcher || !launcher.allow_favorite;
          })
      ),
    ];
    if (staleFavoriteIds.length > 0) {
      try {
        await authCtx.coreAdapter.batch(
          chunks(staleFavoriteIds).map((ids) => ({
            sql: `DELETE FROM launcher_favorites
                   WHERE tenant_id = ? AND user_id = ?
                     AND launcher_id IN (${ids.map(() => '?').join(', ')})`,
            params: [tenantId, session.userId, ...ids],
          }))
        );
      } catch (error) {
        getLogger(c)
          .module('ACCOUNT_LAUNCHERS')
          .warn('Failed to remove stale launcher favorites', {
            stale_favorite_count: staleFavoriteIds.length,
            error: error instanceof Error ? error.message : 'unknown',
          });
      }
    }
    const favoriteIds = new Set(
      favorites
        .map((entry) => entry.launcher_id)
        .filter((id) => definitionsById.get(id)?.allow_favorite === true)
    );
    return c.json({
      launchers: launchers.map((launcher) =>
        accountLauncher(launcher, favoriteIds.has(launcher.id))
      ),
    });
  } catch (error) {
    getLogger(c)
      .module('ACCOUNT_LAUNCHERS')
      .error('Failed to list launchers', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to list launchers' }, 500);
  }
}

export async function buildLaunchTarget(
  c: LauncherContext,
  launcher: ApplicationLauncher
): Promise<string | null> {
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  if (launcher.application_type === 'saml_sp') {
    if (!launcher.application_id) return null;
    const provider = await authCtx.coreAdapter.queryOne<{ config_json: string }>(
      `SELECT config_json FROM identity_providers
        WHERE tenant_id = ? AND id = ? AND provider_type = 'saml_sp' AND enabled = 1`,
      [tenantId, launcher.application_id]
    );
    if (!provider) return null;
    if (launcher.launch_type === 'saml_idp_initiated') {
      const entityId = readSamlSpEntityId(provider.config_json);
      if (!entityId) return null;
      const target = new URL('/saml/idp/init', getRequestAwareIssuerUrl(c, tenantId));
      target.searchParams.set('sp', entityId);
      if (launcher.deep_link_url) target.searchParams.set('relay_state', launcher.deep_link_url);
      return target.toString();
    }
    if (launcher.launch_type === 'saml_sp_initiated') return launcher.launch_url;
  }
  if (!launcher.launch_url) return null;
  if (launcher.launch_type === 'oidc_third_party_initiated') {
    if (!launcher.application_id) return null;
    const client = await authCtx.coreAdapter.queryOne<{ initiate_login_uri: string | null }>(
      'SELECT initiate_login_uri FROM oauth_clients WHERE tenant_id = ? AND client_id = ?',
      [tenantId, launcher.application_id]
    );
    if (readHttpsUrl(client?.initiate_login_uri) !== launcher.launch_url) return null;
    const target = new URL(launcher.launch_url);
    target.searchParams.set('iss', getRequestAwareIssuerUrl(c, tenantId));
    if (launcher.deep_link_url) target.searchParams.set('target_link_uri', launcher.deep_link_url);
    return target.toString();
  }
  return launcher.deep_link_url ?? launcher.launch_url;
}

export async function launchAccountLauncherHandler(c: LauncherContext): Promise<Response> {
  c.header('Cache-Control', 'private, no-store');
  const session = await requireAccountSession(c);
  if (session instanceof Response) return session;
  try {
    const id = c.req.param('id');
    if (!id) return notFound(c);
    const launcher = (await visibleAccountLaunchers(c, session.userId)).find(
      (entry) => entry.id === id
    );
    if (!launcher) return notFound(c);
    const target = await buildLaunchTarget(c, launcher);
    if (!target) {
      return c.json(
        { error: 'configuration_error', error_description: 'Launcher target is unavailable' },
        503
      );
    }
    await recordAccountOperation(c, {
      userId: session.userId,
      action: 'account.launcher.launched',
      resourceType: 'application_launcher',
      resourceId: launcher.id,
      metadata: { launch_type: launcher.launch_type },
    });
    return c.redirect(target, 302);
  } catch (error) {
    getLogger(c)
      .module('ACCOUNT_LAUNCHERS')
      .error('Failed to launch application', {}, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to launch application' },
      500
    );
  }
}

export async function setAccountLauncherFavoriteHandler(c: LauncherContext): Promise<Response> {
  c.header('Cache-Control', 'private, no-store');
  const session = await requireAccountSession(c);
  if (session instanceof Response) return session;
  try {
    const id = c.req.param('id');
    if (!id) return notFound(c);
    const launcher = (await visibleAccountLaunchers(c, session.userId)).find(
      (entry) => entry.id === id
    );
    if (!launcher) return notFound(c);
    if (!launcher.allow_favorite) {
      return c.json(
        { error: 'access_denied', error_description: 'This launcher cannot be favorited' },
        403
      );
    }
    const body = await readJsonObject(c);
    if (body instanceof Response) return body;
    if (typeof body.favorite !== 'boolean') return invalid(c, 'favorite must be a boolean');
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAccountAuthContextFromHono(c, tenantId);
    if (body.favorite) {
      await authCtx.coreAdapter.execute(
        `INSERT INTO launcher_favorites (tenant_id, user_id, launcher_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (tenant_id, user_id, launcher_id) DO NOTHING`,
        [tenantId, session.userId, launcher.id, Date.now()]
      );
    } else {
      await authCtx.coreAdapter.execute(
        'DELETE FROM launcher_favorites WHERE tenant_id = ? AND user_id = ? AND launcher_id = ?',
        [tenantId, session.userId, launcher.id]
      );
    }
    await recordAccountOperation(c, {
      userId: session.userId,
      action: body.favorite ? 'account.launcher.favorited' : 'account.launcher.unfavorited',
      resourceType: 'application_launcher',
      resourceId: launcher.id,
      metadata: {},
    });
    return c.json({ launcher_id: launcher.id, favorite: body.favorite });
  } catch (error) {
    getLogger(c)
      .module('ACCOUNT_LAUNCHERS')
      .error('Failed to update favorite', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to update favorite' }, 500);
  }
}
