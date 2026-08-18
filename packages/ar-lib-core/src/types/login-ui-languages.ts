export const LOGIN_UI_REGION_IDS = [
  'east_asia',
  'south_southeast_asia',
  'europe',
  'middle_east_north_africa',
  'sub_saharan_africa',
] as const;

export type LoginUIRegionId = (typeof LOGIN_UI_REGION_IDS)[number];

export const LOGIN_UI_REGION_TRANSLATION_KEYS: Record<LoginUIRegionId, string> = {
  east_asia: 'language_region_east_asia',
  south_southeast_asia: 'language_region_south_southeast_asia',
  europe: 'language_region_europe',
  middle_east_north_africa: 'language_region_middle_east_north_africa',
  sub_saharan_africa: 'language_region_sub_saharan_africa',
};

export interface LoginUILanguageMetadata {
  localeCode:
    | 'en'
    | 'ja'
    | 'zh-CN'
    | 'zh-TW'
    | 'es'
    | 'pt'
    | 'fr'
    | 'de'
    | 'ko'
    | 'ru'
    | 'id'
    | 'ar'
    | 'it'
    | 'th'
    | 'vi'
    | 'hi'
    | 'bn'
    | 'tr'
    | 'sw'
    | 'am'
    | 'pl';
  englishName: string;
  nativeName: string;
  estimatedTotalSpeakers: number;
  speakerCountEstimateYear: number;
  speakerCountSource: string;
  regionGroup: LoginUIRegionId;
}

export type LoginUILocale = LoginUILanguageMetadata['localeCode'];

const ETHNOLOGUE_2025 = 'Ethnologue, 28th edition (2025)';
const CHINESE_SCRIPT_ESTIMATE_2022 =
  'Estimated script-using population from official national and regional statistics (2022)';

/**
 * Canonical metadata for every locale currently supported by Login UI.
 * Speaker counts are rounded estimates used only to choose an initial set of primary languages.
 */
