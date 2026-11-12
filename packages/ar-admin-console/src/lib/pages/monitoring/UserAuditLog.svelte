<script lang="ts">
	import { untrack } from 'svelte';
	import { hasPermission, type AdminAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { ApiError } from '#lib/api/api-error.js';
	import {
		isIncompleteError,
		type UserAuditClient,
		type UserAuditEntry
	} from '#lib/api/user-audit.js';
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
	import UserAuditEntryDetail from './UserAuditEntryDetail.svelte';
	import {
		RESULT_LABEL,
		RESULT_TONE,
		eventLabel,
		eventLabelKey,
		eventOptions,
		resultOf
	} from './user-audit-labels';

	/**
	 * Monitoring → Audit logs: what end users did and what happened to their accounts in the
	 * selected tenant (sign-ins, sessions, tokens, consents, account changes), newest first,
	 * narrowed by period, event and user, with one event in full above the list.
	 *
	 * The API reads the whole period before it filters, so the period is always bounded (the last
	 * 24 hours at first) and a period that is too large says so instead of showing a partial list.
	 * Admins without `admin:audit:read` see that they cannot, nothing else.
	 */
	interface Props {
		client: UserAuditClient;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
		/** The period first shown. */
		initialRange?: DateRange;
		/** The user first filtered by (a user's page links here). */
		initialUserId?: string;
		/** The time "now" for recent periods (Storybook pins it to its sample data). */
		now?: () => Date;
		/** Opens a user's page. Without it the user is shown, not linked. */
		onopenuser?: (userId: string) => void;
	}

	let {
		client,
		access,
		initialRange = { preset: '24h' },
		initialUserId = '',
		now = () => new Date(),
		onopenuser
	}: Props = $props();

	const who = $derived(access ?? adminAccess.current);
	const canRead = $derived(hasPermission(who, 'admin:audit:read'));
	const canReadAdminActivity = $derived(hasPermission(who, 'admin:admin_audit:read'));

	// svelte-ignore state_referenced_locally
	let range = $state<DateRange>(initialRange);
	let event = $state('');
	// svelte-ignore state_referenced_locally
	let userId = $state(initialUserId.trim());

	let rows = $state<UserAuditEntry[]>([]);
	let next = $state<string | null>(null);
	let mayLag = $state(false);
	let hotOnly = $state(false);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed' | 'incomplete'>('loading');
	let loadingMore = $state(false);
	let moreFailed = $state(false);
	let selectedId = $state<string | null>(null);
	const selected = $derived(rows.find((row) => row.id === selectedId) ?? null);

	const filtered = $derived(range.preset !== '24h' || !!event || !!userId);

	/**
	 * The period of the list being shown, fixed when it is read from the top: the next pages must
	 * ask with the same bounds (a cursor is bound to the query it came from). Always closed at
	 * both ends, because the API would otherwise read the tenant's whole history: a custom period
	 * with no end runs to now, and one with no start covers the 7 days before its end.
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
			userId: userId || undefined,
			action: event || undefined,
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
		if (isReversed(range)) {
			// The field says the period is the wrong way round; nothing is listed for it, and
			// nothing of the previous list (its next page) may be asked for with these filters.
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
		void [JSON.stringify(range), event, userId, canRead];
		untrack(load);
	});

	const eventChoices = $derived(eventOptions(t, hasMessage, event));

	function clear(): void {
		range = { preset: '24h' };
		event = '';
		userId = '';
	}
</script>

<Page>
	<PageHeader title={t('nav.mon.audit')} description={t('uaud.page.desc')} />

	{#if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('uaud.noAccess')} />
	{:else}
		{#if canReadAdminActivity}
			<Link standalone href="/admin/monitoring/admin-activity">{t('uaud.adminLink')}</Link>
		{/if}

		<FilterBar active={filtered} onclear={clear}>
			{#snippet search()}
				<SearchField
					label={t('uaud.filter.user')}
					placeholder={t('uaud.filter.user')}
					size="sm"
					delay={300}
					value={userId}
					onsearch={(value) => (userId = value.trim())}
				/>
			{/snippet}
			<DateRangeField label={t('uaud.filter.range')} hideLabel size="sm" bind:value={range} />
			<Select
				label={t('uaud.filter.event')}
				hideLabel
				size="sm"
				options={eventChoices}
				bind:value={event}
			/>
		</FilterBar>

		{#if phase === 'loading'}
			<LoadingState label={t('common.loading')} />
		{:else if phase === 'incomplete'}
			<EmptyState
				icon="warning"
				title={t('uaud.incomplete.title')}
				description={t('uaud.incomplete.body')}
			/>
		{:else if phase === 'failed'}
			<EmptyState icon="warning" title={t('uaud.loadFailed')} description={t('load.error.body')}>
				{#snippet action()}
					<Button onclick={load}>{t('load.retry')}</Button>
				{/snippet}
			</EmptyState>
		{:else}
			{#if mayLag}
				<Callout icon="info" title={t('uaud.lag.title')}>{t('uaud.lag.body')}</Callout>
			{/if}
			{#if hotOnly}
				<Callout tone="warning" title={t('uaud.hot.title')}>{t('uaud.hot.body')}</Callout>
			{/if}

			{#if selected}
				{#key selected.id}
					<UserAuditEntryDetail entry={selected} onclose={() => (selectedId = null)} />
				{/key}
			{/if}

			<Card title={t('uaud.list.title')} info={t('uaud.list.info')} flush>
				<DataTable
					caption={t('uaud.list.title')}
					columns={[
						{ key: 'time', label: t('uaud.col.time'), width: '18%' },
						{ key: 'event', label: t('uaud.col.event') },
						{ key: 'user', label: t('uaud.col.user'), width: '22%' },
						{ key: 'result', label: t('uaud.col.result'), width: '12%' },
						{ key: 'ip', label: t('uaud.col.ip'), width: '16%' }
					]}
					{rows}
					rowKey={(row) => row.id}
					onrowopen={(row) => (selectedId = row.id)}
					rowOpenLabel={(row) =>
						t('uaud.row.open', { name: eventLabel(row.action, t, hasMessage) })}
				>
					{#snippet cell(row, column)}
						{#if column.key === 'time'}
							<DateTime value={row.createdAt} stacked />
						{:else if column.key === 'event'}
							{@const named = eventLabelKey(row.action, hasMessage)}
							{#if named}
								{t(named)}
								<span class="second"><code>{row.action}</code></span>
							{:else}
								<code>{row.action || t('uaud.event.unknown')}</code>
							{/if}
						{:else if column.key === 'user'}
							{#if !row.userId}
								—
							{:else if onopenuser}
								<Button
									size="sm"
									variant="ghost"
									aria-label={t('uaud.user.open', { id: row.userId })}
									onclick={() => onopenuser(row.userId as string)}><code>{row.userId}</code></Button
								>
							{:else}
								<code>{row.userId}</code>
							{/if}
						{:else if column.key === 'result'}
							{@const result = resultOf(row)}
							{#if result}
								<Badge tone={RESULT_TONE[result]}>{t(RESULT_LABEL[result])}</Badge>
							{/if}
						{:else if row.ipAddress}
							<code dir="ltr">{row.ipAddress}</code>
						{:else}
							—
						{/if}
					{/snippet}
					{#snippet empty()}
						<EmptyState icon="file" title={t('uaud.empty')} />
					{/snippet}
				</DataTable>
				{#if next || moreFailed}
					<div class="more">
						{#if moreFailed}
							<Callout tone="danger" live>{t('uaud.moreFailed')}</Callout>
						{/if}
						{#if next}
							<Button size="sm" loading={loadingMore} onclick={loadMore}>{t('uaud.more')}</Button>
						{/if}
					</div>
				{/if}
			</Card>
		{/if}
	{/if}
</Page>

<style>
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
