/**
 * The account page a tenant publishes, read from its `login-ui` settings document: the page
 * definition (placements) and, for pages published from the builder, the screen snapshots they
 * were published with. Pure, so every Worker that needs to know what the account page shows reads
 * it the same way (the account capabilities API, the lite Login UI guard, the passkey endpoints).
 */
import {
  DEFAULT_ACCOUNT_PAGE_DEFINITION,
  type AccountPageDefinition,
  type AccountPagesDocument,
  type AccountPageScreenPlacement,
  type PublishedAccountPageDefinition,
  type ScreenResponse,
} from '../types/screens';
import type { Env } from '../types/env';

const ACCOUNT_SCREEN_BLOCK_TYPES = new Set([
  'heading',
  'text',
  'link',
  'divider',
  'layout_row',
  'account_profile_widget',
  'account_device_list_widget',
  'account_session_widget',
  'account_passkey_widget',
  'account_totp_widget',
  'account_consent_widget',
  'account_activity_widget',
  'account_social_account_widget',
  'account_launcher_widget',
]);

function safeLinkHref(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  const href = value.trim();
  if (/^#[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(href) || /^\/(?!\/)/u.test(href)) return href;
  try {
    const parsed = new URL(href);
    return parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeSnapshotLocalizations(value: unknown): ScreenResponse['localizations'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: ScreenResponse['localizations'] = {};
  for (const [locale, rawLocalization] of Object.entries(value).slice(0, 32)) {
    if (!/^[a-z]{2,3}(?:[_-][A-Z]{2})?$/u.test(locale)) continue;
    if (!rawLocalization || typeof rawLocalization !== 'object' || Array.isArray(rawLocalization)) {
      continue;
    }
    const localization = rawLocalization as Record<string, unknown>;
    const fields: NonNullable<ScreenResponse['localizations'][string]['fields']> = {};
    if (
      localization.fields &&
      typeof localization.fields === 'object' &&
      !Array.isArray(localization.fields)
    ) {
      for (const [key, rawField] of Object.entries(localization.fields).slice(0, 256)) {
        if (!/^[A-Za-z0-9._-]{1,160}$/u.test(key)) continue;
        if (!rawField || typeof rawField !== 'object' || Array.isArray(rawField)) continue;
        const field = rawField as Record<string, unknown>;
        fields[key] = {
          ...(typeof field.label === 'string' ? { label: field.label.trim().slice(0, 200) } : {}),
          ...(typeof field.text === 'string' ? { text: field.text.trim().slice(0, 4000) } : {}),
          ...(typeof field.help_text === 'string'
            ? { help_text: field.help_text.trim().slice(0, 1000) }
            : {}),
          ...(typeof field.placeholder === 'string'
            ? { placeholder: field.placeholder.trim().slice(0, 500) }
            : {}),
        };
      }
    }
    result[locale] = {
      ...(typeof localization.display_name === 'string'
        ? { display_name: localization.display_name.trim().slice(0, 200) }
        : {}),
      ...(typeof localization.description === 'string'
        ? { description: localization.description.trim().slice(0, 1000) }
        : {}),
      ...(Object.keys(fields).length > 0 ? { fields } : {}),
    };
  }
  return result;
}

function normalizePlacement(
  value: unknown,
  index: number,
  seenIds: Set<string>
): AccountPageScreenPlacement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const screenKey = typeof record.screen_key === 'string' ? record.screen_key.trim() : '';
  if (!/^[a-z0-9_-]{1,96}$/u.test(screenKey)) return null;
  const rawId = typeof record.id === 'string' ? record.id.trim() : '';
  const baseId = /^[a-zA-Z0-9_-]{1,96}$/u.test(rawId) ? rawId : `${screenKey}-${index + 1}`;
  let id = baseId;
  let suffix = 2;
  while (seenIds.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  seenIds.add(id);
  return {
    id,
    screen_key: screenKey,
    width: record.width === 'half' ? 'half' : 'full',
    enabled: record.enabled !== false,
    show_for_guests: record.show_for_guests !== false,
    condition:
      record.condition === 'hidden' ||
      record.condition === 'passkey_enabled' ||
      record.condition === 'totp_enabled' ||
      record.condition === 'external_idp_enabled' ||
      record.condition === 'consent_records_available' ||
      record.condition === 'multiple_sessions'
        ? record.condition
        : 'always',
  };
}

function normalizeAccountPageDefinition(value: unknown): AccountPageDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return structuredClone(DEFAULT_ACCOUNT_PAGE_DEFINITION);
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.screens)) {
    return structuredClone(DEFAULT_ACCOUNT_PAGE_DEFINITION);
  }
  const seenIds = new Set<string>();
  const screens = record.screens
    .slice(0, 32)
    .map((entry, index) => normalizePlacement(entry, index, seenIds))
    .filter((entry): entry is AccountPageScreenPlacement => entry !== null);
  return {
    schema_version: 'authrim.account_page.v1',
    base_preset_id: 'authrim-default',
    base_preset_version:
      typeof record.base_preset_version === 'number' ? record.base_preset_version : 1,
    ...(typeof record.title === 'string' && record.title.trim()
      ? { title: record.title.trim().slice(0, 120) }
      : {}),
    ...(typeof record.description === 'string' && record.description.trim()
      ? { description: record.description.trim().slice(0, 1000) }
      : {}),
    ...(record.localizations && typeof record.localizations === 'object'
      ? {
          localizations: Object.fromEntries(
            Object.entries(record.localizations as Record<string, unknown>)
              .filter(
                ([locale, entry]) =>
                  /^[a-z]{2,3}(?:[_-][A-Z]{2})?$/u.test(locale) &&
                  Boolean(entry) &&
                  typeof entry === 'object' &&
                  !Array.isArray(entry)
              )
              .slice(0, 32)
              .map(([locale, entry]) => {
                const localization = entry as Record<string, unknown>;
                return [
                  locale,
                  {
                    ...(typeof localization.title === 'string'
                      ? { title: localization.title.slice(0, 120) }
                      : {}),
                    ...(typeof localization.description === 'string'
                      ? { description: localization.description.slice(0, 1000) }
                      : {}),
                  },
                ];
              })
          ),
        }
      : {}),
    screens,
  };
}

