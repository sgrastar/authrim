<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { LL } from '$i18n/i18n-svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import {
		adminAuditLogsAPI,
		type AuditLogEntry,
		type Pagination,
		type AuditLogListParams,
		AUDIT_ACTION_TYPES
	} from '$lib/api/admin-audit-logs';

	let entries: AuditLogEntry[] = $state([]);
	let pagination: Pagination | null = $state(null);
	let loading = $state(true);
	let error = $state('');

	// Filter state
	let userIdFilter = $state('');
	let actionFilter = $state('');
	let resourceTypeFilter = $state('');
	let resourceIdFilter = $state('');
	let startDate = $state('');
	let endDate = $state('');
	let currentPage = $state(1);
	const limit = 20;

	// Filter panel visibility
	let showFilters = $state(true);

	// Debounce timer for user ID search
	let searchTimeout: ReturnType<typeof setTimeout>;
	let loadedTenantId = $state('');

	async function loadAuditLogs() {
		loading = true;
		error = '';

		try {
			const params: AuditLogListParams = {
				page: currentPage,
				limit
			};

			if (userIdFilter.trim()) {
				params.user_id = userIdFilter.trim();
			}
			if (actionFilter) {
				params.action = actionFilter;
			}
			if (resourceTypeFilter.trim()) {
				params.resource_type = resourceTypeFilter.trim();
			}
			if (resourceIdFilter.trim()) {
				params.resource_id = resourceIdFilter.trim();
			}
			if (startDate) {
				params.start_date = new Date(startDate).toISOString();
			}
			if (endDate) {
				// Set end date to end of day using timestamp calculation to avoid mutating Date
				const endDateParsed = Date.parse(endDate);
				// Add 23:59:59.999 worth of milliseconds (86399999 ms)
				params.end_date = new Date(endDateParsed + 86399999).toISOString();
			}

			const response = await adminAuditLogsAPI.list(params);
			entries = response.entries;
			pagination = response.pagination;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_audit_logs_load_failed();
		} finally {
			loading = false;
		}
	}

	onMount(async () => {
		await settingsContext.initialize();
	});

	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (!tenantId || tenantId === loadedTenantId) return;
		loadedTenantId = tenantId;
		currentPage = 1;
		loadAuditLogs();
	});

	function handleUserIdSearch() {
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(() => {
			currentPage = 1;
			loadAuditLogs();
		}, 300);
	}

	function handleFilterChange() {
		currentPage = 1;
		loadAuditLogs();
	}

	function clearFilters() {
		userIdFilter = '';
		actionFilter = '';
		resourceTypeFilter = '';
		resourceIdFilter = '';
		startDate = '';
		endDate = '';
		currentPage = 1;
		loadAuditLogs();
	}

	function goToPage(page: number) {
		currentPage = page;
		loadAuditLogs();
	}

	function formatDateTime(isoString: string): string {
		return new Date(isoString).toLocaleString();
	}

	function formatAction(action: string): string {
		switch (action) {
			case 'user.login':
				return $LL.admin_audit_logs_action_user_login();
			case 'user.logout':
				return $LL.admin_audit_logs_action_user_logout();
			case 'user.created':
				return $LL.admin_audit_logs_action_user_created();
			case 'user.updated':
				return $LL.admin_audit_logs_action_user_updated();
			case 'user.deleted':
				return $LL.admin_audit_logs_action_user_deleted();
			case 'user.suspend':
				return $LL.admin_audit_logs_action_user_suspend();
			case 'user.lock':
				return $LL.admin_audit_logs_action_user_lock();
			case 'user.activate':
				return $LL.admin_audit_logs_action_user_activate();
			case 'user.anonymized':
				return $LL.admin_audit_logs_action_user_anonymized();
			case 'client.created':
				return $LL.admin_audit_logs_action_client_created();
			case 'client.updated':
				return $LL.admin_audit_logs_action_client_updated();
			case 'client.deleted':
				return $LL.admin_audit_logs_action_client_deleted();
			case 'client.config.updated':
				return $LL.admin_audit_logs_action_client_config_updated();
			case 'client.config.deleted':
				return $LL.admin_audit_logs_action_client_config_deleted();
			case 'client.secret_regenerate':
				return $LL.admin_audit_logs_action_client_secret_regenerate();
			case 'session.created':
				return $LL.admin_audit_logs_action_session_created();
			case 'session.revoked':
				return $LL.admin_audit_logs_action_session_revoked();
			case 'scim.token.create':
				return $LL.admin_audit_logs_action_scim_token_create();
			case 'scim.token.revoke':
				return $LL.admin_audit_logs_action_scim_token_revoke();
			case 'ai_grant.create':
				return $LL.admin_audit_logs_action_ai_grant_create();
			case 'ai_grant.update':
				return $LL.admin_audit_logs_action_ai_grant_update();
			case 'ai_grant.revoke':
				return $LL.admin_audit_logs_action_ai_grant_revoke();
			case 'webhook.created':
				return $LL.admin_audit_logs_action_webhook_created();
			case 'webhook.updated':
				return $LL.admin_audit_logs_action_webhook_updated();
			case 'webhook.test':
				return $LL.admin_audit_logs_action_webhook_test();
			case 'webhook.test_failed':
				return $LL.admin_audit_logs_action_webhook_test_failed();
			case 'webhook.replay':
				return $LL.admin_audit_logs_action_webhook_replay();
			case 'webhook.replay_failed':
				return $LL.admin_audit_logs_action_webhook_replay_failed();
			case 'role.created':
				return $LL.admin_audit_logs_action_role_created();
			case 'access_review.created':
				return $LL.admin_audit_logs_action_access_review_created();
			case 'signing_keys.status.read':
				return $LL.admin_audit_logs_action_signing_keys_status_read();
			case 'signing_keys.rotate.normal':
				return $LL.admin_audit_logs_action_signing_keys_rotate_normal();
			case 'signing_keys.rotate.emergency':
				return $LL.admin_audit_logs_action_signing_keys_rotate_emergency();
			case 'security_alert.acknowledge':
				return $LL.admin_audit_logs_action_security_alert_acknowledge();
			case 'security.ip_reputation_check':
				return $LL.admin_audit_logs_action_security_ip_reputation_check();
			case 'tenant.cloned':
				return $LL.admin_audit_logs_action_tenant_cloned();
			case 'job.created':
				return $LL.admin_audit_logs_action_job_created();
			case 'email.queued':
				return $LL.admin_audit_logs_action_email_queued();
		}
		// Convert action.name format to readable format
		return action
			.split('.')
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(' ');
	}

	function getActionBadgeClass(action: string): string {
		// Critical/Danger actions (red)
		if (
			action.includes('delete') ||
			action.includes('revoke') ||
			action.includes('emergency') ||
			action.includes('failed') ||
			action.includes('anonymize')
		) {
			return 'badge badge-danger';
		}
		// Success/Create/Login actions (green)
		if (action.includes('create') || action.includes('queued') || action.includes('login')) {
			return 'badge badge-success';
		}
		// Logout actions (light cyan/teal)
		if (action.includes('logout')) {
			return 'badge badge-info';
		}
		// Update/Change actions (blue)
		if (
			action.includes('update') ||
			action.includes('rotate') ||
			action.includes('regenerate') ||
			action.includes('replay') ||
			action.includes('cloned')
		) {
			return 'badge badge-info';
		}
		// Warning actions (amber)
		if (
			action.includes('suspend') ||
			action.includes('lock') ||
			action.includes('alert') ||
			action.includes('acknowledge')
		) {
			return 'badge badge-warning';
		}
		// Info/Read actions (purple)
		if (action.includes('read') || action.includes('check') || action.includes('test')) {
			return 'badge badge-neutral';
		}
		// Default (gray)
		return 'badge badge-neutral';
	}

	function truncateId(id: string | null, length: number = 8): string {
		if (!id) return '-';
		if (id.length <= length) return id;
		return id.substring(0, length) + '...';
	}
