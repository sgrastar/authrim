// @vitest-environment jsdom

import { readable } from 'svelte/store';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import {
	compileSupportOpsSelector,
	getSupportOpsResource,
	listSupportOpsResources
} from '@authrim/ar-lib-core/services/support-ops';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getRegistry: vi.fn(), aggregate: vi.fn() }));

vi.mock('$i18n/i18n-svelte', () => ({
	// Each message renders as its key, so the test finds controls by it.
	LL: readable(new Proxy({}, { get: (_target, key) => () => String(key) }))
}));
vi.mock('$lib/api/admin-support-ops', () => ({ adminSupportOpsAPI: api }));
vi.mock('$lib/stores/settings-context.svelte', () => ({
	settingsContext: { initialize: vi.fn(async () => undefined) }
}));

import SupportOpsPage from './+page.svelte';

// The registry the API serves, and the fields it aggregates.
const resources = listSupportOpsResources();
const aggregatable = Object.entries(resources[0]!.fields)
	.filter(([, field]) => field.aggregatable && !field.sensitive)
	.map(([name]) => name);

describe('Support Ops page', () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('aggregates by default by a field the API aggregates', async () => {
		api.getRegistry.mockResolvedValue({ resources });
		api.aggregate.mockResolvedValue({
			resource: 'User',
			groups: [],
			suppressed_groups: 0,
			privacy: { min_count: 10, count_precision: 10, count_exact: false }
		});
		render(SupportOpsPage);
		const run = await screen.findByRole('button', { name: 'admin_support_ops_run' });
		await waitFor(() => expect(run).toHaveProperty('disabled', false));

		await fireEvent.click(run);

		await waitFor(() => expect(api.aggregate).toHaveBeenCalledTimes(1));
		const [request] = api.aggregate.mock.calls[0]! as [{ group_by: string[]; selector?: never }];
		expect(request.group_by).toHaveLength(1);
		expect(aggregatable).toContain(request.group_by[0]);
		// The selector the page starts with is one the API compiles (not `status = ''`).
		await expect(
			compileSupportOpsSelector(getSupportOpsResource('User')!, request.selector)
		).resolves.toBeDefined();
	});

	it('does not offer an aggregate before the registry is read', async () => {
		api.getRegistry.mockRejectedValue(new Error('unavailable'));
		render(SupportOpsPage);
		await waitFor(() => expect(api.getRegistry).toHaveBeenCalled());
		const run = await screen.findByRole('button', { name: 'admin_support_ops_run' });

		await waitFor(() => expect(run).toHaveProperty('disabled', true));
		await fireEvent.click(run);

		expect(api.aggregate).not.toHaveBeenCalled();
	});
});
