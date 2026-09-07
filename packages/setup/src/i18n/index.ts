/**
 * i18n Core Module for Authrim Setup Tool
 *
 * A lightweight, type-safe i18n solution for CLI and Web.
 */

import {
  type Locale,
  type Translations,
  type LocaleInfo,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
} from './types.js';
import {
  detectSystemLocale,
  detectBrowserLocale,
  isValidLocale,
  normalizeLocale,
} from './detector.js';

// Re-export types
export { type Locale, type Translations, type LocaleInfo, SUPPORTED_LOCALES, DEFAULT_LOCALE };
export { detectSystemLocale, detectBrowserLocale, isValidLocale, normalizeLocale };

// Current locale state
let currentLocale: Locale = DEFAULT_LOCALE;

// Cached translations
const translationsCache = new Map<Locale, Translations>();

const translationLoaders: Record<Locale, () => Promise<{ default: Translations }>> = {
  en: () => import('./locales/en.js'),
  ja: () => import('./locales/ja.js'),
  'zh-CN': () => import('./locales/zh-CN.js'),
  'zh-TW': () => import('./locales/zh-TW.js'),
  es: () => import('./locales/es.js'),
  pt: () => import('./locales/pt.js'),
  fr: () => import('./locales/fr.js'),
  de: () => import('./locales/de.js'),
  ko: () => import('./locales/ko.js'),
  ru: () => import('./locales/ru.js'),
  id: () => import('./locales/id.js'),
};

/**
 * Dynamically import translation module
 */
async function importTranslations(locale: Locale): Promise<Translations> {
  try {
    const module = await translationLoaders[locale]();
    return module.default as Translations;
  } catch {
    // Fallback to English if locale not found
    if (locale !== DEFAULT_LOCALE) {
      console.warn(`Translations for "${locale}" not found, falling back to English`);
      return importTranslations(DEFAULT_LOCALE);
    }
    throw new Error(`Default translations (${DEFAULT_LOCALE}) not found`);
  }
}

/**
 * Load translations for a locale (with caching)
 */
export async function loadTranslations(locale: Locale): Promise<Translations> {
  // Check cache
  const cached = translationsCache.get(locale);
  if (cached) return cached;

  // Load and cache
  const translations = await importTranslations(locale);
  translationsCache.set(locale, translations);

  return translations;
}

/**
 * Load translations synchronously (for Web UI injection)
 * Must be called after loadTranslations or initI18n
 */
export function getTranslationsSync(locale: Locale): Translations | null {
  return translationsCache.get(locale) || null;
}

/**
 * Get the English translations (always loaded as fallback)
 */
export async function getBaseTranslations(): Promise<Translations> {
  return loadTranslations(DEFAULT_LOCALE);
}

/**
 * Initialize i18n with a specific locale
 */
export async function initI18n(locale?: string): Promise<void> {
  // Normalize and validate locale
  if (locale) {
    const normalized = normalizeLocale(locale);
    if (normalized && isValidLocale(normalized)) {
      currentLocale = normalized;
    }
  }

  // Pre-load English as fallback
  await loadTranslations(DEFAULT_LOCALE);

  // Load requested locale
  if (currentLocale !== DEFAULT_LOCALE) {
    await loadTranslations(currentLocale);
  }
}

/**
 * Set the current locale
 */
export async function setLocale(locale: Locale): Promise<void> {
  if (!isValidLocale(locale)) {
    throw new Error(`Invalid locale: ${locale}`);
  }
  currentLocale = locale;
  await loadTranslations(locale);
}

/**
 * Get the current locale
 */
export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Get supported locales list
 */
export function getSupportedLocales(): LocaleInfo[] {
  return SUPPORTED_LOCALES;
}

/**
 * Get available locales (only those with translation files)
 */
export function getAvailableLocales(): LocaleInfo[] {
  // Available locales with translation files
  const availableCodes: Locale[] = [
    'en',
    'ja',
    'zh-CN',
    'zh-TW',
    'es',
    'pt',
    'fr',
    'de',
    'ko',
    'ru',
    'id',
  ];
  return SUPPORTED_LOCALES.filter((l) => availableCodes.includes(l.code));
}

/**
 * Translate a key with optional parameter substitution
 *
 * @param key - The translation key (dot notation)
 * @param params - Optional parameters for substitution {{param}}
 * @returns The translated string, or the key if not found
 *
 * @example
 * t('banner.title') // "Authrim Setup"
 * t('update.available', { version: '1.0.0' }) // "Update available: 1.0.0"
 */
export function t(key: string, params?: Record<string, string | number>): string {
  // Get translations from cache
  let translations = translationsCache.get(currentLocale);

  // If not cached yet, try to get from default locale
  if (!translations) {
    translations = translationsCache.get(DEFAULT_LOCALE);
  }

  // If still no translations, return key
  if (!translations) {
    return key;
  }

  // Get translation string
  let text = translations[key];

  // Fallback to English if key not found in current locale
  if (!text && currentLocale !== DEFAULT_LOCALE) {
    const englishTranslations = translationsCache.get(DEFAULT_LOCALE);
    if (englishTranslations) {
      text = englishTranslations[key];
    }
  }

  // If still not found, return key
  if (!text) {
    return key;
  }

  // Substitute parameters {{param}}
  if (params) {
    for (const [param, value] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{\\{${param}\\}\\}`, 'g'), String(value));
    }
  }

  return text;
}

/**
 * Create a bound translate function for a specific locale
 * Useful for Web UI where locale might differ from current CLI locale
 */
export function createTranslator(
  locale: Locale
): (key: string, params?: Record<string, string | number>) => string {
  return (key: string, params?: Record<string, string | number>): string => {
    const translations = translationsCache.get(locale);

    if (!translations) {
      return key;
    }

    let text = translations[key];

    // Fallback to English
    if (!text && locale !== DEFAULT_LOCALE) {
      const englishTranslations = translationsCache.get(DEFAULT_LOCALE);
      if (englishTranslations) {
        text = englishTranslations[key];
      }
    }

    if (!text) {
      return key;
    }

    if (params) {
      for (const [param, value] of Object.entries(params)) {
        text = text.replace(new RegExp(`\\{\\{${param}\\}\\}`, 'g'), String(value));
      }
    }

    return text;
  };
}

/**
 * Get translations as a flat object for Web UI injection
 */
export function getTranslationsForWeb(locale: Locale): Record<string, string> {
  const translations = translationsCache.get(locale);
  const baseTranslations = translationsCache.get(DEFAULT_LOCALE);

  if (!translations && !baseTranslations) {
    return {};
  }

  // Merge with English fallback
  return {
    ...baseTranslations,
    ...translations,
  };
}
