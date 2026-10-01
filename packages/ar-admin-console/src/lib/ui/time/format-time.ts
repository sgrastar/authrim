/**
 * Date and time formatting for the console. Every instant is shown either in UTC or in the
 * viewer's local zone (a per-admin preference), always with the zone named so a timestamp is
 * never ambiguous. Calendar dates without a time ("2024-03-01") are not instants: they are
 * shown as written and never shifted by a zone.
 */
export type TimeZoneMode = 'local' | 'utc';
export type TimeStyle = 'date' | 'datetime' | 'time';

export type TimeInput = Date | string | number;

const CALENDAR_DATE = /^\d{4}-\d{2}(-\d{2})?$/;

export function isCalendarDate(value: TimeInput): value is string {
	return typeof value === 'string' && CALENDAR_DATE.test(value);
}

/** Parses epoch milliseconds, epoch seconds (< 1e12) and ISO strings. */
export function toDate(value: TimeInput): Date | null {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
	if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value);
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

export interface FormattedTime {
	/** Text shown, including the zone for times ("2026/09/26 14:05 JST"). */
	text: string;
	/** Zone label on its own ("UTC", "JST", "GMT+9"). */
	zone: string;
	/** Machine-readable value for <time datetime>. */
	iso: string;
}

export function formatTime(
	value: TimeInput,
	options: {
		locale: string;
		zone: TimeZoneMode;
		style?: TimeStyle;
		seconds?: boolean;
		/** Override the local zone (tests, or an admin working in another region). */
		localTimeZone?: string;
	}
): FormattedTime | null {
	const style = options.style ?? 'datetime';

	if (isCalendarDate(value)) {
		const [year, month, day] = value.split('-').map(Number);
		const date = new Date(Date.UTC(year, month - 1, day ?? 1));
		const text = new Intl.DateTimeFormat(options.locale, {
			numberingSystem: 'latn',
			timeZone: 'UTC',
			year: 'numeric',
			month: '2-digit',
			...(day ? { day: '2-digit' } : {})
		}).format(date);
		return { text, zone: '', iso: value };
	}

	const date = toDate(value);
	if (!date) return null;

	const timeZone = options.zone === 'utc' ? 'UTC' : options.localTimeZone;
	const zone =
		options.zone === 'utc'
			? 'UTC'
			: (new Intl.DateTimeFormat(options.locale, {
					numberingSystem: 'latn',
					timeZone,
					timeZoneName: 'short'
				})
					.formatToParts(date)
					.find((part) => part.type === 'timeZoneName')?.value ?? '');

	// Latin digits in every language, like the numbers around them (see ui/format.ts).
	const fields: Intl.DateTimeFormatOptions = {
		numberingSystem: 'latn',
		timeZone,
		...(style !== 'time' ? { year: 'numeric', month: '2-digit', day: '2-digit' } : {}),
		...(style !== 'date'
			? {
					hour: '2-digit',
					minute: '2-digit',
					...(options.seconds ? { second: '2-digit' } : {}),
					hourCycle: 'h23'
				}
			: {})
	};
	const body = new Intl.DateTimeFormat(options.locale, fields).format(date);
	return { text: style === 'date' ? body : `${body} ${zone}`, zone, iso: date.toISOString() };
}
