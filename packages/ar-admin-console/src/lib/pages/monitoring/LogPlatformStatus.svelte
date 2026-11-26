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
	import Icon from '#lib/ui/icons/Icon.svelte';
	import type { IconName } from '#lib/ui/icons/icons.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Link from '#lib/ui/primitives/Link.svelte';
	import ProgressBar from '#lib/ui/primitives/ProgressBar.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { consistencyLabel, modeLabel } from './log-platform-labels';
	import {
		archiveVerdict,
		deliveryVerdict,
		readBudgetPercent,
		readVerdict,
		readableLagMinutes,
		readableUntil,
		stuckHours,
		type StageReason,
		type StageVerdict
	} from './log-platform-model';

	/**
	 * Monitoring → Log platform: is the log platform healthy, shown as the flow a record takes.
	 * Three stages, each with its own verdict: delivery (D1 → archive), the log archive (the
	 * Iceberg table; a platform administrator also sees its size against the read limit and its
	 * last compaction) and log reading (a real 24-hour read through the ordinary path). The
	 * sensitive-detail chunk catalog follows with its one safe action. The page never fails
	 * because the archive is broken: that is what it is for.
	 */
	interface Props {
		client: LogPlatformClient;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
		/** The audit coverage registry is kept but not shown; a story may turn it on. */
		showCoverage?: boolean;
	}

	let { client, access, showCoverage = false }: Props = $props();

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
	const exp = $derived(status?.delivery.export ?? null);
	const verdicts = $derived(
		status
			? {
					delivery: deliveryVerdict(status),
					archive: archiveVerdict(status),
					read: readVerdict(status)
				}
			: null
	);
	const until = $derived(status ? readableUntil(status) : null);
	const lag = $derived(status ? readableLagMinutes(status) : null);
	const budget = $derived(status ? readBudgetPercent(status) : null);

	const TONE = {
		ok: 'success',
		warning: 'warning',
		danger: 'danger',
		none: 'neutral'
	} as const;

	/** The words for one reason, with the figures it names. */
	function reasonText(reason: StageReason): string {
		if (!status) return '';
		const a = status.archive;
		switch (reason) {
			case 'archive_unconfigured':
				return t('lplat.reason.archive_unconfigured', { code: a.configuration_error ?? '' });
			case 'archive_unreachable':
				return t('lplat.reason.archive_unreachable', { code: a.reachability_error ?? '' });
			case 'delivery_stuck':
				return t('lplat.reason.delivery_stuck', {
					count: num((outbox?.pending ?? 0) + (outbox?.queued ?? 0)),
					hours: stuckHours(status)
				});
			case 'delivery_error':
				return t('lplat.reason.delivery_error', { code: outbox?.last_error_code ?? '' });
			case 'files_over_limit':
				return t('lplat.reason.files_over_limit', {
					files: num(table?.current_snapshot?.total_data_files ?? 0),
					max: num(a.table_size_hint?.max_files ?? 0)
				});
			case 'compaction_stale':
				return t('lplat.reason.compaction_stale');
			case 'compaction_never':
				return t('lplat.reason.compaction_never');
			case 'read_incomplete':
				return t('lplat.reason.read_incomplete', { code: a.read_probe.reason ?? '' });
			case 'export_error':
				return t('lplat.reason.export_error', {
					code: exp?.active_failure?.error_code ?? exp?.last_error_code ?? ''
				});
		}
	}
</script>

