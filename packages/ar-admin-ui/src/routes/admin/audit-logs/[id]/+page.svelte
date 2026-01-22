<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { adminAuditLogsAPI, type AuditLogEntry } from '$lib/api/admin-audit-logs';

	let entry: AuditLogEntry | null = $state(null);
	let loading = $state(true);
	let error = $state('');

	const entryId = $derived($page.params.id ?? '');

	async function loadEntry() {
		if (!entryId) {
			error = 'Invalid audit log entry ID';
			loading = false;
			return;
		}

		loading = true;
		error = '';

		try {
			entry = await adminAuditLogsAPI.get(entryId);
		} catch (err) {
			console.error('Failed to load audit log entry:', err);
			error = err instanceof Error ? err.message : 'Failed to load audit log entry';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadEntry();
	});

	function formatDateTime(isoString: string): string {
		return new Date(isoString).toLocaleString();
	}

	function formatAction(action: string): string {
		return action
			.split('.')
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(' ');
	}

	function getActionBadgeClass(action: string): string {
		if (action.includes('delete') || action.includes('revoke')) {
			return 'badge badge-danger';
		}
		if (action.includes('create')) {
			return 'badge badge-success';
		}
		if (action.includes('update') || action.includes('rotate')) {
			return 'badge badge-info';
		}
		if (action.includes('suspend') || action.includes('lock')) {
			return 'badge badge-warning';
		}
		return 'badge badge-neutral';
	}

	function formatMetadata(metadata: Record<string, unknown> | null): string {
		if (!metadata) return 'No metadata';
		return JSON.stringify(metadata, null, 2);
	}

	function parseUserAgent(userAgent: string | null): { browser: string; os: string } | null {
		if (!userAgent) return null;

		let browser = 'Unknown';
		let os = 'Unknown';

		// Simple UA parsing
		if (userAgent.includes('Chrome')) browser = 'Chrome';
		else if (userAgent.includes('Firefox')) browser = 'Firefox';
		else if (userAgent.includes('Safari')) browser = 'Safari';
		else if (userAgent.includes('Edge')) browser = 'Edge';

		if (userAgent.includes('Windows')) os = 'Windows';
		else if (userAgent.includes('Mac OS')) os = 'macOS';
		else if (userAgent.includes('Linux')) os = 'Linux';
		else if (userAgent.includes('Android')) os = 'Android';
		else if (userAgent.includes('iOS') || userAgent.includes('iPhone')) os = 'iOS';

		return { browser, os };
	}
</script>

<svelte:head>
	<title>Audit Log Details - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<!-- Back Button -->
	<a href="/admin/audit-logs" class="back-link">← Back to Audit Logs</a>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading audit log entry...</p>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if entry}
		<div class="page-header">
			<div class="flow-title-row">
				<h1 class="page-title">Audit Log Entry</h1>
				<span class={getActionBadgeClass(entry.action)}>
					{formatAction(entry.action)}
				</span>
			</div>
		</div>

		<!-- Basic Information -->
		<div class="panel">
			<h2 class="section-title-border">Basic Information</h2>

			<div class="info-grid">
				<div class="info-item">
					<dt class="info-label">Entry ID</dt>
					<dd class="info-value mono">{entry.id}</dd>
				</div>

				<div class="info-item">
					<dt class="info-label">Action</dt>
					<dd class="info-value mono">{entry.action}</dd>
				</div>

				<div class="info-item">
					<dt class="info-label">Date/Time</dt>
					<dd class="info-value">{formatDateTime(entry.createdAt)}</dd>
				</div>
			</div>
		</div>

		<!-- Actor Information -->
		<div class="panel">
			<h2 class="section-title-border">Actor Information</h2>

			<div class="info-grid">
				<div class="info-item">
					<dt class="info-label">User ID</dt>
					<dd class="info-value">
						{#if entry.userId}
							<a href="/admin/users/{entry.userId}" class="mono">
								{entry.userId}
							</a>
						{:else}
							<span class="text-muted">System / Anonymous</span>
						{/if}
					</dd>
				</div>

				<div class="info-item">
					<dt class="info-label">IP Address</dt>
					<dd class="info-value">{entry.ipAddress || '-'}</dd>
				</div>

				{#if entry.userAgent}
					{@const parsedUA = parseUserAgent(entry.userAgent)}
					<div class="info-item">
						<dt class="info-label">Browser / OS</dt>
						<dd class="info-value">
							{parsedUA ? `${parsedUA.browser} on ${parsedUA.os}` : '-'}
						</dd>
					</div>
				{/if}
			</div>

			{#if entry.userAgent}
				<div class="info-item" style="margin-top: 16px;">
					<dt class="info-label">Full User Agent</dt>
					<dd
						class="info-value mono text-secondary"
						style="word-break: break-all; font-size: 0.75rem;"
					>
						{entry.userAgent}
					</dd>
				</div>
			{/if}
		</div>

		<!-- Resource Information -->
		<div class="panel">
			<h2 class="section-title-border">Resource Information</h2>

			<div class="info-grid">
				<div class="info-item">
					<dt class="info-label">Resource Type</dt>
					<dd class="info-value">{entry.resourceType || '-'}</dd>
				</div>

				<div class="info-item">
					<dt class="info-label">Resource ID</dt>
					<dd class="info-value">
						{#if entry.resourceId}
							{#if entry.resourceType === 'user'}
								<a href="/admin/users/{entry.resourceId}" class="mono">
									{entry.resourceId}
								</a>
							{:else if entry.resourceType === 'client'}
								<a href="/admin/clients/{entry.resourceId}" class="mono">
									{entry.resourceId}
								</a>
							{:else}
								<span class="mono">{entry.resourceId}</span>
							{/if}
						{:else}
							<span class="text-muted">-</span>
						{/if}
					</dd>
				</div>
			</div>
		</div>

		<!-- Metadata -->
		<div class="panel">
			<h2 class="section-title-border">Metadata</h2>

			{#if entry.metadata && Object.keys(entry.metadata).length > 0}
				<pre class="code-block"><code>{formatMetadata(entry.metadata)}</code></pre>
			{:else}
				<p class="text-muted" style="font-style: italic; margin: 0;">
					No additional metadata recorded for this event.
				</p>
			{/if}
		</div>
	{/if}
</div>
