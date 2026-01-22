<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminSessionsAPI,
		type Session,
		type Pagination,
		type SessionListParams
	} from '$lib/api/admin-sessions';

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
			console.error('Failed to load sessions:', err);
			error = 'Failed to load sessions';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
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

		if (diffMins < 1) return 'Just now';
		if (diffMins < 60) return `${diffMins} min${diffMins === 1 ? '' : 's'} ago`;
		if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
		return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
	}

	function getTimeUntil(isoString: string): string {
		const date = new Date(isoString);
		const now = new Date();
		const diffMs = date.getTime() - now.getTime();

		if (diffMs <= 0) return 'Expired';

		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 60) return `${diffMins} min${diffMins === 1 ? '' : 's'}`;
		if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'}`;
		return `${diffDays} day${diffDays === 1 ? '' : 's'}`;
	}

	function parseUserAgent(userAgent: string | null): string {
		if (!userAgent) return '-';

		let browser = 'Unknown';
		let os = 'Unknown';

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
			console.error('Failed to revoke session:', err);
			revokeError = err instanceof Error ? err.message : 'Failed to revoke session';
		} finally {
			revoking = false;
		}
	}
</script>

<svelte:head>
	<title>Sessions - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">Sessions</h1>
			<p class="page-description">Monitor and manage active user sessions</p>
		</div>
	</div>

	<!-- Filters -->
	<div class="panel">
		<div class="filter-row">
			<div class="form-group">
				<label for="user_id" class="form-label">User ID</label>
				<input
					id="user_id"
					type="text"
					class="form-input"
					placeholder="Filter by user ID..."
					bind:value={userIdFilter}
					oninput={handleUserIdSearch}
				/>
			</div>

			<div class="form-group">
				<label for="status" class="form-label">Status</label>
				<select
					id="status"
					class="form-select"
					bind:value={statusFilter}
					onchange={handleStatusChange}
				>
					<option value="">All</option>
					<option value="active">Active Only</option>
					<option value="expired">Expired Only</option>
				</select>
			</div>
		</div>
	</div>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading sessions...</p>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if sessions.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">No sessions found</p>
			</div>
		</div>
	{:else}
		<!-- Sessions Table -->
		<div class="data-table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>User</th>
						<th>Device</th>
						<th>IP Address</th>
						<th>Last Access</th>
						<th>Expires</th>
						<th>Status</th>
						<th class="text-right">Actions</th>
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
									{session.is_active ? 'Active' : 'Expired'}
								</span>
							</td>
							<td class="text-right">
								{#if session.is_active}
									<button class="btn btn-danger btn-sm" onclick={() => openRevokeDialog(session)}>
										Revoke
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
					Showing {(pagination.page - 1) * pagination.limit + 1} to {Math.min(
						pagination.page * pagination.limit,
						pagination.total
					)} of {pagination.total} sessions
				</p>
				<div class="pagination-buttons">
					<button
						class="btn btn-secondary btn-sm"
						onclick={() => goToPage(currentPage - 1)}
						disabled={!pagination.hasPrev}
					>
						Previous
					</button>
					<button
						class="btn btn-secondary btn-sm"
						onclick={() => goToPage(currentPage + 1)}
						disabled={!pagination.hasNext}
					>
						Next
					</button>
				</div>
			</div>
		{/if}
	{/if}
</div>

<!-- Revoke Confirmation Dialog -->
{#if showRevokeDialog && sessionToRevoke}
	<div
		class="modal-overlay"
		onclick={closeRevokeDialog}
		onkeydown={(e) => e.key === 'Escape' && closeRevokeDialog()}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
	>
		<div
			class="modal-content"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<h2 class="modal-title">Revoke Session</h2>
			</div>

			<div class="modal-body">
				<p class="modal-description">
					This will immediately log out the user from this session. Are you sure?
				</p>

				<div class="info-box">
					<div class="info-row">
						<span class="info-label">User:</span>
						<span class="info-value">
							{sessionToRevoke.user_email || sessionToRevoke.user_id}
						</span>
					</div>
					<div class="info-row">
						<span class="info-label">IP:</span>
						<span class="info-value">{sessionToRevoke.ip_address || '-'}</span>
					</div>
					<div class="info-row">
						<span class="info-label">Last Access:</span>
						<span class="info-value">{getRelativeTime(sessionToRevoke.last_accessed_at)}</span>
					</div>
				</div>

				{#if revokeError}
					<div class="alert alert-error">{revokeError}</div>
				{/if}
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={closeRevokeDialog} disabled={revoking}>
					Cancel
				</button>
				<button class="btn btn-danger" onclick={confirmRevoke} disabled={revoking}>
					{revoking ? 'Revoking...' : 'Revoke'}
				</button>
			</div>
		</div>
	</div>
{/if}
