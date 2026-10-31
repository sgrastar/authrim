/**
 * Periods for filtering (logs, activity): a recent span, or a custom from–to. Custom bounds are
 * typed into datetime-local fields, read in the zone the admin chose for timestamps (local or
 * UTC, personal settings) and kept as ISO instants.
 */
import type { TimeZoneMode } from '../time/format-time';

export type RangePreset = '1h' | '24h' | '7d' | '30d' | 'custom';

export interface DateRange {
	preset: RangePreset;
	/** ISO instants; used when `preset` is 'custom'. Either side may be open. */
	from?: string;
	to?: string;
}

export const PRESET_SPANS: Record<Exclude<RangePreset, 'custom'>, number> = {
	'1h': 3_600_000,
	'24h': 86_400_000,
	'7d': 7 * 86_400_000,
	'30d': 30 * 86_400_000
};

/** The instants a range covers now. Open custom sides stay undefined. */
export function resolveRange(range: DateRange, now = new Date()): { from?: Date; to?: Date } {
	if (range.preset !== 'custom') {
		return { from: new Date(now.getTime() - PRESET_SPANS[range.preset]), to: now };
	}
	return {
		from: range.from ? new Date(range.from) : undefined,
		to: range.to ? new Date(range.to) : undefined
	};
}

/** Whether a custom range ends before it starts. */
export function isReversed(range: DateRange): boolean {
	if (range.preset !== 'custom' || !range.from || !range.to) return false;
	return new Date(range.to).getTime() < new Date(range.from).getTime();
}

const pad = (n: number) => String(n).padStart(2, '0');

/** An ISO instant as a datetime-local value ("2026-09-28T14:05") in the chosen zone. */
export function toInputValue(iso: string | undefined, zone: TimeZoneMode): string {
	if (!iso) return '';
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return '';
	if (zone === 'utc') return date.toISOString().slice(0, 16);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
		date.getHours()
	)}:${pad(date.getMinutes())}`;
}

/** A datetime-local value, read in the chosen zone, as an ISO instant. Empty: undefined. */
export function fromInputValue(text: string, zone: TimeZoneMode): string | undefined {
	if (!text) return undefined;
	const date = new Date(zone === 'utc' ? `${text}:00Z` : text);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