export const LOGIN_UI_LANGUAGE_METADATA: readonly LoginUILanguageMetadata[] = [
  {
    localeCode: 'am',
    englishName: 'Amharic',
    nativeName: 'አማርኛ',
    estimatedTotalSpeakers: 58_800_000,
    speakerCountEstimateYear: 2025,
    speakerCountSource: ETHNOLOGUE_2025,
    regionGroup: 'sub_saharan_africa',
  },
  {
    localeCode: 'ar',
    englishName: 'Arabic',
    nativeName: 'العربية',
    estimatedTotalSpeakers: 380_000_000,
    speakerCountEstimateYear: 2025,
    speakerCountSource: ETHNOLOGUE_2025,
    regionGroup: 'middle_east_north_africa',
  },
  {
    localeCode: 'bn',
    englishName: 'Bengali',
    nativeName: 'বাংলা',
    estimatedTotalSpeakers: 284_000_000,
    speakerCountEstimateYear: 2025,
    speakerCountSource: ETHNOLOGUE_2025,
    regionGroup: 'south_southeast_asia',
  },
  {
    localeCode: 'zh-CN',
    englishName: 'Chinese, Simplified',
    nativeName: '简体中文',
    estimatedTotalSpeakers: 1_130_000_000,
    speakerCountEstimateYear: 2022,
    speakerCountSource: CHINESE_SCRIPT_ESTIMATE_2022,
    regionGroup: 'east_asia',
  },
  {
    localeCode: 'zh-TW',
    englishName: 'Chinese, Traditional',
    nativeName: '繁體中文',
    estimatedTotalSpeakers: 32_000_000,
    speakerCountEstimateYear: 2022,
    speakerCountSource: CHINESE_SCRIPT_ESTIMATE_2022,
    regionGroup: 'east_asia',
  },
  {
    localeCode: 'en',
    englishName: 'English',
    nativeName: 'English',
    estimatedTotalSpeakers: 1_528_000_000,
    speakerCountEstimateYear: 2025,
    speakerCountSource: ETHNOLOGUE_2025,
    regionGroup: 'europe',
  },
  {
    localeCode: 'fr',
    englishName: 'French',
    nativeName: 'Français',
    estimatedTotalSpeakers: 312_000_000,
    speakerCountEstimateYear: 2025,
    speakerCountSource: ETHNOLOGUE_2025,
    regionGroup: 'europe',
  },
  {
    localeCode: 'de',
    englishName: 'German',
    nativeName: 'Deutsch',
    estimatedTotalSpeakers: 134_000_000,
    speakerCountEstimateYear: 2025,
    speakerCountSource: ETHNOLOGUE_2025,
    regionGroup: 'europe',
  },
  {
    localeCode: 'hi',
    englishName: 'Hindi',
    nativeName: 'हिन्दी',
    estimatedTotalSpeakers: 609_000_000,
    speakerCountEstimateYear: 2025,
    speakerCountSource: ETHNOLOGUE_2025,
    regionGroup: 'south_southeast_asia',
  },
  {
    localeCode: 'id',
    englishName: 'Indonesian',
    nativeName: 'Bahasa Indonesia',
    estimatedTotalSpeakers: 252_000_000,
    speakerCountEstimateYear: 2025,
    speakerCountSource: ETHNOLOGUE_2025,
    regionGroup: 'south_southeast_asia',
  },
  {
    localeCode: 'it',
    englishName: 'Italian',
    nativeName: 'Italiano',
    estimatedTotalSpeakers: 68_000_000,
    speakerCountEstimateYear: 2025,
    speakerCountSource: ETHNOLOGUE_2025,
    regionGroup: 'europe',
  },
  {
    localeCode: 'ja',
    englishName: 'Japanese',
    nativeName: '日本語',
    estimatedTotalSpeakers: 126_000_000,
    speakerCountEstimateYear: 2025,
    speakerCountSource: ETHNOLOGUE_2025,
    regionGroup: 'east_asia',
  },
  {
    localeCode: 'ko',
    englishName: 'Korean',
    nativeName: '한국어',
    estimatedTotalSpeakers: 82_000_000,
    speakerCountEstimateYear: 2025,
    speakerCountSource: ETHNOLOGUE_2025,
    regionGroup: 'east_asia',
  },
  {
    localeCode: 'pl',
    englishName: 'Polish',
    nativeName: 'Polski',
    estimatedTotalSpeakers: 45_000_000,
    speakerCountEstimateYear: 2025,
    speakerCountSource: ETHNOLOGUE_2025,
    regionGroup: 'europe',
  },
  {
    localeCode: 'pt',
    englishName: 'Portuguese',
    nativeName: 'Português',
    estimatedTotalSpeakers: 267_000_000,
    speakerCountEstimateYear: 2025,
    speakerCountSource: ETHNOLOGUE_2025,
    regionGroup: 'europe',
  },
  {
    localeCode: 'ru',
    englishName: 'Russian',
    nativeName: 'Русский',
    estimatedTotalSpeakers: 253_000_000,
    speakerCountEstimateYear: 2025,
    speakerCountSource: ETHNOLOGUE_2025,
    regionGroup: 'europe',
  },
  {
    localeCode: 'es',
    englishName: 'Spanish',
    nativeName: 'Español',
    estimatedTotalSpeakers: 558_000_000,
    speakerCountEstimateYear: 2025,
    speakerCountSource: ETHNOLOGUE_2025,
    regionGroup: 'europe',
  },
  {
    localeCode: 'sw',
    englishName: 'Swahili',
    nativeName: 'Kiswahili',
    estimatedTotalSpeakers: 98_000_000,
    speakerCountEstimateYear: 2025,
    speakerCountSource: ETHNOLOGUE_2025,
    regionGroup: 'sub_saharan_africa',
  },
  {
    localeCode: 'th',
    englishName: 'Thai',
    nativeName: 'ไทย',
    estimatedTotalSpeakers: 61_000_000,
    speakerCountEstimateYear: 2025,
    speakerCountSource: ETHNOLOGUE_2025,
    regionGroup: 'south_southeast_asia',
  },
  {
    localeCode: 'tr',
    englishName: 'Turkish',
    nativeName: 'Türkçe',
    estimatedTotalSpeakers: 90_000_000,
    speakerCountEstimateYear: 2025,
    speakerCountSource: ETHNOLOGUE_2025,
    regionGroup: 'middle_east_north_africa',
  },
  {
    localeCode: 'vi',
    englishName: 'Vietnamese',
    nativeName: 'Tiếng Việt',
    estimatedTotalSpeakers: 97_000_000,
    speakerCountEstimateYear: 2025,
    speakerCountSource: ETHNOLOGUE_2025,
    regionGroup: 'south_southeast_asia',
  },
] as const;

