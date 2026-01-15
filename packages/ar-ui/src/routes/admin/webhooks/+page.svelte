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

	function getStatusBadgeStyle(active: boolean): string {
		if (active) {
			return 'background-color: #d1fae5; color: #065f46;';
		}
		return 'background-color: #e5e7eb; color: #374151;';
	}

	function getScopeBadgeStyle(scope: string): string {
		if (scope === 'client') {
			return 'background-color: #fce7f3; color: #be185d;';
		}
		return 'background-color: #dbeafe; color: #1e40af;';
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

<div>
	<div
		style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;"
	>
		<h1 style="font-size: 24px; font-weight: bold; margin: 0; color: #1f2937;">Webhooks</h1>
		<button
			onclick={openCreateDialog}
			style="
				padding: 10px 20px;
				background-color: #3b82f6;
				color: white;
				border: none;
				border-radius: 6px;
				cursor: pointer;
				font-size: 14px;
			"
		>
			Add Webhook
		</button>
	</div>

	<p style="color: #6b7280; margin-bottom: 24px;">
		Configure webhooks to receive real-time notifications when events occur in your authentication
		system. Webhooks can be triggered for user events, session events, token events, and more.
	</p>

	{#if error}
		<div
			style="padding: 12px 16px; background-color: #fee2e2; color: #b91c1c; border-radius: 6px; margin-bottom: 16px;"
		>
			{error}
		</div>
	{/if}

	{#if loading}
		<div style="text-align: center; padding: 48px; color: #6b7280;">Loading...</div>
	{:else if webhooks.length === 0}
		<div
			style="text-align: center; padding: 48px; color: #6b7280; background: white; border-radius: 8px; border: 1px solid #e5e7eb;"
		>
			<p style="margin: 0 0 16px 0;">No webhooks configured.</p>
			<p style="margin: 0 0 24px 0; font-size: 14px;">
				Add a webhook to receive real-time event notifications.
			</p>
			<button
				onclick={openCreateDialog}
				style="
					padding: 10px 20px;
					background-color: #3b82f6;
					color: white;
					border: none;
					border-radius: 6px;
					cursor: pointer;
					font-size: 14px;
				"
			>
				Add Your First Webhook
			</button>
		</div>
	{:else}
		<div style="margin-bottom: 16px; color: #6b7280; font-size: 14px;">
			Showing {webhooks.length} of {total} webhooks
		</div>

		<div style="background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
			<table style="width: 100%; border-collapse: collapse;">
				<thead>
					<tr style="background-color: #f9fafb; border-bottom: 1px solid #e5e7eb;">
						<th
							style="text-align: left; padding: 12px 16px; font-weight: 600; font-size: 14px; color: #374151;"
						>
							Name
						</th>
						<th
							style="text-align: left; padding: 12px 16px; font-weight: 600; font-size: 14px; color: #374151;"
						>
							URL
						</th>
						<th
							style="text-align: left; padding: 12px 16px; font-weight: 600; font-size: 14px; color: #374151;"
						>
							Events
						</th>
						<th
							style="text-align: left; padding: 12px 16px; font-weight: 600; font-size: 14px; color: #374151;"
						>
							Scope
						</th>
						<th
							style="text-align: left; padding: 12px 16px; font-weight: 600; font-size: 14px; color: #374151;"
						>
							Status
						</th>
						<th
							style="text-align: right; padding: 12px 16px; font-weight: 600; font-size: 14px; color: #374151;"
						>
							Actions
						</th>
					</tr>
				</thead>
				<tbody>
					{#each webhooks as webhook (webhook.id)}
						<tr style="border-bottom: 1px solid #e5e7eb;">
							<td style="padding: 12px 16px; font-size: 14px; color: #374151;">
								<div style="font-weight: 500; color: #1f2937;">{webhook.name}</div>
								{#if webhook.has_secret}
									<div style="font-size: 11px; color: #22c55e; margin-top: 2px;">🔒 Signed</div>
								{/if}
							</td>
							<td style="padding: 12px 16px; font-size: 14px; color: #374151;">
								<code
									style="font-size: 12px; background: #f3f4f6; padding: 2px 6px; border-radius: 4px;"
								>
									{formatUrl(webhook.url)}
								</code>
							</td>
							<td style="padding: 12px 16px; font-size: 14px; color: #374151;">
								<div style="display: flex; flex-wrap: wrap; gap: 4px; max-width: 200px;">
									{#each webhook.events.slice(0, 3) as event (event)}
										<span
											style="
												font-size: 11px;
												background: #f3f4f6;
												color: #374151;
												padding: 2px 6px;
												border-radius: 4px;
											"
										>
											{event}
										</span>
									{/each}
									{#if webhook.events.length > 3}
										<span style="font-size: 11px; color: #6b7280;">
											+{webhook.events.length - 3} more
										</span>
									{/if}
								</div>
							</td>
							<td style="padding: 12px 16px; font-size: 14px; color: #374151;">
								<span
									style="
										display: inline-block;
										padding: 4px 8px;
										border-radius: 9999px;
										font-size: 12px;
										font-weight: 500;
										{getScopeBadgeStyle(webhook.scope)}
									"
								>
									{webhook.scope}
								</span>
							</td>
							<td style="padding: 12px 16px; font-size: 14px; color: #374151;">
								<span
									style="
										display: inline-block;
										padding: 4px 8px;
										border-radius: 9999px;
										font-size: 12px;
										font-weight: 500;
										{getStatusBadgeStyle(webhook.active)}
									"
								>
									{webhook.active ? 'Active' : 'Inactive'}
								</span>
							</td>
							<td style="padding: 12px 16px; text-align: right;">
								<div style="display: flex; justify-content: flex-end; gap: 8px;">
									<button
										onclick={(e) => navigateToDeliveries(webhook, e)}
										style="
											padding: 6px 12px;
											background-color: #fef3c7;
											color: #92400e;
											border: none;
											border-radius: 4px;
											cursor: pointer;
											font-size: 13px;
										"
									>
										History
									</button>
									<button
										onclick={(e) => openTestDialog(webhook, e)}
										style="
											padding: 6px 12px;
											background-color: #e0e7ff;
											color: #3730a3;
											border: none;
											border-radius: 4px;
											cursor: pointer;
											font-size: 13px;
										"
									>
										Test
									</button>
									<button
										onclick={(e) => toggleActive(webhook, e)}
										style="
											padding: 6px 12px;
											background-color: #f3f4f6;
											color: #374151;
											border: none;
											border-radius: 4px;
											cursor: pointer;
											font-size: 13px;
										"
									>
										{webhook.active ? 'Disable' : 'Enable'}
									</button>
									<button
										onclick={(e) => openDeleteDialog(webhook, e)}
										style="
											padding: 6px 12px;
											background-color: #fee2e2;
											color: #dc2626;
											border: none;
											border-radius: 4px;
											cursor: pointer;
											font-size: 13px;
										"
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
		style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 1000;"
		onclick={closeCreateDialog}
		onkeydown={(e) => e.key === 'Escape' && closeCreateDialog()}
		tabindex="-1"
		role="dialog"
	>
		<div
			style="background: white; border-radius: 8px; padding: 24px; max-width: 600px; width: 90%; max-height: 90vh; overflow-y: auto;"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<h2 style="font-size: 20px; font-weight: bold; margin: 0 0 16px 0; color: #1f2937;">
				Add Webhook
			</h2>

			{#if createError}
				<div
					style="padding: 12px 16px; background-color: #fee2e2; color: #b91c1c; border-radius: 6px; margin-bottom: 16px;"
				>
					{createError}
				</div>
			{/if}

			<div style="margin-bottom: 16px;">
				<label
					style="display: block; font-size: 14px; font-weight: 500; color: #374151; margin-bottom: 6px;"
				>
					Webhook Name
				</label>
				<input
					type="text"
					bind:value={newName}
					placeholder="e.g., Slack Notifications"
					style="
						width: 100%;
						padding: 10px 12px;
						border: 1px solid #d1d5db;
						border-radius: 6px;
						font-size: 14px;
						box-sizing: border-box;
					"
				/>
			</div>

			<div style="margin-bottom: 16px;">
				<label
					style="display: block; font-size: 14px; font-weight: 500; color: #374151; margin-bottom: 6px;"
				>
					Endpoint URL
				</label>
				<input
					type="url"
					bind:value={newUrl}
					placeholder="https://example.com/webhooks/authrim"
					style="
						width: 100%;
						padding: 10px 12px;
						border: 1px solid #d1d5db;
						border-radius: 6px;
						font-size: 14px;
						box-sizing: border-box;
					"
				/>
			</div>

			<div style="margin-bottom: 16px;">
				<label
					style="display: block; font-size: 14px; font-weight: 500; color: #374151; margin-bottom: 6px;"
				>
					Secret (optional, for HMAC signature)
				</label>
				<input
					type="password"
					bind:value={newSecret}
					placeholder="Enter a secret for webhook signing"
					style="
						width: 100%;
						padding: 10px 12px;
						border: 1px solid #d1d5db;
						border-radius: 6px;
						font-size: 14px;
						box-sizing: border-box;
					"
				/>
				<p style="font-size: 12px; color: #6b7280; margin: 4px 0 0 0;">
					If set, webhooks will include an HMAC-SHA256 signature in the X-Webhook-Signature header.
				</p>
			</div>

			<div style="margin-bottom: 16px;">
				<label
					style="display: block; font-size: 14px; font-weight: 500; color: #374151; margin-bottom: 6px;"
				>
					Events to Subscribe
				</label>
				<div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;">
					{#each COMMON_EVENT_PATTERNS as eventPattern (eventPattern.pattern)}
						<button
							type="button"
							onclick={() => toggleEvent(eventPattern.pattern)}
							style="
								padding: 6px 12px;
								border-radius: 6px;
								font-size: 13px;
								cursor: pointer;
								border: 1px solid {selectedEvents.includes(eventPattern.pattern) ? '#3b82f6' : '#d1d5db'};
								background-color: {selectedEvents.includes(eventPattern.pattern) ? '#dbeafe' : 'white'};
								color: {selectedEvents.includes(eventPattern.pattern) ? '#1e40af' : '#374151'};
							"
							title={eventPattern.description}
						>
							{eventPattern.pattern}
						</button>
					{/each}
				</div>

				<div style="display: flex; gap: 8px;">
					<input
						type="text"
						bind:value={customEvent}
						placeholder="Custom event pattern"
						style="
							flex: 1;
							padding: 8px 10px;
							border: 1px solid #d1d5db;
							border-radius: 6px;
							font-size: 14px;
						"
						onkeydown={(e) => e.key === 'Enter' && addCustomEvent()}
					/>
					<button
						type="button"
						onclick={addCustomEvent}
						style="
							padding: 8px 16px;
							background-color: #f3f4f6;
							color: #374151;
							border: none;
							border-radius: 6px;
							cursor: pointer;
							font-size: 14px;
						"
					>
						Add
					</button>
				</div>

				{#if selectedEvents.length > 0}
					<div style="margin-top: 12px; padding: 12px; background: #f9fafb; border-radius: 6px;">
						<div style="font-size: 12px; font-weight: 500; color: #6b7280; margin-bottom: 8px;">
							Selected Events ({selectedEvents.length}):
						</div>
						<div style="display: flex; flex-wrap: wrap; gap: 4px;">
							{#each selectedEvents as event (event)}
								<span
									style="
										display: inline-flex;
										align-items: center;
										gap: 4px;
										font-size: 12px;
										background: white;
										border: 1px solid #d1d5db;
										color: #374151;
										padding: 4px 8px;
										border-radius: 4px;
									"
								>
									{event}
									<button
										type="button"
										onclick={() => toggleEvent(event)}
										style="
											background: none;
											border: none;
											cursor: pointer;
											color: #9ca3af;
											font-size: 14px;
											padding: 0;
											line-height: 1;
										"
									>
										×
									</button>
								</span>
							{/each}
						</div>
					</div>
				{/if}
			</div>

			<div style="display: flex; justify-content: flex-end; gap: 12px;">
				<button
					onclick={closeCreateDialog}
					disabled={creating}
					style="
						padding: 10px 20px;
						background-color: #f3f4f6;
						color: #374151;
						border: none;
						border-radius: 6px;
						cursor: pointer;
						font-size: 14px;
					"
				>
					Cancel
				</button>
				<button
					onclick={confirmCreate}
					disabled={creating}
					style="
						padding: 10px 20px;
						background-color: #3b82f6;
						color: white;
						border: none;
						border-radius: 6px;
						cursor: pointer;
						font-size: 14px;
						opacity: {creating ? 0.7 : 1};
					"
				>
					{creating ? 'Creating...' : 'Create Webhook'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Test Dialog -->
{#if showTestDialog && webhookToTest}
	<div
		style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 1000;"
		onclick={closeTestDialog}
		onkeydown={(e) => e.key === 'Escape' && closeTestDialog()}
		tabindex="-1"
		role="dialog"
	>
		<div
			style="background: white; border-radius: 8px; padding: 24px; max-width: 500px; width: 90%;"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<h2 style="font-size: 20px; font-weight: bold; margin: 0 0 16px 0; color: #1f2937;">
				Test Webhook: {webhookToTest.name}
			</h2>

			{#if testError}
				<div
					style="padding: 12px 16px; background-color: #fee2e2; color: #b91c1c; border-radius: 6px; margin-bottom: 16px;"
				>
					{testError}
				</div>
			{/if}

			<p style="color: #6b7280; margin: 0 0 16px 0;">
				Send a test webhook event to verify the endpoint is reachable and responding correctly.
			</p>

			<div style="background: #f9fafb; padding: 12px; border-radius: 6px; margin-bottom: 16px;">
				<p style="margin: 0 0 8px 0; font-size: 14px; color: #374151;">
					<strong>URL:</strong>
					<code style="font-size: 12px;">{webhookToTest.url}</code>
				</p>
				<p style="margin: 0; font-size: 14px; color: #374151;">
					<strong>Event:</strong> webhook.test
				</p>
			</div>

			{#if testResult}
				<div
					style="
						padding: 16px;
						border-radius: 6px;
						margin-bottom: 16px;
						{testResult.success
						? 'background-color: #d1fae5; border: 1px solid #22c55e;'
						: 'background-color: #fee2e2; border: 1px solid #ef4444;'}
					"
				>
					<div
						style="font-weight: 600; margin-bottom: 8px; {testResult.success
							? 'color: #065f46;'
							: 'color: #b91c1c;'}"
					>
						{testResult.success ? '✓ Test Successful' : '✗ Test Failed'}
					</div>
					{#if testResult.status_code}
						<p style="margin: 0 0 4px 0; font-size: 14px; color: #374151;">
							<strong>Status:</strong>
							{testResult.status_code}
						</p>
					{/if}
					{#if testResult.response_time_ms}
						<p style="margin: 0 0 4px 0; font-size: 14px; color: #374151;">
							<strong>Response Time:</strong>
							{testResult.response_time_ms}ms
						</p>
					{/if}
					{#if testResult.error}
						<p style="margin: 0; font-size: 14px; color: #b91c1c;">
							<strong>Error:</strong>
							{testResult.error}
						</p>
					{/if}
				</div>
			{/if}

			<div style="display: flex; justify-content: flex-end; gap: 12px;">
				<button
					onclick={closeTestDialog}
					style="
						padding: 10px 20px;
						background-color: #f3f4f6;
						color: #374151;
						border: none;
						border-radius: 6px;
						cursor: pointer;
						font-size: 14px;
					"
				>
					Close
				</button>
				<button
					onclick={runTest}
					disabled={testing}
					style="
						padding: 10px 20px;
						background-color: #3b82f6;
						color: white;
						border: none;
						border-radius: 6px;
						cursor: pointer;
						font-size: 14px;
						opacity: {testing ? 0.7 : 1};
					"
				>
					{testing ? 'Sending...' : 'Send Test'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Delete Confirmation Dialog -->
{#if showDeleteDialog && webhookToDelete}
	<div
		style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 1000;"
		onclick={closeDeleteDialog}
		onkeydown={(e) => e.key === 'Escape' && closeDeleteDialog()}
		tabindex="-1"
		role="dialog"
	>
		<div
			style="background: white; border-radius: 8px; padding: 24px; max-width: 500px; width: 90%;"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<h2 style="font-size: 20px; font-weight: bold; margin: 0 0 16px 0; color: #1f2937;">
				Delete Webhook
			</h2>

			{#if deleteError}
				<div
					style="padding: 12px 16px; background-color: #fee2e2; color: #b91c1c; border-radius: 6px; margin-bottom: 16px;"
				>
					{deleteError}
				</div>
			{/if}

			<p style="color: #6b7280; margin: 0 0 16px 0;">
				Are you sure you want to delete this webhook? Event notifications will no longer be sent to
				this endpoint.
			</p>

			<div
				style="background-color: #f9fafb; padding: 12px; border-radius: 6px; margin-bottom: 24px;"
			>
				<p style="margin: 0 0 8px 0; font-size: 14px; color: #374151;">
					<strong>Name:</strong>
					{webhookToDelete.name}
				</p>
				<p style="margin: 0 0 8px 0; font-size: 14px; color: #374151;">
					<strong>URL:</strong>
					<code style="font-size: 12px;">{formatUrl(webhookToDelete.url)}</code>
				</p>
				<p style="margin: 0; font-size: 14px; color: #374151;">
					<strong>Events:</strong>
					{webhookToDelete.events.length} subscribed
				</p>
			</div>

			<div style="display: flex; justify-content: flex-end; gap: 12px;">
				<button
					onclick={closeDeleteDialog}
					disabled={deleting}
					style="
						padding: 10px 20px;
						background-color: #f3f4f6;
						color: #374151;
						border: none;
						border-radius: 6px;
						cursor: pointer;
						font-size: 14px;
					"
				>
					Cancel
				</button>
				<button
					onclick={confirmDelete}
					disabled={deleting}
					style="
						padding: 10px 20px;
						background-color: #dc2626;
						color: white;
						border: none;
						border-radius: 6px;
						cursor: pointer;
						font-size: 14px;
						opacity: {deleting ? 0.7 : 1};
					"
				>
					{deleting ? 'Deleting...' : 'Delete Webhook'}
				</button>
			</div>
		</div>
	</div>
{/if}
