export function toDateTimeLocalValue(date: Date): string {
	if (!Number.isFinite(date.getTime())) throw new Error('invalid_datetime_local_value');
	const local = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
	return local.toISOString().slice(0, 16);
}
