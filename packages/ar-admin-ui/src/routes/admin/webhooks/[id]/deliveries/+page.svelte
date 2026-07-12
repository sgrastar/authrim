<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import {
		adminWebhooksAPI,
		type Webhook,
		type WebhookDelivery,
		type DeliveryStatus
	} from '$lib/api/admin-webhooks';
	import { Modal } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
	import AdminDataTable from '$lib/components/admin/AdminDataTable.svelte';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';
	import AdminToolbar from '$lib/components/admin/AdminToolbar.svelte';

	let webhook: Webhook | null = $state(null);
	let deliveries: WebhookDelivery[] = $state([]);
	let loading = $state(true);
	let error = $state('');

	// Pagination state
	let cursor = $state<string | undefined>(undefined);
	let hasMore = $state(false);
	let loadingMore = $state(false);

	// Filter state
	let statusFilter = $state<DeliveryStatus | 'all'>('all');
	let dateFrom = $state('');
	let dateTo = $state('');

	// Detail dialog state
	let showDetailDialog = $state(false);
	let selectedDelivery: WebhookDelivery | null = $state(null);
	let detailViewMode = $state<'pretty' | 'raw'>('pretty');
	let detailLoading = $state(false);
	let detailError = $state('');

	// Replay state
	let replayingId = $state<string | null>(null);
	let replayError = $state('');

	async function loadWebhook() {
		const webhookId = $page.params.id;
		if (!webhookId) {
			error = $LL.admin_webhooks_deliveries_webhook_id_required();
			return;
		}

		try {
			webhook = await adminWebhooksAPI.get(webhookId);
		} catch {
			error = $LL.admin_webhooks_deliveries_load_webhook_failed();
		}
	}

	async function loadDeliveries(append = false) {
		const webhookId = $page.params.id;
		if (!webhookId) {
			error = $LL.admin_webhooks_deliveries_webhook_id_required();
			return;
		}

		if (append) {
			loadingMore = true;
		} else {
			loading = true;
			deliveries = [];
			cursor = undefined;
		}
		error = '';

		try {
			const response = await adminWebhooksAPI.listDeliveries(webhookId, {
				cursor: append ? cursor : undefined,
				limit: 20,
				status: statusFilter === 'all' ? undefined : statusFilter,
				from: dateFrom || undefined,
				to: dateTo || undefined
			});

			if (append) {
				deliveries = [...deliveries, ...response.deliveries];
			} else {
				deliveries = response.deliveries;
			}
			cursor = response.cursor;
			hasMore = !!response.cursor;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_webhooks_deliveries_load_failed();
		} finally {
			loading = false;
			loadingMore = false;
		}
	}

	onMount(async () => {
		await loadWebhook();
		await loadDeliveries();
	});

	function applyFilters() {
		loadDeliveries(false);
	}

	function loadMoreDeliveries() {
		if (hasMore && !loadingMore) {
			loadDeliveries(true);
		}
	}

	async function openDetailDialog(delivery: WebhookDelivery) {
		selectedDelivery = delivery;
		detailViewMode = 'pretty';
		showDetailDialog = true;
		detailLoading = true;
		detailError = '';

		const webhookId = $page.params.id;
		if (!webhookId) {
			detailLoading = false;
			detailError = $LL.admin_webhooks_deliveries_webhook_id_required();
			return;
		}

		try {
			selectedDelivery = await adminWebhooksAPI.getDelivery(webhookId, delivery.id);
		} catch (err) {
			detailError =
				err instanceof Error ? err.message : $LL.admin_webhooks_deliveries_detail_load_failed();
		} finally {
			detailLoading = false;
		}
	}

	function closeDetailDialog() {
		showDetailDialog = false;
		selectedDelivery = null;
		detailLoading = false;
		detailError = '';
	}

	async function handleReplay(delivery: WebhookDelivery) {
		const webhookId = $page.params.id;
		if (!webhookId) {
			replayError = $LL.admin_webhooks_deliveries_webhook_id_required();
			return;
		}

		if (replayingId) return;

		replayingId = delivery.id;
		replayError = '';

		try {
			await adminWebhooksAPI.replayDelivery(webhookId, delivery.id);
			// Reload deliveries to show updated status
			await loadDeliveries(false);
		} catch (err) {
			replayError =
				err instanceof Error ? err.message : $LL.admin_webhooks_deliveries_replay_failed();
		} finally {
			replayingId = null;
		}
	}

	function getStatusBadgeClass(status: DeliveryStatus): string {
		switch (status) {
			case 'success':
				return 'status-badge status-badge-success';
			case 'failed':
				return 'status-badge status-badge-failed';
			case 'retrying':
				return 'status-badge status-badge-retrying';
			case 'pending':
				return 'status-badge status-badge-pending';
			default:
				return 'status-badge badge-neutral';
		}
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
	}

	function formatDuration(delivery: WebhookDelivery): string {
		if (!delivery.completed_at) return '-';
		const duration = delivery.completed_at - delivery.created_at;
		if (duration < 1000) return `${duration}ms`;
		return `${(duration / 1000).toFixed(2)}s`;
	}

	// Security: Mask sensitive data in payloads
	function maskSensitiveData(content: string | undefined): string {
		if (!content) return '';

		let masked = content;

		// Mask Authorization header
		masked = masked.replace(/"Authorization"\s*:\s*"[^"]*"/gi, '"Authorization": "***MASKED***"');

		// Mask Cookie headers
		masked = masked.replace(/"Cookie"\s*:\s*"[^"]*"/gi, '"Cookie": "***MASKED***"');
		masked = masked.replace(/"Set-Cookie"\s*:\s*"[^"]*"/gi, '"Set-Cookie": "***MASKED***"');

		// Mask X-Auth* headers
		masked = masked.replace(/"X-Auth[^"]*"\s*:\s*"[^"]*"/gi, (match) => {
			const keyMatch = match.match(/"(X-Auth[^"]*)"/i);
			return keyMatch ? `"${keyMatch[1]}": "***MASKED***"` : match;
		});

		// Mask client_secret
		masked = masked.replace(/"client_secret"\s*:\s*"[^"]*"/gi, '"client_secret": "***MASKED***"');

		// Mask tokens (show first 4 chars only)
		masked = masked.replace(
			/"(id_token|access_token|refresh_token)"\s*:\s*"([^"]{4})[^"]*"/gi,
			'"$1": "$2***MASKED***"'
		);

		// Mask email addresses
		masked = masked.replace(/"email"\s*:\s*"([^@"]{1})[^@"]*@([^"]+)"/gi, '"email": "$1***@$2"');

		return masked;
	}

	function formatJson(content: string | undefined): string {
		if (!content) return '';
		const masked = maskSensitiveData(content);

		try {
			// Only pretty-print if content is under 5KB
			if (masked.length < 5000) {
				return JSON.stringify(JSON.parse(masked), null, 2);
			}
			return masked;
		} catch {
			return masked;
		}
	}

	function truncateContent(content: string | undefined, maxLength = 10000): string {
		if (!content) return '';
		if (content.length <= maxLength) return content;
		return content.slice(0, maxLength) + '\n\n' + $LL.admin_webhooks_truncated();
	}

	function canReplay(delivery: WebhookDelivery): boolean {
		return delivery.status === 'failed' || delivery.status === 'retrying';
	}

	function copyToClipboard(text: string) {
		// Copy masked version only
		navigator.clipboard.writeText(maskSensitiveData(text));
	}

	function deliveryStatusLabel(status: DeliveryStatus): string {
		switch (status) {
			case 'success':
				return $LL.admin_webhooks_status_success();
			case 'failed':
				return $LL.admin_webhooks_status_failed();
			case 'retrying':
				return $LL.admin_webhooks_status_retrying();
			case 'pending':
				return $LL.admin_webhooks_status_pending();
			default:
				return status;
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_webhooks_deliveries_title()}</title>
</svelte:head>

{#snippet headerActions()}
	<a href="/admin/webhooks" class="btn btn-secondary">
		<i class="i-ph-arrow-left" aria-hidden="true"></i>
		<span>{$LL.admin_webhooks_deliveries_back()}</span>
	</a>
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={webhook
			? $LL.admin_webhooks_deliveries_title_with_name({ name: webhook.name })
			: $LL.admin_webhooks_deliveries_title()}
		description={webhook ? $LL.admin_webhooks_deliveries_description() : undefined}
		actions={headerActions}
	/>

	{#if error}
		<div class="alert alert-error alert-inline">
			<span>{error}</span>
			<button class="btn btn-secondary btn-sm" onclick={() => loadDeliveries()}>
				{$LL.admin_webhooks_retry()}
			</button>
		</div>
	{/if}

	{#if replayError}
		<div class="alert alert-error alert-inline">
			<span>{replayError}</span>
			<button class="btn btn-secondary btn-sm" onclick={() => (replayError = '')}>
				{$LL.admin_webhooks_dismiss()}
			</button>
		</div>
	{/if}

	<!-- Filters -->
	<AdminSection>
		<AdminToolbar>
			<div class="admin-field admin-field--compact">
				<label for="status-filter" class="admin-field__label">
					{$LL.admin_webhooks_status()}
				</label>
				<select id="status-filter" class="admin-select" bind:value={statusFilter}>
					<option value="all">{$LL.admin_webhooks_all()}</option>
					<option value="success">{$LL.admin_webhooks_status_success()}</option>
					<option value="failed">{$LL.admin_webhooks_status_failed()}</option>
					<option value="retrying">{$LL.admin_webhooks_status_retrying()}</option>
					<option value="pending">{$LL.admin_webhooks_status_pending()}</option>
				</select>
			</div>
			<div class="admin-field admin-field--compact">
				<label for="date-from" class="admin-field__label">{$LL.admin_webhooks_from()}</label>
				<input type="date" id="date-from" class="admin-input" bind:value={dateFrom} />
			</div>
			<div class="admin-field admin-field--compact">
				<label for="date-to" class="admin-field__label">{$LL.admin_webhooks_to()}</label>
				<input type="date" id="date-to" class="admin-input" bind:value={dateTo} />
			</div>
			<button class="btn btn-secondary" onclick={applyFilters}
				>{$LL.admin_webhooks_apply_filters()}</button
			>
		</AdminToolbar>
	</AdminSection>

	<!-- Deliveries Table -->
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_webhooks_deliveries_loading()}</p>
		</div>
	{:else if deliveries.length === 0}
		<AdminSection>
			<div class="empty-state">
				<p class="empty-state-description">{$LL.admin_webhooks_deliveries_empty()}</p>
			</div>
		</AdminSection>
	{:else}
		<AdminSection title={$LL.admin_webhooks_deliveries_title()}>
			<AdminDataTable width="xwide">
				<thead>
					<tr>
						<th>{$LL.admin_webhooks_event()}</th>
						<th>{$LL.admin_webhooks_status()}</th>
						<th>{$LL.admin_webhooks_response()}</th>
						<th>{$LL.admin_webhooks_duration()}</th>
						<th>{$LL.admin_webhooks_attempts()}</th>
						<th>{$LL.admin_webhooks_date()}</th>
						<th>{$LL.admin_webhooks_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each deliveries as delivery (delivery.id)}
						<tr class="delivery-row" onclick={() => openDetailDialog(delivery)}>
							<td class="event-cell">
								<span class="event-type">{delivery.event_type}</span>
								<span class="event-id">{delivery.event_id.slice(0, 8)}</span>
							</td>
							<td>
								<span class={getStatusBadgeClass(delivery.status)}>
									{deliveryStatusLabel(delivery.status)}
								</span>
							</td>
							<td class="response-cell">
								{#if delivery.response_status}
									<span
										class="response-code"
										class:success={delivery.response_status >= 200 &&
											delivery.response_status < 300}
										class:error={delivery.response_status >= 400}
									>
										{delivery.response_status}
									</span>
								{:else if delivery.error_message}
									<span class="error-text" title={delivery.error_message}
										>{$LL.admin_webhooks_error()}</span
									>
								{:else}
									-
								{/if}
							</td>
							<td class="duration-cell">{formatDuration(delivery)}</td>
							<td class="attempts-cell">{delivery.attempt_count}</td>
							<td class="date-cell">{formatDate(delivery.created_at)}</td>
							<td class="actions-cell">
								<button
									class="btn btn-secondary btn-sm"
									onclick={(e) => {
										e.stopPropagation();
										openDetailDialog(delivery);
									}}
								>
									{$LL.admin_webhooks_view()}
								</button>
								{#if canReplay(delivery)}
									<button
										class="btn btn-primary btn-sm"
										onclick={(e) => {
											e.stopPropagation();
											handleReplay(delivery);
										}}
										disabled={replayingId === delivery.id}
									>
										{replayingId === delivery.id
											? $LL.admin_webhooks_replaying()
											: $LL.admin_webhooks_replay()}
									</button>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
		</AdminSection>

		{#if hasMore}
			<div class="load-more">
				<button class="btn btn-secondary" onclick={loadMoreDeliveries} disabled={loadingMore}>
					{loadingMore ? $LL.admin_webhooks_loading() : $LL.admin_webhooks_load_more()}
				</button>
			</div>
		{/if}
	{/if}
</AdminPageShell>

<!-- Detail Dialog -->
<Modal
	open={showDetailDialog && !!selectedDelivery}
	onClose={closeDetailDialog}
	title={$LL.admin_webhooks_delivery_details()}
	size="lg"
>
	{#if selectedDelivery}
		<div class="detail-content">
			<div class="detail-info">
				<div class="info-row">
					<span class="info-label">{$LL.admin_webhooks_event_type()}</span>
					<span class="info-value">{selectedDelivery.event_type}</span>
				</div>
				<div class="info-row">
					<span class="info-label">{$LL.admin_webhooks_event_id()}</span>
					<span class="info-value mono">{selectedDelivery.event_id}</span>
				</div>
				<div class="info-row">
					<span class="info-label">{$LL.admin_webhooks_status()}</span>
					<span class={getStatusBadgeClass(selectedDelivery.status)}>
						{deliveryStatusLabel(selectedDelivery.status)}
					</span>
				</div>
				<div class="info-row">
					<span class="info-label">{$LL.admin_webhooks_attempts()}</span>
					<span class="info-value">{selectedDelivery.attempt_count}</span>
				</div>
				<div class="info-row">
					<span class="info-label">{$LL.admin_webhooks_created()}</span>
					<span class="info-value">{formatDate(selectedDelivery.created_at)}</span>
				</div>
				{#if selectedDelivery.completed_at}
					<div class="info-row">
						<span class="info-label">{$LL.admin_webhooks_completed()}</span>
						<span class="info-value">{formatDate(selectedDelivery.completed_at)}</span>
					</div>
				{/if}
				{#if selectedDelivery.next_retry_at}
					<div class="info-row">
						<span class="info-label">{$LL.admin_webhooks_next_retry()}</span>
						<span class="info-value">{formatDate(selectedDelivery.next_retry_at)}</span>
					</div>
				{/if}
				{#if selectedDelivery.error_message}
					<div class="info-row">
						<span class="info-label">{$LL.admin_webhooks_error()}</span>
						<span class="info-value text-danger">{selectedDelivery.error_message}</span>
					</div>
				{/if}
			</div>

			<div class="view-mode-tabs">
				<button
					class="tab-btn"
					class:active={detailViewMode === 'pretty'}
					onclick={() => (detailViewMode = 'pretty')}
				>
					{$LL.admin_webhooks_pretty()}
				</button>
				<button
					class="tab-btn"
					class:active={detailViewMode === 'raw'}
					onclick={() => (detailViewMode = 'raw')}
				>
					{$LL.admin_webhooks_raw()}
				</button>
			</div>

			{#if detailLoading}
				<div class="loading-state">
					<i class="i-ph-circle-notch loading-spinner"></i>
					<p>{$LL.admin_webhooks_detail_loading()}</p>
				</div>
			{:else if detailError}
				<div class="error-banner">
					<span>{detailError}</span>
				</div>
			{/if}

			{#if selectedDelivery.request_headers && !detailLoading}
				<div class="payload-section">
					<div class="payload-header">
						<h3>{$LL.admin_webhooks_request_headers()}</h3>
						<button
							class="copy-btn"
							onclick={() =>
								copyToClipboard(JSON.stringify(selectedDelivery?.request_headers || {}, null, 2))}
							title={$LL.admin_webhooks_copy_masked_title()}
						>
							{$LL.admin_webhooks_copy()}
						</button>
					</div>
					<pre class="payload-content">{detailViewMode === 'pretty'
							? formatJson(JSON.stringify(selectedDelivery.request_headers))
							: truncateContent(
									maskSensitiveData(JSON.stringify(selectedDelivery.request_headers, null, 2))
								)}</pre>
				</div>
			{/if}

			{#if selectedDelivery.request_body && !detailLoading}
				<div class="payload-section">
					<div class="payload-header">
						<h3>{$LL.admin_webhooks_request_body()}</h3>
						<button
							class="copy-btn"
							onclick={() => copyToClipboard(selectedDelivery?.request_body || '')}
							title={$LL.admin_webhooks_copy_masked_title()}
						>
							{$LL.admin_webhooks_copy()}
						</button>
					</div>
					<pre class="payload-content">{detailViewMode === 'pretty'
							? formatJson(selectedDelivery.request_body)
							: truncateContent(maskSensitiveData(selectedDelivery.request_body))}</pre>
				</div>
			{/if}

			{#if selectedDelivery.response_body && !detailLoading}
				<div class="payload-section">
					<div class="payload-header">
						<h3>{$LL.admin_webhooks_response_body()}</h3>
						<button
							class="copy-btn"
							onclick={() => copyToClipboard(selectedDelivery?.response_body || '')}
							title={$LL.admin_webhooks_copy_masked_title()}
						>
							{$LL.admin_webhooks_copy()}
						</button>
					</div>
					<pre class="payload-content">{detailViewMode === 'pretty'
							? formatJson(selectedDelivery.response_body)
							: truncateContent(maskSensitiveData(selectedDelivery.response_body))}</pre>
				</div>
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		{#if selectedDelivery && canReplay(selectedDelivery)}
			<button
				class="btn btn-primary"
				onclick={() => selectedDelivery && handleReplay(selectedDelivery)}
				disabled={replayingId === selectedDelivery.id}
			>
				{replayingId === selectedDelivery.id
					? $LL.admin_webhooks_replaying()
					: $LL.admin_webhooks_replay_delivery()}
			</button>
		{/if}
		<button class="btn btn-secondary" onclick={closeDetailDialog}
			>{$LL.admin_webhooks_close()}</button
		>
	{/snippet}
</Modal>

<style>
	.alert-inline {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.delivery-row {
		cursor: pointer;
	}

	.event-cell {
		display: grid;
		gap: 4px;
	}

	.event-type {
		color: var(--color-text);
		font-weight: 650;
	}

	.event-id,
	.duration-cell,
	.attempts-cell,
	.date-cell {
		color: var(--color-text-muted);
		font-family: var(--font-mono);
		font-size: 0.82rem;
	}

	.response-code {
		font-family: var(--font-mono);
		font-weight: 700;
	}

	.response-code.success {
		color: var(--color-success);
	}

	.response-code.error,
	.error-text {
		color: var(--color-danger);
	}

	.actions-cell {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.load-more {
		display: flex;
		justify-content: center;
		margin-top: 18px;
	}

	.detail-info {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 12px;
	}

	.info-row {
		display: grid;
		gap: 5px;
		padding: 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface-raised);
	}

	.info-label {
		color: var(--color-text-subtle);
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--field-label-size, 0.68rem);
		font-weight: 700;
		letter-spacing: var(--field-label-letter-spacing, 0.16em);
		text-transform: uppercase;
	}

	.info-value {
		color: var(--color-text);
	}

	.view-mode-tabs {
		display: flex;
		gap: 8px;
		margin: 18px 0 12px;
	}

	.tab-btn {
		min-height: 34px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		padding: 0 12px;
		background: var(--color-surface);
		color: var(--color-text-muted);
		font: inherit;
		cursor: pointer;
	}

	.tab-btn.active {
		border-color: var(--color-accent);
		background: var(--color-accent-muted);
		color: var(--color-accent);
	}

	.payload-section {
		margin-top: 16px;
	}

	.payload-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 8px;
	}

	.payload-header h3 {
		margin: 0;
		color: var(--color-text);
		font-size: 0.95rem;
	}

	.copy-btn {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		padding: 6px 10px;
		background: var(--color-surface);
		color: var(--color-text-muted);
		font: inherit;
		cursor: pointer;
	}

	.payload-content {
		max-height: 360px;
		overflow: auto;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		padding: 12px;
		background: var(--color-surface-raised);
		color: var(--color-text);
		font-family: var(--font-mono);
		font-size: 0.82rem;
		line-height: 1.55;
	}

	@media (max-width: 720px) {
		.alert-inline {
			align-items: stretch;
			flex-direction: column;
		}
	}
</style>
