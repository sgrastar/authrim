<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		adminWebhooksAPI,
		type Webhook,
		type WebhookTestResult,
		COMMON_EVENT_PATTERNS
	} from '$lib/api/admin-webhooks';

	let webhooks: Webhook[] = $state([]);
	let loading = $state(true);
	let error = $state('');
	let total = $state(0);

	// Create dialog state
	let showCreateDialog = $state(false);
	let creating = $state(false);
	let createError = $state('');
	let newName = $state('');
	let newUrl = $state('');
	let newSecret = $state('');
	let selectedEvents = $state<string[]>(['user.*']);
	let customEvent = $state('');

	// Delete confirmation dialog state
	let showDeleteDialog = $state(false);
	let webhookToDelete: Webhook | null = $state(null);
	let deleting = $state(false);
	let deleteError = $state('');

	// Test dialog state
	let showTestDialog = $state(false);
	let webhookToTest: Webhook | null = $state(null);
	let testing = $state(false);
	let testError = $state('');
	let testResult: WebhookTestResult | null = $state(null);

	async function loadWebhooks() {
		loading = true;
		error = '';

		try {
			const response = await adminWebhooksAPI.list({ limit: 50 });
			webhooks = response.webhooks;
			total = response.total;
		} catch (err) {
			console.error('Failed to load webhooks:', err);
			error = 'Failed to load webhooks';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadWebhooks();
	});

	function openCreateDialog() {
		newName = '';
		newUrl = '';
		newSecret = '';
		selectedEvents = ['user.*'];
		customEvent = '';
		createError = '';
		showCreateDialog = true;
	}

	function closeCreateDialog() {
		showCreateDialog = false;
		createError = '';
	}

	function toggleEvent(pattern: string) {
		if (selectedEvents.includes(pattern)) {
			selectedEvents = selectedEvents.filter((e) => e !== pattern);
		} else {
			selectedEvents = [...selectedEvents, pattern];
		}
	}

	function addCustomEvent() {
		if (customEvent.trim() && !selectedEvents.includes(customEvent.trim())) {
			selectedEvents = [...selectedEvents, customEvent.trim()];
			customEvent = '';
		}
	}

	async function confirmCreate() {
		if (!newName.trim() || !newUrl.trim() || selectedEvents.length === 0) {
			createError = 'Name, URL, and at least one event are required';
			return;
		}

		creating = true;
		createError = '';

		try {
			await adminWebhooksAPI.create({
				name: newName.trim(),
				url: newUrl.trim(),
				secret: newSecret.trim() || undefined,
				events: selectedEvents
			});
			showCreateDialog = false;
			await loadWebhooks();
		} catch (err) {
			createError = err instanceof Error ? err.message : 'Failed to create webhook';
		} finally {
			creating = false;
		}
	}

	function openDeleteDialog(webhook: Webhook, event: Event) {
		event.stopPropagation();
		webhookToDelete = webhook;
		deleteError = '';
		showDeleteDialog = true;
	}

	function closeDeleteDialog() {
		showDeleteDialog = false;
		webhookToDelete = null;
		deleteError = '';
	}

	async function confirmDelete() {
		if (!webhookToDelete) return;

		deleting = true;
		deleteError = '';

		try {
			await adminWebhooksAPI.delete(webhookToDelete.id);
			showDeleteDialog = false;
			webhookToDelete = null;
			await loadWebhooks();
		} catch (err) {
			deleteError = err instanceof Error ? err.message : 'Failed to delete webhook';
		} finally {
			deleting = false;
		}
	}

	function openTestDialog(webhook: Webhook, event: Event) {
		event.stopPropagation();
		webhookToTest = webhook;
		testError = '';
		testResult = null;
		showTestDialog = true;
	}

	function closeTestDialog() {
		showTestDialog = false;
		webhookToTest = null;
		testError = '';
		testResult = null;
	}

	async function runTest() {
		if (!webhookToTest) return;

		testing = true;
		testError = '';
		testResult = null;

		try {
			const result = await adminWebhooksAPI.test(webhookToTest.id);
			testResult = result;
		} catch (err) {
			testError = err instanceof Error ? err.message : 'Failed to test webhook';
		} finally {
			testing = false;
		}
	}

	async function toggleActive(webhook: Webhook, event: Event) {
		event.stopPropagation();
		try {
			await adminWebhooksAPI.update(webhook.id, {
				active: !webhook.active
			});
			await loadWebhooks();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to update webhook';
		}
	}

	function formatUrl(url: string): string {
		try {
			const parsed = new URL(url);
			return parsed.hostname + parsed.pathname;
		} catch {
			return url;
		}
	}

	function navigateToDeliveries(webhook: Webhook, event: Event) {
		event.stopPropagation();
		goto(`/admin/webhooks/${webhook.id}/deliveries`);
	}
