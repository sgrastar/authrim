<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import type { AdminAccess } from '#lib/access/access.js';
	import { createFakeLogPlatform } from '#lib/api/fake/log-platform-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import LogPlatformStatus from './LogPlatformStatus.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Monitoring/Log platform',
		component: LogPlatformStatus,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Monitoring → Log platform: is the log platform healthy, in one read (`/api/admin/admin-logging/platform-status`). The log archive (the Iceberg table in R2 Data Catalog): configured, reachable, and for a platform administrator its own size, last commit and last compaction against the 128-file read limit. Whether a real 24-hour read through the ordinary log read path completed, and the reason when it did not. The delivery backlog (pipeline outbox or scheduled export and watermark), the audit coverage registry, the sensitive-detail chunk catalog with its one safe action (apply the automatic repairs, step-up may be asked), and the delivery lanes of the day. The page never fails because the archive is broken: that is what it is for. A tenant administrator sees the same page without the shared table statistics. The stories use an in-memory API that answers the real wire format.'
				}
			}
		}
	});

	const platform: AdminAccess = {
		platform: true,
		roles: ['ar_super_admin'],
		permissions: [
			'admin:admin_logging:overview:read',
			'admin:admin_logging:repair:run',
			'admin:system_logs:read'
		]
	};
	const tenantAdmin: AdminAccess = {
		platform: false,
		roles: ['ar_tenant_admin'],
		permissions: ['admin:admin_logging:overview:read', 'admin:system_logs:read']
	};
	const noAccess: AdminAccess = {
		platform: false,
		roles: ['custom_none'],
		permissions: ['admin:users:read']
	};
</script>

<Story
	name="Healthy"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await waitFor(() => expect(canvas.getByText(t('lplat.archive.reach.ok'))).toBeInTheDocument());
		await expect(canvas.getByText(t('lplat.probe.ok'))).toBeInTheDocument();
		await expect(canvas.getByText(t('lplat.catalog.clean'))).toBeInTheDocument();
		await expect(canvas.queryByText(t('lplat.archive.overLimit.title'))).toBeNull();
	}}
>
	{#snippet template()}
		<LogPlatformStatus client={createFakeLogPlatform({ delay: 200 })} access={platform} />
	{/snippet}
</Story>

<Story
	name="Table outgrew the read limit"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await waitFor(() =>
			expect(canvas.getByText(t('lplat.archive.overLimit.title'))).toBeInTheDocument()
		);
		await expect(canvas.getByText(t('lplat.probe.ng'))).toBeInTheDocument();
		await expect(canvas.getByText('archive_file_read_budget_exceeded')).toBeInTheDocument();
		await expect(canvas.getByText(t('lplat.archive.table.never'))).toBeInTheDocument();
		// The one action: the safe repair, which empties the findings.
		await userEvent.click(canvas.getByRole('button', { name: t('lplat.catalog.repair') }));
		await waitFor(() => expect(canvas.getByText(t('lplat.catalog.clean'))).toBeInTheDocument());
		await expect(
			canvas.getByText(t('lplat.catalog.repair.done', { applied: '3', skipped: '0' }))
		).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<LogPlatformStatus
			client={createFakeLogPlatform({ scenario: 'over-limit', delay: 0 })}
			access={platform}
		/>
	{/snippet}
</Story>

<Story name="Archive unreachable, delivery backed up">
	{#snippet template()}
		<LogPlatformStatus
			client={createFakeLogPlatform({ scenario: 'unreachable', delay: 0 })}
			access={platform}
		/>
	{/snippet}
</Story>

<Story name="Archive not configured">
	{#snippet template()}
		<LogPlatformStatus
			client={createFakeLogPlatform({ scenario: 'unconfigured', delay: 0 })}
			access={platform}
		/>
	{/snippet}
</Story>

<Story name="Scheduled mode">
	{#snippet template()}
		<LogPlatformStatus
			client={createFakeLogPlatform({ scenario: 'scheduled', delay: 0 })}
			access={platform}
		/>
	{/snippet}
</Story>

<Story
	name="Tenant administrator"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await waitFor(() =>
			expect(canvas.getByText(t('lplat.archive.tenantNote'))).toBeInTheDocument()
		);
		await expect(canvas.queryByText(t('lplat.archive.table.files'))).toBeNull();
		await expect(canvas.queryByRole('button', { name: t('lplat.catalog.repair') })).toBeNull();
	}}
>
	{#snippet template()}
		<LogPlatformStatus
			client={createFakeLogPlatform({ scenario: 'tenant', delay: 0 })}
			access={tenantAdmin}
		/>
	{/snippet}
</Story>

<Story name="Loading">
	{#snippet template()}
		<LogPlatformStatus client={createFakeLogPlatform({ hang: true })} access={platform} />
	{/snippet}
</Story>

<Story
	name="Failed to load"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await waitFor(() => expect(canvas.getByText(t('lplat.loadFailed'))).toBeInTheDocument());
	}}
>
	{#snippet template()}
		<LogPlatformStatus client={createFakeLogPlatform({ fail: 500, delay: 0 })} access={platform} />
	{/snippet}
</Story>

<Story
	name="No access"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await waitFor(() => expect(canvas.getByText(t('lplat.noAccess'))).toBeInTheDocument());
	}}
>
	{#snippet template()}
		<LogPlatformStatus client={createFakeLogPlatform({ delay: 0 })} access={noAccess} />
	{/snippet}
</Story>
