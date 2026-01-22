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

	// Replay state
	let replayingId = $state<string | null>(null);
	let replayError = $state('');

	async function loadWebhook() {
		const webhookId = $page.params.id;
		if (!webhookId) {
			error = 'Webhook ID is required';
			return;
		}

		try {
			webhook = await adminWebhooksAPI.get(webhookId);
		} catch (err) {
			console.error('Failed to load webhook:', err);
			error = 'Failed to load webhook details';
		}
	}

	async function loadDeliveries(append = false) {
		const webhookId = $page.params.id;
		if (!webhookId) {
			error = 'Webhook ID is required';
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
			console.error('Failed to load deliveries:', err);
			error = err instanceof Error ? err.message : 'Failed to load deliveries';
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

	function openDetailDialog(delivery: WebhookDelivery) {
		selectedDelivery = delivery;
		detailViewMode = 'pretty';
		showDetailDialog = true;
	}

	function closeDetailDialog() {
		showDetailDialog = false;
		selectedDelivery = null;
	}

	async function handleReplay(delivery: WebhookDelivery) {
		const webhookId = $page.params.id;
		if (!webhookId) {
			replayError = 'Webhook ID is required';
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
			replayError = err instanceof Error ? err.message : 'Failed to replay delivery';
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
		return new Date(timestamp).toLocaleString('en-US', {
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
		return content.slice(0, maxLength) + '\n\n... (truncated, click to expand)';
	}

	function canReplay(delivery: WebhookDelivery): boolean {
		return delivery.status === 'failed' || delivery.status === 'retrying';
	}

	function copyToClipboard(text: string) {
		// Copy masked version only
		navigator.clipboard.writeText(maskSensitiveData(text));
	}
</script>

<div class="deliveries-page admin-page">
	<div class="page-header">
		<div>
			<a href="/admin/webhooks" class="back-link">← Back to Webhooks</a>
			{#if webhook}
				<h1 class="page-title">Delivery History: {webhook.name}</h1>
				<p class="page-description">View and manage webhook delivery attempts.</p>
			{:else}
				<h1 class="page-title">Delivery History</h1>
			{/if}
		</div>
	</div>

	{#if error}
		<div class="error-banner">
			<span>{error}</span>
			<button onclick={() => loadDeliveries()}>Retry</button>
		</div>
	{/if}

	{#if replayError}
		<div class="error-banner">
			<span>{replayError}</span>
			<button onclick={() => (replayError = '')}>Dismiss</button>
		</div>
	{/if}

	<!-- Filters -->
	<div class="filter-section">
		<div class="filter-row">
			<div class="filter-group">
				<label for="status-filter">Status</label>
				<select id="status-filter" bind:value={statusFilter}>
					<option value="all">All</option>
					<option value="success">Success</option>
					<option value="failed">Failed</option>
					<option value="retrying">Retrying</option>
					<option value="pending">Pending</option>
				</select>
			</div>
			<div class="filter-group">
				<label for="date-from">From</label>
				<input type="date" id="date-from" bind:value={dateFrom} />
			</div>
			<div class="filter-group">
				<label for="date-to">To</label>
				<input type="date" id="date-to" bind:value={dateTo} />
			</div>
			<button class="btn btn-secondary" onclick={applyFilters}>Apply Filters</button>
		</div>
	</div>

	<!-- Deliveries Table -->
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading deliveries...</p>
		</div>
	{:else if deliveries.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">No deliveries found.</p>
			</div>
		</div>
	{:else}
		<div class="deliveries-table-container">
			<table class="deliveries-table">
				<thead>
					<tr>
						<th>Event</th>
						<th>Status</th>
						<th>Response</th>
						<th>Duration</th>
						<th>Attempts</th>
						<th>Date</th>
						<th>Actions</th>
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
									{delivery.status}
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
									<span class="error-text" title={delivery.error_message}>Error</span>
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
									View
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
										{replayingId === delivery.id ? 'Replaying...' : 'Replay'}
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
					{loadingMore ? 'Loading...' : 'Load More'}
				</button>
			</div>
		{/if}
	{/if}
</div>

<!-- Detail Dialog -->
{#if showDetailDialog && selectedDelivery}
	<div class="dialog-overlay" onclick={closeDetailDialog} role="presentation">
		<div
			class="dialog detail-dialog"
			onclick={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
			aria-labelledby="detail-dialog-title"
		>
			<div class="dialog-header">
				<h2 id="detail-dialog-title">Delivery Details</h2>
				<button class="close-btn" onclick={closeDetailDialog}>×</button>
			</div>

			<div class="detail-content">
				<div class="detail-info">
					<div class="info-row">
						<span class="info-label">Event Type</span>
						<span class="info-value">{selectedDelivery.event_type}</span>
					</div>
					<div class="info-row">
						<span class="info-label">Event ID</span>
						<span class="info-value mono">{selectedDelivery.event_id}</span>
					</div>
					<div class="info-row">
						<span class="info-label">Status</span>
						<span class={getStatusBadgeClass(selectedDelivery.status)}>
							{selectedDelivery.status}
						</span>
					</div>
					<div class="info-row">
						<span class="info-label">Attempts</span>
						<span class="info-value">{selectedDelivery.attempt_count}</span>
					</div>
					<div class="info-row">
						<span class="info-label">Created</span>
						<span class="info-value">{formatDate(selectedDelivery.created_at)}</span>
					</div>
					{#if selectedDelivery.completed_at}
						<div class="info-row">
							<span class="info-label">Completed</span>
							<span class="info-value">{formatDate(selectedDelivery.completed_at)}</span>
						</div>
					{/if}
					{#if selectedDelivery.next_retry_at}
						<div class="info-row">
							<span class="info-label">Next Retry</span>
							<span class="info-value">{formatDate(selectedDelivery.next_retry_at)}</span>
						</div>
					{/if}
					{#if selectedDelivery.error_message}
						<div class="info-row">
							<span class="info-label">Error</span>
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
						Pretty
					</button>
					<button
						class="tab-btn"
						class:active={detailViewMode === 'raw'}
						onclick={() => (detailViewMode = 'raw')}
					>
						Raw
					</button>
				</div>

				{#if selectedDelivery.request_body}
					<div class="payload-section">
						<div class="payload-header">
							<h3>Request Body</h3>
							<button
								class="copy-btn"
								onclick={() => copyToClipboard(selectedDelivery?.request_body || '')}
								title="Copy masked content"
							>
								Copy
							</button>
						</div>
						<pre class="payload-content">{detailViewMode === 'pretty'
								? formatJson(selectedDelivery.request_body)
								: truncateContent(maskSensitiveData(selectedDelivery.request_body))}</pre>
					</div>
				{/if}

				{#if selectedDelivery.response_body}
					<div class="payload-section">
						<div class="payload-header">
							<h3>Response Body</h3>
							<button
								class="copy-btn"
								onclick={() => copyToClipboard(selectedDelivery?.response_body || '')}
								title="Copy masked content"
							>
								Copy
							</button>
						</div>
						<pre class="payload-content">{detailViewMode === 'pretty'
								? formatJson(selectedDelivery.response_body)
								: truncateContent(maskSensitiveData(selectedDelivery.response_body))}</pre>
					</div>
				{/if}
			</div>

			<div class="dialog-actions">
				{#if canReplay(selectedDelivery)}
					<button
						class="btn btn-primary"
						onclick={() => selectedDelivery && handleReplay(selectedDelivery)}
						disabled={replayingId === selectedDelivery.id}
					>
						{replayingId === selectedDelivery.id ? 'Replaying...' : 'Replay Delivery'}
					</button>
				{/if}
				<button class="btn btn-secondary" onclick={closeDetailDialog}>Close</button>
			</div>
		</div>
	</div>
{/if}
