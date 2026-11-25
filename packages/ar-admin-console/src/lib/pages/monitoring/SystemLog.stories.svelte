<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import type { AdminAccess } from '#lib/access/access.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { SYSTEM_LOG_NOW, createFakeSystemLog } from '#lib/api/fake/system-log-fake.js';
	import type { SystemLogClient } from '#lib/api/system-log.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import SystemLog from './SystemLog.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Monitoring/System logs',
		component: SystemLog,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Monitoring → System logs: what the platform itself did in the selected tenant (`/api/admin/system-logs`: scheduled work, queues, deliveries, metadata refreshes, connector heartbeats), newest first, narrowed by period, source, severity and event name, with one event in full above the list. These events have no administrator and no end user behind them; what users did is in Audit logs and what administrators did in Admin activity. The API reads the whole period before it filters, so the period is always bounded (the last 7 days at first) and a period that is too large says so instead of showing a partial list. Pages are cursors, with no total. Entries carry no personal data, so the list permission (`admin:system_logs:read`) covers the details too; admins without it see only that they cannot see it, and the navigation leaves the item out for them. The stories use an in-memory API that answers the real wire format.'
				}
			}
		}
	});

	const now = () => new Date(SYSTEM_LOG_NOW);
	/** Fails the first read, then works (to show Try again). */
	function flaky(): SystemLogClient {
		const ok = createFakeSystemLog({ delay: 0 });
		let calls = 0;
		return {
			async list(query, signal) {
				if (calls++ === 0) throw new ApiError(500, 'server_error', 'Could not list');
				return ok.list(query, signal);
			}
		};
	}
	/** Can read users and nothing else. */
	const noAccess: AdminAccess = {
		platform: false,
		roles: ['custom_none'],
		permissions: ['admin:users:read']
	};
	/** Reads the system log but not the user audit log (no link to it). */
	const systemOnly: AdminAccess = {
		platform: false,
		roles: ['custom_ops'],
		permissions: ['admin:system_logs:read']
	};
	/** The row buttons, named in the current language after the events the sample writes. */
	const EVENTS = [
		'webhook.outbox.dropped',
		'directory_connector_heartbeat.failed',
		'saml.provider.metadata_refreshed',
		'saml.provider.metadata_refresh_failed'
	] as const;
	const rowName = (event: (typeof EVENTS)[number]) =>
		t('slog.row.open', { name: t(`slog.ev.${event}`) });
	const rowsIn = (canvas: ReturnType<typeof within>, events: readonly string[] = EVENTS) => {
		const names = new Set(events.map((event) => rowName(event as (typeof EVENTS)[number])));
		return canvas.queryAllByRole('button', { name: (name: string) => names.has(name) });
	};
</script>

<Story name="System logs">
	{#snippet template()}
		<SystemLog client={createFakeSystemLog({ delay: 200 })} {now} />
	{/snippet}
</Story>

<Story
	name="An entry in full"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const rows = await canvas.findAllByRole('button', {
			name: t('slog.row.open', { name: t('slog.ev.webhook.outbox.dropped') })
		});
		await userEvent.click(rows[0]);
		await canvas.findByText(t('slog.detail.title'));
		// The source and the target are named; the details show the counts.
		expect(canvas.getAllByText(t('slog.src.account_webhook_outbox')).length).toBeGreaterThan(1);
		await canvas.findByText(t('slog.detail.details'));
		await userEvent.click(canvas.getByRole('button', { name: t('slog.detail.close') }));
		await waitFor(() => expect(canvas.queryByText(t('slog.detail.title'))).toBeNull());
	}}
>
	{#snippet template()}
		<SystemLog client={createFakeSystemLog({ delay: 0 })} {now} />
	{/snippet}
</Story>

<Story
	name="Filtered by source"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await waitFor(() => expect(rowsIn(canvas).length).toBeGreaterThan(0));
		await userEvent.selectOptions(
			canvas.getByLabelText(t('slog.filter.source')),
			'authrim/saml_metadata_scheduler'
		);
		await waitFor(() => {
			const rows = rowsIn(canvas);
			expect(rows.length).toBeGreaterThan(0);
			expect(
				rowsIn(canvas, [
					'saml.provider.metadata_refreshed',
					'saml.provider.metadata_refresh_failed'
				])
			).toHaveLength(rows.length);
		});
	}}
