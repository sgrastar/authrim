// @vitest-environment jsdom

import { readable } from 'svelte/store';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import {
	compileSupportOpsSelector,
	getSupportOpsResource,
	listSupportOpsResources
} from '@authrim/ar-lib-core/services/support-ops';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
	getRegistry: vi.fn(),
	aggregate: vi.fn(),
	previewCohort: vi.fn()
}));

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

	it('labels a preview as bucketed and renders only the returned counts', async () => {
		api.getRegistry.mockResolvedValue({ resources });
		api.previewCohort.mockResolvedValue({
			resource: 'User',
			matched_count: 10,
			actionable_count: 10,
			blocked_count: 0,
			blocked_reasons: [],
			privacy: {
				min_count: 10,
				low_count_suppressed: false,
				count_exact: false,
				count_precision: 10
			},
			risk: {
				min_count: 10,
				matched_count: 10,
				low_count_suppressed: false,
				uses_sensitive_field: false,
				risk_level: 'low',
				approval_required: true
			},
			selector_hash: 'sha256:preview'
		});
		render(SupportOpsPage);
		await waitFor(() => expect(api.getRegistry).toHaveBeenCalled());
		await fireEvent.click(screen.getByRole('tab', { name: 'admin_support_ops_tab_cohort' }));
		const preview = screen.getByRole('button', { name: 'admin_support_ops_preview' });
		await waitFor(() => expect(preview).toHaveProperty('disabled', false));
		await fireEvent.click(preview);

		const privacy = await screen.findByText(/bucket 10/);
		expect(privacy.textContent).toContain('selector sha256:preview');
		expect(screen.getAllByText('10', { selector: 'strong' })).toHaveLength(2);
		expect(screen.queryByText('11', { selector: 'strong' })).toBeNull();
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