</script>

<svelte:head>
	<title>{$LL.admin_audit_logs_head_title()}</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">{$LL.admin_audit_logs_title()}</h1>
			<p class="page-description">{$LL.admin_audit_logs_description()}</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-secondary" onclick={() => (showFilters = !showFilters)}>
				<i class={showFilters ? 'i-ph-funnel-simple-x' : 'i-ph-funnel-simple'}></i>
				{showFilters ? $LL.admin_audit_logs_hide_filters() : $LL.admin_audit_logs_show_filters()}
			</button>
		</div>
	</div>

	<!-- Filters -->
	{#if showFilters}
		<div class="panel">
			<div class="filter-row">
				<div class="form-group">
					<label for="user_id" class="form-label">{$LL.admin_audit_logs_actor_user_id()}</label>
					<input
						id="user_id"
						type="text"
						class="form-input"
						placeholder={$LL.admin_audit_logs_user_id_placeholder()}
						bind:value={userIdFilter}
						oninput={handleUserIdSearch}
					/>
				</div>

				<div class="form-group">
					<label for="action" class="form-label">{$LL.admin_audit_logs_action()}</label>
					<select
						id="action"
						class="form-select"
						bind:value={actionFilter}
						onchange={handleFilterChange}
					>
						<option value="">{$LL.admin_audit_logs_all_actions()}</option>
						{#each AUDIT_ACTION_TYPES as actionType (actionType.value)}
							<option value={actionType.value}>{formatAction(actionType.value)}</option>
						{/each}
					</select>
				</div>
			</div>

			<div class="filter-row">
				<div class="form-group">
					<label for="start_date" class="form-label">{$LL.admin_audit_logs_start_date()}</label>
					<input
						id="start_date"
						type="date"
						class="form-input"
						bind:value={startDate}
						onchange={handleFilterChange}
					/>
				</div>

				<div class="form-group">
					<label for="end_date" class="form-label">{$LL.admin_audit_logs_end_date()}</label>
					<input
						id="end_date"
						type="date"
						class="form-input"
						bind:value={endDate}
						onchange={handleFilterChange}
					/>
				</div>

				<div class="form-group form-group-action">
					<button class="btn btn-secondary" onclick={clearFilters}>
						<i class="i-ph-x"></i>
						{$LL.admin_audit_logs_clear_filters()}
					</button>
				</div>
			</div>

			<div class="filter-row">
				<div class="form-group">
					<label for="resource_type" class="form-label"
						>{$LL.admin_audit_logs_resource_type()}</label
					>
					<input
						id="resource_type"
						type="text"
						class="form-input"
						placeholder={$LL.admin_audit_logs_resource_type_placeholder()}
						bind:value={resourceTypeFilter}
						oninput={handleUserIdSearch}
					/>
				</div>

				<div class="form-group">
					<label for="resource_id" class="form-label">{$LL.admin_audit_logs_resource_id()}</label>
					<input
						id="resource_id"
						type="text"
						class="form-input"
						placeholder={$LL.admin_audit_logs_resource_id_placeholder()}
						bind:value={resourceIdFilter}
						oninput={handleUserIdSearch}
					/>
				</div>
			</div>

			<p class="filter-hint">
				{$LL.admin_audit_logs_filter_hint()}
			</p>
		</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_audit_logs_loading()}</p>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if entries.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">{$LL.admin_audit_logs_empty()}</p>
			</div>
		</div>
	{:else}
		<!-- Audit Logs Table -->
		<div class="data-table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>{$LL.admin_audit_logs_date_time()}</th>
						<th>{$LL.admin_audit_logs_action()}</th>
						<th>{$LL.admin_audit_logs_actor()}</th>
						<th>{$LL.admin_audit_logs_resource()}</th>
						<th>{$LL.admin_audit_logs_ip_address()}</th>
					</tr>
				</thead>
				<tbody>
					{#each entries as entry (entry.id)}
						<tr
							onclick={() => goto(`/admin/audit-logs/${entry.id}`)}
							onkeydown={(e) => e.key === 'Enter' && goto(`/admin/audit-logs/${entry.id}`)}
							tabindex="0"
							role="button"
						>
							<td class="muted nowrap">{formatDateTime(entry.createdAt)}</td>
							<td>
								<span class={getActionBadgeClass(entry.action)}>
									{formatAction(entry.action)}
								</span>
							</td>
							<td class="mono">{truncateId(entry.userId)}</td>
							<td class="muted">
								{#if entry.resourceType}
									<span class="cell-primary">{entry.resourceType}</span>
									{#if entry.resourceId}
										<span class="mono cell-secondary">({truncateId(entry.resourceId)})</span>
									{/if}
								{:else}
									-
								{/if}
							</td>
							<td class="muted">{entry.ipAddress || '-'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<!-- Pagination -->
		{#if pagination && pagination.totalPages > 1}
			<div class="pagination">
				<p class="pagination-info">
					{$LL.admin_audit_logs_pagination({
						from: (pagination.page - 1) * pagination.limit + 1,
						to: Math.min(pagination.page * pagination.limit, pagination.total),
						total: pagination.total
					})}
				</p>
				<div class="pagination-buttons">
					<button
						class="btn btn-secondary btn-sm"
						onclick={() => goToPage(currentPage - 1)}
						disabled={currentPage <= 1}
					>
						{$LL.admin_audit_logs_previous()}
					</button>
					<button
						class="btn btn-secondary btn-sm"
						onclick={() => goToPage(currentPage + 1)}
						disabled={currentPage >= pagination.totalPages}
					>
						{$LL.admin_audit_logs_next()}
					</button>
				</div>
			</div>
		{/if}
	{/if}
</div>
