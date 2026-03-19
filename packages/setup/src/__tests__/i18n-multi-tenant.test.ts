import { describe, expect, it } from 'vitest';
import de from '../i18n/locales/de.js';
import en from '../i18n/locales/en.js';
import es from '../i18n/locales/es.js';
import fr from '../i18n/locales/fr.js';
import id from '../i18n/locales/id.js';
import ja from '../i18n/locales/ja.js';
import ko from '../i18n/locales/ko.js';
import pt from '../i18n/locales/pt.js';
import ru from '../i18n/locales/ru.js';
import zhCN from '../i18n/locales/zh-CN.js';
import zhTW from '../i18n/locales/zh-TW.js';

const requiredKeys = [
  'web.form.multiTenantEnable',
  'web.form.multiTenantHint',
  'web.form.multiTenantExamples',
  'web.form.multiTenantExampleDefaultOmitted',
  'web.form.multiTenantExampleDefaultIncluded',
  'web.form.multiTenantExampleOther',
] as const;

const locales = {
  en,
  ja,
  de,
  es,
  fr,
  id,
  ko,
  pt,
  ru,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
} as const;

describe('multi-tenant i18n keys', () => {
  for (const [locale, translations] of Object.entries(locales)) {
    it(`defines all multi-tenant setup keys for ${locale}`, () => {
      for (const key of requiredKeys) {
        expect(translations[key]).toBeTypeOf('string');
        expect(translations[key]).not.toHaveLength(0);
      }
    });
  }
});
