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

<div>
	<div
		style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;"
	>
		<h1 style="font-size: 24px; font-weight: bold; color: #1f2937; margin: 0;">Sessions</h1>
	</div>

	<!-- Filters -->
	<div
		style="background-color: white; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 16px;"
	>
		<div style="display: flex; gap: 16px; flex-wrap: wrap;">
			<!-- User ID Filter -->
			<div style="flex: 1; min-width: 200px;">
				<label
					for="user_id"
					style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
					>User ID</label
				>
				<input
					id="user_id"
					type="text"
					placeholder="Filter by user ID..."
					bind:value={userIdFilter}
					oninput={handleUserIdSearch}
					style="
						width: 100%;
						padding: 8px 12px;
						border: 1px solid #d1d5db;
						border-radius: 4px;
						font-size: 14px;
						box-sizing: border-box;
					"
				/>
			</div>

			<!-- Status Filter -->
			<div style="min-width: 150px;">
				<label
					for="status"
					style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
					>Status</label
				>
				<select
					id="status"
					bind:value={statusFilter}
					onchange={handleStatusChange}
					style="
						width: 100%;
						padding: 8px 12px;
						border: 1px solid #d1d5db;
						border-radius: 4px;
						font-size: 14px;
						background-color: white;
					"
				>
					<option value="">All</option>
					<option value="active">Active Only</option>
					<option value="expired">Expired Only</option>
				</select>
			</div>
		</div>
	</div>

	{#if loading}
		<p style="color: #6b7280; text-align: center; padding: 40px;">Loading sessions...</p>
	{:else if error}
		<div
			style="background-color: #fee2e2; border: 1px solid #ef4444; color: #b91c1c; padding: 12px; border-radius: 6px;"
		>
			{error}
		</div>
	{:else if sessions.length === 0}
		<div
			style="background-color: white; border-radius: 8px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); text-align: center;"
		>
			<p style="color: #9ca3af; margin: 0;">No sessions found</p>
		</div>
	{:else}
		<!-- Sessions Table -->
		<div
			style="background-color: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); overflow: hidden;"
		>
			<table style="width: 100%; border-collapse: collapse;">
				<thead>
					<tr style="background-color: #f9fafb; border-bottom: 1px solid #e5e7eb;">
						<th
							style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>User</th
						>
						<th
							style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>Device</th
						>
						<th
							style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>IP Address</th
						>
						<th
							style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>Last Access</th
						>
						<th
							style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>Expires</th
						>
						<th
							style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>Status</th
						>
						<th
							style="text-align: right; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
							>Actions</th
						>
					</tr>
				</thead>
				<tbody>
					{#each sessions as session (session.id)}
						<tr style="border-bottom: 1px solid #e5e7eb;">
							<td style="padding: 12px 16px;">
								<div style="font-size: 14px; color: #1f2937;">
									{session.user_email || '-'}
								</div>
								{#if session.user_name}
									<div style="font-size: 12px; color: #6b7280;">
										{session.user_name}
									</div>
								{/if}
							</td>
							<td style="padding: 12px 16px; font-size: 14px; color: #6b7280;">
								{parseUserAgent(session.user_agent)}
							</td>
							<td style="padding: 12px 16px; font-size: 14px; color: #6b7280;">
								{session.ip_address || '-'}
							</td>
							<td style="padding: 12px 16px; font-size: 14px; color: #6b7280;">
								<span title={formatDateTime(session.last_accessed_at)}>
									{getRelativeTime(session.last_accessed_at)}
								</span>
							</td>
							<td style="padding: 12px 16px; font-size: 14px; color: #6b7280;">
								<span title={formatDateTime(session.expires_at)}>
									{getTimeUntil(session.expires_at)}
								</span>
							</td>
							<td style="padding: 12px 16px;">
								<span
									style="
									display: inline-block;
									padding: 2px 8px;
									border-radius: 12px;
									font-size: 12px;
									font-weight: 500;
									{session.is_active
										? 'background-color: #d1fae5; color: #065f46;'
										: 'background-color: #e5e7eb; color: #374151;'}
								"
								>
									{session.is_active ? 'Active' : 'Expired'}
								</span>
							</td>
							<td style="padding: 12px 16px; text-align: right;">
								{#if session.is_active}
									<button
										onclick={() => openRevokeDialog(session)}
										style="
											padding: 6px 12px;
											background-color: #fee2e2;
											color: #991b1b;
											border: 1px solid #fecaca;
											border-radius: 4px;
											font-size: 12px;
											cursor: pointer;
										"
									>
										Revoke
									</button>
								{:else}
									<span style="color: #9ca3af; font-size: 12px;">-</span>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<!-- Pagination -->
		{#if pagination && pagination.totalPages > 1}
			<div
				style="display: flex; justify-content: space-between; align-items: center; margin-top: 16px; padding: 0 4px;"
			>
				<p style="color: #6b7280; font-size: 14px; margin: 0;">
					Showing {(pagination.page - 1) * pagination.limit + 1} to {Math.min(
						pagination.page * pagination.limit,
						pagination.total
					)} of {pagination.total} sessions
				</p>
				<div style="display: flex; gap: 8px;">
					<button
						onclick={() => goToPage(currentPage - 1)}
						disabled={!pagination.hasPrev}
						style="
							padding: 8px 16px;
							border: 1px solid #d1d5db;
							border-radius: 4px;
							background-color: white;
							color: {pagination.hasPrev ? '#374151' : '#9ca3af'};
							cursor: {pagination.hasPrev ? 'pointer' : 'not-allowed'};
							font-size: 14px;
						"
					>
						Previous
					</button>
					<button
						onclick={() => goToPage(currentPage + 1)}
						disabled={!pagination.hasNext}
						style="
							padding: 8px 16px;
							border: 1px solid #d1d5db;
							border-radius: 4px;
							background-color: white;
							color: {pagination.hasNext ? '#374151' : '#9ca3af'};
							cursor: {pagination.hasNext ? 'pointer' : 'not-allowed'};
							font-size: 14px;
						"
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
		style="
			position: fixed;
			inset: 0;
			background-color: rgba(0, 0, 0, 0.5);
			display: flex;
			justify-content: center;
			align-items: center;
			z-index: 50;
		"
		onclick={closeRevokeDialog}
		onkeydown={(e) => e.key === 'Escape' && closeRevokeDialog()}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
	>
		<div
			style="
				background-color: white;
				border-radius: 8px;
				padding: 24px;
				max-width: 400px;
				width: 90%;
				box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
			"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<h2 style="font-size: 18px; font-weight: 600; color: #1f2937; margin: 0 0 16px 0;">
				Revoke Session
			</h2>

			<p style="color: #4b5563; margin: 0 0 16px 0; font-size: 14px;">
				This will immediately log out the user from this session. Are you sure?
			</p>

			<div
				style="background-color: #f9fafb; border-radius: 6px; padding: 12px; margin-bottom: 16px;"
			>
				<div style="font-size: 14px; margin-bottom: 8px;">
					<span style="color: #6b7280;">User:</span>
					<span style="color: #1f2937; margin-left: 8px;">
						{sessionToRevoke.user_email || sessionToRevoke.user_id}
					</span>
				</div>
				<div style="font-size: 14px; margin-bottom: 8px;">
					<span style="color: #6b7280;">IP:</span>
					<span style="color: #1f2937; margin-left: 8px;">
						{sessionToRevoke.ip_address || '-'}
					</span>
				</div>
				<div style="font-size: 14px;">
					<span style="color: #6b7280;">Last Access:</span>
					<span style="color: #1f2937; margin-left: 8px;">
						{getRelativeTime(sessionToRevoke.last_accessed_at)}
					</span>
				</div>
			</div>

			{#if revokeError}
				<div
					style="background-color: #fee2e2; border: 1px solid #ef4444; color: #b91c1c; padding: 8px 12px; border-radius: 4px; font-size: 14px; margin-bottom: 16px;"
				>
					{revokeError}
				</div>
			{/if}

			<div style="display: flex; justify-content: flex-end; gap: 12px;">
				<button
					onclick={closeRevokeDialog}
					disabled={revoking}
					style="
						padding: 10px 20px;
						background-color: white;
						color: #374151;
						border: 1px solid #d1d5db;
						border-radius: 6px;
						font-size: 14px;
						cursor: pointer;
					"
				>
					Cancel
				</button>
				<button
					onclick={confirmRevoke}
					disabled={revoking}
					style="
						padding: 10px 20px;
						background-color: #dc2626;
						color: white;
						border: none;
						border-radius: 6px;
						font-size: 14px;
						cursor: {revoking ? 'not-allowed' : 'pointer'};
						opacity: {revoking ? 0.7 : 1};
					"
				>
					{revoking ? 'Revoking...' : 'Revoke'}
				</button>
			</div>
		</div>
	</div>
{/if}
