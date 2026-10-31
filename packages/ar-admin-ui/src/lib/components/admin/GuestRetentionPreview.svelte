<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import {
		adminGuestRetentionAPI,
		type GuestRetentionPreview,
		type GuestRetentionResult
	} from '$lib/api/admin-guest-retention';
	import AdminSection from './AdminSection.svelte';
	let {
		tenantId,
		policyVersion,
		disabled = false
	} = $props<{ tenantId: string; policyVersion: string; disabled?: boolean }>();
	let preview = $state<GuestRetentionPreview | null>(null);
	let result = $state<GuestRetentionResult | null>(null);
	let busy = $state(false);
	let error = $state('');
	let requestId = 0;
	$effect(() => resetPreview(tenantId, policyVersion));
	function resetPreview(_tenant: string, _policyVersion: string) {
		requestId += 1;
		preview = null;
		result = null;
		error = '';
		busy = false;
	}
	async function load(cursor?: string) {
		if (busy || disabled) return;
		const request = ++requestId;
		const tenant = tenantId;
		busy = true;
		error = '';
		result = null;
		try {
			const response = await adminGuestRetentionAPI.preview(tenant, cursor);
			if (request === requestId) preview = response;
		} catch {
			if (request === requestId) error = $LL.admin_retentionPreviewError();
		} finally {
			if (request === requestId) busy = false;
		}
	}
	async function apply() {
		if (busy || disabled || !preview || result) return;
		const request = ++requestId;
		const tenant = tenantId;
		busy = true;
		error = '';
		try {
			const response = await adminGuestRetentionAPI.apply(tenant, preview.preview_token);
			if (request === requestId) result = response;
		} catch {
			if (request === requestId) error = $LL.admin_retentionApplyError();
		} finally {
			if (request === requestId) busy = false;
		}
	}
	const date = (value: number | null) =>
		value === null ? $LL.admin_retentionNoDeadline() : new Date(value * 1000).toLocaleString();
</script>

<AdminSection
	title={$LL.admin_retentionPreviewTitle()}
	description={$LL.admin_retentionPreviewDescription()}
>
	<div class="preview">
		<button
			type="button"
			class="btn btn-secondary"
			disabled={disabled || busy}
			onclick={() => load()}>{$LL.admin_retentionPreviewButton()}</button
		>
		{#if error}<p role="alert">{error}</p>{/if}
		{#if preview}
			<p>{$LL.admin_retentionPreviewCounts({ count: preview.count, due: preview.due_now })}</p>
			{#if preview.items.length}
				<div class="table-scroll">
					<table>
						<thead
							><tr
								><th>{$LL.admin_retentionAccount()}</th><th>{$LL.admin_retentionBefore()}</th><th
									>{$LL.admin_retentionAfter()}</th
								></tr
							></thead
						>
						<tbody
							>{#each preview.items as item (item.user_id)}<tr
									><td>{item.user_id}</td><td>{date(item.previous_due_at)}</td><td
										>{date(item.new_due_at)}</td
									></tr
								>{/each}</tbody
						>
					</table>
				</div>
				<button
					type="button"
					class="btn btn-primary"
					disabled={disabled || busy || !!result}
					onclick={apply}>{$LL.admin_retentionApplyButton({ count: preview.count })}</button
				>
			{/if}
			{#if result}<p role="status">
					{$LL.admin_retentionApplied({
						applied: result.applied,
						unchanged: result.unchanged,
						skipped: result.skipped
					})}
				</p>{/if}
			{#if preview.next_cursor}<button
					type="button"
					class="btn btn-secondary"
					disabled={disabled || busy}
					onclick={() => load(preview?.next_cursor ?? undefined)}
					>{$LL.admin_retentionNextPage()}</button
				>{/if}
		{/if}
	</div>
</AdminSection>

<style>
	.preview {
		display: grid;
		gap: 1rem;
	}
	button {
		justify-self: start;
	}
	.table-scroll {
		overflow: auto;
		max-height: 24rem;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
	}
	th,
	td {
		text-align: start;
		padding: 0.5rem;
		border-bottom: 1px solid var(--color-border, #cbd5e1);
	}
	th {
		position: sticky;
		top: 0;
		background: var(--table-header-bg, var(--color-surface-muted, var(--bg-subtle)));
	}
</style>
