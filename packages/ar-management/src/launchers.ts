import type { Context } from 'hono';
import type {
  AccountLauncher,
  ApplicationLauncher,
  Env,
  LauncherApplicationType,
  LauncherAttributeMatch,
  LauncherAttributeOperator,
  LauncherAttributeRule,
  LauncherIconType,
  LauncherLaunchType,
  LauncherVisibility,
  LauncherVisibilityMode,
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
  resolveCustomClaimRuntimeSourcesFromHono,
} from '@authrim/ar-lib-core';
import { requireAccountSession } from './account-page';
import { recordAccountOperation } from './account-operation-log';
import { getRequestAwareIssuerUrl } from './request-issuer';

type LauncherContext = Context<{ Bindings: Env }>;
type Row = Record<string, unknown>;
type LauncherRow = {
  id: string;
  config_json: string;
  created_at: number;
  updated_at: number;
};

const APPLICATION_TYPES = new Set<LauncherApplicationType>([
  'standalone',
  'oidc_client',
  'saml_sp',
]);
const LAUNCH_TYPES = new Set<LauncherLaunchType>([
  'bookmark',
  'saml_sp_initiated',
  'oidc_third_party_initiated',
  'saml_idp_initiated',
]);
const ICON_TYPES = new Set<LauncherIconType>(['phosphor', 'image']);
const VISIBILITY_MODES = new Set<LauncherVisibilityMode>([
  'everyone',
  'users',
  'groups',
  'attributes',
]);
const ATTRIBUTE_MATCHES = new Set<LauncherAttributeMatch>(['all', 'any']);
const ATTRIBUTE_OPERATORS = new Set<LauncherAttributeOperator>([
  'equals',
  'not_equals',
  'contains',
  'starts_with',
  'ends_with',
  'exists',
]);
const PHOSPHOR_ICON_NAMES = new Set([
  'airplane-tilt',
  'bank',
  'book-open',
  'books',
  'briefcase',
  'browser',
  'buildings',
  'calendar',
  'chart-line-up',
  'chat-circle-text',
  'cloud',
  'code',
  'compass',
  'database',
  'envelope-simple',
  'folder-open',
  'gear',
  'github-logo',
  'globe',
  'graduation-cap',
  'house',
  'identification-card',
  'key',
  'link',
  'monitor',
  'notebook',
  'presentation-chart',
  'rocket-launch',
  'shield-check',
  'shopping-cart',
  'student',
  'terminal-window',
  'users-three',
  'wrench',
]);

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

function readString(value: unknown, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function readRequiredString(value: unknown, maximum: number): string {
  return readString(value, maximum) ?? '';
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

function readEnum<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  return typeof value === 'string' && allowed.has(value as T) ? (value as T) : fallback;
}

function readHttpsUrl(value: unknown): string | null {
  const raw = readString(value, 2048);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function readColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value)
    ? value.toLowerCase()
    : fallback;
}

function readSamlSpEntityId(configJson: string): string | null {
  try {
    const config = JSON.parse(configJson) as Row;
    return readString(config.entityId, 2048);
  } catch {
    return null;
  }
}

function readSubjectIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => /^[A-Za-z0-9:._-]{1,200}$/u.test(entry))
    ),
  ].slice(0, 500);
}

function readAttributeRules(value: unknown): LauncherAttributeRule[] {
  if (!Array.isArray(value)) return [];
  const rules: LauncherAttributeRule[] = [];
  for (const entry of value.slice(0, 32)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Row;
    const key = readRequiredString(record.attribute_key, 128);
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(key)) continue;
    const operator = readEnum(record.operator, ATTRIBUTE_OPERATORS, 'equals');
    const attributeValue = operator === 'exists' ? null : readString(record.attribute_value, 500);
    if (operator !== 'exists' && attributeValue === null) continue;
    const rawId = readString(record.id, 100);
    rules.push({
      id: rawId && /^[A-Za-z0-9_-]{1,100}$/u.test(rawId) ? rawId : crypto.randomUUID(),
      attribute_key: key,
      operator,
      attribute_value: attributeValue,
    });
  }
  return rules;
}

type NormalizedLauncherInput = Omit<ApplicationLauncher, 'id' | 'created_at' | 'updated_at'>;

