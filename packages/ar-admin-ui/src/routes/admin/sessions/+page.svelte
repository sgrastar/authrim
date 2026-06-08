<script lang="ts">
	import { onMount } from 'svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import {
		adminSessionsAPI,
		type Session,
		type Pagination,
		type SessionListParams
	} from '$lib/api/admin-sessions';
	import { Modal } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';

	let sessions: Session[] = $state([]);
	let pagination: Pagination | null = $state(null);
	let loading = $state(true);
	let error = $state('');

	// Filter state
	let userIdFilter = $state('');
	let statusFilter = $state<'active' | 'expired' | ''>('active'); // Default to active sessions
	let currentPage = $state(1);
	const limit = 20;

	// Revoke confirmation dialog state
	let showRevokeDialog = $state(false);
	let sessionToRevoke: Session | null = $state(null);
	let revoking = $state(false);
	let revokeError = $state('');

	// Debounce timer for user ID search
	let searchTimeout: ReturnType<typeof setTimeout>;
	let loadedTenantId = $state('');

	async function loadSessions() {
		loading = true;
		error = '';

		try {
			const params: SessionListParams = {
				page: currentPage,
				limit
			};

			if (userIdFilter.trim()) {
				params.user_id = userIdFilter.trim();
			}
			if (statusFilter) {
				params.status = statusFilter;
			}

			const response = await adminSessionsAPI.list(params);
			sessions = response.sessions;
			pagination = response.pagination;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_sessions_load_failed();
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
		loadSessions();
	});

	function handleUserIdSearch() {
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(() => {
			currentPage = 1;
			loadSessions();
		}, 300);
	}

	function handleStatusChange() {
		currentPage = 1;
		loadSessions();
	}

	function goToPage(page: number) {
		currentPage = page;
		loadSessions();
	}

	function formatDateTime(isoString: string): string {
		return new Date(isoString).toLocaleString();
	}

	function getRelativeTime(isoString: string): string {
		const date = new Date(isoString);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 1) return $LL.admin_sessions_just_now();
		if (diffMins < 60) return $LL.admin_sessions_minutes_ago({ count: diffMins });
		if (diffHours < 24) return $LL.admin_sessions_hours_ago({ count: diffHours });
		return $LL.admin_sessions_days_ago({
			count: diffDays
		});
	}

	function getTimeUntil(isoString: string): string {
		const date = new Date(isoString);
		const now = new Date();
		const diffMs = date.getTime() - now.getTime();

		if (diffMs <= 0) return $LL.admin_sessions_expired();

		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 60) return $LL.admin_sessions_minutes({ count: diffMins });
		if (diffHours < 24) return $LL.admin_sessions_hours({ count: diffHours });
		return $LL.admin_sessions_days({
			count: diffDays
		});
	}

	function parseUserAgent(userAgent: string | null): string {
		if (!userAgent) return '-';

		let browser: string = $LL.admin_sessions_unknown();
		let os: string = $LL.admin_sessions_unknown();

		if (userAgent.includes('Chrome')) browser = 'Chrome';
		else if (userAgent.includes('Firefox')) browser = 'Firefox';
		else if (userAgent.includes('Safari')) browser = 'Safari';
		else if (userAgent.includes('Edge')) browser = 'Edge';

		if (userAgent.includes('Windows')) os = 'Windows';
		else if (userAgent.includes('Mac OS')) os = 'macOS';
		else if (userAgent.includes('Linux')) os = 'Linux';
		else if (userAgent.includes('Android')) os = 'Android';
		else if (userAgent.includes('iOS') || userAgent.includes('iPhone')) os = 'iOS';

		return `${browser} / ${os}`;
	}

	function openRevokeDialog(session: Session) {
		sessionToRevoke = session;
		revokeError = '';
		showRevokeDialog = true;
	}

	function closeRevokeDialog() {
		showRevokeDialog = false;
		sessionToRevoke = null;
		revokeError = '';
	}

	async function confirmRevoke() {
		if (!sessionToRevoke) return;

		revoking = true;
		revokeError = '';

		try {
			await adminSessionsAPI.revoke(sessionToRevoke.id);
			closeRevokeDialog();
			// Reload sessions after successful revoke
			await loadSessions();
		} catch (err) {
			revokeError = err instanceof Error ? err.message : $LL.admin_sessions_revoke_failed();
		} finally {
			revoking = false;
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_sessions_head_title()}</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">{$LL.admin_sessions_title()}</h1>
			<p class="page-description">{$LL.admin_sessions_description()}</p>
		</div>
	</div>

	<!-- Filters -->
	<div class="panel">
		<div class="filter-row">
			<div class="form-group">
				<label for="user_id" class="form-label">{$LL.admin_sessions_user_id()}</label>
				<input
					id="user_id"
					type="text"
					class="form-input"
					placeholder={$LL.admin_sessions_user_id_placeholder()}
					bind:value={userIdFilter}
					oninput={handleUserIdSearch}
				/>
			</div>

			<div class="form-group">
				<label for="status" class="form-label">{$LL.admin_sessions_status()}</label>
				<select
					id="status"
					class="form-select"
					bind:value={statusFilter}
					onchange={handleStatusChange}
				>
					<option value="">{$LL.admin_sessions_status_all()}</option>
					<option value="active">{$LL.admin_sessions_status_active_only()}</option>
					<option value="expired">{$LL.admin_sessions_status_expired_only()}</option>
				</select>
			</div>
		</div>
	</div>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_sessions_loading()}</p>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if sessions.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">{$LL.admin_sessions_empty()}</p>
			</div>
		</div>
	{:else}
		<!-- Sessions Table -->
		<div class="data-table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>{$LL.admin_sessions_user()}</th>
						<th>{$LL.admin_sessions_device()}</th>
						<th>{$LL.admin_sessions_ip_address()}</th>
						<th>{$LL.admin_sessions_last_access()}</th>
						<th>{$LL.admin_sessions_expires()}</th>
						<th>{$LL.admin_sessions_status()}</th>
						<th class="text-right">{$LL.admin_sessions_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each sessions as session (session.id)}
						<tr>
							<td>
								<div class="cell-primary">{session.user_email || '-'}</div>
								{#if session.user_name}
									<div class="cell-secondary">{session.user_name}</div>
								{/if}
							</td>
							<td class="muted">{parseUserAgent(session.user_agent)}</td>
							<td class="muted">{session.ip_address || '-'}</td>
							<td class="muted">
								<span title={formatDateTime(session.last_accessed_at)}>
									{getRelativeTime(session.last_accessed_at)}
								</span>
							</td>
							<td class="muted">
								<span title={formatDateTime(session.expires_at)}>
									{getTimeUntil(session.expires_at)}
								</span>
							</td>
							<td>
								<span class={session.is_active ? 'badge badge-success' : 'badge badge-neutral'}>
									{session.is_active ? $LL.admin_sessions_active() : $LL.admin_sessions_expired()}
								</span>
							</td>
							<td class="text-right">
								{#if session.is_active}
									<button class="btn btn-danger btn-sm" onclick={() => openRevokeDialog(session)}>
										{$LL.admin_sessions_revoke()}
									</button>
								{:else}
									<span class="muted">-</span>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<!-- Pagination -->
		{#if pagination && pagination.totalPages > 1}
			<div class="pagination">
				<p class="pagination-info">
					{$LL.admin_sessions_pagination({
						from: (pagination.page - 1) * pagination.limit + 1,
						to: Math.min(pagination.page * pagination.limit, pagination.total),
						total: pagination.total
					})}
				</p>
				<div class="pagination-buttons">
					<button
						class="btn btn-secondary btn-sm"
						onclick={() => goToPage(currentPage - 1)}
						disabled={!pagination.hasPrev}
					>
						{$LL.admin_sessions_previous()}
					</button>
					<button
						class="btn btn-secondary btn-sm"
						onclick={() => goToPage(currentPage + 1)}
						disabled={!pagination.hasNext}
					>
						{$LL.admin_sessions_next()}
					</button>
				</div>
			</div>
		{/if}
	{/if}
</div>

<!-- Revoke Confirmation Dialog -->
<Modal
	open={showRevokeDialog && !!sessionToRevoke}
	onClose={closeRevokeDialog}
	title={$LL.admin_sessions_revoke_title()}
	size="md"
>
	{#if sessionToRevoke}
		<p class="modal-description">
			{$LL.admin_sessions_revoke_description()}
		</p>

		<div class="info-box">
			<div class="info-row">
				<span class="info-label">{$LL.admin_sessions_user()}:</span>
				<span class="info-value">
					{sessionToRevoke.user_email || sessionToRevoke.user_id}
				</span>
			</div>
			<div class="info-row">
				<span class="info-label">{$LL.admin_sessions_ip()}</span>
				<span class="info-value">{sessionToRevoke.ip_address || '-'}</span>
			</div>
			<div class="info-row">
				<span class="info-label">{$LL.admin_sessions_last_access()}:</span>
				<span class="info-value">{getRelativeTime(sessionToRevoke.last_accessed_at)}</span>
			</div>
		</div>

		{#if revokeError}
			<div class="alert alert-error">{revokeError}</div>
		{/if}
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeRevokeDialog} disabled={revoking}>
			{$LL.admin_sessions_cancel()}
		</button>
		<button class="btn btn-danger" onclick={confirmRevoke} disabled={revoking}>
			{revoking ? $LL.admin_sessions_revoking() : $LL.admin_sessions_revoke()}
		</button>
	{/snippet}
</Modal>
