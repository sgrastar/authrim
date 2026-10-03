<script lang="ts">
	import {
		errorCode,
		type AccessReviewDetail,
		type ComplianceClient,
		type Decision,
		type ReviewItem
	} from '$lib/api/compliance';
	import { t } from '$lib/i18n/i18n.svelte';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import ConfirmDialog from '$lib/ui/patterns/ConfirmDialog.svelte';
	import DataTable from '$lib/ui/patterns/DataTable.svelte';
	import LoadingState from '$lib/ui/patterns/LoadingState.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import SegmentedControl from '$lib/ui/primitives/SegmentedControl.svelte';
	import TextField from '$lib/ui/primitives/TextField.svelte';
	import { toast } from '$lib/ui/toast/toast.svelte';
	import { applyTone, label, reviewTone, timeText } from './labels';

	interface Props {
		client: ComplianceClient;
		tenantId: string;
		reviewId: string;
		/** Back to the list; `changed`: the review changed, so the list reloads. */
		onclose: (changed: boolean) => void;
	}

	let { client, tenantId, reviewId, onclose }: Props = $props();

	/** The API takes at most this many items per decision. */
	const DECISION_BATCH = 100;
	type Filter = 'all' | 'pending' | Decision;

	let review = $state<AccessReviewDetail | null>(null);
	let items = $state<ReviewItem[]>([]);
	let nextCursor = $state<string | undefined>(undefined);
	let filter = $state<Filter>('all');
	let selected = $state<string[]>([]);
	let justification = $state('');
	let loading = $state(true);
	let loadingMore = $state(false);
	let busy = $state(false);
	let error = $state('');
	/** Why the last decision did not go through; kept across the reload after it. */
	let decideError = $state('');
	let changed = false;
	let confirming = $state<'complete' | 'cancel' | null>(null);
	/** Each load's number: a response to an older one (another filter) is dropped. */
	let generation = 0;

	const open = $derived(review?.status === 'in_progress');

	async function reload() {
		const current = ++generation;
		loading = true;
		selected = [];
		// Nothing of the previous list stays to act on while this one loads (or if it fails).
		items = [];
		nextCursor = undefined;
		try {
			const [detail, page] = await Promise.all([
				client.review(tenantId, reviewId),
				client.reviewItems(tenantId, reviewId, {
					decision: filter === 'all' ? undefined : filter
				})
			]);
			if (current !== generation) return;
			review = detail;
			items = page.data;
			nextCursor = page.pagination.has_more ? page.pagination.next_cursor : undefined;
		} catch {
			if (current === generation) error = t('cmp.loadFailed');
		} finally {
			if (current === generation) loading = false;
		}
	}

	async function loadMore() {
		if (loading || loadingMore || !nextCursor) return;
		const current = generation;
		loadingMore = true;
		try {
			const page = await client.reviewItems(tenantId, reviewId, {
				cursor: nextCursor,
				decision: filter === 'all' ? undefined : filter
			});
			if (current !== generation) return;
			items = [...items, ...page.data];
			nextCursor = page.pagination.has_more ? page.pagination.next_cursor : undefined;
		} catch {
			if (current === generation) error = t('cmp.loadFailed');
		} finally {
			loadingMore = false;
		}
	}

	$effect(() => {
		void reload();
	});

	function setFilter(value: string) {
		filter = value as Filter;
		error = '';
		void reload();
	}

	async function decide(decision: Decision) {
		if (selected.length === 0 || loading) return;
		busy = true;
		decideError = '';
		let updated = 0;
		let unchanged = 0;
		// The items and the reason as they are now, for every batch.
		const ids = [...selected];
		const reason = justification.trim();
		let sent = 0;
		try {
			// In batches the API takes; each batch is recorded on its own.
			for (let start = 0; start < ids.length; start += DECISION_BATCH) {
				const batch = ids.slice(start, start + DECISION_BATCH);
				const result = await client.decide(tenantId, reviewId, {
					item_ids: batch,
					decision,
					...(reason ? { justification: reason } : {})
				});
				sent += batch.length;
				updated += result.updated;
				unchanged += result.unchanged;
			}
			justification = '';
		} catch {
			// The batch that failed may have been recorded before its error (the list, reloaded,
			// says); the ones after it were not sent.
			const unknown = Math.min(DECISION_BATCH, ids.length - sent);
			decideError = t('cmp.decidePartial', {
				recorded: updated,
				unchanged,
				unknown,
				left: ids.length - sent - unknown
			});
		} finally {
			if (updated > 0 || unchanged > 0) {
				changed = true;
				toast.success(t('cmp.decided', { count: updated }));
				if (unchanged > 0) toast.warning(t('cmp.decisionLocked', { count: unchanged }));
			}
			busy = false;
			await reload();
		}
	}

	async function complete() {
		busy = true;
		error = '';
		try {
			const result = await client.complete(tenantId, reviewId);
			changed = true;
			if (result.completed) toast.success(t('cmp.completed', { applied: result.applied }));
			else
				toast.warning(
					t('cmp.completedPartial', {
						applied: result.applied,
						failed: result.failed,
						remaining: result.remaining
					})
				);
		} catch (e) {
			error =
				errorCode(e) === 'access_review_undecided_items' && review
					? t('cmp.complete.undecided', {
							count: review.progress.total_items - review.progress.reviewed_items
						})
					: t('cmp.completeFailed');
		} finally {
			busy = false;
			confirming = null;
			await reload();
		}
	}

	async function cancel() {
		busy = true;
		error = '';
		try {
			await client.cancel(tenantId, reviewId);
			changed = true;
			toast.success(t('cmp.cancelled'));
		} catch (e) {
			error =
				errorCode(e) === 'access_review_closed'
					? t('cmp.cancelReview.blocked')
					: t('cmp.cancelFailed');
		} finally {
			busy = false;
			confirming = null;
			await reload();
		}
	}

	function accessText(item: ReviewItem): string {
		if (item.permission_type === 'role')
			return t('cmp.access.role', { value: item.permission_value });
		if (item.permission_type === 'organization') {
			return t('cmp.access.organization', { value: item.permission_value });
		}
		return t('cmp.access.account');
	}

	function decisionText(item: ReviewItem): string {
		return item.decision ? label('cmp.decision.', item.decision) : t('cmp.decision.undecided');
	}

	const filters = $derived([
		{ value: 'all', label: t('cmp.filter.all') },
		{ value: 'pending', label: t('cmp.decision.undecided') },
		{ value: 'approved', label: t('cmp.decision.approved') },
		{ value: 'revoked', label: t('cmp.decision.revoked') }
	]);
