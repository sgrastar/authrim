<script lang="ts">
	import { hasPermission, type AdminAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
	import type {
		LogPlatformClient,
		LogPlatformStatus,
		SafeRepairResult
	} from '#lib/api/log-platform.js';
	import { i18n, t } from '#lib/i18n/i18n.svelte.js';
	import { formatNumber } from '#lib/ui/format.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Link from '#lib/ui/primitives/Link.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import {
		consistencyLabel,
		laneLabel,
		laneStatusTone,
		modeLabel,
		statusLabel
	} from './log-platform-labels';

	/**
	 * Monitoring → Log platform: is the log platform healthy. One read answers it: the log
	 * archive's configuration and reachability (and, for a platform administrator, the table's own
	 * size and last compaction), whether a real 24-hour read completes and why not, the delivery
	 * backlog, the audit coverage registry and the sensitive-detail chunk catalog, with the one
	 * safe action, the automatic catalog repair. The page itself never fails because the archive
	 * is broken: that is what it is for.
	 */
	interface Props {
		client: LogPlatformClient;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
	}

	let { client, access }: Props = $props();

	const who = $derived(access ?? adminAccess.current);
	const canRead = $derived(hasPermission(who, 'admin:admin_logging:overview:read'));
	const canRepair = $derived(hasPermission(who, 'admin:admin_logging:repair:run'));
	const canSeeLogs = $derived(hasPermission(who, 'admin:system_logs:read'));

	let status = $state<LogPlatformStatus | null>(null);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let repairing = $state(false);
	let repairResult = $state<SafeRepairResult | null>(null);
	let repairFailed = $state(false);

	const num = (value: number) => formatNumber(value, i18n.locale);
	const STUCK_AFTER_MS = 60 * 60 * 1000;

	let generation = 0;
	async function load(): Promise<void> {
		const mine = ++generation;
		if (!canRead) {
			phase = 'forbidden';
			return;
		}
		phase = 'loading';
		try {
			const next = await client.status();
			if (mine !== generation) return;
			status = next;
			phase = 'ready';
		} catch {
			if (mine !== generation) return;
			phase = 'failed';
		}
	}

	async function repair(): Promise<void> {
		repairing = true;
		repairFailed = false;
		repairResult = null;
		try {
			repairResult = await client.applySafeRepairs(status?.chunk_catalog.scan_limit ?? 200);
			await load();
		} catch (error) {
			if (!(error instanceof StepUpCancelledError)) repairFailed = true;
		} finally {
			repairing = false;
		}
	}

	$effect(() => {
		void load();
	});

	const archive = $derived(status?.archive ?? null);
	const table = $derived(archive?.table ?? null);
	const outbox = $derived(status?.delivery.outbox ?? null);
	const stuck = $derived(
		outbox && outbox.oldest_pending_at !== null && status
			? status.generated_at - outbox.oldest_pending_at >= STUCK_AFTER_MS
			: false
	);
	const stuckHours = $derived(
		outbox?.oldest_pending_at && status
			? Math.floor((status.generated_at - outbox.oldest_pending_at) / STUCK_AFTER_MS)
			: 0
	);
	const overLimit = $derived(archive?.table_size_hint?.data_files_over_limit ?? false);
	const lanes = $derived(status?.delivery_lanes ?? []);
</script>

