<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		adminWebhooksAPI,
		type Webhook,
		type WebhookTestResult,
		COMMON_EVENT_PATTERNS
	} from '$lib/api/admin-webhooks';
	import { Modal } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
	import AdminDataTable from '$lib/components/admin/AdminDataTable.svelte';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';

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
		} catch {
			error = $LL.admin_webhooks_load_failed();
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
			createError = $LL.admin_webhooks_create_required();
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
			createError = err instanceof Error ? err.message : $LL.admin_webhooks_create_failed();
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
			deleteError = err instanceof Error ? err.message : $LL.admin_webhooks_delete_failed();
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
			testError = err instanceof Error ? err.message : $LL.admin_webhooks_test_failed();
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
			error = err instanceof Error ? err.message : $LL.admin_webhooks_update_failed();
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

	function eventPatternDescription(pattern: string, fallback: string): string {
		switch (pattern) {
			case 'user.*':
				return $LL.admin_webhooks_event_all_user();
			case 'user.created':
				return $LL.admin_webhooks_event_user_created();
			case 'user.updated':
				return $LL.admin_webhooks_event_user_updated();
			case 'user.deleted':
				return $LL.admin_webhooks_event_user_deleted();
			case 'session.*':
				return $LL.admin_webhooks_event_all_session();
			case 'session.created':
				return $LL.admin_webhooks_event_session_created();
			case 'session.revoked':
				return $LL.admin_webhooks_event_session_revoked();
			case 'token.*':
				return $LL.admin_webhooks_event_all_token();
			case 'token.issued':
				return $LL.admin_webhooks_event_token_issued();
			case 'token.revoked':
				return $LL.admin_webhooks_event_token_revoked();
			case 'client.*':
				return $LL.admin_webhooks_event_all_client();
			case 'consent.*':
				return $LL.admin_webhooks_event_all_consent();
			case 'webhook.test':
				return $LL.admin_webhooks_event_test();
			default:
				return fallback;
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_webhooks_head_title()}</title>
</svelte:head>

{#snippet pageActions()}
	<button class="btn btn-primary" onclick={openCreateDialog}>
		<i class="i-ph-plus" aria-hidden="true"></i>
		{$LL.admin_webhooks_add()}
	</button>
{/snippet}

{#snippet resultActions()}
	<p class="result-count">
		{$LL.admin_webhooks_result_count({ shown: webhooks.length, total })}
	</p>
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_webhooks_title()}
		description={$LL.admin_webhooks_description()}
		actions={pageActions}
	/>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_webhooks_loading()}</p>
		</div>
	{:else if webhooks.length === 0}
		<AdminSection>
			<div class="empty-state">
				<p class="empty-state-description">{$LL.admin_webhooks_empty()}</p>
				<p class="empty-state-hint">{$LL.admin_webhooks_empty_hint()}</p>
				<button class="btn btn-primary" onclick={openCreateDialog}
					>{$LL.admin_webhooks_add_first()}</button
				>
			</div>
		</AdminSection>
	{:else}
		<AdminSection title={$LL.admin_webhooks_title()} actions={resultActions}>
			<AdminDataTable>
				<thead>
					<tr>
						<th>{$LL.admin_webhooks_name()}</th>
						<th>{$LL.admin_webhooks_url()}</th>
						<th>{$LL.admin_webhooks_events()}</th>
						<th>{$LL.admin_webhooks_scope()}</th>
						<th>{$LL.admin_webhooks_status()}</th>
						<th class="text-right">{$LL.admin_webhooks_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each webhooks as webhook (webhook.id)}
						<tr>
							<td>
								<div class="cell-primary">{webhook.name}</div>
								{#if webhook.has_secret}
									<div class="cell-secondary success">
										<i class="i-ph-lock-key" aria-hidden="true"></i>
										{$LL.admin_webhooks_signed()}
									</div>
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
										<span class="muted"
											>{$LL.admin_webhooks_more_events({
												count: webhook.events.length - 3
											})}</span
										>
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
									{webhook.active ? $LL.admin_webhooks_active() : $LL.admin_webhooks_inactive()}
								</span>
							</td>
							<td class="text-right">
								<div class="action-buttons">
									<button
										class="btn btn-warning btn-sm"
										onclick={(e) => navigateToDeliveries(webhook, e)}
									>
										{$LL.admin_webhooks_history()}
									</button>
									<button class="btn btn-info btn-sm" onclick={(e) => openTestDialog(webhook, e)}>
										{$LL.admin_webhooks_test()}
									</button>
									<button
										class="btn btn-secondary btn-sm"
										onclick={(e) => toggleActive(webhook, e)}
									>
										{webhook.active ? $LL.admin_webhooks_disable() : $LL.admin_webhooks_enable()}
									</button>
									<button
										class="btn btn-danger btn-sm"
										onclick={(e) => openDeleteDialog(webhook, e)}
									>
										{$LL.admin_webhooks_delete()}
									</button>
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
		</AdminSection>
	{/if}
</AdminPageShell>

<!-- Create Dialog -->
<Modal
	open={showCreateDialog}
	onClose={closeCreateDialog}
	title={$LL.admin_webhooks_create_title()}
	size="lg"
>
	{#if createError}
		<div class="alert alert-error">{createError}</div>
	{/if}

	<div class="admin-field dialog-field">
		<label for="webhook-name" class="admin-field__label">{$LL.admin_webhooks_name_label()}</label>
		<input
			id="webhook-name"
			type="text"
			class="admin-input"
			bind:value={newName}
			placeholder={$LL.admin_webhooks_name_placeholder()}
		/>
	</div>

	<div class="admin-field dialog-field">
		<label for="webhook-url" class="admin-field__label">{$LL.admin_webhooks_endpoint_url()}</label>
		<input
			id="webhook-url"
			type="url"
			class="admin-input"
			bind:value={newUrl}
			placeholder={$LL.admin_webhooks_endpoint_placeholder()}
		/>
	</div>

	<div class="admin-field dialog-field">
		<label for="webhook-secret" class="admin-field__label"
			>{$LL.admin_webhooks_secret_label()}</label
		>
		<input
			id="webhook-secret"
			type="password"
			class="admin-input"
			bind:value={newSecret}
			placeholder={$LL.admin_webhooks_secret_placeholder()}
		/>
		<p class="form-hint">
			{$LL.admin_webhooks_secret_hint()}
		</p>
	</div>

	<div class="admin-field dialog-field">
		<!-- svelte-ignore a11y_label_has_associated_control -->
		<label class="admin-field__label">{$LL.admin_webhooks_events_to_subscribe()}</label>
		<div class="event-selector">
			{#each COMMON_EVENT_PATTERNS as eventPattern (eventPattern.pattern)}
				<button
					type="button"
					class="event-btn"
					class:selected={selectedEvents.includes(eventPattern.pattern)}
					onclick={() => toggleEvent(eventPattern.pattern)}
					title={eventPatternDescription(eventPattern.pattern, eventPattern.description)}
				>
					{eventPattern.pattern}
				</button>
			{/each}
		</div>

		<div class="custom-event-row">
			<input
				type="text"
				class="admin-input"
				bind:value={customEvent}
				placeholder={$LL.admin_webhooks_custom_event_placeholder()}
				onkeydown={(e) => e.key === 'Enter' && addCustomEvent()}
			/>
			<button type="button" class="btn btn-secondary" onclick={addCustomEvent}
				>{$LL.admin_webhooks_add_event()}</button
			>
		</div>

		{#if selectedEvents.length > 0}
			<div class="selected-events">
				<div class="selected-events-label">
					{$LL.admin_webhooks_selected_events({ count: selectedEvents.length })}
				</div>
				<div class="tag-list">
					{#each selectedEvents as event (event)}
						<span class="tag removable">
							{event}
							<button type="button" class="tag-remove" onclick={() => toggleEvent(event)}>×</button>
						</span>
					{/each}
				</div>
			</div>
		{/if}
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeCreateDialog} disabled={creating}
			>{$LL.admin_webhooks_cancel()}</button
		>
		<button class="btn btn-primary" onclick={confirmCreate} disabled={creating}>
			{creating ? $LL.admin_webhooks_creating() : $LL.admin_webhooks_create_button()}
		</button>
	{/snippet}
</Modal>

<!-- Test Dialog -->
<Modal
	open={showTestDialog && !!webhookToTest}
	onClose={closeTestDialog}
	title={$LL.admin_webhooks_test_title({ name: webhookToTest?.name ?? '' })}
	size="md"
>
	{#if testError}
		<div class="alert alert-error">{testError}</div>
	{/if}

	<p class="modal-description">
		{$LL.admin_webhooks_test_description()}
	</p>

	<div class="info-box">
		<div class="info-row">
			<span class="info-label">{$LL.admin_webhooks_url()}:</span>
			<code class="info-value">{webhookToTest?.url}</code>
		</div>
		<div class="info-row">
			<span class="info-label">{$LL.admin_webhooks_event()}:</span>
			<span class="info-value">webhook.test</span>
		</div>
	</div>

	{#if testResult}
		<div class={testResult.success ? 'alert alert-success' : 'alert alert-error'}>
			<div class="alert-title">
				{testResult.success
					? '✓ ' + $LL.admin_webhooks_test_success()
					: '✗ ' + $LL.admin_webhooks_test_failed_result()}
			</div>
			{#if testResult.status_code}
				<p class="alert-detail">
					<strong>{$LL.admin_webhooks_response_status()}</strong>
					{testResult.status_code}
				</p>
			{/if}
			{#if testResult.response_time_ms}
				<p class="alert-detail">
					<strong>{$LL.admin_webhooks_response_time()}</strong>
					{testResult.response_time_ms}ms
				</p>
			{/if}
			{#if testResult.error}
				<p class="alert-detail">
					<strong>{$LL.admin_webhooks_error_label()}</strong>
					{testResult.error}
				</p>
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeTestDialog}>{$LL.admin_webhooks_close()}</button
		>
		<button class="btn btn-primary" onclick={runTest} disabled={testing}>
			{testing ? $LL.admin_webhooks_sending() : $LL.admin_webhooks_send_test()}
		</button>
	{/snippet}
</Modal>

<!-- Delete Confirmation Dialog -->
<Modal
	open={showDeleteDialog && !!webhookToDelete}
	onClose={closeDeleteDialog}
	title={$LL.admin_webhooks_delete_title()}
	size="md"
>
	{#if deleteError}
		<div class="alert alert-error">{deleteError}</div>
	{/if}

	<p class="modal-description">
		{$LL.admin_webhooks_delete_confirm()}
	</p>

	<div class="info-box">
		<div class="info-row">
			<span class="info-label">{$LL.admin_webhooks_name()}:</span>
			<span class="info-value">{webhookToDelete?.name}</span>
		</div>
		<div class="info-row">
			<span class="info-label">{$LL.admin_webhooks_url()}:</span>
			<code class="info-value">{formatUrl(webhookToDelete?.url ?? '')}</code>
		</div>
		<div class="info-row">
			<span class="info-label">{$LL.admin_webhooks_events()}:</span>
			<span class="info-value"
				>{$LL.admin_webhooks_events_subscribed({
					count: webhookToDelete?.events.length ?? 0
				})}</span
			>
		</div>
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeDeleteDialog} disabled={deleting}
			>{$LL.admin_webhooks_cancel()}</button
		>
		<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
			{deleting ? $LL.admin_webhooks_deleting() : $LL.admin_webhooks_delete_button()}
		</button>
	{/snippet}
</Modal>

<style>
	.result-count {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.85rem;
	}

	.cell-secondary.success {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin-top: 4px;
	}

	.dialog-field {
		display: grid;
		gap: 6px;
		margin-bottom: 16px;
	}

	.dialog-field :global(.admin-field__label) {
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--field-label-size, 0.68rem);
		font-weight: 700;
		letter-spacing: var(--field-label-letter-spacing, 0.16em);
		text-transform: uppercase;
		color: var(--color-text-subtle);
	}

	.dialog-field :global(.admin-input) {
		width: 100%;
		min-height: var(--control-height, 38px);
		padding: var(--control-padding, 8px 12px);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
		outline: none;
	}

	.dialog-field :global(.admin-input:focus) {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.custom-event-row {
		display: flex;
		gap: 10px;
		margin-top: 12px;
	}

	@media (max-width: 640px) {
		.custom-event-row {
			flex-direction: column;
		}
	}
</style>