function normalizeSnapshot(value: unknown): ScreenResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const screen = value as ScreenResponse;
  if (screen.screen_kind !== 'account' || !/^[a-z0-9_-]{1,96}$/u.test(screen.screen_key)) {
    return null;
  }
  if (!Array.isArray(screen.fields)) return null;
  const fields = screen.fields
    .slice(0, 256)
    .filter(
      (field) =>
        Boolean(field) &&
        typeof field === 'object' &&
        ACCOUNT_SCREEN_BLOCK_TYPES.has(field.block_type ?? '') &&
        typeof field.field === 'string' &&
        typeof field.label === 'string'
    )
    .map((field) => ({
      ...field,
      field: field.field.trim().slice(0, 200),
      label: field.label.trim().slice(0, 200),
      text: typeof field.text === 'string' ? field.text.trim().slice(0, 4000) : undefined,
      help_text:
        typeof field.help_text === 'string' ? field.help_text.trim().slice(0, 1000) : undefined,
      placeholder:
        typeof field.placeholder === 'string' ? field.placeholder.trim().slice(0, 500) : undefined,
      href: field.block_type === 'link' ? safeLinkHref(field.href) : undefined,
    }))
    .filter((field) => field.block_type !== 'link' || Boolean(field.href));
  const primaryWidgets = fields.filter(
    (field) => typeof field.block_type === 'string' && field.block_type.startsWith('account_')
  );
  if (primaryWidgets.length > 1) return null;
  return {
    ...structuredClone(screen),
    fields,
    localizations: sanitizeSnapshotLocalizations(screen.localizations),
  };
}

function normalizePublishedDefinition(value: unknown): PublishedAccountPageDefinition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const definition = normalizeAccountPageDefinition(value);
  if (!record.screen_snapshots || typeof record.screen_snapshots !== 'object') return null;
  const screenSnapshots: Record<string, ScreenResponse> = {};
  for (const placement of definition.screens.filter((item) => item.enabled)) {
    const snapshot = normalizeSnapshot(
      (record.screen_snapshots as Record<string, unknown>)[placement.screen_key]
    );
    if (!snapshot || snapshot.screen_key !== placement.screen_key) return null;
    screenSnapshots[placement.screen_key] = snapshot;
  }
  const stableTargets = new Set(
    definition.screens
      .filter((placement) => placement.enabled && placement.condition === 'always')
      .map((placement) => placement.id)
  );
  for (const snapshot of Object.values(screenSnapshots)) {
    snapshot.fields = snapshot.fields.filter(
      (field) =>
        field.block_type !== 'link' ||
        !field.href?.startsWith('#') ||
        stableTargets.has(field.href.slice(1))
    );
  }
  return {
    ...definition,
    resolved_at: typeof record.resolved_at === 'string' ? record.resolved_at : '',
    screen_snapshots: screenSnapshots,
  };
}

function selectedPageId(
  settings: Record<string, unknown>,
  document: AccountPagesDocument
): string | null {
  try {
    const serializedThemes = settings['login-ui.custom_themes'];
    const themes: unknown =
      typeof serializedThemes === 'string' ? JSON.parse(serializedThemes) : null;
    if (themes && typeof themes === 'object' && !Array.isArray(themes)) {
      const record = themes as Record<string, unknown>;
      const active = typeof record.active === 'string' ? record.active : null;
      const theme = Array.isArray(record.themes)
        ? (record.themes as unknown[]).find(
            (entry): entry is Record<string, unknown> =>
              Boolean(entry) &&
              typeof entry === 'object' &&
              (entry as Record<string, unknown>).id === active
          )
        : undefined;
      const associated =
        theme && typeof theme.account_page_id === 'string' ? theme.account_page_id : null;
      if (associated && document.pages.some((page) => page.id === associated && page.published)) {
        return associated;
      }
    }
  } catch {
    // Invalid theme settings are ignored in favor of the tenant default.
  }
  return document.default_page_id;
}

