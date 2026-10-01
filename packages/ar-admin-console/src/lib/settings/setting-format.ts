/**
 * A setting's value as people read it ("1 day", "On", "Write it to the log"), for read-only
 * pages and for "Default: …" lines. Durations take the largest unit that shows a whole number.
 */
import type { SettingMeta } from '@authrim/ar-lib-core/utils/settings-manager';
import { i18n, t } from '$lib/i18n/i18n.svelte';
import { formatNumber } from '$lib/ui/format';
import { settingText } from './setting-text';

const UNITS = [
	{ unit: 'day', ms: 86_400_000 },
	{ unit: 'hour', ms: 3_600_000 },
	{ unit: 'minute', ms: 60_000 },
	{ unit: 'second', ms: 1000 },
	{ unit: 'millisecond', ms: 1 }
] as const;

/** Milliseconds of a duration setting's value. */
export function durationMs(meta: SettingMeta, value: number): number {
	return meta.unit === 'ms' ? value : value * 1000;
}

export function formatDuration(ms: number, locale: string): string {
	const { unit, ms: size } = UNITS.find((u) => ms !== 0 && ms % u.ms === 0) ?? UNITS[3];
	return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(
		ms / size
	);
}

export function formatSetting(key: string, meta: SettingMeta, value: unknown): string {
	const locale = i18n.locale;
	if (value === null || value === undefined || value === '') return t('settings.value.empty');
	switch (meta.type) {
		case 'duration':
			return typeof value === 'number'
				? formatDuration(durationMs(meta, value), locale)
				: String(value);
		case 'number':
			return typeof value === 'number' ? formatNumber(value, locale) : String(value);
		case 'boolean':
			return value === true ? t('settings.value.on') : t('settings.value.off');
		case 'enum':
			return typeof value === 'string' ? t(settingText(key).choice(value)) : String(value);
		default:
			return typeof value === 'string' ? value : JSON.stringify(value);
	}
}