{#snippet stageHead(icon: IconName, title: string, desc: string, verdict: StageVerdict)}
	<header class="stage__head">
		<span class="stage__icon" aria-hidden="true"><Icon name={icon} size={28} /></span>
		<h2 class="stage__title">{title}</h2>
		<p class="stage__desc">{desc}</p>
	</header>
	<div class="stage__status">
		<span class="stage__status-label">{t('lplat.status')}</span>
		<Badge tone={TONE[verdict.tone]} dot={verdict.tone !== 'none'} size="md">
			{t(`lplat.status.${verdict.tone}`)}
		</Badge>
	</div>
	{#if verdict.reasons.length > 0 && verdict.tone !== 'none'}
		<ul class="stage__reasons" class:is-danger={verdict.tone === 'danger'}>
			{#each verdict.reasons as reason (reason)}
				<li>{reasonText(reason)}</li>
			{/each}
		</ul>
	{/if}
{/snippet}

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
	{:else if phase === 'failed' || !status || !archive || !verdicts}
		<EmptyState icon="warning" title={t('lplat.loadFailed')} description={t('load.error.body')}>
			{#snippet action()}
				<Button onclick={load}>{t('load.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		<div class="meta">
			<p class="meta__as-of">
				<span class="muted">{t('lplat.asOf')}:</span>
				<DateTime value={status.generated_at} seconds showSecondary />
			</p>
			<p class="muted meta__period">{t('lplat.period')}</p>
			{#if canSeeLogs}
				<Link standalone href="/admin/monitoring/system">{t('lplat.links')}</Link>
			{/if}
		</div>

		<section class="flow" aria-label={t('lplat.flow.label')}>
			<!-- 1. Delivery -->
			<article class="stage" data-stage="delivery">
				{@render stageHead(
					'upload',
					t('lplat.stage.delivery'),
					t('lplat.stage.delivery.desc'),
					verdicts.delivery
				)}
				{#if archive.configured}
					<DetailList ruled size="sm">
						<DetailItem label={t('lplat.delivery.lastIngested')}>
							{#if status.delivery.last_ingested_at}
								<DateTime value={status.delivery.last_ingested_at} seconds showSecondary />
							{:else}
								—
							{/if}
						</DetailItem>
						<DetailItem label={t('lplat.delivery.published')}>
							{num(status.delivery.recent.published)}
							<span class="muted unit">{t('lplat.delivery.unit')}</span>
						</DetailItem>
						<DetailItem label={t('lplat.delivery.prepared')}>
							{num(status.delivery.recent.prepared)}
							<span class="muted unit">{t('lplat.delivery.unit')}</span>
						</DetailItem>
						<DetailItem label={t('lplat.delivery.aborted')}>
							{num(status.delivery.recent.aborted)}
							<span class="muted unit">{t('lplat.delivery.unit')}</span>
						</DetailItem>
						{#if outbox}
							<DetailItem label={t('lplat.delivery.pending')}>
								<span class:attention={verdicts.delivery.reasons.includes('delivery_stuck')}>
									{num(outbox.pending)}
								</span>
								<span class="muted unit">{t('lplat.delivery.unit')}</span>
							</DetailItem>
							<DetailItem label={t('lplat.delivery.queued')}>
								{num(outbox.queued)}
								<span class="muted unit">{t('lplat.delivery.unit')}</span>
							</DetailItem>
							<DetailItem label={t('lplat.delivery.ingested')}>
								{num(status.delivery.recent.ingested)}
								<span class="muted unit">{t('lplat.delivery.unit')}</span>
							</DetailItem>
							{#if outbox.oldest_pending_at}
								<DetailItem label={t('lplat.delivery.oldest')}>
									<DateTime value={outbox.oldest_pending_at} seconds showSecondary />
								</DetailItem>
							{/if}
							{#if outbox.last_error_code}
								<DetailItem label={t('lplat.delivery.lastError')}>
									<code>{outbox.last_error_code}</code>
								</DetailItem>
							{/if}
						{/if}
						{#if exp}
							<DetailItem label={t('lplat.delivery.export.state')}>
								{#if exp.last_state}<code>{exp.last_state}</code>{:else}—{/if}
							</DetailItem>
							{#if exp.updated_at}
								<DetailItem label={t('lplat.delivery.export.updated')}>
									<DateTime value={exp.updated_at} seconds showSecondary />
								</DetailItem>
							{/if}
							{#if exp.last_error_code}
								<DetailItem label={t('lplat.delivery.lastError')}>
									<code>{exp.last_error_code}</code>
								</DetailItem>
							{/if}
							{#if exp.watermark}
								<DetailItem label={t('lplat.delivery.export.watermark')}>
									<DateTime value={exp.watermark.updated_at} seconds showSecondary />
									<span class="second"><code>{exp.watermark.snapshot_id}</code></span>
								</DetailItem>
							{/if}
						{/if}
					</DetailList>
				{/if}
			</article>

			<div class="flow__arrow" aria-hidden="true"></div>

			<!-- 2. Archive -->
			<article class="stage" data-stage="archive">
				{@render stageHead(
					'database',
					t('lplat.stage.archive'),
					t('lplat.stage.archive.desc'),
					verdicts.archive
				)}
				{#if archive.configured}
					<DetailList ruled size="sm">
						<DetailItem label={t('lplat.archive.readableUntil')}>
							{#if until !== null}
								<DateTime value={until} seconds showSecondary />
							{:else}
								—
							{/if}
						</DetailItem>
						<DetailItem label={t('lplat.archive.mode')}>
							{#if archive.local_staging_only}
								{t('lplat.archive.local')}
							{:else if archive.mode}
								{modeLabel(archive.mode, t)}
							{:else}
								—
							{/if}
						</DetailItem>
						<DetailItem label={t('lplat.archive.generation')}>
							{#if archive.generation}<code>{archive.generation}</code>{:else}—{/if}
						</DetailItem>
						<DetailItem label={t('lplat.archive.activated')}>
							{#if archive.activated_at}
								<DateTime value={archive.activated_at} showSecondary />
							{:else}
								—
							{/if}
						</DetailItem>
					</DetailList>

					{#if table}
						<div class="platform" data-testid="platform-box">
							<h3 class="platform__title">{t('lplat.archive.platform')}</h3>
							{#if budget !== null && archive.table_size_hint}
								<ProgressBar
									label={t('lplat.archive.budget')}
									value={Math.min(budget, 100)}
									showLabel
									showValue
									size="sm"
									tone={budget > 100 ? 'danger' : 'default'}
								/>
								<p class="muted platform__detail">
									{t('lplat.archive.budget.detail', {
										files: num(table.current_snapshot?.total_data_files ?? 0),
										max: num(archive.table_size_hint.max_files)
									})}
									{#if budget > 100}<span class="attention"> ({budget}%)</span>{/if}
								</p>
							{/if}
							<DetailList ruled size="sm">
								<DetailItem label={t('lplat.archive.records')}>
									{table.current_snapshot?.total_records === null ||
									table.current_snapshot?.total_records === undefined
										? '—'
										: num(table.current_snapshot.total_records)}
								</DetailItem>
								<DetailItem label={t('lplat.archive.files')}>
									{table.current_snapshot?.total_data_files === null ||
									table.current_snapshot?.total_data_files === undefined
										? '—'
										: num(table.current_snapshot.total_data_files)}
								</DetailItem>
								<DetailItem label={t('lplat.archive.snapshots')}>
									{num(table.snapshot_count)}
								</DetailItem>
								<DetailItem label={t('lplat.archive.lastCommit')}>
									{#if table.current_snapshot}
										<DateTime value={table.current_snapshot.committed_at} seconds showSecondary />
									{:else}
										—
									{/if}
								</DetailItem>
								<DetailItem label={t('lplat.archive.lastCompaction')}>
									{#if table.last_compaction_at}
										<DateTime value={table.last_compaction_at} seconds showSecondary />
									{:else}
										<Badge tone={verdicts.archive.tone === 'ok' ? 'neutral' : 'warning'}>
											{t('lplat.archive.never')}
										</Badge>
									{/if}
								</DetailItem>
							</DetailList>
						</div>
					{:else if !archive.local_staging_only}
						<p class="muted note">{t('lplat.archive.tenantNote')}</p>
					{/if}
				{/if}
			</article>

			<div class="flow__arrow" aria-hidden="true"></div>

			<!-- 3. Reading -->
			<article class="stage" data-stage="read">
				{@render stageHead(
					'search',
					t('lplat.stage.read'),
					t('lplat.stage.read.desc'),
					verdicts.read
				)}
				{#if archive.configured}
					<p class="read__until">
						{#if lag === null || !archive.read_probe.ok}
							<span class="muted">{t('lplat.read.unknown')}</span>
						{:else if lag === 0}
							{t('lplat.read.untilNow')}
						{:else}
							{t('lplat.read.until', { minutes: num(lag) })}
						{/if}
					</p>
					<DetailList ruled size="sm">
						{#if !archive.read_probe.ok}
							<DetailItem label={t('lplat.read.reason')}>
								<code>{archive.read_probe.reason ?? '—'}</code>
							</DetailItem>
						{/if}
						{#if archive.read_probe.coverage}
							<DetailItem label={t('lplat.read.consistency')}>
								{consistencyLabel(archive.read_probe.coverage.consistency, t)}
							</DetailItem>
							{#if archive.read_probe.coverage.pending_deliveries !== null}
								<DetailItem label={t('lplat.read.pending')}>
									{num(archive.read_probe.coverage.pending_deliveries)}
									<span class="muted unit">{t('lplat.delivery.unit')}</span>
								</DetailItem>
							{/if}
						{/if}
						{#if archive.read_probe.ok && !archive.read_probe.has_archive}
							<DetailItem label={t('lplat.stage.archive')}>
								<span class="muted">{t('lplat.read.noArchive')}</span>
							</DetailItem>
						{/if}
					</DetailList>
				{/if}
			</article>
		</section>

		{#if showCoverage}
			<Card title={t('lplat.coverage.title')} info={t('lplat.coverage.desc')}>
				<DetailList columns={3} size="sm">
					<DetailItem label={t('lplat.coverage.covered')}
						>{num(status.audit_coverage.covered)}</DetailItem
					>
					<DetailItem label={t('lplat.coverage.gap')}>
						<span class:attention={status.audit_coverage.gap_detected > 0}>
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
							<DateTime value={status.audit_coverage.last_checked_at} showSecondary />
						{:else}
							<span class="muted">{t('lplat.coverage.never')}</span>
						{/if}
					</DetailItem>
				</DetailList>
			</Card>
		{/if}

		<Card title={t('lplat.catalog.title')} info={t('lplat.catalog.desc')}>
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
			<DetailList columns={3} size="sm">
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
	{/if}
</Page>

<style>
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-related) var(--space-field);
	}
	.meta p {
		margin: 0;
		font-size: var(--fs-small);
	}
	.muted {
		color: var(--text-muted);
	}
	.unit {
		margin-inline-start: 0.25em;
		font-size: var(--fs-small);
	}
	.second {
		display: block;
		font-size: var(--fs-small);
		color: var(--text-muted);
	}
	.attention {
		color: var(--danger);
		font-weight: var(--fw-semibold);
	}

	/* The flow: three stages with an arrow between them; stacked when the row cannot fit. */
	.flow {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto minmax(0, 1fr);
		gap: var(--space-related);
		align-items: stretch;
	}
	.stage {
		display: flex;
		flex-direction: column;
		gap: var(--space-field);
		padding: var(--space-field);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--bg-card);
	}
	.stage__head {
		display: grid;
		grid-template-columns: auto 1fr;
		grid-template-rows: auto auto;
		column-gap: var(--space-related);
		align-items: center;
	}
	.stage__icon {
		grid-row: 1 / span 2;
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		border-radius: var(--radius-md);
		background: var(--bg-subtle);
		color: var(--text-secondary);
	}
	.stage__title {
		margin: 0;
		font-size: var(--fs-title);
		font-weight: var(--fw-semibold);
		line-height: var(--lh-tight);
	}
	.stage__desc {
		margin: 0;
		font-size: var(--fs-small);
		line-height: var(--lh-snug);
		color: var(--text-muted);
	}
	.stage__status {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-related);
		padding-block: var(--space-related);
		border-block: 1px solid var(--border-subtle);
	}
	.stage__status-label {
		font-size: var(--fs-label);
		font-weight: var(--fw-medium);
		color: var(--text-secondary);
	}
	.stage__reasons {
		margin: 0;
		padding: var(--space-related) var(--space-field);
		border-radius: var(--radius-md);
		background: var(--warning-bg);
		color: var(--warning-text);
		font-size: var(--fs-small);
		line-height: var(--lh-snug);
		list-style: none;
	}
	.stage__reasons.is-danger {
		background: var(--danger-bg);
		color: var(--danger);
	}
	.stage__reasons li + li {
		margin-top: var(--space-related);
	}
	.flow__arrow {
		align-self: center;
		width: 28px;
		height: 2px;
		margin-top: 22px;
		background: var(--border);
		position: relative;
	}
	.flow__arrow::after {
		content: '';
		position: absolute;
		inset-inline-end: -1px;
		top: -5px;
		border: 6px solid transparent;
		border-inline-start: 8px solid var(--border);
		border-inline-end: 0;
	}
	.platform {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
		padding: var(--space-field);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--bg-subtle);
	}
	.platform__title {
		margin: 0;
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
		color: var(--text-secondary);
	}
	.platform__detail {
		margin: 0;
		font-size: var(--fs-small);
	}
	.note {
		margin: 0;
		font-size: var(--fs-small);
	}
	.read__until {
		margin: 0;
		font-size: var(--fs-body);
		font-weight: var(--fw-medium);
	}

	@media (max-width: 1100px) {
		.flow {
			grid-template-columns: minmax(0, 1fr);
		}
		.flow__arrow {
			justify-self: center;
			width: 2px;
			height: 24px;
			margin: 0;
		}
		.flow__arrow::after {
			inset-inline-end: auto;
			left: -5px;
			top: auto;
			bottom: -1px;
			border: 6px solid transparent;
			border-top: 8px solid var(--border);
			border-bottom: 0;
		}
	}
</style>
