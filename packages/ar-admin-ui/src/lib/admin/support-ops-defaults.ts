import type {
	SupportOpsFieldDescriptor,
	SupportOpsResourceDescriptor
} from '$lib/api/admin-support-ops';

/**
 * The field a Support Ops aggregate groups by: `current` while the resource can be grouped by
 * it (aggregatable and not sensitive, as the API accepts), else the resource's first such field,
 * else none (''). A field name chosen before the registry was read, or for another resource, is
 * never sent.
 */
export function aggregatableGroupBy(
	resource: Pick<SupportOpsResourceDescriptor, 'fields'> | null | undefined,
	current: string
): string {
	const fields = Object.entries(resource?.fields ?? {}).filter(
		([, field]) => field.aggregatable && !field.sensitive
	);
	if (fields.some(([name]) => name === current)) return current;
	return fields[0]?.[0] ?? '';
}

/**
 * The value a new selector condition on `field` starts with, so the condition the page shows is
 * one the API accepts and the one it sends: an enum's first value (not the blank choice, which
 * the API refuses), `true` for a boolean (its select shows `true` first), empty for a value
 * typed in.
 */
export function initialSelectorValue(field: SupportOpsFieldDescriptor | null | undefined): string {
	if (!field) return '';
	if (field.values && field.values.length > 0) return String(field.values[0]);
	if (field.type === 'boolean') return 'true';
	return '';
}
