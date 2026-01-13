<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
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

	function getActionBadgeStyle(action: string): string {
		if (action.includes('delete') || action.includes('revoke')) {
			return 'background-color: #fee2e2; color: #991b1b;';
		}
		if (action.includes('create')) {
			return 'background-color: #d1fae5; color: #065f46;';
		}
		if (action.includes('update') || action.includes('rotate')) {
			return 'background-color: #dbeafe; color: #1e40af;';
		}
		if (action.includes('suspend') || action.includes('lock')) {
			return 'background-color: #fef3c7; color: #92400e;';
		}
		return 'background-color: #e5e7eb; color: #374151;';
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

<div>
	<!-- Back Button -->
	<button
		onclick={() => goto('/admin/audit-logs')}
		style="
			display: inline-flex;
			align-items: center;
			gap: 8px;
			padding: 8px 16px;
			margin-bottom: 16px;
			background-color: white;
			border: 1px solid #d1d5db;
			border-radius: 4px;
			font-size: 14px;
			cursor: pointer;
			color: #374151;
		"
	>
		&larr; Back to Audit Logs
	</button>

	{#if loading}
		<p style="color: #6b7280; text-align: center; padding: 40px;">Loading audit log entry...</p>
	{:else if error}
		<div
			style="background-color: #fee2e2; border: 1px solid #ef4444; color: #b91c1c; padding: 12px; border-radius: 6px;"
		>
			{error}
		</div>
	{:else if entry}
		<div
			style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;"
		>
			<div style="display: flex; align-items: center; gap: 16px;">
				<h1 style="font-size: 24px; font-weight: bold; color: #1f2937; margin: 0;">
					Audit Log Entry
				</h1>
				<span
					style="
					display: inline-block;
					padding: 4px 12px;
					border-radius: 16px;
					font-size: 14px;
					font-weight: 500;
					{getActionBadgeStyle(entry.action)}
				"
				>
					{formatAction(entry.action)}
				</span>
			</div>
		</div>

		<!-- Basic Information -->
		<div
			style="background-color: white; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 16px;"
		>
			<h2
				style="font-size: 16px; font-weight: 600; color: #1f2937; margin: 0 0 16px 0; padding-bottom: 8px; border-bottom: 1px solid #e5e7eb;"
			>
				Basic Information
			</h2>

			<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px;">
				<div>
					<label style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
						>Entry ID</label
					>
					<p style="margin: 0; font-size: 14px; color: #1f2937; font-family: monospace;">
						{entry.id}
					</p>
				</div>

				<div>
					<label style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
						>Action</label
					>
					<p style="margin: 0; font-size: 14px; color: #1f2937; font-family: monospace;">
						{entry.action}
					</p>
				</div>

				<div>
					<label style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
						>Date/Time</label
					>
					<p style="margin: 0; font-size: 14px; color: #1f2937;">
						{formatDateTime(entry.createdAt)}
					</p>
				</div>
			</div>
		</div>

		<!-- Actor Information -->
		<div
			style="background-color: white; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 16px;"
		>
			<h2
				style="font-size: 16px; font-weight: 600; color: #1f2937; margin: 0 0 16px 0; padding-bottom: 8px; border-bottom: 1px solid #e5e7eb;"
			>
				Actor Information
			</h2>

			<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px;">
				<div>
					<label style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
						>User ID</label
					>
					{#if entry.userId}
						<a
							href="/admin/users/{entry.userId}"
							style="font-size: 14px; color: #3b82f6; text-decoration: none; font-family: monospace;"
						>
							{entry.userId}
						</a>
					{:else}
						<p style="margin: 0; font-size: 14px; color: #9ca3af;">System / Anonymous</p>
					{/if}
				</div>

				<div>
					<label style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
						>IP Address</label
					>
					<p style="margin: 0; font-size: 14px; color: #1f2937;">
						{entry.ipAddress || '-'}
					</p>
				</div>

				{#if entry.userAgent}
					{@const parsedUA = parseUserAgent(entry.userAgent)}
					<div>
						<label style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
							>Browser / OS</label
						>
						<p style="margin: 0; font-size: 14px; color: #1f2937;">
							{parsedUA ? `${parsedUA.browser} on ${parsedUA.os}` : '-'}
						</p>
					</div>
				{/if}
			</div>

			{#if entry.userAgent}
				<div style="margin-top: 16px;">
					<label style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
						>Full User Agent</label
					>
					<p
						style="margin: 0; font-size: 12px; color: #6b7280; font-family: monospace; word-break: break-all;"
					>
						{entry.userAgent}
					</p>
				</div>
			{/if}
		</div>

		<!-- Resource Information -->
		<div
			style="background-color: white; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 16px;"
		>
			<h2
				style="font-size: 16px; font-weight: 600; color: #1f2937; margin: 0 0 16px 0; padding-bottom: 8px; border-bottom: 1px solid #e5e7eb;"
			>
				Resource Information
			</h2>

			<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px;">
				<div>
					<label style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
						>Resource Type</label
					>
					<p style="margin: 0; font-size: 14px; color: #1f2937;">
						{entry.resourceType || '-'}
					</p>
				</div>

				<div>
					<label style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
						>Resource ID</label
					>
					{#if entry.resourceId}
						{#if entry.resourceType === 'user'}
							<a
								href="/admin/users/{entry.resourceId}"
								style="font-size: 14px; color: #3b82f6; text-decoration: none; font-family: monospace;"
							>
								{entry.resourceId}
							</a>
						{:else if entry.resourceType === 'client'}
							<a
								href="/admin/clients/{entry.resourceId}"
								style="font-size: 14px; color: #3b82f6; text-decoration: none; font-family: monospace;"
							>
								{entry.resourceId}
							</a>
						{:else}
							<p style="margin: 0; font-size: 14px; color: #1f2937; font-family: monospace;">
								{entry.resourceId}
							</p>
						{/if}
					{:else}
						<p style="margin: 0; font-size: 14px; color: #9ca3af;">-</p>
					{/if}
				</div>
			</div>
		</div>

		<!-- Metadata -->
		<div
			style="background-color: white; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);"
		>
			<h2
				style="font-size: 16px; font-weight: 600; color: #1f2937; margin: 0 0 16px 0; padding-bottom: 8px; border-bottom: 1px solid #e5e7eb;"
			>
				Metadata
			</h2>

			{#if entry.metadata && Object.keys(entry.metadata).length > 0}
				<pre
					style="
					background-color: #f3f4f6;
					padding: 16px;
					border-radius: 6px;
					font-size: 13px;
					font-family: monospace;
					overflow-x: auto;
					margin: 0;
					white-space: pre-wrap;
					word-break: break-word;
				">{formatMetadata(entry.metadata)}</pre>
			{:else}
				<p style="margin: 0; color: #9ca3af; font-style: italic;">
					No additional metadata recorded for this event.
				</p>
			{/if}
		</div>
	{/if}
</div>
