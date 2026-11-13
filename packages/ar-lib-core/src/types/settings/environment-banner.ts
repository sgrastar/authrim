/**
 * Environment Banner Settings Category
 *
 * A plain notice band at the top of the Login UI and the Admin Console ("This is the staging
 * environment..."), and an optional noindex for the Login UI. It is an honest notice, not a
 * security control. Platform only: a tenant can neither see this as its own nor change it.
 * Environment variable and KV value are the usual hybrid (KV, then env, then code default).
 * API: GET/PATCH /api/admin/platform/settings/environment-banner
 * Config Level: platform
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export interface EnvironmentBannerSettings {
  'environment_banner.enabled': boolean;
  'environment_banner.text': string;
  'environment_banner.text_localizations': string;
  'environment_banner.noindex': boolean;
}

export const ENVIRONMENT_BANNER_CATEGORY = 'environment-banner';

export const ENVIRONMENT_BANNER_ENABLED_KEY = 'environment_banner.enabled';
export const ENVIRONMENT_BANNER_TEXT_KEY = 'environment_banner.text';
export const ENVIRONMENT_BANNER_TEXT_LOCALIZATIONS_KEY = 'environment_banner.text_localizations';
export const ENVIRONMENT_BANNER_NOINDEX_KEY = 'environment_banner.noindex';

/** The longest banner text (also per language), in UTF-16 code units. */
export const MAX_ENVIRONMENT_BANNER_TEXT_LENGTH = 200;
/** The most languages the text may be given in. */
export const MAX_ENVIRONMENT_BANNER_LOCALIZATIONS = 16;

export const ENVIRONMENT_BANNER_SETTINGS_META: Record<
  keyof EnvironmentBannerSettings,
  SettingMeta
> = {
  'environment_banner.enabled': {
    key: ENVIRONMENT_BANNER_ENABLED_KEY,
    type: 'boolean',
    default: false,
    envKey: 'ENVIRONMENT_BANNER_ENABLED',
    label: 'Environment banner: show',
    description:
      'On: a band with the banner text is shown at the top of the Login UI and the Admin Console. Nothing is shown while the text is empty. It is a notice only, not a security control. Default off.',
    scopes: ['platform'],
    visibility: 'admin',
  },
  'environment_banner.text': {
    key: ENVIRONMENT_BANNER_TEXT_KEY,
    type: 'string',
    default: '',
    envKey: 'ENVIRONMENT_BANNER_TEXT',
    label: 'Environment banner: text',
    description:
      'Plain text (at most 200 characters, no HTML, no control characters) shown in the banner, for example "This is the staging environment." Used when no text is given for the viewer\'s language.',
    scopes: ['platform'],
    visibility: 'admin',
  },
  'environment_banner.text_localizations': {
    key: ENVIRONMENT_BANNER_TEXT_LOCALIZATIONS_KEY,
    type: 'string',
    default: '{}',
    envKey: 'ENVIRONMENT_BANNER_TEXT_LOCALIZATIONS',
    label: 'Environment banner: text per language',
    description:
      'JSON text mapping a language tag to the banner text in that language, e.g. {"ja": "ステージング環境です", "en": "This is the staging environment."}; at most 16 languages, each at most 200 characters. No language is required. A viewer whose language is not listed sees the banner text.',
    scopes: ['platform'],
    visibility: 'admin',
  },
  'environment_banner.noindex': {
    key: ENVIRONMENT_BANNER_NOINDEX_KEY,
    type: 'boolean',
    default: false,
    envKey: 'ENVIRONMENT_BANNER_NOINDEX',
    label: 'Environment banner: keep the Login UI out of search engines',
    description:
      'On: the Login UI asks search engines not to index it (robots meta tag and X-Robots-Tag header). Independent of whether the banner is shown. Default off.',
    scopes: ['platform'],
    visibility: 'admin',
  },
};

export const ENVIRONMENT_BANNER_CATEGORY_META: CategoryMeta = {
  category: ENVIRONMENT_BANNER_CATEGORY,
  label: 'Environment Banner',
  description: 'A notice band on the Login UI and the Admin Console, and an optional noindex',
  settings: ENVIRONMENT_BANNER_SETTINGS_META,
};

export const ENVIRONMENT_BANNER_DEFAULTS: EnvironmentBannerSettings = {
  'environment_banner.enabled': false,
  'environment_banner.text': '',
  'environment_banner.text_localizations': '{}',
  'environment_banner.noindex': false,
};
