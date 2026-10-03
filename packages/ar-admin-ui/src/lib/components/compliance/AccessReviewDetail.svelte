<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		adminComplianceAPI,
		ComplianceAPIError,
		type AccessReviewDecision,
		type AccessReviewDetail,
		type AccessReviewItem
	} from '$lib/api/admin-compliance';
	import AdminDataTable from '$lib/components/admin/AdminDataTable.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { toast } from '$lib/toast';
	import {
		applyStatusClass,
		applyStatusLabel,
		formatDateTime,
		reviewStatusClass,
		reviewStatusLabel
	} from './format';

	interface Props {
		reviewId: string;
		/** Back to the list; `changed`: the review changed, so the list reloads. */
		onClose: (changed: boolean) => void;
	}

	let { reviewId, onClose }: Props = $props();

	const PAGE_SIZE = 50;
	type DecisionFilter = 'all' | 'pending' | 'approved' | 'revoked';

	let review = $state<AccessReviewDetail | null>(null);
	let items = $state<AccessReviewItem[]>([]);
	let nextCursor = $state<string | undefined>(undefined);
	let filter = $state<DecisionFilter>('all');
	let loading = $state(true);
	let error = $state('');
	/** Why the last decision did not go through; kept across the reload after it. */
	let decideError = $state('');
	let busy = $state(false);
	let changed = $state(false);
	const selected = new SvelteSet<string>();
	let justification = $state('');

	const open = $derived(review?.status === 'in_progress');
	const undecided = $derived(
		review ? review.progress.total_items - review.progress.reviewed_items : 0
	);

	/** The API takes at most this many items per decision. */
	const DECISION_BATCH = 100;
	/** Each load's number: a response to an older one (another filter) is dropped. */
	let generation = 0;
	let loadingMore = $state(false);

	async function reload() {
		const current = ++generation;
		loading = true;
		error = '';
		selected.clear();
		// Nothing of the previous list stays to act on while this one loads (or if it fails).
		items = [];
		nextCursor = undefined;
		try {
			const [detail, page] = await Promise.all([
				adminComplianceAPI.getAccessReview(reviewId),
				adminComplianceAPI.listAccessReviewItems(reviewId, {
					limit: PAGE_SIZE,
					decision: filter === 'all' ? undefined : filter
				})
			]);
			if (current !== generation) return;
			review = detail;
			items = page.data;
			nextCursor = page.pagination.has_more ? page.pagination.next_cursor : undefined;
		} catch (e) {
			if (current !== generation) return;
			error = e instanceof Error ? e.message : $LL.admin_compliance_load_failed();
		} finally {
			if (current === generation) loading = false;
		}
	}

	async function loadMore() {
		if (loadingMore || loading || !nextCursor) return;
		const current = generation;
		loadingMore = true;
		try {
			const page = await adminComplianceAPI.listAccessReviewItems(reviewId, {
				limit: PAGE_SIZE,
				cursor: nextCursor,
				decision: filter === 'all' ? undefined : filter
			});
			if (current !== generation) return;
			items = [...items, ...page.data];
			nextCursor = page.pagination.has_more ? page.pagination.next_cursor : undefined;
		} catch (e) {
			if (current === generation) {
				error = e instanceof Error ? e.message : $LL.admin_compliance_load_failed();
			}
		} finally {
			loadingMore = false;
		}
	}

	onMount(() => {
		void reload();
	});

	function setFilter(next: DecisionFilter) {
		filter = next;
		void reload();
	}

	function toggle(itemId: string) {
		if (selected.has(itemId)) selected.delete(itemId);
		else selected.add(itemId);
	}

	function togglePage(checked: boolean) {
		selected.clear();
		if (checked) for (const item of items) selected.add(item.item_id);
	}

	async function decide(decision: AccessReviewDecision) {
		if (selected.size === 0 || loading) return;
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
				const result = await adminComplianceAPI.decideAccessReviewItems(reviewId, {
					item_ids: batch,
					decision,
					...(reason ? { justification: reason } : {})
				});
				sent += batch.length;
				updated += result.updated;
				unchanged += result.unchanged;
			}
			justification = '';
		} catch (e) {
			// The batch that failed may have been recorded before its error (the list, reloaded,
			// says); the ones after it were not sent.
			const unknown = Math.min(DECISION_BATCH, ids.length - sent);
			decideError = $LL.admin_compliance_decide_partial({
				message: e instanceof Error ? e.message : $LL.admin_compliance_decide_failed(),
				recorded: updated,
				unchanged,
				unknown,
				left: ids.length - sent - unknown
			});
		} finally {
			if (updated > 0 || unchanged > 0) {
				changed = true;
				toast.success($LL.admin_compliance_decided({ count: updated }));
				if (unchanged > 0) {
					toast.warning($LL.admin_compliance_decision_locked({ count: unchanged }));
				}
			}
			busy = false;
			await reload();
		}
	}

	async function complete() {
		busy = true;
		error = '';
		try {
			const result = await adminComplianceAPI.completeAccessReview(reviewId);
			changed = true;
			if (result.completed) {
				toast.success($LL.admin_compliance_completed({ applied: result.applied }));
			} else {
				toast.warning(
					$LL.admin_compliance_completed_partial({
						applied: result.applied,
						failed: result.failed,
						remaining: result.remaining
					})
				);
			}
			await reload();
		} catch (e) {
			error =
				e instanceof ComplianceAPIError && e.code === 'access_review_undecided_items'
					? $LL.admin_compliance_complete_undecided({ count: undecided })
					: e instanceof Error
						? e.message
						: $LL.admin_compliance_complete_failed();
		} finally {
			busy = false;
		}
	}

	async function cancel() {
		if (!confirm($LL.admin_compliance_cancel_confirm())) return;
		busy = true;
		error = '';
		try {
			await adminComplianceAPI.cancelAccessReview(reviewId);
			changed = true;
			toast.success($LL.admin_compliance_cancelled());
			await reload();
		} catch (e) {
			error =
				e instanceof ComplianceAPIError && e.status === 409
					? $LL.admin_compliance_cancel_blocked()
					: e instanceof Error
						? e.message
						: $LL.admin_compliance_cancel_failed();
		} finally {
			busy = false;
		}
	}

	function accessLabel(item: AccessReviewItem): string {
		switch (item.permission_type) {
			case 'role':
				return $LL.admin_compliance_access_role({ value: item.permission_value });
			case 'organization':
				return $LL.admin_compliance_access_organization({ value: item.permission_value });
			default:
				return $LL.admin_compliance_access_account();
		}
	}

	function decisionLabel(item: AccessReviewItem): string {
		if (item.decision === 'approved') return $LL.admin_compliance_decision_approved();
		if (item.decision === 'revoked') return $LL.admin_compliance_decision_revoked();
		return $LL.admin_compliance_decision_undecided();
	}
