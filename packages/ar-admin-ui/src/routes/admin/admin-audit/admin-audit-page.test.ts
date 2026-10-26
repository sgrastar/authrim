// @vitest-environment jsdom

import { readable } from 'svelte/store';
import { tick } from 'svelte';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminAuditLogStats } from '$lib/api/admin-admin-audit';

const api = vi.hoisted(() => ({
	list: vi.fn(),
	getStats: vi.fn(),
	listActions: vi.fn(),
	listResourceTypes: vi.fn()
}));
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$i18n/i18n-svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('$i18n/i18n-svelte')>()),
	LL: readable(new Proxy({}, { get: (_target, key) => () => String(key) }))
}));
vi.mock('$lib/api/admin-admin-audit', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/api/admin-admin-audit')>()),
	adminAdminAuditAPI: api
}));
import { settingsContext } from '$lib/stores/settings-context.svelte';
import AdminAuditPage from './+page.svelte';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const stats = (total: number): AdminAuditLogStats => ({
	total_entries: total,
	recent_entries: 1,
	time_range_days: 7,
	result_breakdown: { success: 1, failure: 0 },
	severity_breakdown: { info: 1 },
	top_actions: [],
	most_active_admins: []
});

describe('administrator audit requests', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		sessionStorage.clear();
		localStorage.clear();
		settingsContext.reset();
		vi.spyOn(settingsContext, 'initialize').mockResolvedValue();
		await settingsContext.setTenantId('tenant-a');
		api.list
			.mockReset()
			.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20, totalPages: 0 });
		api.getStats.mockReset().mockResolvedValue(stats(73));
		api.listActions.mockReset().mockResolvedValue({ items: [] });
		api.listResourceTypes.mockReset().mockResolvedValue({ items: [] });
	});
	afterEach(() => {
		cleanup();
		settingsContext.reset();
		vi.restoreAllMocks();
	});

	it('finishes delayed statistics and filter options after the user reloads the list', async () => {
		const pendingStats = deferred<AdminAuditLogStats>();
		const pendingOptions = deferred<{ items: string[] }>();
		api.getStats.mockReturnValueOnce(pendingStats.promise);
		api.listActions.mockReturnValueOnce(pendingOptions.promise);
		const { container } = render(AdminAuditPage);
		await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
		await fireEvent.change(screen.getByLabelText('admin_admin_audit_result'), {
			target: { value: 'failure' }
		});
		await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
		pendingStats.resolve(stats(73));
		pendingOptions.resolve({ items: ['user.updated'] });
		await screen.findByText('73');
		await waitFor(() =>
			expect(container.querySelector('option[value="user.updated"]')).not.toBeNull()
		);
		expect(container.querySelector('.stat-loading')).toBeNull();
	});

	it('shows an incomplete statistics error and ends loading even after a list filter changes', async () => {
		const pending = deferred<AdminAuditLogStats>();
		api.getStats.mockReturnValueOnce(pending.promise);
		const { container } = render(AdminAuditPage);
		await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
		await fireEvent.change(screen.getByLabelText('admin_admin_audit_result'), {
			target: { value: 'failure' }
		});
		pending.reject(new Error('Log results are incomplete.'));
		expect(await screen.findByRole('alert')).toHaveProperty(
			'textContent',
			'Log results are incomplete.'
		);
		expect(container.querySelector('.stat-loading')).toBeNull();
		expect(container.querySelector('.stat-value')).toBeNull();
	});

	it('rejects old statistics and options when a tenant is selected again', async () => {
		const oldStats = deferred<AdminAuditLogStats>();
		const oldOptions = deferred<{ items: string[] }>();
		api.getStats
			.mockReturnValueOnce(oldStats.promise)
			.mockResolvedValueOnce(stats(222))
			.mockResolvedValueOnce(stats(333));
		api.listActions
			.mockReturnValueOnce(oldOptions.promise)
			.mockResolvedValueOnce({ items: ['from-b'] })
			.mockResolvedValueOnce({ items: ['new-a'] });
		const { container } = render(AdminAuditPage);
		await waitFor(() => expect(api.getStats).toHaveBeenCalledTimes(1));
		await settingsContext.setTenantId('tenant-b');
		await screen.findByText('222');
		await settingsContext.setTenantId('tenant-a');
		await screen.findByText('333');
		oldStats.resolve(stats(111));
		oldOptions.resolve({ items: ['old-a'] });
		await tick();
		await waitFor(() => expect(container.querySelector('option[value="new-a"]')).not.toBeNull());
		expect(screen.queryByText('111')).toBeNull();
		expect(screen.getByText('333')).toBeDefined();
		expect(container.querySelector('option[value="old-a"]')).toBeNull();
	});
});
