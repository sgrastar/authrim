/**
 * An application launcher's configuration as stored and as sent: the allowed values, the checks of
 * a request body, and the reading of a stored row. No database access (the checks of the
 * applications a launcher names are the handlers', launchers.ts).
 */
import type {
  ApplicationLauncher,
  LauncherApplicationType,
  LauncherAttributeMatch,
  LauncherAttributeOperator,
  LauncherAttributeRule,
  LauncherIconType,
  LauncherLaunchType,
  LauncherVisibility,
  LauncherVisibilityMode,
} from '@authrim/ar-lib-core';

export type Row = Record<string, unknown>;

export const APPLICATION_TYPES = new Set<LauncherApplicationType>([
  'standalone',
  'oidc_client',
  'saml_sp',
]);
export const LAUNCH_TYPES = new Set<LauncherLaunchType>([
  'bookmark',
  'saml_sp_initiated',
  'oidc_third_party_initiated',
  'saml_idp_initiated',
]);
export const ICON_TYPES = new Set<LauncherIconType>(['phosphor', 'image']);
export const VISIBILITY_MODES = new Set<LauncherVisibilityMode>([
  'everyone',
  'users',
  'groups',
  'attributes',
]);
export const ATTRIBUTE_MATCHES = new Set<LauncherAttributeMatch>(['all', 'any']);
export const ATTRIBUTE_OPERATORS = new Set<LauncherAttributeOperator>([
  'equals',
  'not_equals',
  'contains',
  'starts_with',
  'ends_with',
  'exists',
]);
export const PHOSPHOR_ICON_NAMES = new Set([
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

export function readString(value: unknown, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

export function readRequiredString(value: unknown, maximum: number): string {
  return readString(value, maximum) ?? '';
}

export function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function readInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

export function readEnum<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  return typeof value === 'string' && allowed.has(value as T) ? (value as T) : fallback;
}

export function readHttpsUrl(value: unknown): string | null {
  const raw = readString(value, 2048);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function readColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value)
    ? value.toLowerCase()
    : fallback;
}

/**
 * An uploaded launcher background of this environment: a tenant's own
 * (`/api/assets/<tenant>/login-ui/launcher-background/<file>`) or the platform's
 * (`/api/assets/_platform/...`, see platform-launchers). Same-origin, served by the public assets
 * route.
 */
export const UPLOADED_BACKGROUND_PATH =
  /^\/api\/assets\/(?:_platform|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\/login-ui\/launcher-background\/[A-Za-z0-9-]{1,64}\.(?:gif|jpe?g|png|webp)$/u;

/** A tile background image: an uploaded one (a path of this origin) or an HTTPS URL; else null. */
export function readBackgroundImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 2048) return null;
  if (UPLOADED_BACKGROUND_PATH.test(raw)) return raw;
  return readHttpsUrl(raw);
}

/** A colour that may be left unset (null): anything that is not `#rrggbb` reads as unset. */
export function readNullableColor(value: unknown): string | null {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value) ? value.toLowerCase() : null;
}

export function readSamlSpEntityId(configJson: string): string | null {
  try {
    const config = JSON.parse(configJson) as Row;
    return readString(config.entityId, 2048);
  } catch {
    return null;
  }
}

export function readSubjectIds(value: unknown): string[] {
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

export function readAttributeRules(value: unknown): LauncherAttributeRule[] {
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

export type NormalizedLauncherInput = Omit<ApplicationLauncher, 'id' | 'created_at' | 'updated_at'>;

export function validateLauncherBody(body: Row): string | null {
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

  if (
    body.background_image_url !== undefined &&
    body.background_image_url !== null &&
    body.background_image_url !== '' &&
    readBackgroundImageUrl(body.background_image_url) === null
  ) {
    return 'background_image_url must be an HTTPS URL or an uploaded launcher background';
  }
  for (const key of ['open_in_new_tab', 'enabled', 'allow_favorite', 'hide_icon', 'hide_name']) {
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
  if (
    body.tile_background_color !== undefined &&
    body.tile_background_color !== null &&
    (typeof body.tile_background_color !== 'string' ||
      !/^#[0-9a-f]{6}$/iu.test(body.tile_background_color))
  ) {
    return 'tile_background_color must be null or a six-digit hexadecimal color';
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

export function storedLauncher(value: unknown): ApplicationLauncher | null {
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
    tile_background_color: readNullableColor(record.tile_background_color),
    background_image_url: readBackgroundImageUrl(record.background_image_url),
    hide_icon: readBoolean(record.hide_icon, false),
    hide_name: readBoolean(record.hide_name, false),
    grid_width: readInteger(record.grid_width, 2, 1, 8),
    sort_order: readInteger(record.sort_order, 0, 0, 1000000),
    enabled: readBoolean(record.enabled, true),
    allow_favorite: readBoolean(record.allow_favorite, true),
    visibility,
    created_at: readInteger(record.created_at, 0, 0, Number.MAX_SAFE_INTEGER),
    updated_at: readInteger(record.updated_at, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}
