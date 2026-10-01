/**
 * Minimal typed i18n. Messages are flat dotted keys; Japanese is the source and every other
 * locale is checked against it at compile time (`satisfies Messages`).
 */
import { ar } from './messages/ar';
import { de } from './messages/de';
import { en } from './messages/en';
import { ja, type MessageKey, type Messages } from './messages/ja';
import { DEFAULT_LOCALE, localeDir, type Locale } from './locales';
import { pseudoLocalize } from './pseudo';
import { formatNumber } from '../ui/format';

export type { MessageKey } from './messages/ja';

const CATALOG: Record<Locale, Messages> = { ja, en, de, ar };

let current = $state<Locale>(DEFAULT_LOCALE);
/** Storybook-only check mode: English, pseudo-localised (see pseudo.ts). */
let pseudo = $state(false);

export const i18n = {
	get locale(): Locale {
		return current;
	},
	get dir(): 'ltr' | 'rtl' {
		return localeDir(current);
	},
	get pseudo(): boolean {
		return pseudo;
	},
	/**
	 * Storybook toolbar only: show English pseudo-localised to find hard-coded text, cut-off
	 * labels and clipped lines. The console never offers it to admins.
	 */
	setPseudo(on: boolean): void {
		pseudo = on;
		if (on) this.set('en');
	},
	set(locale: Locale): void {
		current = locale;
		if (typeof document !== 'undefined') {
			document.documentElement.lang = locale;
			document.documentElement.dir = localeDir(locale);
		}
	}
};

/** Translate a key. `{name}` placeholders are replaced from `params`; values stay plain text. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
	const source = CATALOG[current][key] ?? ja[key] ?? key;
	const template = pseudo ? pseudoLocalize(en[key] ?? source) : source;
	if (!params) return template;
	// Numbers are grouped the local way ("1,234 件", "1.234 Einträge"), in Latin digits.
	return template.replace(/\{(\w+)\}/g, (match, name: string) => {
		if (!(name in params)) return match;
		const value = params[name];
		return typeof value === 'number' ? formatNumber(value, current) : value;
	});
}

/** True when `key` names a message. Used where keys are composed at runtime (e.g. retire notes). */
export function hasMessage(key: string): key is MessageKey {
	return key in ja;
}