function validateLauncherBody(body: Row): string | null {
  const stringLimits: Array<[string, number]> = [
    ['application_id', 500],
    ['name', 120],
    ['description', 1000],
    ['category', 100],
    ['launch_url', 2048],
    ['deep_link_url', 2048],
    ['icon_value', 2048],
  ];
  for (const [key, maximum] of stringLimits) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return `${key} must be a string or null`;
    if (value.trim().length > maximum) return `${key} must not exceed ${maximum} characters`;
  }

  const enumInputs: Array<[string, Set<string>]> = [
    ['application_type', APPLICATION_TYPES],
    ['launch_type', LAUNCH_TYPES],
    ['icon_type', ICON_TYPES],
  ];
  for (const [key, allowed] of enumInputs) {
    const value = body[key];
    if (value !== undefined && (typeof value !== 'string' || !allowed.has(value))) {
      return `${key} is invalid`;
    }
  }
  if (
    body.launch_type === 'saml_idp_initiated' &&
    typeof body.deep_link_url === 'string' &&
    new TextEncoder().encode(body.deep_link_url.trim()).byteLength > 80
  ) {
    return 'deep_link_url for SAML IdP-initiated launch must not exceed 80 UTF-8 bytes';
  }

  for (const key of ['open_in_new_tab', 'enabled', 'allow_favorite']) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') {
      return `${key} must be a boolean`;
    }
  }
  for (const [key, minimum, maximum] of [
    ['grid_width', 1, 8],
    ['sort_order', 0, 1_000_000],
  ] as const) {
    const value = body[key];
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum)
    ) {
      return `${key} must be an integer from ${minimum} to ${maximum}`;
    }
  }
  for (const key of ['icon_color', 'background_color']) {
    const value = body[key];
    if (value !== undefined && (typeof value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value))) {
      return `${key} must be a six-digit hexadecimal color`;
    }
  }

  if (body.visibility !== undefined) {
    if (!body.visibility || typeof body.visibility !== 'object' || Array.isArray(body.visibility)) {
      return 'visibility must be an object';
    }
    const visibility = body.visibility as Row;
    if (
      visibility.mode !== undefined &&
      (typeof visibility.mode !== 'string' ||
        !VISIBILITY_MODES.has(visibility.mode as LauncherVisibilityMode))
    ) {
      return 'visibility.mode is invalid';
    }
    if (
      visibility.attribute_match !== undefined &&
      (typeof visibility.attribute_match !== 'string' ||
        !ATTRIBUTE_MATCHES.has(visibility.attribute_match as LauncherAttributeMatch))
    ) {
      return 'visibility.attribute_match is invalid';
    }
    for (const key of ['user_ids', 'group_ids']) {
      const value = visibility[key];
      if (
        value !== undefined &&
        (!Array.isArray(value) ||
          value.length > 500 ||
          value.some(
            (entry) => typeof entry !== 'string' || !/^[A-Za-z0-9:._-]{1,200}$/u.test(entry)
          ))
      ) {
        return `visibility.${key} must contain at most 500 safe identifiers`;
      }
    }
    const rules = visibility.attribute_rules;
    if (rules !== undefined) {
      if (!Array.isArray(rules) || rules.length > 32) {
        return 'visibility.attribute_rules must contain at most 32 rules';
      }
      for (const rule of rules) {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
          return 'Each attribute rule must be an object';
        }
        const record = rule as Row;
        if (
          typeof record.attribute_key !== 'string' ||
          !/^[A-Za-z0-9._-]{1,128}$/u.test(record.attribute_key)
        ) {
          return 'Attribute rule keys must be safe identifiers';
        }
        if (
          typeof record.operator !== 'string' ||
          !ATTRIBUTE_OPERATORS.has(record.operator as LauncherAttributeOperator)
        ) {
          return 'Attribute rule operators are invalid';
        }
        if (
          record.operator !== 'exists' &&
          (typeof record.attribute_value !== 'string' ||
            !record.attribute_value.trim() ||
            record.attribute_value.trim().length > 500)
        ) {
          return 'Attribute rule values must contain 1 to 500 characters';
        }
        if (
          record.id !== undefined &&
          (typeof record.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(record.id))
        ) {
          return 'Attribute rule IDs must be safe identifiers';
        }
      }
    }
  }
  return null;
}