</script>

<svelte:head>
	<title>Webhooks - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">Webhooks</h1>
			<p class="page-description">
				Configure webhooks to receive real-time notifications when events occur in your
				authentication system.
			</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-primary" onclick={openCreateDialog}>
				<i class="i-ph-plus"></i>
				Add Webhook
			</button>
		</div>
	</div>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading...</p>
		</div>
	{:else if webhooks.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">No webhooks configured.</p>
				<p class="empty-state-hint">Add a webhook to receive real-time event notifications.</p>
				<button class="btn btn-primary" onclick={openCreateDialog}>Add Your First Webhook</button>
			</div>
		</div>
	{:else}
		<p class="result-count">Showing {webhooks.length} of {total} webhooks</p>

		<div class="data-table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>Name</th>
						<th>URL</th>
						<th>Events</th>
						<th>Scope</th>
						<th>Status</th>
						<th class="text-right">Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each webhooks as webhook (webhook.id)}
						<tr>
							<td>
								<div class="cell-primary">{webhook.name}</div>
								{#if webhook.has_secret}
									<div class="cell-secondary success">🔒 Signed</div>
								{/if}
							</td>
							<td>
								<code class="code-inline">{formatUrl(webhook.url)}</code>
							</td>
							<td>
								<div class="tag-list">
									{#each webhook.events.slice(0, 3) as event (event)}
										<span class="tag">{event}</span>
									{/each}
									{#if webhook.events.length > 3}
										<span class="muted">+{webhook.events.length - 3} more</span>
									{/if}
								</div>
							</td>
							<td>
								<span
									class={webhook.scope === 'client' ? 'badge badge-warning' : 'badge badge-info'}
								>
									{webhook.scope}
								</span>
							</td>
							<td>
								<span class={webhook.active ? 'badge badge-success' : 'badge badge-neutral'}>
									{webhook.active ? 'Active' : 'Inactive'}
								</span>
							</td>
							<td class="text-right">
								<div class="action-buttons">
									<button
										class="btn btn-warning btn-sm"
										onclick={(e) => navigateToDeliveries(webhook, e)}
									>
										History
									</button>
									<button class="btn btn-info btn-sm" onclick={(e) => openTestDialog(webhook, e)}>
										Test
									</button>
									<button
										class="btn btn-secondary btn-sm"
										onclick={(e) => toggleActive(webhook, e)}
									>
										{webhook.active ? 'Disable' : 'Enable'}
									</button>
									<button
										class="btn btn-danger btn-sm"
										onclick={(e) => openDeleteDialog(webhook, e)}
									>
										Delete
									</button>
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<!-- Create Dialog -->
{#if showCreateDialog}
	<div
		class="modal-overlay"
		onclick={closeCreateDialog}
		onkeydown={(e) => e.key === 'Escape' && closeCreateDialog()}
		tabindex="-1"
		role="dialog"
		aria-modal="true"
	>
		<div
			class="modal-content modal-lg"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<h2 class="modal-title">Add Webhook</h2>
			</div>

			<div class="modal-body">
				{#if createError}
					<div class="alert alert-error">{createError}</div>
				{/if}

				<div class="form-group">
					<label for="webhook-name" class="form-label">Webhook Name</label>
					<input
						id="webhook-name"
						type="text"
						class="form-input"
						bind:value={newName}
						placeholder="e.g., Slack Notifications"
					/>
				</div>

				<div class="form-group">
					<label for="webhook-url" class="form-label">Endpoint URL</label>
					<input
						id="webhook-url"
						type="url"
						class="form-input"
						bind:value={newUrl}
						placeholder="https://example.com/webhooks/authrim"
					/>
				</div>

				<div class="form-group">
					<label for="webhook-secret" class="form-label"
						>Secret (optional, for HMAC signature)</label
					>
					<input
						id="webhook-secret"
						type="password"
						class="form-input"
						bind:value={newSecret}
						placeholder="Enter a secret for webhook signing"
					/>
					<p class="form-hint">
						If set, webhooks will include an HMAC-SHA256 signature in the X-Webhook-Signature
						header.
					</p>
				</div>

				<div class="form-group">
					<label class="form-label">Events to Subscribe</label>
					<div class="event-selector">
						{#each COMMON_EVENT_PATTERNS as eventPattern (eventPattern.pattern)}
							<button
								type="button"
								class="event-btn"
								class:selected={selectedEvents.includes(eventPattern.pattern)}
								onclick={() => toggleEvent(eventPattern.pattern)}
								title={eventPattern.description}
							>
								{eventPattern.pattern}
							</button>
						{/each}
					</div>

					<div class="custom-event-row">
						<input
							type="text"
							class="form-input"
							bind:value={customEvent}
							placeholder="Custom event pattern"
							onkeydown={(e) => e.key === 'Enter' && addCustomEvent()}
						/>
						<button type="button" class="btn btn-secondary" onclick={addCustomEvent}>Add</button>
					</div>

					{#if selectedEvents.length > 0}
						<div class="selected-events">
							<div class="selected-events-label">Selected Events ({selectedEvents.length}):</div>
							<div class="tag-list">
								{#each selectedEvents as event (event)}
									<span class="tag removable">
										{event}
										<button type="button" class="tag-remove" onclick={() => toggleEvent(event)}
											>×</button
										>
									</span>
								{/each}
							</div>
						</div>
					{/if}
				</div>
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={closeCreateDialog} disabled={creating}
					>Cancel</button
				>
				<button class="btn btn-primary" onclick={confirmCreate} disabled={creating}>
					{creating ? 'Creating...' : 'Create Webhook'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Test Dialog -->
{#if showTestDialog && webhookToTest}
	<div
		class="modal-overlay"
		onclick={closeTestDialog}
		onkeydown={(e) => e.key === 'Escape' && closeTestDialog()}
		tabindex="-1"
		role="dialog"
		aria-modal="true"
	>
		<div
			class="modal-content"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<h2 class="modal-title">Test Webhook: {webhookToTest.name}</h2>
			</div>

			<div class="modal-body">
				{#if testError}
					<div class="alert alert-error">{testError}</div>
				{/if}

				<p class="modal-description">
					Send a test webhook event to verify the endpoint is reachable and responding correctly.
				</p>

				<div class="info-box">
					<div class="info-row">
						<span class="info-label">URL:</span>
						<code class="info-value">{webhookToTest.url}</code>
					</div>
					<div class="info-row">
						<span class="info-label">Event:</span>
						<span class="info-value">webhook.test</span>
					</div>
				</div>

				{#if testResult}
					<div class={testResult.success ? 'alert alert-success' : 'alert alert-error'}>
						<div class="alert-title">
							{testResult.success ? '✓ Test Successful' : '✗ Test Failed'}
						</div>
						{#if testResult.status_code}
							<p class="alert-detail"><strong>Status:</strong> {testResult.status_code}</p>
						{/if}
						{#if testResult.response_time_ms}
							<p class="alert-detail">
								<strong>Response Time:</strong>
								{testResult.response_time_ms}ms
							</p>
						{/if}
						{#if testResult.error}
							<p class="alert-detail"><strong>Error:</strong> {testResult.error}</p>
						{/if}
					</div>
				{/if}
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={closeTestDialog}>Close</button>
				<button class="btn btn-primary" onclick={runTest} disabled={testing}>
					{testing ? 'Sending...' : 'Send Test'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Delete Confirmation Dialog -->
{#if showDeleteDialog && webhookToDelete}
	<div
		class="modal-overlay"
		onclick={closeDeleteDialog}
		onkeydown={(e) => e.key === 'Escape' && closeDeleteDialog()}
		tabindex="-1"
		role="dialog"
		aria-modal="true"
	>
		<div
			class="modal-content"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<h2 class="modal-title">Delete Webhook</h2>
			</div>

			<div class="modal-body">
				{#if deleteError}
					<div class="alert alert-error">{deleteError}</div>
				{/if}

				<p class="modal-description">
					Are you sure you want to delete this webhook? Event notifications will no longer be sent
					to this endpoint.
				</p>

				<div class="info-box">
					<div class="info-row">
						<span class="info-label">Name:</span>
						<span class="info-value">{webhookToDelete.name}</span>
					</div>
					<div class="info-row">
						<span class="info-label">URL:</span>
						<code class="info-value">{formatUrl(webhookToDelete.url)}</code>
					</div>
					<div class="info-row">
						<span class="info-label">Events:</span>
						<span class="info-value">{webhookToDelete.events.length} subscribed</span>
					</div>
				</div>
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={closeDeleteDialog} disabled={deleting}
					>Cancel</button
				>
				<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
					{deleting ? 'Deleting...' : 'Delete Webhook'}
				</button>
			</div>
		</div>
	</div>
{/if}