</script>

<div class="review-detail">
	<button class="btn btn-link" onclick={() => onClose(changed)}>
		← {$LL.admin_compliance_review_back()}
	</button>

	{#if error}
		<div class="alert alert-error" role="alert">{error}</div>
	{/if}
	{#if decideError}
		<div class="alert alert-error" role="alert">{decideError}</div>
	{/if}

	{#if loading && !review}
		<div class="loading-state">{$LL.admin_compliance_loading()}</div>
	{:else if review}
		<AdminSection title={review.name} description={review.description ?? undefined}>
			{#snippet actions()}
				<span class={reviewStatusClass(review!.status)}
					>{reviewStatusLabel($LL, review!.status)}</span
				>
				{#if review!.overdue}
					<span class="badge badge-danger">{$LL.admin_compliance_overdue()}</span>
				{/if}
			{/snippet}
			<p>
				{$LL.admin_compliance_review_counts({
					reviewed: review.progress.reviewed_items,
					total: review.progress.total_items,
					approved: review.progress.approved_items,
					revoked: review.progress.revoked_items
				})}
			</p>
			<p class="text-secondary">
				{$LL.admin_compliance_review_application({
					applied: review.application.applied,
					failed: review.application.failed,
					pending: review.application.pending_revocations
				})}
			</p>
			{#if review.due_date}
				<p class="text-secondary">
					{$LL.admin_compliance_due_date()}: {formatDateTime(review.due_date)}
				</p>
			{/if}
			{#if open}
				<p class="form-hint">{$LL.admin_compliance_complete_hint()}</p>
				<div class="form-actions">
					<button class="btn btn-primary" disabled={busy} onclick={complete}>
						{$LL.admin_compliance_complete()}
					</button>
					<button class="btn btn-secondary" disabled={busy} onclick={cancel}>
						{$LL.admin_compliance_cancel_review()}
					</button>
				</div>
			{/if}
		</AdminSection>

		<AdminSection title={$LL.admin_compliance_items()}>
			<div class="filter-row" role="group" aria-label={$LL.admin_compliance_item_decision()}>
				{#each [['all', $LL.admin_compliance_filter_all()], ['pending', $LL.admin_compliance_decision_undecided()], ['approved', $LL.admin_compliance_decision_approved()], ['revoked', $LL.admin_compliance_decision_revoked()]] as [value, label] (value)}
					<button
						class="btn btn-sm"
						class:btn-primary={filter === value}
						class:btn-secondary={filter !== value}
						aria-pressed={filter === value}
						onclick={() => setFilter(value as DecisionFilter)}
					>
						{label}
					</button>
				{/each}
			</div>

			{#if open}
				<div class="decision-bar">
					<span class="text-secondary"
						>{$LL.admin_compliance_selected({ count: selected.size })}</span
					>
					<input
						class="form-input"
						maxlength="1000"
						placeholder={$LL.admin_compliance_justification()}
						aria-label={$LL.admin_compliance_justification()}
						disabled={busy}
						bind:value={justification}
					/>
					<button
						class="btn btn-secondary btn-sm"
						disabled={busy || loading || selected.size === 0}
						onclick={() => decide('approved')}
					>
						{$LL.admin_compliance_keep_selected()}
					</button>
					<button
						class="btn btn-danger btn-sm"
						disabled={busy || loading || selected.size === 0}
						onclick={() => decide('revoked')}
					>
						{$LL.admin_compliance_revoke_selected()}
					</button>
				</div>
			{/if}

			<AdminDataTable width="wide">
				<thead>
					<tr>
						{#if open}
							<th>
								<input
									type="checkbox"
									aria-label={$LL.admin_compliance_select_page()}
									disabled={loading}
									checked={items.length > 0 && selected.size === items.length}
									onchange={(event) => togglePage(event.currentTarget.checked)}
								/>
							</th>
						{/if}
						<th>{$LL.admin_compliance_item_user()}</th>
						<th>{$LL.admin_compliance_item_access()}</th>
						<th>{$LL.admin_compliance_item_decision()}</th>
						<th>{$LL.admin_compliance_item_applied()}</th>
					</tr>
				</thead>
				<tbody>
					{#each items as item (item.item_id)}
						<tr>
							{#if open}
								<td>
									<input
										type="checkbox"
										aria-label={$LL.admin_compliance_select_item({
											user: item.user.name ?? item.user.email ?? item.user_id
										})}
										disabled={loading}
										checked={selected.has(item.item_id)}
										onchange={() => toggle(item.item_id)}
									/>
								</td>
							{/if}
							<td>
								<div class="cell-primary">{item.user.name ?? item.user.email ?? item.user_id}</div>
								<div class="cell-secondary">{item.user.email ?? item.user_id}</div>
							</td>
							<td>{accessLabel(item)}</td>
							<td>
								<div>{decisionLabel(item)}</div>
								{#if item.decided_by}
									<div class="cell-secondary">
										{item.decided_by} · {formatDateTime(item.decided_at)}
									</div>
								{/if}
								{#if item.justification}
									<div class="cell-secondary">{item.justification}</div>
								{/if}
							</td>
							<td>
								{#if item.apply_status}
									<span class={applyStatusClass(item.apply_status)}>
										{applyStatusLabel($LL, item.apply_status)}
									</span>
									{#if item.apply_error}
										<div class="cell-secondary">
											{$LL.admin_compliance_apply_error({ code: item.apply_error })}
										</div>
									{/if}
								{:else}
									<span class="text-secondary">—</span>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
			{#if nextCursor}
				<div class="center-actions">
					<button class="btn btn-secondary" disabled={loading || loadingMore} onclick={loadMore}>
						{$LL.admin_compliance_load_more()}
					</button>
				</div>
			{/if}
		</AdminSection>
	{/if}
</div>

<style>
	.review-detail {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.filter-row {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin-bottom: 12px;
	}

	.decision-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin-bottom: 12px;
	}

	.decision-bar .form-input {
		flex: 1 1 240px;
	}
</style>
