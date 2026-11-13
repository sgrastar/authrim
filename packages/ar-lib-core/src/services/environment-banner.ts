/**
 * The environment banner (category `environment-banner`): a plain notice band on the Login UI and
 * the Admin Console, and an optional noindex for the Login UI. It is an honest notice, not a
 * security control, so an unreadable setting is read as "off" (fail quiet) rather than blocking
 * anything. Reads use the short per-isolate cache of the runtime settings (about a minute).
 */

import {
  resolvePlatformSettingsWithSources,
  type EffectiveSettingsEnv,
} from './effective-settings';
import {
  ENVIRONMENT_BANNER_CATEGORY,
  ENVIRONMENT_BANNER_ENABLED_KEY,
  ENVIRONMENT_BANNER_NOINDEX_KEY,
  ENVIRONMENT_BANNER_TEXT_KEY,
  ENVIRONMENT_BANNER_TEXT_LOCALIZATIONS_KEY,
  MAX_ENVIRONMENT_BANNER_LOCALIZATIONS,
  MAX_ENVIRONMENT_BANNER_TEXT_LENGTH,
} from '../types/settings/environment-banner';

export { environmentBannerText } from '../utils/environment-banner-text';

const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
// eslint-disable-next-line no-control-regex -- the point is to find control characters
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/** What the settings say about the banner. */
export interface EnvironmentBanner {
  enabled: boolean;
  text: string;
  textLocalizations: Readonly<Record<string, string>>;
  noindex: boolean;
}

/** The banner as clients receive it: only when it is enabled. */
export interface EnvironmentBannerNotice {
  text: string;
  textLocalizations: Readonly<Record<string, string>>;
}

export const ENVIRONMENT_BANNER_OFF: EnvironmentBanner = {
  enabled: false,
  text: '',
  textLocalizations: {},
  noindex: false,
};

/** Why a banner text is not valid (null when it is): plain text of 1 to 200 characters. */
function textProblem(value: unknown, allowEmpty: boolean): string | null {
  if (typeof value !== 'string') return 'must be text';
  if (value === '' && allowEmpty) return null;
  if (
    value === '' ||
    value !== value.trim() ||
    value.length > MAX_ENVIRONMENT_BANNER_TEXT_LENGTH ||
    CONTROL_CHARACTER.test(value)
  ) {
    return `must be ${allowEmpty ? '' : '1 to '}${MAX_ENVIRONMENT_BANNER_TEXT_LENGTH} characters of plain text, without padding or control characters`;
  }
  return null;
}

/** Why `environment_banner.text` is not valid as saved (null when it is). Empty means none. */
export function environmentBannerTextProblem(value: unknown): string | null {
  return textProblem(value, true);
}

/**
 * Why `environment_banner.text_localizations` is not valid as saved (null when it is): JSON text
 * of an object from language tag to text, at most 16 languages. No language is required.
 */
export function environmentBannerTextLocalizationsProblem(value: unknown): string | null {
  const shape = 'must be JSON text of an object of language tags to texts';
  if (typeof value !== 'string') return shape;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return shape;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return shape;
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > MAX_ENVIRONMENT_BANNER_LOCALIZATIONS) {
    return `must give the text in at most ${MAX_ENVIRONMENT_BANNER_LOCALIZATIONS} languages`;
  }
  for (const [language, text] of entries) {
    if (!LANGUAGE_TAG.test(language)) {
      return 'every key must be a language tag (a lowercase language such as ja or en, optionally with a region such as en-gb)';
    }
    if (textProblem(text, false)) {
      return `the text in "${language}" must be 1 to ${MAX_ENVIRONMENT_BANNER_TEXT_LENGTH} characters of plain text, without padding or control characters`;
    }
  }
  return null;
}

/** The saved localizations as runtime reads them: empty when none or not valid (it is only shown). */
function readLocalizations(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'string' || environmentBannerTextLocalizationsProblem(value) !== null) {
    return {};
  }
  return JSON.parse(value) as Record<string, string>;
}

/** From the effective values of the `environment-banner` category. */
export function environmentBannerFromSettings(values: Record<string, unknown>): EnvironmentBanner {
  const text = values[ENVIRONMENT_BANNER_TEXT_KEY];
  return {
    enabled: values[ENVIRONMENT_BANNER_ENABLED_KEY] === true,
    text: typeof text === 'string' && environmentBannerTextProblem(text) === null ? text : '',
    textLocalizations: readLocalizations(values[ENVIRONMENT_BANNER_TEXT_LOCALIZATIONS_KEY]),
    noindex: values[ENVIRONMENT_BANNER_NOINDEX_KEY] === true,
  };
}

/** Reads the banner. Unreadable settings: the banner and noindex are off. */
export async function readEnvironmentBanner(
  env: EffectiveSettingsEnv,
  options: { fresh?: boolean } = {}
): Promise<EnvironmentBanner> {
  try {
    const { values } = await resolvePlatformSettingsWithSources(
      env,
      ENVIRONMENT_BANNER_CATEGORY,
      options.fresh ? { fresh: true } : {}
    );
    return environmentBannerFromSettings(values);
  } catch {
    return ENVIRONMENT_BANNER_OFF;
  }
}

/** The notice for clients: null unless enabled and there is some text to show in some language. */
export function environmentBannerNotice(banner: EnvironmentBanner): EnvironmentBannerNotice | null {
  if (!banner.enabled) return null;
  const hasText = banner.text !== '' || Object.keys(banner.textLocalizations).length > 0;
  return hasText ? { text: banner.text, textLocalizations: banner.textLocalizations } : null;
}