>
	{#snippet template()}
		<SystemLog client={createFakeSystemLog({ delay: 0 })} {now} />
	{/snippet}
</Story>

<Story
	name="Load more"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await waitFor(() => expect(rowsIn(canvas).length).toBe(20));
		await userEvent.click(canvas.getByRole('button', { name: t('slog.more') }));
		await waitFor(() => expect(rowsIn(canvas).length).toBe(40));
	}}
>
	{#snippet template()}
		<SystemLog client={createFakeSystemLog({ delay: 0, pageSize: 20 })} {now} />
	{/snippet}
</Story>

<Story
	name="Newest may lag"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('slog.lag.title'));
	}}
>
	{#snippet template()}
		<SystemLog client={createFakeSystemLog({ delay: 0, mayLag: true })} {now} />
	{/snippet}
</Story>

<Story
	name="Older records may be missing"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('slog.hot.title'));
	}}
>
	{#snippet template()}
		<SystemLog client={createFakeSystemLog({ delay: 0, hotOnly: true })} {now} />
	{/snippet}
</Story>

<Story
	name="Event name that cannot be searched"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await waitFor(() => expect(rowsIn(canvas).length).toBeGreaterThan(0));
		const field = canvas.getByLabelText(t('slog.filter.event'));
		expect(field.getAttribute('dir')).toBe('ltr');
		await userEvent.type(field, 'webhook outbox{enter}');
		await canvas.findByText(t('slog.filter.event.invalid'));
		expect(rowsIn(canvas)).toHaveLength(0);
		await userEvent.clear(field);
		await userEvent.type(field, 'webhook.outbox.dropped{enter}');
		await waitFor(() =>
			expect(rowsIn(canvas, ['webhook.outbox.dropped']).length).toBeGreaterThan(0)
		);
		expect(canvas.queryByText(t('slog.filter.event.invalid'))).toBeNull();
	}}
>
	{#snippet template()}
		<SystemLog client={createFakeSystemLog({ delay: 0 })} {now} />
	{/snippet}
</Story>

<Story
	name="Too much data"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('slog.incomplete.title'));
	}}
>
	{#snippet template()}
		<SystemLog client={createFakeSystemLog({ fail: 'incomplete' })} {now} />
	{/snippet}
</Story>

<Story
	name="Empty"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('slog.empty'));
	}}
>
	{#snippet template()}
		<SystemLog client={createFakeSystemLog({ empty: true })} {now} />
	{/snippet}
</Story>

<Story name="Loading">
	{#snippet template()}
		<SystemLog client={createFakeSystemLog({ hang: true })} {now} />
	{/snippet}
</Story>

<Story
	name="Try again"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('load.retry') }));
		await waitFor(() => expect(rowsIn(canvas).length).toBeGreaterThan(0));
		expect(canvas.queryByText(t('slog.loadFailed'))).toBeNull();
	}}
>
	{#snippet template()}
		<SystemLog client={flaky()} {now} />
	{/snippet}
</Story>

<Story
	name="No access"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('slog.noAccess'));
	}}
>
	{#snippet template()}
		<SystemLog client={createFakeSystemLog({ fail: 403 })} access={noAccess} {now} />
	{/snippet}
</Story>

<Story
	name="Without the audit log link"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await waitFor(() => expect(rowsIn(canvas).length).toBeGreaterThan(0));
		expect(canvas.queryByText(t('slog.otherLogs'))).toBeNull();
	}}
>
	{#snippet template()}
		<SystemLog client={createFakeSystemLog({ delay: 0 })} access={systemOnly} {now} />
	{/snippet}
</Story>
