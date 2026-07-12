<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminLoggingControlAPI,
		type LoggingNotificationEvent,
		type NotificationCenterResponse,
		type NotificationDeliveryRoute,
		type NotificationCenterSummaryRow
	} from '$lib/api/admin-logging-control';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminToolbar
	} from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';

	const CATEGORY_OPTIONS = [
		{ value: '', getLabel: () => $LL.admin_notifications_all_categories() },
		{
			value: 'storage_registry_security',
			getLabel: () => $LL.admin_notifications_category_storage_registry_security()
		},
		{
			value: 'storage_registry_health',
			getLabel: () => $LL.admin_notifications_category_storage_registry_health()
		},
		{
			value: 'tenant_database_stats',
			getLabel: () => $LL.admin_notifications_category_tenant_database_stats()
		},
		{
			value: 'tenant_database_health',
			getLabel: () => $LL.admin_notifications_category_tenant_database_health()
		},
		{
			value: 'logging_destination_health',
			getLabel: () => $LL.admin_notifications_category_logging_destination_health()
		},
		{
			value: 'logging_delivery_failure',
			getLabel: () => $LL.admin_notifications_category_logging_delivery_failure()
		},
		{
			value: 'logging_fallback_used',
			getLabel: () => $LL.admin_notifications_category_logging_fallback_used()
		},
		{
			value: 'logging_dlq_backlog',
			getLabel: () => $LL.admin_notifications_category_logging_dlq_backlog()
		},
		{
			value: 'logging_quota_warning',
			getLabel: () => $LL.admin_notifications_category_logging_quota_warning()
		},
		{
			value: 'logging_repair_job_status',
			getLabel: () => $LL.admin_notifications_category_logging_repair_job_status()
		},
		{
			value: 'notification_delivery_failure',
			getLabel: () => $LL.admin_notifications_category_notification_delivery_failure()
		}
	];

	const STATUS_OPTIONS = [
		{ value: 'unresolved', getLabel: () => $LL.admin_notifications_unresolved() },
		{ value: 'all', getLabel: () => $LL.admin_notifications_all_statuses() },
		{ value: 'pending', getLabel: () => $LL.admin_notifications_pending() },
		{ value: 'failed', getLabel: () => $LL.admin_notifications_failed() },
		{ value: 'dead_letter', getLabel: () => $LL.admin_notifications_dead_letter() },
		{ value: 'suppressed', getLabel: () => $LL.admin_notifications_resolved() },
		{ value: 'delivered', getLabel: () => $LL.admin_notifications_delivered() }
	];

	const SEVERITY_OPTIONS = [
		{ value: '', getLabel: () => $LL.admin_notifications_all_severities() },
		{ value: 'critical', getLabel: () => $LL.admin_notifications_critical() },
		{ value: 'high', getLabel: () => $LL.admin_notifications_high() },
		{ value: 'medium', getLabel: () => $LL.admin_notifications_medium() },
		{ value: 'low', getLabel: () => $LL.admin_notifications_low() },
		{ value: 'info', getLabel: () => $LL.admin_notifications_info() }
	];

	let tenantId = $state('');
	let category = $state('');
	let status = $state('unresolved');
	let severity = $state('');
	let limit = $state(50);
	let loading = $state(false);
	let resolvingId = $state('');
	let deliveringId = $state('');
	let deliveryRunning = $state(false);
	let error = $state('');
	let response = $state<NotificationCenterResponse | null>(null);
	let deliveryRoutes = $state<NotificationDeliveryRoute[]>([]);

	const events = $derived(response?.items ?? []);
	const summary = $derived(response?.page?.summary ?? []);
	const unresolvedCount = $derived(
		summary
			.filter((row) => ['pending', 'failed', 'dead_letter'].includes(row.status))
			.reduce((sum, row) => sum + Number(row.count ?? 0), 0)
	);

	onMount(() => {
		void loadNotifications();
	});

	function formatDate(value: string | null): string {
		if (!value) {
			return '-';
		}
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
	}

	function parsePayload(event: LoggingNotificationEvent): Record<string, unknown> | null {
		try {
			const value = JSON.parse(event.payload_json);
			return value && typeof value === 'object' && !Array.isArray(value)
				? (value as Record<string, unknown>)
				: null;
		} catch {
			return null;
		}
	}

	function payloadPreview(event: LoggingNotificationEvent): string {
		const parsed = parsePayload(event);
		if (!parsed) {
			return event.payload_json.slice(0, 180);
		}
		const keys = Object.keys(parsed).filter((key) => key !== 'notification_routing_policy');
		return keys.slice(0, 5).join(', ') || '-';
	}

	function summaryKey(row: NotificationCenterSummaryRow): string {
		return `${row.category}:${row.severity}:${row.status}`;
	}

	async function loadNotifications() {
		loading = true;
		error = '';
		try {
			const [notificationResponse, routeResponse] = await Promise.all([
				adminLoggingControlAPI.listNotificationCenter({
					tenantId: tenantId || undefined,
					category: category || undefined,
					status,
					severity: severity || undefined,
					limit
				}),
				adminLoggingControlAPI.listNotificationDeliveryRoutes().catch(() => ({
					items: [],
					total: 0
				}))
			]);
			response = notificationResponse;
			deliveryRoutes = routeResponse.items;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_notifications_load_failed();
		} finally {
			loading = false;
		}
	}

	async function resolveEvent(event: LoggingNotificationEvent) {
		if (!['pending', 'failed', 'dead_letter'].includes(event.status)) {
			return;
		}
		resolvingId = event.id;
		error = '';
		try {
			await adminLoggingControlAPI.resolveNotificationCenterEvent(event.id);
			await loadNotifications();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_notifications_resolve_failed();
		} finally {
			resolvingId = '';
		}
	}

	async function deliverEvent(event: LoggingNotificationEvent) {
		deliveringId = event.id;
		error = '';
		try {
			await adminLoggingControlAPI.deliverNotificationCenterEvent(event.id);
			await loadNotifications();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_notifications_deliver_failed();
		} finally {
			deliveringId = '';
		}
	}

	async function runDelivery() {
		deliveryRunning = true;
		error = '';
		try {
			await adminLoggingControlAPI.runNotificationDelivery(limit);
			await loadNotifications();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_notifications_run_delivery_failed();
		} finally {
			deliveryRunning = false;
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_notifications_page_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		eyebrow={$LL.admin_notifications_eyebrow()}
		title={$LL.admin_notifications_title()}
	>
		{#snippet actions()}
			<button
				class="btn btn-secondary"
				type="button"
				onclick={runDelivery}
				disabled={deliveryRunning}
			>
				{deliveryRunning
					? $LL.admin_notifications_delivering()
					: $LL.admin_notifications_run_delivery()}
			</button>
			<button class="btn btn-primary" type="button" onclick={loadNotifications} disabled={loading}>
				<i class="i-ph-arrow-clockwise"></i>
				{loading ? $LL.admin_notifications_loading() : $LL.admin_notifications_refresh()}
			</button>
		{/snippet}
	</AdminPageHeader>

	<AdminToolbar>
		<label class="admin-field admin-field--compact">
			<span class="admin-field__label">{$LL.admin_notifications_tenant_id()}</span>
			<input
				class="admin-input"
				bind:value={tenantId}
				placeholder={$LL.admin_notifications_platform_view()}
			/>
		</label>
		<label class="admin-field admin-field--compact">
			<span class="admin-field__label">{$LL.admin_notifications_category()}</span>
			<select class="admin-select" bind:value={category}>
				{#each CATEGORY_OPTIONS as option (option.value)}
					<option value={option.value}>{option.getLabel()}</option>
				{/each}
			</select>
		</label>
		<label class="admin-field admin-field--compact">
			<span class="admin-field__label">{$LL.admin_notifications_status()}</span>
			<select class="admin-select" bind:value={status}>
				{#each STATUS_OPTIONS as option (option.value)}
					<option value={option.value}>{option.getLabel()}</option>
				{/each}
			</select>
		</label>
		<label class="admin-field admin-field--compact">
			<span class="admin-field__label">{$LL.admin_notifications_severity()}</span>
			<select class="admin-select" bind:value={severity}>
				{#each SEVERITY_OPTIONS as option (option.value)}
					<option value={option.value}>{option.getLabel()}</option>
				{/each}
			</select>
		</label>
		<label class="admin-field admin-field--compact">
			<span class="admin-field__label">{$LL.admin_notifications_limit()}</span>
			<input class="admin-input" type="number" min="1" max="200" bind:value={limit} />
		</label>
	</AdminToolbar>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	<section class="summary-strip">
		<div>
			<span class="metric-label">{$LL.admin_notifications_unresolved()}</span>
			<strong>{unresolvedCount}</strong>
		</div>
		<div>
			<span class="metric-label">{$LL.admin_notifications_visible()}</span>
			<strong>{events.length}</strong>
		</div>
		<div>
			<span class="metric-label">{$LL.admin_notifications_groups()}</span>
			<strong>{summary.length}</strong>
		</div>
		<div>
			<span class="metric-label">{$LL.admin_notifications_routes()}</span>
			<strong>{deliveryRoutes.length}</strong>
		</div>
	</section>

	{#if summary.length > 0}
		<section class="summary-grid" aria-label={$LL.admin_notifications_summary_aria()}>
			{#each summary as row (summaryKey(row))}
				<div class="summary-cell">
					<div class="summary-count">{row.count}</div>
					<div class="summary-meta">
						<span class={`severity severity-${row.severity}`}>{row.severity}</span>
						<span>{row.status}</span>
						<span>{row.category}</span>
					</div>
				</div>
			{/each}
		</section>
	{/if}

	<AdminDataTable width="xwide">
		<thead>
			<tr>
				<th>{$LL.admin_notifications_severity()}</th>
				<th>{$LL.admin_notifications_status()}</th>
				<th>{$LL.admin_notifications_category()}</th>
				<th>{$LL.admin_notifications_tenant()}</th>
				<th>{$LL.admin_notifications_event()}</th>
				<th>{$LL.admin_notifications_attempts()}</th>
				<th>{$LL.admin_notifications_updated()}</th>
				<th>{$LL.admin_notifications_action()}</th>
			</tr>
		</thead>
		<tbody>
			{#if events.length === 0}
				<tr>
					<td colspan="8" class="empty-cell">{$LL.admin_notifications_empty()}</td>
				</tr>
			{:else}
				{#each events as event (event.id)}
					<tr>
						<td>
							<span class={`severity severity-${event.severity}`}>{event.severity}</span>
						</td>
						<td><span class={`status status-${event.status}`}>{event.status}</span></td>
						<td>{event.category}</td>
						<td>{event.tenant_id}</td>
						<td>
							<div class="event-title">{event.event_type}</div>
							<div class="event-sub">{payloadPreview(event)}</div>
							{#if event.last_error}
								<div class="event-error">{event.last_error}</div>
							{/if}
						</td>
						<td>{event.attempts}</td>
						<td>{formatDate(event.updated_at)}</td>
						<td>
							<div class="notification-actions">
								<button
									class="btn btn-secondary btn-sm"
									type="button"
									onclick={() => deliverEvent(event)}
									disabled={deliveringId === event.id}
								>
									{deliveringId === event.id
										? $LL.admin_notifications_sending()
										: $LL.admin_notifications_deliver()}
								</button>
								<button
									class="btn btn-secondary btn-sm"
									type="button"
									onclick={() => resolveEvent(event)}
									disabled={resolvingId === event.id ||
										!['pending', 'failed', 'dead_letter'].includes(event.status)}
								>
									{resolvingId === event.id
										? $LL.admin_notifications_resolving()
										: $LL.admin_notifications_resolve()}
								</button>
							</div>
						</td>
					</tr>
				{/each}
			{/if}
		</tbody>
	</AdminDataTable>
</AdminPageShell>

<style>
	.summary-strip {
		display: grid;
		grid-template-columns: repeat(4, minmax(120px, 1fr));
		gap: 1px;
		margin-bottom: 18px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
		overflow: hidden;
		box-shadow: var(--card-shadow, var(--shadow-panel, none));
	}

	.summary-strip > div {
		padding: 14px 16px;
		background: var(--color-surface-muted);
	}

	.metric-label {
		display: block;
		color: var(--color-text-muted);
		font-family: var(--font-meta, var(--font-body));
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: var(--table-header-letter-spacing, 0.08em);
		text-transform: uppercase;
	}

	.summary-strip strong {
		display: block;
		margin-top: 4px;
		color: var(--color-text);
		font-size: 1.5rem;
		line-height: 1.15;
	}

	.summary-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 10px;
		margin-bottom: 18px;
	}

	.summary-cell {
		display: flex;
		gap: 12px;
		align-items: center;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		padding: 12px;
		background: var(--color-surface);
		box-shadow: var(--card-shadow, var(--shadow-panel, none));
	}

	.summary-count {
		min-width: 42px;
		color: var(--color-text);
		font-size: 1.35rem;
		font-weight: 700;
	}

	.summary-meta {
		display: flex;
		flex-direction: column;
		gap: 3px;
		color: var(--color-text-muted);
		font-size: 12px;
		word-break: break-word;
	}

	.severity,
	.status {
		display: inline-flex;
		align-items: center;
		min-height: 22px;
		border-radius: 999px;
		border: 1px solid transparent;
		padding: 2px 8px;
		font-size: 12px;
		font-weight: 600;
		white-space: nowrap;
	}

	.severity-critical,
	.status-dead_letter {
		border-color: color-mix(in srgb, var(--color-danger) 32%, var(--color-border));
		background: color-mix(in srgb, var(--color-danger) 12%, transparent);
		color: var(--color-danger);
	}

	.severity-high,
	.status-failed {
		border-color: color-mix(in srgb, var(--color-warning) 36%, var(--color-border));
		background: color-mix(in srgb, var(--color-warning) 12%, transparent);
		color: var(--color-warning);
	}

	.severity-medium,
	.status-pending {
		border-color: color-mix(in srgb, var(--color-warning) 30%, var(--color-border));
		background: color-mix(in srgb, var(--color-warning) 9%, transparent);
		color: var(--color-warning);
	}

	.severity-low,
	.severity-info,
	.status-delivered,
	.status-suppressed {
		border-color: color-mix(in srgb, var(--color-accent) 26%, var(--color-border));
		background: color-mix(in srgb, var(--color-accent) 9%, transparent);
		color: var(--color-accent);
	}

	.event-title {
		color: var(--color-text);
		font-weight: 600;
	}

	.event-sub,
	.event-error {
		margin-top: 4px;
		color: var(--color-text-muted);
		font-size: 12px;
		word-break: break-word;
	}

	.event-error {
		color: var(--color-danger);
	}

	.alert {
		margin-bottom: 18px;
		border-radius: var(--radius-control);
		padding: 10px 12px;
		font-size: 14px;
	}

	.alert-error {
		border: 1px solid color-mix(in srgb, var(--color-danger) 32%, var(--color-border));
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
		color: var(--color-danger);
	}

	.empty-cell {
		color: var(--color-text-muted);
		text-align: center;
	}

	.notification-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	@media (max-width: 720px) {
		.summary-strip {
			grid-template-columns: 1fr;
		}
	}
</style>