export const LOGIN_UI_LOCALES = LOGIN_UI_LANGUAGE_METADATA.map(
  ({ localeCode }) => localeCode
) as LoginUILocale[];

export const LOGIN_UI_LANGUAGE_METADATA_BY_LOCALE = Object.fromEntries(
  LOGIN_UI_LANGUAGE_METADATA.map((metadata) => [metadata.localeCode, metadata])
) as Record<LoginUILocale, LoginUILanguageMetadata>;

export const LOGIN_UI_LANGUAGE_GROUPING_THRESHOLD = 11;
export const MAX_LOGIN_UI_PRIMARY_LOCALES = 6;

export function isLoginUILocale(value: unknown): value is LoginUILocale {
  return typeof value === 'string' && LOGIN_UI_LOCALES.includes(value as LoginUILocale);
}

export function compareLoginUILanguagesByEnglishName(
  left: Pick<LoginUILanguageMetadata, 'englishName'>,
  right: Pick<LoginUILanguageMetadata, 'englishName'>
): number {
  return left.englishName.localeCompare(right.englishName, 'en', { sensitivity: 'base' });
}

export function compareLoginUILanguagesBySpeakerCount(
  left: Pick<LoginUILanguageMetadata, 'estimatedTotalSpeakers' | 'englishName'>,
  right: Pick<LoginUILanguageMetadata, 'estimatedTotalSpeakers' | 'englishName'>
): number {
  return (
    right.estimatedTotalSpeakers - left.estimatedTotalSpeakers ||
    compareLoginUILanguagesByEnglishName(left, right)
  );
}

export function sortLoginUILocalesByEnglishName(
  locales: readonly LoginUILocale[]
): LoginUILocale[] {
  return [...locales].sort((left, right) =>
    compareLoginUILanguagesByEnglishName(
      LOGIN_UI_LANGUAGE_METADATA_BY_LOCALE[left],
      LOGIN_UI_LANGUAGE_METADATA_BY_LOCALE[right]
    )
  );
}

export function getLoginUILanguageDisplayName(
  locale: LoginUILocale,
  showEnglishName: boolean
): string {
  const { englishName, nativeName } = LOGIN_UI_LANGUAGE_METADATA_BY_LOCALE[locale];
  if (
    !showEnglishName ||
    englishName.localeCompare(nativeName, 'en', { sensitivity: 'base' }) === 0
  ) {
    return nativeName;
  }
  return `${englishName} (${nativeName})`;
}

export function parseConfiguredPrimaryLoginUILocales(value: unknown): LoginUILocale[] | null {
  if (value === null || value === undefined || value === '' || value === 'null') return null;
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  return parsed
    .filter(isLoginUILocale)
    .filter((locale, index, locales) => locales.indexOf(locale) === index)
    .slice(0, MAX_LOGIN_UI_PRIMARY_LOCALES);
}

export function selectDefaultPrimaryLoginUILocales(
  enabledLocales: readonly LoginUILocale[]
): LoginUILocale[] {
  const enabled = new Set(enabledLocales);
  return LOGIN_UI_LANGUAGE_METADATA.filter(({ localeCode }) => enabled.has(localeCode))
    .sort(compareLoginUILanguagesBySpeakerCount)
    .slice(0, MAX_LOGIN_UI_PRIMARY_LOCALES)
    .map(({ localeCode }) => localeCode);
}

export function resolveEffectivePrimaryLoginUILocales(
  enabledLocales: readonly LoginUILocale[],
  configuredPrimaryLocales: readonly LoginUILocale[] | null
): LoginUILocale[] {
  if (enabledLocales.length < LOGIN_UI_LANGUAGE_GROUPING_THRESHOLD) return [];
  const enabled = new Set(enabledLocales);
  const selected = configuredPrimaryLocales ?? selectDefaultPrimaryLoginUILocales(enabledLocales);
  return selected
    .filter((locale) => enabled.has(locale))
    .slice(0, MAX_LOGIN_UI_PRIMARY_LOCALES)
    .sort((left, right) =>
      compareLoginUILanguagesBySpeakerCount(
        LOGIN_UI_LANGUAGE_METADATA_BY_LOCALE[left],
        LOGIN_UI_LANGUAGE_METADATA_BY_LOCALE[right]
      )
    );
}
