<script lang="ts">
	import { untrack } from 'svelte';
	import { hasPermission, type AdminAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import type { AuditSeverity } from '#lib/api/admin-audit.js';
	import { ApiError } from '#lib/api/api-error.js';
	import type { SystemLogClient, SystemLogEntry } from '#lib/api/system-log.js';
	import { isIncompleteError } from '#lib/api/user-audit.js';
	import { hasMessage, t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import DateRangeField from '#lib/ui/patterns/DateRangeField.svelte';
	import {
		PRESET_SPANS,
		isReversed,
		resolveRange,
		type DateRange
	} from '#lib/ui/patterns/date-range.js';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FilterBar from '#lib/ui/patterns/FilterBar.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Link from '#lib/ui/primitives/Link.svelte';
	import SearchField from '#lib/ui/primitives/SearchField.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import SystemLogEntryDetail from './SystemLogEntryDetail.svelte';
	import {
		SEVERITIES,
		SEVERITY_LABEL,
		SEVERITY_TONE,
		eventLabel,
		eventLabelKey,
		isValidFilterValue,
		severityOf,
		sourceLabel,
		sourceLabelKey,
		sourceOptions,
		surfaceOf
	} from './system-log-labels';

	/**
	 * Monitoring → System logs: what the platform itself did in the selected tenant (scheduled
	 * work, queues, deliveries, metadata refreshes, connector heartbeats), newest first, narrowed
	 * by period, source, severity and event name, with one event in full above the list.
	 *
	 * The API reads the whole period before it filters, so the period is always bounded (the last
	 * 7 days at first; system events are few) and a period that is too large says so instead of
	 * showing a partial list. Admins without `admin:system_logs:read` see that they cannot,
	 * nothing else.
	 */
	interface Props {
		client: SystemLogClient;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
		/** The period first shown. */
		initialRange?: DateRange;
		/** The time "now" for recent periods (Storybook pins it to its sample data). */
		now?: () => Date;
	}

	let { client, access, initialRange = { preset: '7d' }, now = () => new Date() }: Props = $props();

	const who = $derived(access ?? adminAccess.current);
	const canRead = $derived(hasPermission(who, 'admin:system_logs:read'));
	const canReadUserAudit = $derived(hasPermission(who, 'admin:audit:read'));

	// svelte-ignore state_referenced_locally
	let range = $state<DateRange>(initialRange);
	let source = $state('');
	let severity = $state<'' | AuditSeverity>('');
	let eventType = $state('');
	let rows = $state<SystemLogEntry[]>([]);
	let next = $state<string | null>(null);
	let mayLag = $state(false);
	let hotOnly = $state(false);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed' | 'incomplete'>('loading');
	let loadingMore = $state(false);
	let moreFailed = $state(false);
	let selectedId = $state<string | null>(null);
	const selected = $derived(rows.find((row) => row.id === selectedId) ?? null);
	const filtered = $derived(range.preset !== '7d' || !!source || !!severity || !!eventType);
	/** The API takes a name, a code or an ID as the event filter; anything else is said, not sent. */
	const eventTypeValid = $derived(isValidFilterValue(eventType));

	/**
	 * The period of the list being shown, fixed when it is read from the top: the next pages must
	 * ask with the same bounds (a cursor is bound to the query it came from). Always closed at
	 * both ends: a custom period with no end runs to now, one with no start covers the 7 days
	 * before its end.
	 */
	let bounds: { from: Date; to: Date } = { from: new Date(0), to: new Date(0) };
	function boundsOf(period: DateRange): { from: Date; to: Date } {
		const at = now();
		const resolved = resolveRange(period, at);
		const to = resolved.to ?? at;
		return { from: resolved.from ?? new Date(to.getTime() - PRESET_SPANS['7d']), to };
	}

	function query(cursor?: string) {
		return {
			...bounds,
			source: source || undefined,
			severity: severity || undefined,
			eventType: eventType || undefined,
			cursor
		};
	}

	let generation = 0;
	async function load(): Promise<void> {
		const mine = ++generation;
		if (!canRead) {
			phase = 'forbidden';
			return;
		}
		loadingMore = false;
		moreFailed = false;
		if (isReversed(range) || !eventTypeValid) {
			// The field says the period is the wrong way round, or the event name is not one the
			// API would accept; nothing is listed for it, and nothing of the previous list (its
			// next page) may be asked for with these filters.
			rows = [];
			next = null;
			mayLag = false;
			hotOnly = false;
			selectedId = null;
			phase = 'ready';
			return;
		}
		phase = 'loading';
		bounds = boundsOf(range);
		try {
			const page = await client.list(query());
			if (mine !== generation) return;
			rows = page.entries;
			next = page.next;
			mayLag = page.mayLag;
			hotOnly = page.hotOnly;
			if (selectedId && !rows.some((row) => row.id === selectedId)) selectedId = null;
			phase = 'ready';
		} catch (error) {
			if (mine !== generation) return;
			phase =
				error instanceof ApiError && error.forbidden
					? 'forbidden'
					: isIncompleteError(error)
						? 'incomplete'
						: 'failed';
		}
	}

	async function loadMore(): Promise<void> {
		if (!next) return;
		const mine = generation;
		loadingMore = true;
		moreFailed = false;
		try {
			const page = await client.list(query(next));
			if (mine !== generation) return;
			const seen = new Set(rows.map((row) => row.id));
			rows = [...rows, ...page.entries.filter((row) => !seen.has(row.id))];
			next = page.next;
			mayLag = mayLag || page.mayLag;
			hotOnly = hotOnly || page.hotOnly;
		} catch {
			if (mine === generation) moreFailed = true;
		} finally {
			if (mine === generation) loadingMore = false;
		}
	}

	// The filters (and who is looking) decide the list: read it again from the top when they change.
	$effect(() => {
		void [JSON.stringify(range), source, severity, eventType, eventTypeValid, canRead];
		untrack(load);
	});

	const sourceChoices = $derived(sourceOptions(t, hasMessage, source));
	const severityChoices = $derived([
		{ value: '', label: t('slog.filter.severity.all') },
		...SEVERITIES.map((level) => ({ value: level, label: t(SEVERITY_LABEL[level]) }))
	]);

	function clear(): void {
		range = { preset: '7d' };
		source = '';
		severity = '';
		eventType = '';
	}
</script>

<Page>
	<PageHeader title={t('nav.mon.system')} description={t('slog.page.desc')} />

	{#if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('slog.noAccess')} />
	{:else}
		{#if canReadUserAudit}
			<Link standalone href="/admin/monitoring/audit">{t('slog.otherLogs')}</Link>
		{/if}
		<FilterBar active={filtered} onclear={clear}>
			{#snippet search()}
				<SearchField
					label={t('slog.filter.event')}
					placeholder={t('slog.filter.event')}
					size="sm"
					delay={300}
					latinOnly
					value={eventType}
					onsearch={(value) => (eventType = value.trim())}
				/>
			{/snippet}
			<DateRangeField label={t('slog.filter.range')} hideLabel size="sm" bind:value={range} />
			<Select
				label={t('slog.filter.source')}
				hideLabel
				size="sm"
				options={sourceChoices}
				bind:value={source}
			/>
			<Select
				label={t('slog.filter.severity')}
				hideLabel
				size="sm"
				options={severityChoices}
				bind:value={() => severity, (value) => (severity = value as '' | AuditSeverity)}
			/>
		</FilterBar>

		{#if phase === 'loading'}
			<LoadingState label={t('common.loading')} />
		{:else if phase === 'incomplete'}
			<EmptyState
				icon="warning"
				title={t('slog.incomplete.title')}
				description={t('slog.incomplete.body')}
			/>
		{:else if phase === 'failed'}
			<EmptyState icon="warning" title={t('slog.loadFailed')} description={t('load.error.body')}>
				{#snippet action()}
					<Button onclick={load}>{t('load.retry')}</Button>
				{/snippet}
			</EmptyState>
		{:else}
			{#if !eventTypeValid}
				<Callout tone="warning" title={t('slog.filter.event.invalid')}
					>{t('slog.filter.event.invalid.body')}</Callout
				>
			{/if}
			{#if hotOnly}
				<Callout tone="warning" title={t('slog.hot.title')}>{t('slog.hot.body')}</Callout>
			{/if}
			{#if mayLag}
				<Callout icon="info" title={t('slog.lag.title')}>{t('slog.lag.body')}</Callout>
			{/if}

			{#if selected}
				{#key selected.id}
					<SystemLogEntryDetail entry={selected} onclose={() => (selectedId = null)} />
				{/key}
			{/if}

			<Card title={t('slog.list.title')} info={t('slog.list.info')} flush>
				<DataTable
					caption={t('slog.list.title')}
					columns={[
						{ key: 'time', label: t('slog.col.time'), width: '18%' },
						{ key: 'source', label: t('slog.col.source'), width: '22%' },
						{ key: 'event', label: t('slog.col.event') },
						{ key: 'severity', label: t('slog.col.severity'), width: '12%' },
						{ key: 'target', label: t('slog.col.target'), width: '18%' }
					]}
					{rows}
					rowKey={(row) => row.id}
					onrowopen={(row) => (selectedId = row.id)}
					rowOpenLabel={(row) =>
						t('slog.row.open', { name: eventLabel(row.event_type, t, hasMessage) })}
				>
					{#snippet cell(row, column)}
						{#if column.key === 'time'}
							<DateTime value={row.created_at} stacked />
						{:else if column.key === 'source'}
							{@const named = sourceLabelKey(row.source, hasMessage)}
							{#if named}
								<span class="cell-name">{sourceLabel(row.source, t, hasMessage)}</span>
								<span class="second"><code>{surfaceOf(row.source)}</code></span>
							{:else}
								<code>{surfaceOf(row.source)}</code>
							{/if}
						{:else if column.key === 'event'}
							{@const named = eventLabelKey(row.event_type, hasMessage)}
							{#if named}
								{t(named)}
								<span class="second"><code>{row.event_type}</code></span>
							{:else}
								<code>{row.event_type || t('slog.event.unknown')}</code>
							{/if}
						{:else if column.key === 'severity'}
							{@const level = severityOf(row)}
							{#if level}
								<Badge tone={SEVERITY_TONE[level]}>{t(SEVERITY_LABEL[level])}</Badge>
							{:else}
								<code>{row.severity}</code>
							{/if}
						{:else if row.target_id || row.target_type}
							<code>{row.target_id ?? row.target_type}</code>
							{#if row.target_id && row.target_type}
								<span class="second"><code>{row.target_type}</code></span>
							{/if}
						{:else}
							—
						{/if}
					{/snippet}
					{#snippet empty()}
						<EmptyState icon="file" title={t('slog.empty')} />
					{/snippet}
				</DataTable>
				{#if next || moreFailed}
					<div class="more">
						{#if moreFailed}
							<Callout tone="danger" live>{t('slog.moreFailed')}</Callout>
						{/if}
						{#if next}
							<Button size="sm" loading={loadingMore} onclick={loadMore}>{t('slog.more')}</Button>
						{/if}
					</div>
				{/if}
			</Card>
		{/if}
	{/if}
</Page>

<style>
	.cell-name {
		font-weight: var(--fw-name);
	}

	.second {
		display: block;
		color: var(--text-muted);
		font-size: var(--fs-caption);
		line-height: var(--lh-body);
	}

	.more {
		display: grid;
		justify-items: center;
		gap: var(--space-related);
		padding: var(--box-pad);
	}
</style>
