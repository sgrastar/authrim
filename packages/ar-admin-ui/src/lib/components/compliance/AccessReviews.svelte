<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminComplianceAPI,
		ComplianceAPIError,
		type AccessReview,
		type AccessReviewScope
	} from '$lib/api/admin-compliance';
	import { Modal } from '$lib/components';
	import AdminDataTable from '$lib/components/admin/AdminDataTable.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import AccessReviewDetail from './AccessReviewDetail.svelte';
	import { formatDateTime, reviewStatusClass, reviewStatusLabel } from './format';

	const PAGE_SIZE = 20;

	let reviews = $state<AccessReview[]>([]);
	let nextCursor = $state<string | undefined>(undefined);
	let loading = $state(true);
	let loadError = $state('');
	let openReviewId = $state<string | null>(null);

	let showCreate = $state(false);
	let creating = $state(false);
	let createError = $state('');
	let name = $state('');
	let description = $state('');
	let scope = $state<AccessReviewScope>('all_users');
	let scopeValue = $state('');
	let inactiveDays = $state(90);
	let dueDate = $state('');

	async function load(more = false) {
		loading = true;
		loadError = '';
		try {
			const page = await adminComplianceAPI.listAccessReviews({
				limit: PAGE_SIZE,
				cursor: more ? nextCursor : undefined
			});
			reviews = more ? [...reviews, ...page.data] : page.data;
			nextCursor = page.pagination.has_more ? page.pagination.next_cursor : undefined;
		} catch (error) {
			loadError = error instanceof Error ? error.message : $LL.admin_compliance_load_failed();
		} finally {
			loading = false;
		}
	}

	onMount(() => {
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
		showCreate = true;
	}

	async function create() {
		if (!name.trim()) {
			createError = $LL.admin_compliance_review_name_required();
			return;
		}
		if ((scope === 'role' || scope === 'organization') && !scopeValue.trim()) {
			createError = $LL.admin_compliance_review_scope_value_required();
			return;
		}
		creating = true;
		createError = '';
		try {
			const review = await adminComplianceAPI.createAccessReview({
				name: name.trim(),
				...(description.trim() ? { description: description.trim() } : {}),
				scope,
				...(scope === 'role' || scope === 'organization' ? { scope_value: scopeValue.trim() } : {}),
				...(scope === 'inactive_users' ? { inactive_days: inactiveDays } : {}),
				...(dueDate ? { due_date: dueDate } : {})
			});
			reviews = [review, ...reviews];
			showCreate = false;
			openReviewId = review.review_id;
		} catch (error) {
			createError =
				error instanceof ComplianceAPIError &&
				(error.code === 'access_review_too_large' || error.code === 'access_review_scan_limit')
					? $LL.admin_compliance_review_too_many()
					: error instanceof Error
						? error.message
						: $LL.admin_compliance_review_create_failed();
		} finally {
			creating = false;
		}
	}

	function closeDetail(changed: boolean) {
		openReviewId = null;
		if (changed) void load();
	}

	function scopeLabel(review: AccessReview): string {
		switch (review.scope) {
			case 'all_users':
				return $LL.admin_compliance_scope_all_users();
			case 'role':
				return `${$LL.admin_compliance_scope_role()}: ${review.scope_value ?? ''}`;
			case 'organization':
				return `${$LL.admin_compliance_scope_organization()}: ${review.scope_value ?? ''}`;
			case 'inactive_users':
				return `${$LL.admin_compliance_scope_inactive_users()} (${$LL.admin_compliance_days({
					count: review.inactive_days ?? 0
				})})`;
			default:
				return String(review.scope);
		}
	}
</script>

{#if openReviewId}
	<AccessReviewDetail reviewId={openReviewId} onClose={closeDetail} />
{:else}
	<div class="tab-header-actions">
		<button class="btn btn-primary" onclick={openCreate}>
			{$LL.admin_compliance_start_review()}
		</button>
	</div>

	{#if loadError}
		<div class="alert alert-error" role="alert">
			{loadError}
			<button class="btn btn-secondary btn-sm" onclick={() => load()}>
				{$LL.admin_compliance_retry()}
			</button>
		</div>
	{/if}

	{#if loading && reviews.length === 0}
		<div class="loading-state">{$LL.admin_compliance_loading()}</div>
	{:else if reviews.length === 0 && !loadError}
		<div class="empty-state"><p>{$LL.admin_compliance_no_reviews()}</p></div>
	{:else}
		<AdminDataTable width="wide">
			<thead>
				<tr>
					<th>{$LL.admin_compliance_review_name()}</th>
					<th>{$LL.admin_compliance_review_scope()}</th>
					<th>{$LL.admin_compliance_review_progress()}</th>
					<th>{$LL.admin_compliance_review_created()}</th>
					<th>{$LL.admin_compliance_due_date()}</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				{#each reviews as review (review.review_id)}
					<tr>
						<td>
							<div class="cell-primary">{review.name}</div>
							<span class={reviewStatusClass(review.status)}>
								{reviewStatusLabel($LL, review.status)}
							</span>
							{#if review.overdue}
								<span class="badge badge-danger">{$LL.admin_compliance_overdue()}</span>
							{/if}
						</td>
						<td>{scopeLabel(review)}</td>
						<td>
							{review.progress.reviewed_items} / {review.progress.total_items}
							<div class="cell-secondary">{review.progress.completion_percent}%</div>
						</td>
						<td class="text-secondary">{formatDateTime(review.created_at)}</td>
						<td class="text-secondary">{formatDateTime(review.due_date)}</td>
						<td class="text-right">
							<button
								class="btn btn-secondary btn-sm"
								onclick={() => (openReviewId = review.review_id)}
							>
								{$LL.admin_compliance_review_open()}
							</button>
						</td>
					</tr>
				{/each}
			</tbody>
		</AdminDataTable>
		{#if nextCursor}
			<div class="center-actions">
				<button class="btn btn-secondary" disabled={loading} onclick={() => load(true)}>
					{$LL.admin_compliance_load_more()}
				</button>
			</div>
		{/if}
	{/if}
{/if}

<Modal
	open={showCreate}
	onClose={() => (showCreate = false)}
	title={$LL.admin_compliance_start_review()}
	size="md"
>
	<div class="form-section">
		{#if createError}
			<div class="alert alert-error" role="alert">{createError}</div>
		{/if}
		<div class="form-group">
			<label class="form-label" for="review-name">{$LL.admin_compliance_review_name()}</label>
			<input id="review-name" class="form-input" maxlength="200" bind:value={name} />
		</div>
		<div class="form-group">
			<label class="form-label" for="review-description">
				{$LL.admin_compliance_review_description()}
			</label>
			<textarea
				id="review-description"
				class="form-input"
				maxlength="1000"
				rows="2"
				bind:value={description}
			></textarea>
		</div>
		<div class="form-group">
			<label class="form-label" for="review-scope">{$LL.admin_compliance_review_scope()}</label>
			<select id="review-scope" class="form-select" bind:value={scope}>
				<option value="all_users">{$LL.admin_compliance_scope_all_users()}</option>
				<option value="role">{$LL.admin_compliance_scope_role()}</option>
				<option value="organization">{$LL.admin_compliance_scope_organization()}</option>
				<option value="inactive_users">{$LL.admin_compliance_scope_inactive_users()}</option>
			</select>
		</div>
		{#if scope === 'role' || scope === 'organization'}
			<div class="form-group">
				<label class="form-label" for="review-scope-value">
					{scope === 'role'
						? $LL.admin_compliance_scope_value_role()
						: $LL.admin_compliance_scope_value_organization()}
				</label>
				<input id="review-scope-value" class="form-input" maxlength="255" bind:value={scopeValue} />
			</div>
		{/if}
		{#if scope === 'inactive_users'}
			<div class="form-group">
				<label class="form-label" for="review-inactive-days">
					{$LL.admin_compliance_inactive_days()}
				</label>
				<input
					id="review-inactive-days"
					class="form-input"
					type="number"
					min="1"
					max="3650"
					bind:value={inactiveDays}
				/>
			</div>
		{/if}
		<div class="form-group">
			<label class="form-label" for="review-due">{$LL.admin_compliance_due_date()}</label>
			<input id="review-due" class="form-input" type="date" bind:value={dueDate} />
		</div>
	</div>
	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showCreate = false)}>
			{$LL.admin_compliance_cancel()}
		</button>
		<button class="btn btn-primary" disabled={creating} onclick={create}>
			{$LL.admin_compliance_start_review()}
		</button>
	{/snippet}
</Modal>
