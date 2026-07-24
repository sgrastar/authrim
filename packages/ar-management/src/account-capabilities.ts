import type { Context } from 'hono';
import {
  DEFAULT_ACCOUNT_PAGE_DEFINITION,
  getTenantIdFromContext,
  type AccountPageDefinition,
  type AccountPagesDocument,
  type AccountPageScreenPlacement,
  type Env,
  type PublishedAccountPageDefinition,
  type ScreenResponse,
} from '@authrim/ar-lib-core';
import { requireAccountSession } from './account-page';
import { getActiveAccountScreens } from './admin-screens';

type AccountCapabilityStatus = 'available' | 'planned';

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

type AccountCapability = {
  id: string;
  status: AccountCapabilityStatus;
  requires_reauth: boolean;
  planned_phase?: string;
};

const CAPABILITIES: AccountCapability[] = [
  {
    id: 'profile.name',
    status: 'available',
    requires_reauth: false,
  },
  {
    id: 'sessions.manage',
    status: 'available',
    requires_reauth: false,
  },
  {
    id: 'passkeys.manage',
    status: 'available',
    requires_reauth: true,
  },
  {
    id: 'email.change',
    status: 'planned',
    requires_reauth: true,
    planned_phase: '4E-1',
  },
  {
    id: 'account.deletion',
    status: 'planned',
    requires_reauth: true,
    planned_phase: '4E-2',
  },
  {
    id: 'social_accounts.manage',
    status: 'planned',
    requires_reauth: true,
    planned_phase: '4E-3',
  },
  {
    id: 'rp_sessions.manage',
    status: 'planned',
    requires_reauth: false,
    planned_phase: '4E-4',
  },
  {
    id: 'theme.customize',
    status: 'planned',
    requires_reauth: false,
    planned_phase: '4E-5',
  },
];

const SECTIONS = [
  {
    id: 'profile',
    status: 'available',
    capabilities: ['profile.name'],
  },
  {
    id: 'security',
    status: 'available',
    capabilities: ['sessions.manage', 'passkeys.manage'],
  },
  {
    id: 'connections',
    status: 'planned',
    capabilities: ['social_accounts.manage'],
  },
  {
    id: 'danger',
    status: 'planned',
    capabilities: ['account.deletion'],
  },
] as const;

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
    const themes = typeof serializedThemes === 'string' ? JSON.parse(serializedThemes) : null;
    if (themes && typeof themes === 'object' && !Array.isArray(themes)) {
      const active = typeof themes.active === 'string' ? themes.active : null;
      const theme = Array.isArray(themes.themes)
        ? themes.themes.find(
            (entry: unknown) =>
              Boolean(entry) &&
              typeof entry === 'object' &&
              (entry as Record<string, unknown>).id === active
          )
        : null;
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

async function getPublishedAccountPage(
  env: Env,
  tenantId: string
): Promise<{
  definition: AccountPageDefinition;
  version: number;
  published_at: string;
  page_id: string | null;
  name: string;
  screens: ScreenResponse[] | null;
}> {
  try {
    const raw = await env.SETTINGS?.get(`settings:tenant:${tenantId}:login-ui`);
    if (!raw) {
      return {
        definition: structuredClone(DEFAULT_ACCOUNT_PAGE_DEFINITION),
        version: 0,
        published_at: '',
        page_id: null,
        name: 'Built-in default',
        screens: null,
      };
    }
    const settings = JSON.parse(raw) as Record<string, unknown>;
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
    const parsed =
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

export async function getAccountCapabilitiesHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  const tenantId = getTenantIdFromContext(c);
  const accountPage = await getPublishedAccountPage(c.env, tenantId);
  const accountScreens = accountPage.screens ? [] : await getActiveAccountScreens(c, tenantId);
  const configuredScreenKeys = new Set(
    accountPage.definition.screens.filter((item) => item.enabled).map((item) => item.screen_key)
  );

  return c.json({
    capabilities: CAPABILITIES,
    sections: SECTIONS,
    theme: {
      version: 1,
      scope: 'login-ui',
      source: accountPage.version > 0 ? 'published_account_page' : 'default',
      account_page_overrides_supported: true,
      planned_tokens: [],
    },
    account_page: {
      definition: accountPage.definition,
      version: accountPage.version,
      published_at: accountPage.published_at,
      page_id: accountPage.page_id,
      name: accountPage.name,
      screens:
        accountPage.screens ??
        accountScreens.filter((screen) => configuredScreenKeys.has(screen.screen_key)),
    },
  });
}
