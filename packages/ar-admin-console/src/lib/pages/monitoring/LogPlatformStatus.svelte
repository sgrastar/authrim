<script lang="ts">
	import type { Snippet } from 'svelte';
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
	import InfoTip from '#lib/ui/primitives/InfoTip.svelte';
	import type { IconName } from '#lib/ui/icons/icons.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Link from '#lib/ui/primitives/Link.svelte';
	import ProgressBar from '#lib/ui/primitives/ProgressBar.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { modeLabel } from './log-platform-labels';
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
	/** For a caller who is not shown the table's commits: minutes since its last accepted record. */
	const acceptedLag = $derived(
		status?.delivery.last_ingested_at
			? Math.max(0, Math.floor((status.generated_at - status.delivery.last_ingested_at) / 60_000))
			: null
	);
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
				if (exp && !outbox) {
					const oldest = Math.min(
						exp.oldest_unfinished_at ?? Number.POSITIVE_INFINITY,
						exp.oldest_eligible_since ?? Number.POSITIVE_INFINITY
					);
					return t('lplat.reason.export_stalled', {
						hours: Math.floor((status.generated_at - oldest) / 3_600_000)
					});
				}
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
			case 'publication_stalled':
				return t('lplat.reason.publication_stalled', {
					hours: Math.floor(
						(status.generated_at - (status.delivery.oldest_prepared_at ?? status.generated_at)) /
							3_600_000
					)
				});
			case 'export_error':
				return t('lplat.reason.export_error', {
					code: exp?.active_failure?.error_code ?? exp?.last_error_code ?? ''
				});
		}
	}
</script>