<Page>
	<PageHeader title={t('nav.mon.logPlatform')} description={t('lplat.page.desc')}>
		{#snippet actions()}
			{#if phase === 'ready'}
				<Button variant="secondary" size="sm" icon="reset" onclick={load}>
					{t('lplat.refresh')}
				</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('lplat.noAccess')} />
	{:else if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'failed' || !status || !archive}
		<EmptyState icon="warning" title={t('lplat.loadFailed')} description={t('load.error.body')}>
			{#snippet action()}
				<Button onclick={load}>{t('load.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		{#if canSeeLogs}
			<Link standalone href="/admin/monitoring/system">{t('lplat.links')}</Link>
		{/if}
		<p class="muted as-of" data-testid="generated-at">
			{t('lplat.asOf')}: <DateTime value={status.generated_at} seconds />
		</p>

		{#if !archive.configured}
			<Callout tone="danger" title={t('lplat.archive.unconfigured.title')} live>
				{t('lplat.archive.unconfigured.body', { code: archive.configuration_error ?? '' })}
			</Callout>
		{:else if !archive.local_staging_only && !archive.reachable}
			<Callout tone="danger" title={t('lplat.archive.unreachable.title')} live>
				{t('lplat.archive.unreachable.body', { code: archive.reachability_error ?? '' })}
			</Callout>
		{:else if overLimit && table?.current_snapshot}
			<Callout tone="warning" title={t('lplat.archive.overLimit.title')} live>
				{t('lplat.archive.overLimit.body', {
					files: num(table.current_snapshot.total_data_files ?? 0),
					max: num(archive.table_size_hint?.max_files ?? 0)
				})}
			</Callout>
		{/if}
		{#if stuck && outbox}
			<Callout tone="warning" title={t('lplat.outbox.stuck.title')} live>
				{t('lplat.outbox.stuck.body', {
					count: num(outbox.pending + outbox.queued),
					hours: stuckHours
				})}
			</Callout>
		{/if}
		{#if status.audit_coverage.gap_detected > 0}
			<Callout tone="warning" title={t('lplat.coverage.gap.title')}>
				{t('lplat.coverage.gap.body', { count: num(status.audit_coverage.gap_detected) })}
			</Callout>
		{/if}

		<div class="grid">
			<Card title={t('lplat.archive.title')} description={t('lplat.archive.desc')}>
				<DetailList columns={2} size="sm">
					<DetailItem label={t('lplat.archive.mode')}>
						{#if archive.local_staging_only}
							{t('lplat.archive.local')}
						{:else if archive.mode}
							{modeLabel(archive.mode, t)}
						{:else}
							—
						{/if}
					</DetailItem>
					<DetailItem label={t('lplat.archive.reach')}>
						{#if !archive.configured}
							—
						{:else if archive.local_staging_only}
							—
						{:else}
							<Badge tone={archive.reachable ? 'success' : 'danger'} dot>
								{t(archive.reachable ? 'lplat.archive.reach.ok' : 'lplat.archive.reach.ng')}
							</Badge>
						{/if}
					</DetailItem>
					<DetailItem label={t('lplat.archive.generation')}>
						{#if archive.generation}<code>{archive.generation}</code>{:else}—{/if}
					</DetailItem>
					<DetailItem label={t('lplat.archive.activated')}>
						{#if archive.activated_at}<DateTime value={archive.activated_at} />{:else}—{/if}
					</DetailItem>
					{#if table}
						<DetailItem label={t('lplat.archive.table.files')}>
							{#if table.current_snapshot?.total_data_files !== null && table.current_snapshot}
								<span class:over={overLimit}
									>{num(table.current_snapshot.total_data_files ?? 0)}</span
								>
								{#if archive.table_size_hint}
									<span class="muted"> / {num(archive.table_size_hint.max_files)}</span>
								{/if}
							{:else}
								—
							{/if}
						</DetailItem>
						<DetailItem label={t('lplat.archive.table.records')}>
							{table.current_snapshot?.total_records === null ||
							table.current_snapshot?.total_records === undefined
								? '—'
								: num(table.current_snapshot.total_records)}
						</DetailItem>
						<DetailItem label={t('lplat.archive.table.snapshots')}>
							{num(table.snapshot_count)}
						</DetailItem>
						<DetailItem label={t('lplat.archive.table.lastCommit')}>
							{#if table.current_snapshot}
								<DateTime value={table.current_snapshot.committed_at} seconds />
							{:else}
								—
							{/if}
						</DetailItem>
						<DetailItem label={t('lplat.archive.table.lastCompaction')}>
							{#if table.last_compaction_at}
								<DateTime value={table.last_compaction_at} />
							{:else}
								<Badge tone={overLimit ? 'warning' : 'neutral'}
									>{t('lplat.archive.table.never')}</Badge
								>
							{/if}
						</DetailItem>
					{/if}
				</DetailList>
				{#if archive.configured && !archive.local_staging_only && !table}
					<p class="muted note">{t('lplat.archive.tenantNote')}</p>
				{/if}
			</Card>

			<Card title={t('lplat.probe.title')} description={t('lplat.probe.desc')}>
				<DetailList size="sm">
					<DetailItem label={t('lplat.probe.title')}>
						<Badge tone={archive.read_probe.ok ? 'success' : 'danger'} dot>
							{t(archive.read_probe.ok ? 'lplat.probe.ok' : 'lplat.probe.ng')}
						</Badge>
					</DetailItem>
					{#if !archive.read_probe.ok}
						<DetailItem label={t('lplat.probe.reason')}>
							<code>{archive.read_probe.reason ?? '—'}</code>
						</DetailItem>
					{/if}
					{#if archive.read_probe.coverage}
						<DetailItem label={t('lplat.probe.consistency')}>
							{consistencyLabel(archive.read_probe.coverage.consistency, t)}
						</DetailItem>
						{#if archive.read_probe.coverage.pending_deliveries !== null}
							<DetailItem label={t('lplat.probe.pending')}>
								{num(archive.read_probe.coverage.pending_deliveries)}
							</DetailItem>
						{/if}
					{/if}
					{#if archive.read_probe.ok && !archive.read_probe.has_archive}
						<DetailItem label={t('lplat.archive.title')}>
							<span class="muted">{t('lplat.probe.noArchive')}</span>
						</DetailItem>
					{/if}
				</DetailList>
			</Card>

			<Card title={t('lplat.delivery.title')} description={t('lplat.delivery.desc')}>
				<DetailList columns={2} size="sm">
					<DetailItem label={t('lplat.delivery.published')}>
						{num(status.delivery.publications.published)}
					</DetailItem>
					<DetailItem label={t('lplat.delivery.prepared')}>
						{num(status.delivery.publications.prepared)}
					</DetailItem>
					<DetailItem label={t('lplat.delivery.aborted')}>
						{num(status.delivery.publications.aborted)}
					</DetailItem>
					{#if outbox}
						<DetailItem label={t('lplat.outbox.pending')}>
							<span class:over={stuck}>{num(outbox.pending)}</span>
						</DetailItem>
						<DetailItem label={t('lplat.outbox.queued')}>{num(outbox.queued)}</DetailItem>
						<DetailItem label={t('lplat.outbox.oldest')}>
							{#if outbox.oldest_pending_at}
								<DateTime value={outbox.oldest_pending_at} seconds />
							{:else}
								<span class="muted">{t('lplat.none')}</span>
							{/if}
						</DetailItem>
						<DetailItem label={t('lplat.outbox.lastError')}>
							{#if outbox.last_error_code}
								<code>{outbox.last_error_code}</code>
							{:else}
								<span class="muted">{t('lplat.none')}</span>
							{/if}
						</DetailItem>
					{/if}
					{#if status.delivery.export}
						{@const exp = status.delivery.export}
						<DetailItem label={t('lplat.export.state')}>
							{#if exp.last_state}<code>{exp.last_state}</code>{:else}—{/if}
						</DetailItem>
						<DetailItem label={t('lplat.export.updated')}>
							{#if exp.updated_at}<DateTime value={exp.updated_at} seconds />{:else}—{/if}
						</DetailItem>
						<DetailItem label={t('lplat.export.lastError')}>
							{#if exp.last_error_code}
								<code>{exp.last_error_code}</code>
							{:else}
								<span class="muted">{t('lplat.none')}</span>
							{/if}
						</DetailItem>
						<DetailItem label={t('lplat.export.watermark')}>
							{#if exp.watermark}
								<code>{exp.watermark.snapshot_id}</code>
								<span class="muted"> · <DateTime value={exp.watermark.updated_at} /></span>
							{:else}
								<span class="muted">{t('lplat.none')}</span>
							{/if}
						</DetailItem>
					{/if}
				</DetailList>
			</Card>

			<Card title={t('lplat.coverage.title')} description={t('lplat.coverage.desc')}>
				<DetailList columns={2} size="sm">
					<DetailItem label={t('lplat.coverage.covered')}
						>{num(status.audit_coverage.covered)}</DetailItem
					>
					<DetailItem label={t('lplat.coverage.gap')}>
						<span class:over={status.audit_coverage.gap_detected > 0}>
							{num(status.audit_coverage.gap_detected)}
						</span>
					</DetailItem>
					<DetailItem label={t('lplat.coverage.acknowledged')}>
						{num(status.audit_coverage.acknowledged)}
					</DetailItem>
					<DetailItem label={t('lplat.coverage.ignored')}
						>{num(status.audit_coverage.ignored)}</DetailItem
					>
					<DetailItem label={t('lplat.coverage.lastChecked')}>
						{#if status.audit_coverage.last_checked_at}
							<DateTime value={status.audit_coverage.last_checked_at} />
						{:else}
							<span class="muted">{t('lplat.coverage.never')}</span>
						{/if}
					</DetailItem>
				</DetailList>
			</Card>

			<Card title={t('lplat.catalog.title')} description={t('lplat.catalog.desc')}>
				{#snippet actions()}
					{#if canRepair && status && status.chunk_catalog.sampled_repair_findings > 0}
						<Button size="sm" variant="secondary" loading={repairing} onclick={repair}>
							{t('lplat.catalog.repair')}
						</Button>
					{/if}
				{/snippet}
				{#if repairResult}
					<Callout tone="info" live>
						{t('lplat.catalog.repair.done', {
							applied: num(repairResult.applied_count),
							skipped: num(repairResult.skipped_count)
						})}
					</Callout>
				{/if}
				{#if repairFailed}
					<Callout tone="danger" live>{t('lplat.catalog.repair.failed')}</Callout>
				{/if}
				<DetailList columns={2} size="sm">
					<DetailItem label={t('lplat.catalog.findings')}>
						{#if status.chunk_catalog.sampled_repair_findings === 0}
							<Badge tone="success" dot>{t('lplat.catalog.clean')}</Badge>
						{:else}
							<Badge tone="warning" dot>{num(status.chunk_catalog.sampled_repair_findings)}</Badge>
						{/if}
						<div class="muted">
							{t('lplat.catalog.sample', { limit: num(status.chunk_catalog.scan_limit) })}
						</div>
					</DetailItem>
					<DetailItem label={t('lplat.catalog.sensitive')}>
						{num(status.chunk_catalog.sampled_sensitive_detail_findings)}
					</DetailItem>
					{#each status.chunk_catalog.sensitive_detail_index as entry (entry.store)}
						<DetailItem label="{t('lplat.catalog.index')} · {entry.store}">
							{#if entry.indexed_objects !== null}
								{t('lplat.catalog.index.count', { count: num(entry.indexed_objects) })}
							{:else}
								<span class="muted">
									{t(
										entry.error === 'index_table_missing'
											? 'lplat.catalog.index.missing'
											: 'lplat.catalog.index.unavailable'
									)}
								</span>
							{/if}
						</DetailItem>
					{/each}
				</DetailList>
			</Card>
		</div>

		<Card title={t('lplat.lanes.title')} info={t('lplat.lanes.desc')} flush>
			<DataTable
				caption={t('lplat.lanes.title')}
				columns={[
					{ key: 'lane', label: t('lplat.lanes.col.lane'), width: '30%' },
					{ key: 'status', label: t('lplat.lanes.col.status'), width: '40%' },
					{ key: 'total', label: t('lplat.lanes.col.total') }
				]}
				rows={lanes}
				rowKey={(row) => `${row.lane}:${row.status}`}
			>
				{#snippet cell(row, column)}
					{#if column.key === 'lane'}
						{laneLabel(row.lane, t)}
					{:else if column.key === 'status'}
						<Badge tone={laneStatusTone(row.status)}>{statusLabel(row.status, t)}</Badge>
					{:else}
						{num(row.total)}
					{/if}
				{/snippet}
				{#snippet empty()}
					<EmptyState icon="file" title={t('lplat.lanes.empty')} />
				{/snippet}
			</DataTable>
		</Card>
	{/if}
</Page>

<style>
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
		gap: var(--space-columns);
	}
	.as-of {
		margin: 0;
		font-size: var(--fs-small);
	}
	.muted {
		color: var(--text-muted);
	}
	.note {
		margin: var(--space-related) 0 0;
		font-size: var(--fs-small);
	}
	.over {
		color: var(--danger);
		font-weight: var(--fw-semibold);
	}
</style>
