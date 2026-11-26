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
						'Monitoring → Log platform: is the log platform healthy, shown as the flow a record takes (`/api/admin/admin-logging/platform-status`). Three stages, each with its own verdict and the reasons when it is not healthy: delivery (records written to D1 on their way to the archive: sealed, waiting to send, queued, ingested, the oldest waiting, the last error), the log archive (the Iceberg table in R2 Data Catalog: readable up to, mode, generation; for a platform administrator also the whole-platform box with the read budget used by data files, records, snapshots, last commit and last compaction) and log reading (a real 24-hour read through the ordinary log read path: how many minutes back logs can be read, consistency, the reason when the read did not complete). Verdict rules: delivery is failing when a record has waited more than an hour, attention on a last error; the archive is failing when unreachable or when the data files exceed the 128-file read limit, attention when compaction has not run for a day or never; reading is failing when the read did not complete. Delivery counts are the last 24 hours; archive figures are current totals; table-wide figures are platform-only. Every time shows local and UTC. The sensitive-detail chunk catalog follows with its one safe action (apply the automatic repairs; step-up may be asked). The audit coverage registry is kept behind `showCoverage` but not shown. The page never fails because the archive is broken. The stories use an in-memory API that answers the real wire format.'
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
	const statusBadges = (canvas: ReturnType<typeof within>, text: string) =>
		canvas.queryAllByText(text).length;
</script>

<Story
	name="Healthy"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await waitFor(() => expect(statusBadges(canvas, t('lplat.status.ok'))).toBe(3));
		await expect(canvas.getByText(t('lplat.catalog.clean'))).toBeInTheDocument();
		await expect(canvas.getByText(t('lplat.read.until', { minutes: '4' }))).toBeInTheDocument();
		await expect(canvas.queryByText(t('lplat.coverage.title'))).toBeNull();
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
		// Delivery is fine, the archive asks for attention (size is advisory), the read is failing.
		await waitFor(() => expect(statusBadges(canvas, t('lplat.status.danger'))).toBe(1));
		await expect(statusBadges(canvas, t('lplat.status.warning'))).toBe(1);
		await expect(statusBadges(canvas, t('lplat.status.ok'))).toBe(1);
		await expect(canvas.getByText(t('lplat.reason.compaction_never'))).toBeInTheDocument();
		await expect(
			canvas.getByText(
				t('lplat.reason.read_incomplete', { code: 'archive_file_read_budget_exceeded' })
			)
		).toBeInTheDocument();
		await expect(canvas.getByText(t('lplat.archive.never'))).toBeInTheDocument();
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

<Story
	name="Archive unreachable, delivery backed up"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await waitFor(() => expect(statusBadges(canvas, t('lplat.status.danger'))).toBe(3));
		await expect(
			canvas.getByText(t('lplat.reason.delivery_stuck', { count: '54', hours: 3 }))
		).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<LogPlatformStatus
			client={createFakeLogPlatform({ scenario: 'unreachable', delay: 0 })}
			access={platform}
		/>
	{/snippet}
</Story>

<Story
	name="Intents left behind by a dead writer"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// Only delivery fails: four intents no writer committed, the oldest 93 hours ago.
		await waitFor(() => expect(statusBadges(canvas, t('lplat.status.danger'))).toBe(1));
		await expect(statusBadges(canvas, t('lplat.status.ok'))).toBe(2);
		await expect(
			canvas.getByText(t('lplat.reason.intent_orphaned', { count: '4', hours: 93 }))
		).toBeInTheDocument();
		await expect(canvas.getByText(t('lplat.delivery.orphaned'))).toBeInTheDocument();
		// The one action: record all four as never committed; they leave the alarm, stay listed.
		await userEvent.click(canvas.getByRole('button', { name: t('lplat.delivery.reclaim') }));
		await waitFor(() =>
			expect(
				canvas.getByText(t('lplat.delivery.reclaim.done', { abandoned: '4' }))
			).toBeInTheDocument()
		);
		await waitFor(() => expect(statusBadges(canvas, t('lplat.status.ok'))).toBe(3));
		await expect(canvas.getByText(t('lplat.delivery.abandoned'))).toBeInTheDocument();
		await expect(
			canvas.queryByRole('button', { name: t('lplat.delivery.reclaim') })
		).not.toBeInTheDocument();
	}}
>
	{#snippet template()}
		<LogPlatformStatus
			client={createFakeLogPlatform({ scenario: 'orphaned', delay: 0 })}
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
		await expect(canvas.queryByText(t('lplat.archive.platform'))).toBeNull();
		await expect(canvas.queryByRole('button', { name: t('lplat.catalog.repair') })).toBeNull();
		// A tenant is not told a commit point in pipeline mode; it sees its own last acceptance instead.
		await expect(canvas.getByText(t('lplat.read.accepted', { minutes: '9' }))).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<LogPlatformStatus
			client={createFakeLogPlatform({ scenario: 'tenant', delay: 0 })}
			access={tenantAdmin}
		/>
	{/snippet}
</Story>

<Story name="With the audit coverage registry">
	{#snippet template()}
		<LogPlatformStatus
			client={createFakeLogPlatform({ delay: 0 })}
			access={platform}
			showCoverage
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