async function normalizeLauncherInput(
  c: LauncherContext,
  body: Row,
  existing?: ApplicationLauncher
): Promise<NormalizedLauncherInput | Response> {
  const validationError = validateLauncherBody(body);
  if (validationError) return invalid(c, validationError);
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
    grid_width: readInteger(body.grid_width, existing?.grid_width ?? 2, 1, 8),
    sort_order: readInteger(body.sort_order, existing?.sort_order ?? 0, 0, 1000000),
    enabled: readBoolean(body.enabled, existing?.enabled ?? true),
    allow_favorite: readBoolean(body.allow_favorite, existing?.allow_favorite ?? true),
    visibility,
  };
}

function storedLauncher(value: unknown): ApplicationLauncher | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Row;
  if (validateLauncherBody(record)) return null;
  const id = readRequiredString(record.id, 100);
  const name = readRequiredString(record.name, 120);
  const applicationType = readEnum(record.application_type, APPLICATION_TYPES, 'standalone');
  const launchType = readEnum(record.launch_type, LAUNCH_TYPES, 'bookmark');
  const iconType = readEnum(record.icon_type, ICON_TYPES, 'phosphor');
  const iconValue = readRequiredString(record.icon_value, 2048);
  if (!/^[A-Za-z0-9_-]{1,100}$/u.test(id) || !name) return null;
  if (iconType === 'phosphor' && !PHOSPHOR_ICON_NAMES.has(iconValue)) return null;
  if (iconType === 'image' && readHttpsUrl(iconValue) === null) return null;
  const launchUrl = readHttpsUrl(record.launch_url);
  const deepLinkUrl = readHttpsUrl(record.deep_link_url);
  const applicationId =
    applicationType === 'standalone' ? null : readString(record.application_id, 500);
  if (launchType !== 'saml_idp_initiated' && !launchUrl) return null;
  if (
    launchType === 'saml_idp_initiated' &&
    deepLinkUrl &&
    new TextEncoder().encode(deepLinkUrl).byteLength > 80
  )
    return null;
  if (
    launchType === 'oidc_third_party_initiated' &&
    (applicationType !== 'oidc_client' || !applicationId)
  )
    return null;
  if (
    (launchType === 'saml_sp_initiated' || launchType === 'saml_idp_initiated') &&
    (applicationType !== 'saml_sp' || !applicationId)
  )
    return null;
  const rawVisibility =
    record.visibility && typeof record.visibility === 'object' && !Array.isArray(record.visibility)
      ? (record.visibility as Row)
      : {};
  const visibility: LauncherVisibility = {
    mode: readEnum(rawVisibility.mode, VISIBILITY_MODES, 'everyone'),
    attribute_match: readEnum(rawVisibility.attribute_match, ATTRIBUTE_MATCHES, 'all'),
    user_ids: readSubjectIds(rawVisibility.user_ids),
    group_ids: readSubjectIds(rawVisibility.group_ids),
    attribute_rules: readAttributeRules(rawVisibility.attribute_rules),
  };
  return {
    id,
    application_type: applicationType,
    application_id: applicationId,
    name,
    description: readString(record.description, 1000),
    category: readString(record.category, 100),
    launch_type: launchType,
    launch_url: launchUrl,
    deep_link_url: deepLinkUrl,
    open_in_new_tab: readBoolean(record.open_in_new_tab, false),
    icon_type: iconType,
    icon_value: iconValue,
    icon_color: readColor(record.icon_color, '#ffffff'),
    background_color: readColor(record.background_color, '#2563eb'),
    grid_width: readInteger(record.grid_width, 2, 1, 8),
    sort_order: readInteger(record.sort_order, 0, 0, 1000000),
    enabled: readBoolean(record.enabled, true),
    allow_favorite: readBoolean(record.allow_favorite, true),
    visibility,
    created_at: readInteger(record.created_at, 0, 0, Number.MAX_SAFE_INTEGER),
    updated_at: readInteger(record.updated_at, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

async function readLaunchers(
  c: LauncherContext,
  enabledOnly: boolean
): Promise<ApplicationLauncher[]> {
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const rows = await authCtx.coreAdapter.query<LauncherRow>(
    `SELECT id, config_json, created_at, updated_at
       FROM application_launchers
      WHERE tenant_id = ?
      ORDER BY updated_at ASC, id ASC
      LIMIT 501`,
    [tenantId]
  );
  if (rows.length > 500) {
    throw new Error('Application launcher limit exceeded');
  }
  const launchers = rows.map((row) => {
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
  });
  return launchers
    .filter((launcher) => !enabledOnly || launcher.enabled)
    .sort((left, right) =>
      left.sort_order === right.sort_order
        ? left.created_at - right.created_at || left.id.localeCompare(right.id)
        : left.sort_order - right.sort_order
    );
}

async function findLauncher(c: LauncherContext, id: string): Promise<ApplicationLauncher | null> {
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const row = await authCtx.coreAdapter.queryOne<LauncherRow>(
    `SELECT id, config_json, created_at, updated_at
       FROM application_launchers
      WHERE tenant_id = ? AND id = ?`,
    [tenantId, id]
  );
  if (!row) return null;
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
    return c.json({ launchers: await readLaunchers(c, false) });
  } catch (error) {
    getLogger(c)
      .module('ADMIN_LAUNCHERS')
      .error('Failed to list launchers', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to list launchers' }, 500);
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
    const existingLaunchers = await readLaunchers(c, false);
    if (existingLaunchers.length >= 500) {
      return invalid(c, 'A tenant can have at most 500 launchers');
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    const launcher: ApplicationLauncher = { id, ...input, created_at: now, updated_at: now };
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    await authCtx.coreAdapter.execute(
      `INSERT INTO application_launchers
        (tenant_id, id, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [tenantId, id, JSON.stringify(launcher), now, now]
    );
    await recordAdminAudit(c, 'launcher.created', id, {
      launch_type: input.launch_type,
      application_type: input.application_type,
      visibility_mode: input.visibility.mode,
    });
    return c.json({ launcher }, 201);
  } catch (error) {
    getLogger(c)
      .module('ADMIN_LAUNCHERS')
      .error('Failed to create launcher', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to create launcher' }, 500);
  }
}

export async function adminLauncherUpdateHandler(c: LauncherContext): Promise<Response> {
  try {
    const id = c.req.param('id');
    if (!id) return notFound(c);
    const existing = await findLauncher(c, id);
    if (!existing) return notFound(c);
    const body = await readJsonObject(c);
    if (body instanceof Response) return body;
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
    return c.json({ launcher: updated });
  } catch (error) {
    getLogger(c)
      .module('ADMIN_LAUNCHERS')
      .error('Failed to update launcher', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to update launcher' }, 500);
  }
}

export async function adminLauncherOrderHandler(c: LauncherContext): Promise<Response> {
  try {
    const body = await readJsonObject(c);
    if (body instanceof Response) return body;
    if (!Array.isArray(body.launcher_ids)) {
      return invalid(c, 'launcher_ids must be an array');
    }
    const launcherIds = body.launcher_ids;
    if (
      launcherIds.length > 500 ||
      launcherIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(id)) ||
      new Set(launcherIds).size !== launcherIds.length
    ) {
      return invalid(c, 'launcher_ids must contain unique safe launcher identifiers');
    }

    const launchers = await readLaunchers(c, false);
    const currentIds = new Set(launchers.map((launcher) => launcher.id));
    if (launcherIds.length !== launchers.length || launcherIds.some((id) => !currentIds.has(id))) {
      return c.json(
        {
          error: 'conflict',
          error_description: 'Launcher collection changed. Refresh and try again.',
        },
        409
      );
    }

    const byId = new Map(launchers.map((launcher) => [launcher.id, launcher]));
    const now = Date.now();
    const ordered = launcherIds.map((id, index) => {
      const launcher = byId.get(id);
      if (!launcher) throw new Error(`Launcher disappeared while reordering: ${id}`);
      return { ...launcher, sort_order: index * 10, updated_at: now };
    });
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    await authCtx.coreAdapter.batch(
      ordered.map((launcher) => ({
        sql: `UPDATE application_launchers
                 SET config_json = ?, updated_at = ?
               WHERE tenant_id = ? AND id = ?`,
        params: [JSON.stringify(launcher), now, tenantId, launcher.id],
      }))
    );
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
    const existing = await findLauncher(c, id);
    if (!existing) return notFound(c);
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
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
  const enabledLaunchers = (definitions ?? (await readLaunchers(c, false))).filter(
    (launcher) => launcher.enabled
  );
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
    const definitions = await readLaunchers(c, false);
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
