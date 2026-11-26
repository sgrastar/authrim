<script lang="ts">
	import { untrack } from 'svelte';
	import { hasPermission, type AdminAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { ApiError } from '#lib/api/api-error.js';
	import {
		EMAIL_DELIVERIES_MAX,
		EMAIL_DELIVERIES_PAGE_SIZE,
		type EmailDeliveriesClient,
		type EmailDelivery,
		type EmailDeliveryStatus,
		type RecipientVisibility
	} from '#lib/api/email-deliveries.js';
	import { hasMessage, t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FilterBar from '#lib/ui/patterns/FilterBar.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import EmailDeliveryDetail from './EmailDeliveryDetail.svelte';
	import {
		STATUS_LABEL,
		STATUS_TONE,
		isEmailDeliveryStatus,
		kindLabel,
		kindLabelKey,
		statusOf,
		statusOptions
	} from './email-deliveries-labels';

	/**
	 * Monitoring → Email deliveries: the mails Authrim asked its provider to send for the selected
	 * tenant, newest first, narrowed by status, with one record in full above the list. The API
	 * has no period and no cursor: the newest records up to a limit (50, or 100). Recipients come
	 * masked, in full or not at all, as the server decides from the caller's permissions; the
	 * page says which. Admins without `admin:email_deliveries:read` see that they cannot.
	 */
	interface Props {
		client: EmailDeliveriesClient;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
	}

	let { client, access }: Props = $props();

	const who = $derived(access ?? adminAccess.current);
	const canRead = $derived(hasPermission(who, 'admin:email_deliveries:read'));
	const canReadUsers = $derived(hasPermission(who, 'admin:users:read'));

	let status = $state<'' | EmailDeliveryStatus>('');
	let limit = $state(EMAIL_DELIVERIES_PAGE_SIZE);
	let rows = $state<EmailDelivery[]>([]);
	let visibility = $state<RecipientVisibility>('none');
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let selectedId = $state<string | null>(null);
	const selected = $derived(rows.find((row) => row.intent_id === selectedId) ?? null);
	const filtered = $derived(!!status || limit !== EMAIL_DELIVERIES_PAGE_SIZE);

	let generation = 0;
	async function load(): Promise<void> {
		const mine = ++generation;
		if (!canRead) {
			phase = 'forbidden';
			return;
		}
		phase = 'loading';
		try {
			const page = await client.list({ status: status || undefined, limit });
			if (mine !== generation) return;
			rows = page.items;
			visibility = page.recipientVisibility;
			if (selectedId && !rows.some((row) => row.intent_id === selectedId)) selectedId = null;
			phase = 'ready';
		} catch (error) {
			if (mine !== generation) return;
			phase = error instanceof ApiError && error.forbidden ? 'forbidden' : 'failed';
		}
	}

	// The filters (and who is looking) decide the list: read it again when they change.
	$effect(() => {
		void [status, limit, canRead];
		untrack(load);
	});

	const statusChoices = $derived(statusOptions(t));
	const limitChoices = $derived(
		[EMAIL_DELIVERIES_PAGE_SIZE, EMAIL_DELIVERIES_MAX].map((count) => ({
			value: String(count),
			label: t('edel.filter.limit.n', { count })
		}))
	);

	function clear(): void {
		status = '';
		limit = EMAIL_DELIVERIES_PAGE_SIZE;
	}

	const userHref = (accountId: string) => (canReadUsers ? `/admin/users/all/${accountId}` : null);
</script>

<Page>
	<PageHeader title={t('nav.mon.deliveries')} description={t('edel.page.desc')} />

	{#if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('edel.noAccess')} />
	{:else}
		<FilterBar active={filtered} onclear={clear}>
			<Select
				label={t('edel.filter.status')}
				hideLabel
				size="sm"
				options={statusChoices}
				bind:value={() => status, (value) => (status = isEmailDeliveryStatus(value) ? value : '')}
			/>
			<Select
				label={t('edel.filter.limit')}
				hideLabel
				size="sm"
				options={limitChoices}
				bind:value={() => String(limit), (value) => (limit = Number(value))}
			/>
		</FilterBar>

		{#if phase === 'loading'}
			<LoadingState label={t('common.loading')} />
		{:else if phase === 'failed'}
			<EmptyState icon="warning" title={t('edel.loadFailed')} description={t('load.error.body')}>
				{#snippet action()}
					<Button onclick={load}>{t('load.retry')}</Button>
				{/snippet}
			</EmptyState>
		{:else}
			{#if visibility === 'masked'}
				<Callout icon="info" title={t('edel.visibility.masked.title')}
					>{t('edel.visibility.masked.body')}</Callout
				>
			{:else if visibility === 'none'}
				<Callout icon="info" title={t('edel.visibility.none.title')}
					>{t('edel.visibility.none.body')}</Callout
				>
			{/if}

			{#if selected}
				{#key selected.intent_id}
					<EmailDeliveryDetail item={selected} {userHref} onclose={() => (selectedId = null)} />
				{/key}
			{/if}

			<Card
				title={t('edel.list.title')}
				info={t('edel.list.info', { count: EMAIL_DELIVERIES_MAX })}
				flush
			>
				<DataTable
					caption={t('edel.list.title')}
					columns={[
						{ key: 'time', label: t('edel.col.time'), width: '18%' },
						{ key: 'kind', label: t('edel.col.kind'), width: '24%' },
						{ key: 'recipient', label: t('edel.col.recipient') },
						{ key: 'status', label: t('edel.col.status'), width: '14%' },
						{ key: 'error', label: t('edel.col.error'), width: '18%' }
					]}
					{rows}
					rowKey={(row) => row.intent_id}
					onrowopen={(row) => (selectedId = row.intent_id)}
					rowOpenLabel={(row) =>
						t('edel.row.open', { kind: kindLabel(row.notification_kind, t, hasMessage) })}
				>
					{#snippet cell(row, column)}
						{#if column.key === 'time'}
							{#if row.requested_at}
								<DateTime value={row.requested_at} stacked />
							{:else}
								—
							{/if}
						{:else if column.key === 'kind'}
							{@const named = kindLabelKey(row.notification_kind, hasMessage)}
							{#if named}
								<span class="cell-name">{t(named)}</span>
								<span class="second"><code>{row.notification_kind}</code></span>
							{:else}
								<code>{row.notification_kind || t('edel.kind.unknown')}</code>
							{/if}
						{:else if column.key === 'recipient'}
							{#if row.recipient}
								<code>{row.recipient}</code>
							{:else}
								<span class="muted">{t('edel.recipient.hidden')}</span>
							{/if}
						{:else if column.key === 'status'}
							{@const known = statusOf(row)}
							{#if known}
								<Badge tone={STATUS_TONE[known]}>{t(STATUS_LABEL[known])}</Badge>
							{:else}
								<code>{row.status}</code>
							{/if}
							{#if row.attempts > 1}
								<span class="second">{t('edel.attempts', { count: row.attempts })}</span>
							{/if}
						{:else if row.last_error_code}
							<code>{row.last_error_code}</code>
						{:else}
							—
						{/if}
					{/snippet}
					{#snippet empty()}
						<EmptyState icon="mail" title={t('edel.empty')} />
					{/snippet}
				</DataTable>
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

	.muted {
		color: var(--text-muted);
	}
</style>
