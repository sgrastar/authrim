<script lang="ts">
	import {
		errorCode,
		type AccessReview,
		type ComplianceClient,
		type ReviewScope
	} from '$lib/api/compliance';
	import { t } from '$lib/i18n/i18n.svelte';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import DataTable from '$lib/ui/patterns/DataTable.svelte';
	import EmptyState from '$lib/ui/patterns/EmptyState.svelte';
	import FormDialog from '$lib/ui/patterns/FormDialog.svelte';
	import LoadingState from '$lib/ui/patterns/LoadingState.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import NumberField from '$lib/ui/primitives/NumberField.svelte';
	import Select from '$lib/ui/primitives/Select.svelte';
	import TextArea from '$lib/ui/primitives/TextArea.svelte';
	import TextField from '$lib/ui/primitives/TextField.svelte';
	import ReviewDetail from './ReviewDetail.svelte';
	import { duration, label, reviewTone, timeText } from './labels';

	interface Props {
		client: ComplianceClient;
		tenantId: string;
	}

	let { client, tenantId }: Props = $props();

	let reviews = $state<AccessReview[] | null>(null);
	let nextCursor = $state<string | undefined>(undefined);
	let loadError = $state('');
	let loadingMore = $state(false);
	let openId = $state<string | null>(null);

	let creating = $state(false);
	let busy = $state(false);
	let createError = $state('');
	let name = $state('');
	let description = $state('');
	let scope = $state<ReviewScope>('all_users');
	let scopeValue = $state('');
	let inactiveDays = $state<number | null>(90);
	let dueDate = $state('');

	async function load() {
		loadError = '';
		try {
			const page = await client.reviews(tenantId);
			reviews = page.data;
			nextCursor = page.pagination.has_more ? page.pagination.next_cursor : undefined;
		} catch {
			loadError = t('cmp.loadFailed');
			reviews = reviews ?? [];
		}
	}

	async function loadMore() {
		if (loadingMore || !nextCursor) return;
		loadingMore = true;
		try {
			const page = await client.reviews(tenantId, nextCursor);
			reviews = [...(reviews ?? []), ...page.data];
			nextCursor = page.pagination.has_more ? page.pagination.next_cursor : undefined;
		} catch {
			loadError = t('cmp.loadFailed');
		} finally {
			loadingMore = false;
		}
	}

	$effect(() => {
		void load();
	});

	function openCreate() {
		name = '';
		description = '';
		scope = 'all_users';
		scopeValue = '';
		inactiveDays = 90;
		dueDate = '';
		createError = '';
		creating = true;
	}

	async function create() {
		if (!name.trim()) {
			createError = t('cmp.review.nameRequired');
			return;
		}
		if ((scope === 'role' || scope === 'organization') && !scopeValue.trim()) {
			createError = t('cmp.review.scopeValueRequired');
			return;
		}
		busy = true;
		createError = '';
		try {
			const review = await client.createReview(tenantId, {
				name: name.trim(),
				...(description.trim() ? { description: description.trim() } : {}),
				scope,
				...(scope === 'role' || scope === 'organization' ? { scope_value: scopeValue.trim() } : {}),
				...(scope === 'inactive_users' && inactiveDays ? { inactive_days: inactiveDays } : {}),
				...(dueDate ? { due_date: dueDate } : {})
			});
			creating = false;
			reviews = [review, ...(reviews ?? [])];
			openId = review.review_id;
		} catch (error) {
			const code = errorCode(error);
			createError =
				code === 'access_review_too_large' || code === 'access_review_scan_limit'
					? t('cmp.review.tooMany')
					: t('cmp.review.createFailed');
		} finally {
			busy = false;
		}
	}

	function scopeText(review: AccessReview): string {
		const base = label('cmp.scope.', review.scope);
		if (review.scope === 'role' || review.scope === 'organization') {
			return `${base}: ${review.scope_value ?? ''}`;
		}
		if (review.scope === 'inactive_users' && review.inactive_days) {
			return `${base} (${duration(review.inactive_days * 86_400)})`;
		}
		return base;
	}

	function closeDetail(changed: boolean) {
		openId = null;
		if (changed) void load();
	}

	const scopes = $derived(
		(['all_users', 'role', 'organization', 'inactive_users'] as const).map((value) => ({
			value,
			label: t(`cmp.scope.${value}`)
		}))
	);
