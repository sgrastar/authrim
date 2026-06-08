<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import {
		adminWebhooksAPI,
		type Webhook,
		type WebhookDelivery,
		type DeliveryStatus
	} from '$lib/api/admin-webhooks';
	import { Modal } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';

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

	function _navigateBack() {
		goto('/admin/webhooks');
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

<div class="deliveries-page admin-page">
	<div class="page-header">
		<div>
			<a href="/admin/webhooks" class="back-link">← {$LL.admin_webhooks_deliveries_back()}</a>
			{#if webhook}
				<h1 class="page-title">
					{$LL.admin_webhooks_deliveries_title_with_name({ name: webhook.name })}
				</h1>
				<p class="page-description">{$LL.admin_webhooks_deliveries_description()}</p>
			{:else}
				<h1 class="page-title">{$LL.admin_webhooks_deliveries_title()}</h1>
			{/if}
		</div>
	</div>

	{#if error}
		<div class="error-banner">
			<span>{error}</span>
			<button onclick={() => loadDeliveries()}>{$LL.admin_webhooks_retry()}</button>
		</div>
	{/if}

	{#if replayError}
		<div class="error-banner">
			<span>{replayError}</span>
			<button onclick={() => (replayError = '')}>{$LL.admin_webhooks_dismiss()}</button>
		</div>
	{/if}

	<!-- Filters -->
	<div class="filter-section">
		<div class="filter-row">
			<div class="filter-group">
				<label for="status-filter">{$LL.admin_webhooks_status()}</label>
				<select id="status-filter" bind:value={statusFilter}>
					<option value="all">{$LL.admin_webhooks_all()}</option>
					<option value="success">{$LL.admin_webhooks_status_success()}</option>
					<option value="failed">{$LL.admin_webhooks_status_failed()}</option>
					<option value="retrying">{$LL.admin_webhooks_status_retrying()}</option>
					<option value="pending">{$LL.admin_webhooks_status_pending()}</option>
				</select>
			</div>
			<div class="filter-group">
				<label for="date-from">{$LL.admin_webhooks_from()}</label>
				<input type="date" id="date-from" bind:value={dateFrom} />
			</div>
			<div class="filter-group">
				<label for="date-to">{$LL.admin_webhooks_to()}</label>
				<input type="date" id="date-to" bind:value={dateTo} />
			</div>
			<button class="btn btn-secondary" onclick={applyFilters}
				>{$LL.admin_webhooks_apply_filters()}</button
			>
		</div>
	</div>

	<!-- Deliveries Table -->
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_webhooks_deliveries_loading()}</p>
		</div>
	{:else if deliveries.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">{$LL.admin_webhooks_deliveries_empty()}</p>
			</div>
		</div>
	{:else}
		<div class="deliveries-table-container">
			<table class="deliveries-table">
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
									class="action-btn view-btn"
									onclick={(e) => {
										e.stopPropagation();
										openDetailDialog(delivery);
									}}
								>
									{$LL.admin_webhooks_view()}
								</button>
								{#if canReplay(delivery)}
									<button
										class="action-btn replay-btn"
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
			</table>
		</div>

		{#if hasMore}
			<div class="load-more">
				<button class="btn btn-secondary" onclick={loadMoreDeliveries} disabled={loadingMore}>
					{loadingMore ? $LL.admin_webhooks_loading() : $LL.admin_webhooks_load_more()}
				</button>
			</div>
		{/if}
	{/if}
</div>

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