</script>

<div class="detail">
	<div>
		<Button variant="ghost" size="sm" icon="arrowBack" onclick={() => onclose(changed)}>
			{t('cmp.review.back')}
		</Button>
	</div>

	{#if error}
		<Callout tone="danger" live>{error}</Callout>
	{/if}
	{#if decideError}
		<Callout tone="danger" live>{decideError}</Callout>
	{/if}

	{#if !review}
		<LoadingState label={t('cmp.loading')} />
	{:else}
		<Card title={review.name} description={review.description ?? undefined}>
			{#snippet actions()}
				<Badge tone={reviewTone(review!.status)}
					>{label('cmp.review.status.', review!.status)}</Badge
				>
				{#if review!.overdue}<Badge tone="danger">{t('cmp.review.overdue')}</Badge>{/if}
			{/snippet}
			<p>
				{t('cmp.review.counts', {
					reviewed: review.progress.reviewed_items,
					total: review.progress.total_items,
					approved: review.progress.approved_items,
					revoked: review.progress.revoked_items
				})}
			</p>
			<p class="muted">
				{t('cmp.review.application', {
					applied: review.application.applied,
					failed: review.application.failed,
					pending: review.application.pending_revocations
				})}
			</p>
			{#if review.due_date}
				<p class="muted">{t('cmp.review.due')}: {timeText(review.due_date)}</p>
			{/if}
			{#if open}
				<p class="muted">{t('cmp.complete.desc')}</p>
				<div class="actions">
					<Button
						variant="primary"
						disabled={busy || loading}
						onclick={() => (confirming = 'complete')}
					>
						{t('cmp.complete')}
					</Button>
					<Button
						variant="secondary"
						disabled={busy || loading}
						onclick={() => (confirming = 'cancel')}
					>
						{t('cmp.cancelReview')}
					</Button>
				</div>
			{/if}
		</Card>

		<Card title={t('cmp.items')} flush>
			{#snippet actions()}
				<SegmentedControl
					label={t('cmp.item.decision')}
					options={filters}
					value={filter}
					onchange={setFilter}
				/>
			{/snippet}
			<DataTable
				caption={t('cmp.items')}
				columns={[
					{ key: 'user', label: t('cmp.item.user'), width: '30%' },
					{ key: 'access', label: t('cmp.item.access') },
					{ key: 'decision', label: t('cmp.item.decision'), width: '26%' },
					{ key: 'applied', label: t('cmp.item.applied'), width: '18%' }
				]}
				rows={items}
				rowKey={(item) => item.item_id}
				selectable={open && !loading}
				bind:selected
				rowLabel={(item) => item.user.name ?? item.user.email ?? item.user_id}
			>
				{#snippet bulkActions()}
					<TextField
						label={t('cmp.justification')}
						hideLabel
						size="sm"
						maxlength={1000}
						placeholder={t('cmp.justification')}
						disabled={busy}
						bind:value={justification}
					/>
					<Button size="sm" variant="secondary" loading={busy} onclick={() => decide('approved')}>
						{t('cmp.keep')}
					</Button>
					<Button size="sm" variant="danger" loading={busy} onclick={() => decide('revoked')}>
						{t('cmp.revoke')}
					</Button>
				{/snippet}
				{#snippet cell(item, column)}
					{#if column.key === 'user'}
						<div class="stack">
							<strong>{item.user.name ?? item.user.email ?? item.user_id}</strong>
							<span class="muted">{item.user.email ?? item.user_id}</span>
						</div>
					{:else if column.key === 'access'}
						{accessText(item)}
					{:else if column.key === 'decision'}
						<div class="stack">
							<span>{decisionText(item)}</span>
							{#if item.decided_by}
								<span class="muted">{item.decided_by} · {timeText(item.decided_at)}</span>
							{/if}
							{#if item.justification}<span class="muted">{item.justification}</span>{/if}
						</div>
					{:else if item.apply_status}
						<div class="stack">
							<Badge tone={applyTone(item.apply_status)}
								>{label('cmp.apply.', item.apply_status)}</Badge
							>
							{#if item.apply_error}
								<span class="muted">{t('cmp.apply.reason', { code: item.apply_error })}</span>
							{/if}
						</div>
					{:else}
						<span class="muted">—</span>
					{/if}
				{/snippet}
			</DataTable>
		</Card>
		{#if nextCursor}
			<div class="more">
				<Button variant="secondary" loading={loadingMore} disabled={loading} onclick={loadMore}>
					{t('cmp.loadMore')}
				</Button>
			</div>
		{/if}
	{/if}
</div>

<ConfirmDialog
	open={confirming === 'complete'}
	title={t('cmp.complete')}
	body={t('cmp.complete.confirm')}
	confirmLabel={t('cmp.complete')}
	{busy}
	onconfirm={complete}
	oncancel={() => (confirming = null)}
/>
<ConfirmDialog
	open={confirming === 'cancel'}
	title={t('cmp.cancelReview')}
	body={t('cmp.cancelReview.confirm')}
	confirmLabel={t('cmp.cancelReview')}
	cancelLabel={t('cmp.keepGoing')}
	tone="danger"
	{busy}
	onconfirm={cancel}
	oncancel={() => (confirming = null)}
/>

<style>
	.detail {
		display: flex;
		flex-direction: column;
		gap: var(--space-section);
	}

	.detail p {
		margin: 0 0 var(--space-related);
	}

	.actions {
		display: flex;
		gap: var(--space-related);
		flex-wrap: wrap;
	}

	.stack {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
	}

	.muted {
		color: var(--text-secondary);
	}

	.more {
		display: flex;
		justify-content: center;
	}
</style>