</script>

{#if openId}
	<ReviewDetail {client} {tenantId} reviewId={openId} onclose={closeDetail} />
{:else}
	{#if loadError}
		<Callout tone="danger" live>
			{loadError}
			<Button variant="secondary" size="sm" onclick={load}>{t('cmp.retry')}</Button>
		</Callout>
	{/if}
	{#if reviews === null}
		<LoadingState label={t('cmp.loading')} />
	{:else}
		<Card flush>
			{#snippet actions()}
				<Button variant="primary" icon="plus" onclick={openCreate}>{t('cmp.review.start')}</Button>
			{/snippet}
			<DataTable
				caption={t('cmp.tab.reviews')}
				columns={[
					{ key: 'name', label: t('cmp.review.name'), width: '30%' },
					{ key: 'scope', label: t('cmp.review.scope') },
					{ key: 'progress', label: t('cmp.review.decided'), width: '14%' },
					{ key: 'due', label: t('cmp.review.due'), width: '18%' },
					{ key: 'open', label: '', width: '8rem', align: 'end' }
				]}
				rows={reviews}
				rowKey={(review) => review.review_id}
			>
				{#snippet cell(review, column)}
					{#if column.key === 'name'}
						<div class="stack">
							<strong>{review.name}</strong>
							<span class="badges">
								<Badge tone={reviewTone(review.status)}
									>{label('cmp.review.status.', review.status)}</Badge
								>
								{#if review.overdue}<Badge tone="danger">{t('cmp.review.overdue')}</Badge>{/if}
							</span>
						</div>
					{:else if column.key === 'scope'}
						{scopeText(review)}
					{:else if column.key === 'progress'}
						{review.progress.reviewed_items} / {review.progress.total_items}
					{:else if column.key === 'due'}
						{timeText(review.due_date)}
					{:else}
						<Button variant="secondary" size="sm" onclick={() => (openId = review.review_id)}>
							{t('cmp.review.open')}
						</Button>
					{/if}
				{/snippet}
				{#snippet empty()}
					<EmptyState
						icon="check"
						title={t('cmp.review.none')}
						description={t('cmp.review.none.desc')}
					/>
				{/snippet}
			</DataTable>
		</Card>
		{#if nextCursor}
			<div class="more">
				<Button variant="secondary" loading={loadingMore} onclick={loadMore}
					>{t('cmp.loadMore')}</Button
				>
			</div>
		{/if}
	{/if}
{/if}

<FormDialog
	open={creating}
	title={t('cmp.review.start')}
	submitLabel={t('cmp.review.start')}
	{busy}
	error={createError}
	onsubmit={create}
	oncancel={() => (creating = false)}
>
	<TextField label={t('cmp.review.name')} maxlength={200} required bind:value={name} />
	<TextArea
		label={t('cmp.review.description')}
		maxlength={1000}
		rows={2}
		bind:value={description}
	/>
	<Select label={t('cmp.review.scope')} options={scopes} bind:value={scope} />
	{#if scope === 'role' || scope === 'organization'}
		<TextField
			label={scope === 'role' ? t('cmp.scope.roleId') : t('cmp.scope.organizationId')}
			maxlength={255}
			required
			bind:value={scopeValue}
		/>
	{/if}
	{#if scope === 'inactive_users'}
		<NumberField label={t('cmp.scope.inactiveDays')} min={1} max={3650} bind:value={inactiveDays} />
	{/if}
	<TextField
		label={t('cmp.review.due')}
		type="date"
		hint={t('cmp.review.dueHint')}
		bind:value={dueDate}
	/>
</FormDialog>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
	}

	.badges {
		display: inline-flex;
		gap: 4px;
	}

	.more {
		display: flex;
		justify-content: center;
		margin-top: var(--space-related);
	}
</style>