export interface PublishedAccountPage {
  definition: AccountPageDefinition;
  version: number;
  published_at: string;
  page_id: string | null;
  name: string;
  screens: ScreenResponse[] | null;
}

export async function getPublishedAccountPage(
  env: Env,
  tenantId: string
): Promise<PublishedAccountPage> {
  let settings: Record<string, unknown> | null;
  try {
    const raw = await env.SETTINGS?.get(`settings:tenant:${tenantId}:login-ui`);
    settings = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    settings = null;
  }
  return publishedAccountPageFromSettings(settings);
}

/**
 * The account page a tenant's `login-ui` settings publish. Takes the document itself, so a
 * change can be judged before it is saved (the lite Login UI guard).
 */
export function publishedAccountPageFromSettings(
  settings: Record<string, unknown> | null
): PublishedAccountPage {
  try {
    if (!settings) {
      return {
        definition: structuredClone(DEFAULT_ACCOUNT_PAGE_DEFINITION),
        version: 0,
        published_at: '',
        page_id: null,
        name: 'Built-in default',
        screens: null,
      };
    }
    const serializedPages = settings['login-ui.account_pages'];
    if (typeof serializedPages === 'string' && serializedPages.trim()) {
      const document = JSON.parse(serializedPages) as AccountPagesDocument;
      if (document.schema_version === 'authrim.account_pages.v1' && Array.isArray(document.pages)) {
        const pageId = selectedPageId(settings, document);
        const page = document.pages.find((entry) => entry.id === pageId);
        const published = normalizePublishedDefinition(page?.published);
        if (
          page &&
          published &&
          typeof page.id === 'string' &&
          /^[a-z0-9_-]{1,96}$/u.test(page.id)
        ) {
          return {
            definition: published,
            version: Number.isFinite(page.published_version) ? page.published_version : 0,
            published_at: typeof page.published_at === 'string' ? page.published_at : '',
            page_id: page.id,
            name:
              typeof page.name === 'string' && page.name.trim()
                ? page.name.trim().slice(0, 80)
                : 'Custom account page',
            screens: Object.values(published.screen_snapshots),
          };
        }
      }
    }
    const serialized = settings['login-ui.account_page_published'];
    const parsed: unknown =
      typeof serialized === 'string' && serialized.trim() ? JSON.parse(serialized) : null;
    const rawVersion = settings['login-ui.account_page_published_version'];
    return {
      definition: normalizeAccountPageDefinition(parsed),
      version: typeof rawVersion === 'number' && Number.isFinite(rawVersion) ? rawVersion : 0,
      published_at:
        typeof settings['login-ui.account_page_published_at'] === 'string'
          ? settings['login-ui.account_page_published_at']
          : '',
      page_id: null,
      name: 'Legacy account page',
      screens: null,
    };
  } catch {
    return {
      definition: structuredClone(DEFAULT_ACCOUNT_PAGE_DEFINITION),
      version: 0,
      published_at: '',
      page_id: null,
      name: 'Built-in default',
      screens: null,
    };
  }
}

/** Built-in account screen that holds the passkey list (`account_passkey_widget`). */
const BUILT_IN_PASSKEY_SCREEN_KEY = 'account_passkeys';

/**
 * The id of the first placement on the published account page that shows the passkey list and
 * its "add a passkey" button, or null when the page shows none.
 *
 * Counted: enabled placements shown to everyone (`always`) or while passkeys are on
 * (`passkey_enabled`), guests included. Placements shown only for some accounts or other methods
 * are not, since the link has to work for anyone. A page published from the builder must carry the passkey
 * widget in the placement's screen snapshot; the built-in and legacy pages, whose screens are the
 * tenant's active account screens, count the built-in passkeys screen.
 */
export function passkeyPlacementId(page: PublishedAccountPage): string | null {
  for (const placement of page.definition.screens) {
    if (!placement.enabled) continue;
    if (placement.condition !== 'always' && placement.condition !== 'passkey_enabled') continue;
    if (placement.show_for_guests === false) continue;
    if (page.screens) {
      const screen = page.screens.find((entry) => entry.screen_key === placement.screen_key);
      if (screen?.fields.some((field) => field.block_type === 'account_passkey_widget')) {
        return placement.id;
      }
    } else if (placement.screen_key === BUILT_IN_PASSKEY_SCREEN_KEY) {
      return placement.id;
    }
  }
  return null;
}
