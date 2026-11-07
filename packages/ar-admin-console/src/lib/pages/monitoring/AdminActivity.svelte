<script lang="ts">
	import { untrack } from 'svelte';
	import { hasPermission, type AdminAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import type {
		AdminAuditClient,
		AdminAuditEntry,
		AuditPosition,
		AuditResult
	} from '#lib/api/admin-audit.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { hasMessage, t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import DateRangeField from '#lib/ui/patterns/DateRangeField.svelte';
	import { isReversed, resolveRange, type DateRange } from '#lib/ui/patterns/date-range.js';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FilterBar from '#lib/ui/patterns/FilterBar.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import SearchField from '#lib/ui/primitives/SearchField.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import AuditEntryDetail from './AuditEntryDetail.svelte';
	import {
		RESULT_LABEL,
		RESULT_TONE,
		actionLabelKey,
		actorKindKey,
		actorName,
		isStepUp,
		stepUpFacts
	} from './audit-labels';

	/**
	 * Monitoring → Admin activity: what administrators did in the selected tenant, newest first,
	 * narrowed by period, operation, result and admin, with one entry in full above the list.
	 * Step-ups read as words (which operation was checked, at which level), not only as their
	 * action name. Admins without `admin:admin_audit:read` see that they cannot, nothing else.
	 */
	interface Props {
		client: AdminAuditClient;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
		/** The period first shown. */
		initialRange?: DateRange;
		/** The time "now" for recent periods (Storybook pins it to its sample data). */
		now?: () => Date;
	}

	let { client, access, initialRange = { preset: '7d' }, now = () => new Date() }: Props = $props();

	const who = $derived(access ?? adminAccess.current);
	const canRead = $derived(hasPermission(who, 'admin:admin_audit:read'));
	const canReadChanges = $derived(hasPermission(who, 'admin:admin_audit:detail:read'));

	// svelte-ignore state_referenced_locally
	let range = $state<DateRange>(initialRange);
	let action = $state('');
	let result = $state<'' | AuditResult>('');
	let actor = $state('');

	let actions = $state<string[]>([]);
	let rows = $state<AdminAuditEntry[]>([]);
	let total = $state<number | null>(null);
	let next = $state<AuditPosition | null>(null);
	let mayLag = $state(false);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed' | 'incomplete'>('loading');
	let loadingMore = $state(false);
	let moreFailed = $state(false);
	let selectedId = $state<string | null>(null);
	const selected = $derived(rows.find((row) => row.id === selectedId) ?? null);

	const filtered = $derived(range.preset !== '7d' || !!action || !!result || !!actor);

	/**
	 * The period of the list being shown, fixed when it is read from the top: the next pages must
	 * ask with the same bounds (a cursor is bound to the query it came from).
	 */
	let bounds: { from?: Date; to?: Date } = {};

	function query(at?: AuditPosition) {
		const { from, to } = bounds;
		return {
			actor: actor.trim() || undefined,
			action: action || undefined,
			result: result || undefined,
			from,
			to,
			at
		};
	}

	let generation = 0;
	async function load(): Promise<void> {
		const mine = ++generation;
		if (!canRead) {
			phase = 'forbidden';
			return;
		}
		if (isReversed(range)) {
			// The field says the period is the wrong way round; nothing is listed for it, and
			// nothing of the previous list (its next page) may be asked for with these filters.
			rows = [];
			total = null;
			next = null;
			mayLag = false;
			loadingMore = false;
			moreFailed = false;
			selectedId = null;
			phase = 'ready';
			return;
		}
		phase = 'loading';
		moreFailed = false;
		loadingMore = false;
		bounds = resolveRange(range, now());
		try {
			const page = await client.list(query());
			if (mine !== generation) return;
			rows = page.items;
			total = page.total;
			next = page.next;
			mayLag = page.mayLag;
			if (selectedId && !rows.some((row) => row.id === selectedId)) selectedId = null;
			phase = 'ready';
		} catch (error) {
			if (mine !== generation) return;
			phase =
				error instanceof ApiError && error.forbidden
					? 'forbidden'
					: error instanceof ApiError && error.code === 'log_query_incomplete'
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
			rows = [...rows, ...page.items.filter((row) => !seen.has(row.id))];
			next = page.next;
			mayLag = mayLag || page.mayLag;
		} catch {
			if (mine === generation) moreFailed = true;
		} finally {
			if (mine === generation) loadingMore = false;
		}
	}

	// The filters (and who is looking) decide the list: read it again from the top when they change.
	$effect(() => {
		void [JSON.stringify(range), action, result, actor, canRead];
		untrack(load);
	});

	$effect(() => {
		if (!canRead) return;
		let current = true;
		client
			.actions()
			.then((list) => current && (actions = list))
			.catch(() => current && (actions = []));
		return () => (current = false);
	});

	const actionOptions = $derived([
		{ value: '', label: t('aud.filter.action.all') },
		...[...new Set([...actions, ...(action ? [action] : [])])].map((name) => {
			const key = actionLabelKey(name, hasMessage);
			return { value: name, label: key ? `${t(key)} (${name})` : name };
		})
	]);

	function clear(): void {
		range = { preset: '7d' };
		action = '';
		result = '';
		actor = '';
	}
</script>

<Page>
	<PageHeader title={t('nav.mon.adminActivity')} description={t('aud.page.desc')} />

	{#if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('aud.noAccess')} />
	{:else}
		<FilterBar results={total ?? undefined} active={filtered} onclear={clear}>
			{#snippet search()}
				<SearchField
					label={t('aud.filter.actor')}
					placeholder={t('aud.filter.actor')}
					size="sm"
					delay={300}
					value={actor}
					onsearch={(value) => (actor = value)}
				/>
			{/snippet}
			<DateRangeField label={t('aud.filter.range')} hideLabel size="sm" bind:value={range} />
			<Select
				label={t('aud.filter.action')}
				hideLabel
				size="sm"
				options={actionOptions}
				bind:value={action}
			/>
			<Select
				label={t('aud.filter.result')}
				hideLabel
				size="sm"
				options={[
					{ value: '', label: t('aud.filter.result.all') },
					{ value: 'success', label: t('aud.result.success') },
					{ value: 'failure', label: t('aud.result.failure') }
				]}
				bind:value={() => result, (value) => (result = value as '' | AuditResult)}
			/>
		</FilterBar>

		{#if phase === 'loading'}
			<LoadingState label={t('common.loading')} />
		{:else if phase === 'incomplete'}
			<EmptyState
				icon="warning"
				title={t('aud.incomplete.title')}
				description={t('aud.incomplete.body')}
			/>
		{:else if phase === 'failed'}
			<EmptyState icon="warning" title={t('aud.loadFailed')} description={t('load.error.body')}>
				{#snippet action()}
					<Button onclick={load}>{t('load.retry')}</Button>
				{/snippet}
			</EmptyState>
		{:else}
			{#if mayLag}
				<Callout icon="info" title={t('aud.lag.title')}>{t('aud.lag.body')}</Callout>
			{/if}

			{#if selected}
				{#key selected.id}
					<AuditEntryDetail
						entry={selected}
						{client}
						{canReadChanges}
						onclose={() => (selectedId = null)}
					/>
				{/key}
			{/if}

			<Card title={t('aud.list.title')} info={t('aud.list.info')} flush>
				<DataTable
					caption={t('aud.list.title')}
					columns={[
						{ key: 'time', label: t('aud.col.time'), width: '20%' },
						{ key: 'actor', label: t('aud.col.actor'), width: '22%' },
						{ key: 'action', label: t('aud.col.action') },
						{ key: 'target', label: t('aud.col.target'), width: '20%' },
						{ key: 'result', label: t('aud.col.result'), width: '12%' }
					]}
					{rows}
					rowKey={(row) => row.id}
					onrowopen={(row) => (selectedId = row.id)}
					rowOpenLabel={(row) => t('aud.row.open', { name: actorName(row, t) })}
				>
					{#snippet cell(row, column)}
						{#if column.key === 'time'}
							<DateTime value={row.created_at} stacked />
						{:else if column.key === 'actor'}
							{@const kind = actorKindKey(row)}
							<span class="cell-name">{actorName(row, t)}</span>
							{#if kind}<Badge>{t(kind)}</Badge>{/if}
						{:else if column.key === 'action'}
							{@const key = actionLabelKey(row.action, hasMessage)}
							{@const stepUp = stepUpFacts(row)}
							<span class="action">
								{#if isStepUp(row.action)}<Badge tone="info">{t('aud.stepUp.badge')}</Badge>{/if}
								{#if key}{t(key)}{:else}<code>{row.action}</code>{/if}
							</span>
							{#if stepUp}
								<span class="second"
									>{t('aud.stepUp.summary', {
										level: t(`aud.level.${stepUp.level}`),
										operation: stepUp.operation
									})}</span
								>
							{:else if key}
								<span class="second"><code>{row.action}</code></span>
							{/if}
						{:else if column.key === 'target'}
							{#if row.resource_id || row.resource_type}
								<code>{row.resource_id ?? row.resource_type}</code>
								{#if row.resource_id && row.resource_type}
									<span class="second">{row.resource_type}</span>
								{/if}
							{:else}
								—
							{/if}
						{:else}
							<Badge tone={RESULT_TONE[row.result]}>{t(RESULT_LABEL[row.result])}</Badge>
						{/if}
					{/snippet}
					{#snippet empty()}
						<EmptyState icon="file" title={t('aud.empty')} />
					{/snippet}
				</DataTable>
				{#if next || moreFailed}
					<div class="more">
						{#if moreFailed}
							<Callout tone="danger" live>{t('aud.moreFailed')}</Callout>
						{/if}
						{#if next}
							<Button size="sm" loading={loadingMore} onclick={loadMore}>{t('aud.more')}</Button>
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

	.action {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
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
