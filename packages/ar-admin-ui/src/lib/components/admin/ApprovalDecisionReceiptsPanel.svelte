<script lang="ts">
	import type { ApprovalDecisionReceiptRecord } from '$lib/api/admin-approvals';
	import { LL } from '$i18n/i18n-svelte';

	type Props = {
		receipts: ApprovalDecisionReceiptRecord[];
		formatDateTime: (timestamp?: number | null) => string;
	};

	let { receipts, formatDateTime }: Props = $props();
</script>

{#if receipts.length === 0}
	<div class="empty-state compact-empty-state">{$LL.admin_approvals_no_receipts_recorded()}</div>
{:else}
	<div class="steps-list">
		{#each receipts as receipt (receipt.receipt_id)}
			<div class="timeline-card tone-success">
				<div class="step-header">
					<div>
						<div class="cell-primary">{receipt.receipt_id}</div>
						<div class="cell-secondary">
							{receipt.decision ?? receipt.receipt?.decision ?? $LL.admin_approvals_recorded()}
							· {receipt.request_status ??
								receipt.receipt?.request_status ??
								$LL.admin_approvals_unknown()}
						</div>
					</div>
					<span class="timeline-timestamp">{formatDateTime(receipt.event_at)}</span>
				</div>
				<div class="timeline-badges">
					<span>{receipt.receipt?.method ?? $LL.admin_approvals_method_na()}</span>
					{#if receipt.receipt?.transport_channel}
						<span>{receipt.receipt.transport_channel}</span>
					{/if}
					{#if receipt.grant_ids.length > 0}
						<span>{$LL.admin_approvals_grants_count({ count: receipt.grant_ids.length })}</span>
					{/if}
				</div>
				<div class="timeline-summary">
					{#if receipt.path}
						<div class="cell-secondary">{receipt.path}</div>
					{/if}
					{#if receipt.portal_path}
						<div class="cell-secondary">{receipt.portal_path}</div>
					{/if}
					{#if receipt.receipt?.completed_at}
						<div class="cell-secondary">
							{$LL.admin_approvals_completed_at({
								value: formatDateTime(receipt.receipt.completed_at)
							})}
						</div>
					{/if}
					{#if receipt.expires_at ?? receipt.receipt?.expires_at}
						<div class="cell-secondary">
							{$LL.admin_approvals_expires_at({
								value: formatDateTime(receipt.expires_at ?? receipt.receipt?.expires_at)
							})}
						</div>
					{/if}
				</div>
			</div>
		{/each}
	</div>
{/if}
