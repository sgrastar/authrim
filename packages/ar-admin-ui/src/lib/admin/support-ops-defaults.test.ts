import { listSupportOpsResources } from '@authrim/ar-lib-core/services/support-ops';
import { describe, expect, it } from 'vitest';
import type { SupportOpsResourceDescriptor } from '$lib/api/admin-support-ops';
import { aggregatableGroupBy, initialSelectorValue } from './support-ops-defaults';

// The registry the API serves: a field the page groups by must be one it aggregates.
const [user] = listSupportOpsResources() as unknown as SupportOpsResourceDescriptor[];

function acceptedByApi(field: string): boolean {
	const descriptor = user.fields[field];
	return Boolean(descriptor?.aggregatable && !descriptor.sensitive);
}

describe('aggregatableGroupBy', () => {
	it('replaces a field the API does not aggregate (status) with one it does', () => {
		expect(acceptedByApi('status')).toBe(false);
		const field = aggregatableGroupBy(user, 'status');
		expect(field).not.toBe('');
		expect(acceptedByApi(field)).toBe(true);
	});

	it('keeps a field the API aggregates', () => {
		expect(aggregatableGroupBy(user, 'user_type')).toBe('user_type');
	});

	it('never sends a sensitive field', () => {
		const resource = {
			fields: {
				email: { ...user.fields.lifecycle_state, sensitive: true },
				lifecycle_state: user.fields.lifecycle_state
			}
		};
		expect(aggregatableGroupBy(resource, 'email')).toBe('lifecycle_state');
	});

	it('chooses none before the registry is read', () => {
		expect(aggregatableGroupBy(null, 'status')).toBe('');
	});
});

describe('initialSelectorValue', () => {
	it('starts an enum condition with a value the API accepts', () => {
		expect(initialSelectorValue(user.fields.status)).toBe(String(user.fields.status.values![0]));
		expect(user.fields.status.values).toContain(initialSelectorValue(user.fields.status));
	});

	it('starts a boolean condition as its select shows it', () => {
		expect(initialSelectorValue(user.fields.email_verified)).toBe('true');
	});

	it('leaves a typed value empty', () => {
		expect(initialSelectorValue(user.fields.created_at)).toBe('');
		expect(initialSelectorValue(null)).toBe('');
	});
});