{#snippet fact(label: string, value: Snippet)}
	<div class="fact">
		<dt>{label}</dt>
		<dd>{@render value()}</dd>
	</div>
{/snippet}

{#snippet count(value: number)}
	<span class="num">{num(value)}</span><span class="unit">{t('lplat.delivery.unit')}</span>
{/snippet}

{#snippet when(value: number | null | undefined)}
	{#if value}
		<DateTime {value} seconds showSecondary stacked />
	{:else}
		<span class="muted">—</span>
	{/if}
{/snippet}

{#snippet stageHead(icon: IconName, title: string, desc: string, verdict: StageVerdict)}
	<header class="stage__head">
		<span class="stage__link" aria-hidden="true"></span>
		<span class="stage__icon" aria-hidden="true"><Icon name={icon} size={30} /></span>
		<div class="stage__title-row">
			<h2 class="stage__title">{title}</h2>
			<InfoTip label="{t('common.moreInfo')}: {title}" text={desc} />
		</div>
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
			<p class="muted">{t('lplat.period')}</p>
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
					<dl class="facts">
						{#snippet lastAccepted()}{@render when(status?.delivery.last_ingested_at)}{/snippet}
						{@render fact(t('lplat.delivery.lastIngested'), lastAccepted)}
						{#snippet published()}{@render count(status?.delivery.recent.published ?? 0)}{/snippet}
						{@render fact(t('lplat.delivery.published'), published)}
						{#snippet prepared()}{@render count(status?.delivery.recent.prepared ?? 0)}{/snippet}
						{@render fact(t('lplat.delivery.prepared'), prepared)}
						{#snippet aborted()}{@render count(status?.delivery.recent.aborted ?? 0)}{/snippet}
						{@render fact(t('lplat.delivery.aborted'), aborted)}
						{#if outbox}
							{#snippet pending()}
								<span class:attention={verdicts?.delivery.reasons.includes('delivery_stuck')}>
									{@render count(outbox?.pending ?? 0)}
								</span>
							{/snippet}
							{@render fact(t('lplat.delivery.pending'), pending)}
							{#snippet queued()}{@render count(outbox?.queued ?? 0)}{/snippet}
							{@render fact(t('lplat.delivery.queued'), queued)}
							{#snippet ingested()}{@render count(status?.delivery.recent.ingested ?? 0)}{/snippet}
							{@render fact(t('lplat.delivery.ingested'), ingested)}
							{#if outbox.oldest_pending_at}
								{#snippet oldest()}{@render when(outbox?.oldest_pending_at)}{/snippet}
								{@render fact(t('lplat.delivery.oldest'), oldest)}
							{/if}
							{#if outbox.last_error_code}
								{#snippet lastError()}<code>{outbox?.last_error_code}</code>{/snippet}
								{@render fact(t('lplat.delivery.lastError'), lastError)}
							{/if}
						{/if}
						{#if exp}
							{#snippet exportState()}
								{#if exp?.last_state}<code>{exp.last_state}</code>{:else}<span class="muted">—</span
									>{/if}
							{/snippet}
							{@render fact(t('lplat.delivery.export.state'), exportState)}
							{#snippet exportUpdated()}{@render when(exp?.updated_at)}{/snippet}
							{@render fact(t('lplat.delivery.export.updated'), exportUpdated)}
							{#if exp.active_failure || exp.last_error_code}
								{#snippet exportError()}
									<code>{exp?.active_failure?.error_code ?? exp?.last_error_code}</code>
								{/snippet}
								{@render fact(t('lplat.delivery.lastError'), exportError)}
							{/if}
						{/if}
					</dl>
				{/if}
			</article>

			<!-- 2. Archive -->
			<article class="stage" data-stage="archive">
				{@render stageHead(
					'database',
					t('lplat.stage.archive'),
					t('lplat.stage.archive.desc'),
					verdicts.archive
				)}
				{#if archive.configured}
					<dl class="facts">
						{#if until !== null}
							{#snippet readable()}{@render when(until)}{/snippet}
							{@render fact(
								t(
									archive.mode === 'scheduled'
										? 'lplat.delivery.export.watermark'
										: 'lplat.archive.lastCommit'
								),
								readable
							)}
						{/if}
						{#snippet mode()}
							{#if archive?.local_staging_only}
								{t('lplat.archive.local')}
							{:else if archive?.mode}
								{modeLabel(archive.mode, t)}
							{:else}
								—
							{/if}
						{/snippet}
						{@render fact(t('lplat.archive.mode'), mode)}
						{#snippet generationValue()}
							{#if archive?.generation}<code>{archive.generation}</code>{:else}—{/if}
						{/snippet}
						{@render fact(t('lplat.archive.generation'), generationValue)}
						{#snippet activated()}
							{#if archive?.activated_at}
								<DateTime value={archive.activated_at} showSecondary stacked />
							{:else}
								—
							{/if}
						{/snippet}
						{@render fact(t('lplat.archive.activated'), activated)}
					</dl>

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
							<dl class="facts facts--tight">
								{#snippet records()}
									<span class="num">
										{table?.current_snapshot?.total_records === null ||
										table?.current_snapshot?.total_records === undefined
											? '—'
											: num(table.current_snapshot.total_records)}
									</span>
								{/snippet}
								{@render fact(t('lplat.archive.records'), records)}
								{#snippet files()}
									<span class="num">
										{table?.current_snapshot?.total_data_files === null ||
										table?.current_snapshot?.total_data_files === undefined
											? '—'
											: num(table.current_snapshot.total_data_files)}
									</span>
								{/snippet}
								{@render fact(t('lplat.archive.files'), files)}
								{#snippet snapshots()}<span class="num">{num(table?.snapshot_count ?? 0)}</span
									>{/snippet}
								{@render fact(t('lplat.archive.snapshots'), snapshots)}
								{#snippet compaction()}
									{#if table?.last_compaction_at}
										<DateTime value={table.last_compaction_at} seconds showSecondary stacked />
									{:else}
										<Badge tone={verdicts?.archive.tone === 'ok' ? 'neutral' : 'warning'}>
											{t('lplat.archive.never')}
										</Badge>
									{/if}
								{/snippet}
								{@render fact(t('lplat.archive.lastCompaction'), compaction)}
							</dl>
						</div>
					{:else if !archive.local_staging_only}
						<p class="muted note">{t('lplat.archive.tenantNote')}</p>
					{/if}
				{/if}
			</article>

			<!-- 3. Reading -->
			<article class="stage" data-stage="read">
				{@render stageHead(
					'search',
					t('lplat.stage.read'),
					t('lplat.stage.read.desc'),
					verdicts.read
				)}
				{#if archive.configured}
					{#if archive.read_probe.ok}
						<p class="read__until">
							{#if lag !== null && archive.mode === 'scheduled'}
								{t('lplat.read.watermark', { minutes: num(lag) })}
							{:else if lag !== null}
								{t('lplat.read.until', { minutes: num(lag) })}
							{:else if acceptedLag !== null}
								{t('lplat.read.accepted', { minutes: num(acceptedLag) })}
							{:else}
								<span class="muted">{t('lplat.read.none')}</span>
							{/if}
						</p>
					{/if}
					<dl class="facts">
						{#if !archive.read_probe.ok}
							{#snippet reason()}<code>{archive?.read_probe.reason ?? '—'}</code>{/snippet}
							{@render fact(t('lplat.read.reason'), reason)}
						{/if}
						{#if archive.read_probe.coverage}
							{#if archive.read_probe.coverage.consistency === 'local_hot_only'}
								{#snippet hotOnly()}
									<span class="muted">{t('lplat.read.consistency.local_hot_only')}</span>
								{/snippet}
								{@render fact(t('lplat.read.consistency'), hotOnly)}
							{/if}
							{#if archive.read_probe.coverage.pending_deliveries !== null}
								{#snippet pendingDeliveries()}
									{@render count(archive?.read_probe.coverage?.pending_deliveries ?? 0)}
								{/snippet}
								{@render fact(t('lplat.read.pending'), pendingDeliveries)}
							{/if}
						{/if}
						{#if archive.read_probe.ok && !archive.read_probe.has_archive}
							{#snippet noArchive()}<span class="muted">{t('lplat.read.noArchive')}</span>{/snippet}
							{@render fact(t('lplat.stage.archive'), noArchive)}
						{/if}
					</dl>
				{/if}
			</article>
		</section>

		{#if showCoverage}
			<Card title={t('lplat.coverage.title')} info={t('lplat.coverage.desc')}>
				<dl class="facts facts--row">
					{#snippet covered()}<span class="num">{num(status?.audit_coverage.covered ?? 0)}</span
						>{/snippet}
					{@render fact(t('lplat.coverage.covered'), covered)}
					{#snippet gap()}
						<span class="num" class:attention={(status?.audit_coverage.gap_detected ?? 0) > 0}>
							{num(status?.audit_coverage.gap_detected ?? 0)}
						</span>
					{/snippet}
					{@render fact(t('lplat.coverage.gap'), gap)}
					{#snippet acknowledged()}<span class="num"
							>{num(status?.audit_coverage.acknowledged ?? 0)}</span
						>{/snippet}
					{@render fact(t('lplat.coverage.acknowledged'), acknowledged)}
					{#snippet ignored()}<span class="num">{num(status?.audit_coverage.ignored ?? 0)}</span
						>{/snippet}
					{@render fact(t('lplat.coverage.ignored'), ignored)}
					{#snippet lastChecked()}
						{#if status?.audit_coverage.last_checked_at}
							<DateTime value={status.audit_coverage.last_checked_at} showSecondary />
						{:else}
							<span class="muted">{t('lplat.coverage.never')}</span>
						{/if}
					{/snippet}
					{@render fact(t('lplat.coverage.lastChecked'), lastChecked)}
				</dl>
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
			<dl class="facts facts--row">
				{#snippet findings()}
					{#if status?.chunk_catalog.sampled_repair_findings === 0}
						<Badge tone="success" dot>{t('lplat.catalog.clean')}</Badge>
					{:else}
						<Badge tone="warning" dot
							>{num(status?.chunk_catalog.sampled_repair_findings ?? 0)}</Badge
						>
					{/if}
					<span class="muted sample">
						{t('lplat.catalog.sample', { limit: num(status?.chunk_catalog.scan_limit ?? 0) })}
					</span>
				{/snippet}
				{@render fact(t('lplat.catalog.findings'), findings)}
				{#snippet sensitive()}
					<span class="num"
						>{num(status?.chunk_catalog.sampled_sensitive_detail_findings ?? 0)}</span
					>
				{/snippet}
				{@render fact(t('lplat.catalog.sensitive'), sensitive)}
				{#each status.chunk_catalog.sensitive_detail_index as entry (entry.store)}
					{#snippet indexValue()}
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
					{/snippet}
					{@render fact(`${t('lplat.catalog.index')} · ${entry.store}`, indexValue)}
				{/each}
			</dl>
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
	.num {
		font-variant-numeric: tabular-nums;
	}
	.unit {
		margin-inline-start: 0.3em;
		font-size: var(--fs-caption);
		color: var(--text-muted);
	}
	.attention {
		color: var(--danger);
		font-weight: var(--fw-semibold);
	}
	.sample {
		display: block;
		font-size: var(--fs-caption);
	}

	/* Compact fact rows: label at the start, value at the end, one thin rule between rows. */
	.facts {
		margin: 0;
		font-size: var(--fs-small);
	}
	.fact {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--space-related);
		padding-block: 5px;
		border-top: 1px solid var(--border-subtle);
	}
	.fact:first-child {
		border-top: 0;
	}
	.fact dt {
		flex: 0 1 auto;
		color: var(--text-muted);
	}
	.fact dd {
		flex: 1 1 auto;
		margin: 0;
		min-width: 0;
		text-align: end;
		font-weight: var(--fw-medium);
		color: var(--text-primary);
	}
	.facts--tight .fact {
		padding-block: 4px;
	}
	.facts--row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
		gap: 0 var(--space-section);
	}

	/*
	 * The flow: one frame, three equal columns divided by a rule that starts under the icon
	 * line, and an arrow from each icon to the next drawn across the divider. Stacked when the
	 * row cannot fit.
	 */
	.flow {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--bg-card);
		overflow: hidden;
	}
	.stage {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
		padding: var(--space-related) var(--space-field) var(--space-field);
		min-width: 0;
	}
	.stage + .stage::before {
		content: '';
		position: absolute;
		inset-inline-start: 0;
		top: calc(var(--space-related) + 48px + 8px);
		bottom: 0;
		width: 1px;
		background: var(--border-subtle);
	}
	/*
	 * The arrow belongs to the stage it points to: it runs from the previous icon's edge to this
	 * icon's edge. Columns are equal, so "the previous icon centre" is half a column to the start.
	 */
	.stage__link {
		display: none;
	}
	.stage + .stage .stage__link {
		display: block;
		position: absolute;
		top: calc(var(--space-related) + 23px);
		inset-inline-start: calc(-50% + 24px + 10px);
		inset-inline-end: calc(50% + 24px + 10px);
		height: 2px;
		background: var(--text-secondary);
	}
	.stage + .stage .stage__link::after {
		content: '';
		position: absolute;
		inset-inline-end: -1px;
		top: -4px;
		border: 5px solid transparent;
		border-inline-start: 7px solid var(--text-secondary);
		border-inline-end: 0;
	}
	.stage__head {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		text-align: center;
	}
	.stage__icon {
		display: grid;
		place-items: center;
		width: 48px;
		height: 48px;
		margin-bottom: 4px;
		border-radius: var(--radius-round);
		background: var(--bg-subtle);
		color: var(--text-primary);
	}
	/* One line each, so the three status rows below sit on the same line. */
	.stage__title-row {
		display: flex;
		align-items: center;
		gap: 4px;
		white-space: nowrap;
	}
	.stage__title {
		margin: 0;
		font-size: var(--fs-title);
		font-weight: var(--fw-semibold);
		line-height: var(--lh-tight);
	}
	.stage__status {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-related);
		padding-block: 6px;
	}
	.stage__status-label {
		font-size: var(--fs-small);
		font-weight: var(--fw-medium);
		color: var(--text-secondary);
	}
	.stage__reasons {
		margin: 0;
		padding: 6px var(--space-related);
		border-radius: var(--radius-sm);
		background: var(--warning-bg);
		color: var(--warning-text);
		font-size: var(--fs-caption);
		line-height: var(--lh-snug);
		list-style: none;
	}
	.stage__reasons.is-danger {
		background: var(--danger-bg);
		color: var(--danger);
	}
	.stage__reasons li + li {
		margin-top: 4px;
	}
	.platform {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: var(--space-related) var(--space-related) 6px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--bg-subtle);
	}
	.platform__title {
		margin: 0;
		font-size: var(--fs-small);
		font-weight: var(--fw-semibold);
		color: var(--text-secondary);
	}
	.platform__detail {
		margin: 0;
		font-size: var(--fs-caption);
	}
	.note {
		margin: 0;
		font-size: var(--fs-caption);
	}
	.read__until {
		margin: 0;
		font-size: var(--fs-small);
		font-weight: var(--fw-medium);
		line-height: var(--lh-snug);
	}

	@media (max-width: 1000px) {
		.flow {
			grid-template-columns: minmax(0, 1fr);
		}
		.stage + .stage::before {
			inset-inline: 0;
			top: 0;
			bottom: auto;
			width: auto;
			height: 1px;
		}
		.stage + .stage .stage__link {
			display: none;
		}
	}
</style>
