<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminLoggingControlAPI,
		type LoggingNotificationEvent,
		type NotificationCenterResponse,
		type NotificationDeliveryRoute,
		type NotificationCenterSummaryRow
	} from '$lib/api/admin-logging-control';
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

<div class="page-shell">
	<header class="page-header">
		<div>
			<p class="eyebrow">{$LL.admin_notifications_eyebrow()}</p>
			<h1>{$LL.admin_notifications_title()}</h1>
		</div>
		<div class="header-actions">
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
		</div>
	</header>

	<section class="filter-panel">
		<label>
			{$LL.admin_notifications_tenant_id()}
			<input bind:value={tenantId} placeholder={$LL.admin_notifications_platform_view()} />
		</label>
		<label>
			{$LL.admin_notifications_category()}
			<select bind:value={category}>
				{#each CATEGORY_OPTIONS as option (option.value)}
					<option value={option.value}>{option.getLabel()}</option>
				{/each}
			</select>
		</label>
		<label>
			{$LL.admin_notifications_status()}
			<select bind:value={status}>
				{#each STATUS_OPTIONS as option (option.value)}
					<option value={option.value}>{option.getLabel()}</option>
				{/each}
			</select>
		</label>
		<label>
			{$LL.admin_notifications_severity()}
			<select bind:value={severity}>
				{#each SEVERITY_OPTIONS as option (option.value)}
					<option value={option.value}>{option.getLabel()}</option>
				{/each}
			</select>
		</label>
		<label>
			{$LL.admin_notifications_limit()}
			<input type="number" min="1" max="200" bind:value={limit} />
		</label>
	</section>

	{#if error}
		<p class="alert-error">{error}</p>
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

	<section class="table-panel">
		<div class="table-wrap">
			<table>
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
									<button
										class="btn btn-secondary btn-small"
										type="button"
										onclick={() => deliverEvent(event)}
										disabled={deliveringId === event.id}
									>
										{deliveringId === event.id
											? $LL.admin_notifications_sending()
											: $LL.admin_notifications_deliver()}
									</button>
									<button
										class="btn btn-secondary btn-small"
										type="button"
										onclick={() => resolveEvent(event)}
										disabled={resolvingId === event.id ||
											!['pending', 'failed', 'dead_letter'].includes(event.status)}
									>
										{resolvingId === event.id
											? $LL.admin_notifications_resolving()
											: $LL.admin_notifications_resolve()}
									</button>
								</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>
	</section>
</div>

<style>
	.page-shell {
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	.page-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}

	.header-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.eyebrow {
		margin: 0 0 4px;
		color: var(--text-secondary);
		font-size: 12px;
		text-transform: uppercase;
	}

	h1 {
		margin: 0;
		font-size: 28px;
	}

	.filter-panel,
	.summary-strip,
	.table-panel {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-card);
	}

	.filter-panel {
		display: grid;
		grid-template-columns: repeat(5, minmax(140px, 1fr));
		gap: 12px;
		padding: 16px;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 6px;
		color: var(--text-secondary);
		font-size: 12px;
		font-weight: 600;
	}

	input,
	select {
		min-height: 36px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0 10px;
		background: var(--bg-input);
		color: var(--text-primary);
	}

	.summary-strip {
		display: grid;
		grid-template-columns: repeat(4, minmax(120px, 1fr));
		gap: 1px;
		overflow: hidden;
	}

	.summary-strip > div {
		padding: 14px 16px;
		background: var(--bg-subtle);
	}

	.metric-label {
		display: block;
		color: var(--text-secondary);
		font-size: 12px;
	}

	.summary-strip strong {
		display: block;
		margin-top: 4px;
		font-size: 24px;
	}

	.summary-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 10px;
	}

	.summary-cell {
		display: flex;
		gap: 12px;
		align-items: center;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		padding: 12px;
		background: var(--bg-card);
	}

	.summary-count {
		min-width: 42px;
		font-size: 22px;
		font-weight: 700;
	}

	.summary-meta {
		display: flex;
		flex-direction: column;
		gap: 3px;
		color: var(--text-secondary);
		font-size: 12px;
		word-break: break-word;
	}

	.table-wrap {
		overflow-x: auto;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		min-width: 960px;
	}

	th,
	td {
		padding: 12px;
		border-bottom: 1px solid var(--border);
		text-align: left;
		vertical-align: top;
	}

	th {
		color: var(--text-secondary);
		font-size: 12px;
		text-transform: uppercase;
	}

	.severity,
	.status {
		display: inline-flex;
		align-items: center;
		min-height: 22px;
		border-radius: 999px;
		padding: 2px 8px;
		font-size: 12px;
		font-weight: 600;
	}

	.severity-critical,
	.status-dead_letter {
		background: rgba(220, 38, 38, 0.12);
		color: #b91c1c;
	}

	.severity-high,
	.status-failed {
		background: rgba(234, 88, 12, 0.12);
		color: #c2410c;
	}

	.severity-medium,
	.status-pending {
		background: rgba(202, 138, 4, 0.14);
		color: #a16207;
	}

	.severity-low,
	.severity-info,
	.status-delivered,
	.status-suppressed {
		background: rgba(37, 99, 235, 0.1);
		color: #1d4ed8;
	}

	.event-title {
		font-weight: 600;
	}

	.event-sub,
	.event-error {
		margin-top: 4px;
		color: var(--text-secondary);
		font-size: 12px;
		word-break: break-word;
	}

	.event-error {
		color: #b91c1c;
	}

	.alert-error {
		border: 1px solid rgba(220, 38, 38, 0.25);
		border-radius: 8px;
		padding: 10px 12px;
		background: rgba(220, 38, 38, 0.08);
		color: #b91c1c;
	}

	.empty-cell {
		color: var(--text-secondary);
		text-align: center;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-height: 36px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0 12px;
		cursor: pointer;
		font: inherit;
		transition: background var(--transition-fast);
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-primary {
		background: var(--primary);
		color: white;
		border-color: var(--primary);
	}

	.btn-primary:hover:not(:disabled) {
		background: var(--primary-hover);
	}

	.btn-secondary {
		background: var(--bg-subtle);
		color: var(--text-primary);
	}

	.btn-secondary:hover:not(:disabled) {
		background: var(--border);
	}

	.btn-small {
		min-height: 30px;
		font-size: 12px;
	}

	.btn:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	@media (max-width: 1100px) {
		.filter-panel {
			grid-template-columns: repeat(2, minmax(160px, 1fr));
		}
	}

	@media (max-width: 720px) {
		.page-header {
			flex-direction: column;
		}

		.filter-panel,
		.summary-strip {
			grid-template-columns: 1fr;
		}
	}
</style>
