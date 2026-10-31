// @vitest-environment jsdom

import { readable } from 'svelte/store';
import { tick } from 'svelte';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import {
	compileSupportOpsSelector,
	getSupportOpsResource,
	listSupportOpsResources
} from '@authrim/ar-lib-core/services/support-ops';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
	getRegistry: vi.fn(),
	aggregate: vi.fn(),
	previewCohort: vi.fn(),
	executeAction: vi.fn(),
	getAction: vi.fn()
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
		vi.useRealTimers();
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

type ActionStatus = 'running' | 'completed' | 'failed';
function action(actionId: string, status: ActionStatus, marker = '') {
	return {
		action_id: actionId,
		cohort_id: 'cohort-a',
		resource: 'User',
		action: 'suspend',
		status,
		reason: 'Fixture support request',
		support_case_id: null,
		approval_request_id: null,
		result_summary: { marker },
		created_at: 1,
		updated_at: 2
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((fulfill, fail) => {
		resolve = fulfill;
		reject = fail;
	});
	return { promise, resolve, reject };
}
async function openAction(actionId = 'action-a') {
	const page = render(SupportOpsPage);
	await waitFor(() => expect(api.getRegistry).toHaveBeenCalled());
	await fireEvent.click(screen.getByRole('tab', { name: 'admin_support_ops_tab_action' }));
	await fireEvent.input(screen.getByLabelText('admin_support_ops_action_id'), {
		target: { value: actionId }
	});
	const execute = screen.getByRole('button', { name: 'admin_support_ops_execute' });
	await waitFor(() => expect(execute).toHaveProperty('disabled', false));
	return { ...page, execute };
}
async function advance(milliseconds: number) {
	await vi.advanceTimersByTimeAsync(milliseconds);
	await tick();
}

describe('Support Ops background action polling', () => {
	beforeEach(() => {
		api.getRegistry.mockReset().mockResolvedValue({ resources });
		api.executeAction
			.mockReset()
			.mockResolvedValue({ action_id: 'action-a', status: 'running', job_id: 'job-a' });
		api.getAction.mockReset();
	});
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('treats an accepted running job as pending, polls every five seconds and stops at completion', async () => {
		api.getAction
			.mockResolvedValueOnce(action('action-a', 'running'))
			.mockResolvedValueOnce(action('action-a', 'completed', 'finished'));
		const { execute } = await openAction();
		vi.useFakeTimers();

		await fireEvent.click(execute);

		expect(screen.getByText('admin_support_ops_action_running')).toBeDefined();
		expect(screen.queryByText('admin_support_ops_action_completed')).toBeNull();
		expect(api.getAction).not.toHaveBeenCalled();
		await advance(4_999);
		expect(api.getAction).not.toHaveBeenCalled();
		await advance(1);
		expect(api.getAction).toHaveBeenCalledExactlyOnceWith('action-a');
		await advance(5_000);
		expect(api.getAction).toHaveBeenCalledTimes(2);
		expect(screen.getByText('admin_support_ops_action_completed')).toBeDefined();
		expect(screen.getByText(/"marker": "finished"/)).toBeDefined();
		await advance(30_000);
		expect(api.getAction).toHaveBeenCalledTimes(2);
		expect(api.executeAction).toHaveBeenCalledExactlyOnceWith('action-a');
	});

	it('waits for the previous read response before scheduling another poll', async () => {
		const pending = deferred<ReturnType<typeof action>>();
		api.getAction
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValueOnce(action('action-a', 'completed'));
		const { execute } = await openAction();
		vi.useFakeTimers();
		await fireEvent.click(execute);
		await advance(5_000);
		await advance(30_000);
		expect(api.getAction).toHaveBeenCalledTimes(1);

		pending.resolve(action('action-a', 'running'));
		await tick();
		await advance(4_999);
		expect(api.getAction).toHaveBeenCalledTimes(1);
		await advance(1);
		expect(api.getAction).toHaveBeenCalledTimes(2);
	});

	it.each(['action-a', 'action-b'])(
		'ignores an old generation response after execution is restarted as %s',
		async (nextId) => {
			const old = deferred<ReturnType<typeof action>>();
			api.getAction
				.mockReturnValueOnce(old.promise)
				.mockResolvedValueOnce(action(nextId, 'completed', 'current-result'));
			const { execute } = await openAction();
			vi.useFakeTimers();
			await fireEvent.click(execute);
			await advance(5_000);
			await fireEvent.input(screen.getByLabelText('admin_support_ops_action_id'), {
				target: { value: nextId }
			});
			api.executeAction.mockResolvedValueOnce({
				action_id: nextId,
				status: 'running',
				job_id: 'new-job'
			});
			await fireEvent.click(execute);

			old.resolve(action('action-a', 'completed', 'obsolete-result'));
			await tick();
			expect(screen.queryByText(/obsolete-result/)).toBeNull();
			expect(screen.queryByText('admin_support_ops_action_completed')).toBeNull();
			expect(screen.getByText(/new-job/)).toBeDefined();
			await advance(5_000);
			expect(api.getAction.mock.calls).toEqual([['action-a'], [nextId]]);
			expect(screen.getByText(/current-result/)).toBeDefined();
		}
	);

	it.each(['scheduled', 'in-flight', 'rejected'])(
		'does not restart %s polling after unmount',
		async (phase) => {
			const pending = deferred<ReturnType<typeof action>>();
			api.getAction.mockReturnValue(pending.promise);
			const { execute, unmount } = await openAction();
			vi.useFakeTimers();
			await fireEvent.click(execute);
			if (phase !== 'scheduled') await advance(5_000);
			await unmount();
			if (phase === 'in-flight') pending.resolve(action('action-a', 'running'));
			if (phase === 'rejected') pending.reject(new Error('temporary-unavailable'));
			await tick();

			await advance(30_000);

			expect(api.getAction).toHaveBeenCalledTimes(phase === 'scheduled' ? 0 : 1);
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it('does not create a polling timer if the execute response arrives after unmount', async () => {
		api.getAction.mockResolvedValue(action('action-a', 'running'));
		const accepted = deferred<{ action_id: string; status: string; job_id: string }>();
		api.executeAction.mockReturnValueOnce(accepted.promise);
		const { execute, unmount } = await openAction();
		vi.useFakeTimers();
		await fireEvent.click(execute);
		await unmount();

		accepted.resolve({
			action_id: 'action-a',
			status: 'running',
			job_id: 'accepted-after-unmount'
		});
		await tick();
		await advance(30_000);

		expect(api.getAction).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('retries a temporary read failure after five seconds without reporting execution success', async () => {
		api.getAction
			.mockRejectedValueOnce(new Error('temporary-unavailable'))
			.mockResolvedValueOnce(action('action-a', 'completed'));
		const { execute } = await openAction();
		vi.useFakeTimers();
		await fireEvent.click(execute);
		await advance(5_000);
		expect(api.getAction).toHaveBeenCalledTimes(1);
		expect(screen.queryByText('admin_support_ops_action_completed')).toBeNull();
		await advance(5_000);
		expect(api.getAction).toHaveBeenCalledTimes(2);
		expect(screen.getByText('admin_support_ops_action_completed')).toBeDefined();
	});

	it('shows a terminal failure and stops polling instead of calling it completed', async () => {
		api.getAction.mockResolvedValueOnce(action('action-a', 'failed'));
		const { execute } = await openAction();
		vi.useFakeTimers();
		await fireEvent.click(execute);
		await advance(5_000);

		expect(screen.getByText('admin_support_ops_action_execution_failed')).toBeDefined();
		expect(screen.queryByText('admin_support_ops_action_completed')).toBeNull();
		await advance(30_000);
		expect(api.getAction).toHaveBeenCalledTimes(1);
	});
});
