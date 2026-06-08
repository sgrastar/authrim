<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { LL } from '$i18n/i18n-svelte';
	import { adminAuditLogsAPI, type AuditLogEntry } from '$lib/api/admin-audit-logs';
	import { settingsContext } from '$lib/stores/settings-context.svelte';

	let entry: AuditLogEntry | null = $state(null);
	let loading = $state(true);
	let error = $state('');
	let loadedTenantId = $state('');

	const entryId = $derived($page.params.id ?? '');

	async function loadEntry() {
		if (!entryId) {
			error = $LL.admin_audit_logs_invalid_entry_id();
			loading = false;
			return;
		}

		loading = true;
		error = '';

		try {
			entry = await adminAuditLogsAPI.get(entryId);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_audit_logs_entry_load_failed();
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
		entry = null;
		error = '';
		loadEntry();
	});

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
		if (!metadata) return $LL.admin_audit_logs_no_metadata();
		return JSON.stringify(metadata, null, 2);
	}

	function parseUserAgent(userAgent: string | null): { browser: string; os: string } | null {
		if (!userAgent) return null;

		let browser: string = $LL.admin_audit_logs_unknown();
		let os: string = $LL.admin_audit_logs_unknown();

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
	<title>{$LL.admin_audit_logs_detail_head_title()}</title>
</svelte:head>

<div class="admin-page">
	<!-- Back Button -->
	<a href="/admin/audit-logs" class="back-link">← {$LL.admin_audit_logs_back()}</a>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_audit_logs_entry_loading()}</p>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if entry}
		<div class="page-header">
			<div class="flow-title-row">
				<h1 class="page-title">{$LL.admin_audit_logs_entry_title()}</h1>
				<span class={getActionBadgeClass(entry.action)}>
					{formatAction(entry.action)}
				</span>
			</div>
		</div>

		<!-- Basic Information -->
		<div class="panel">
			<h2 class="section-title-border">{$LL.admin_audit_logs_basic_information()}</h2>

			<div class="info-grid">
				<div class="info-item">
					<dt class="info-label">{$LL.admin_audit_logs_entry_id()}</dt>
					<dd class="info-value mono">{entry.id}</dd>
				</div>

				<div class="info-item">
					<dt class="info-label">{$LL.admin_audit_logs_action()}</dt>
					<dd class="info-value mono">{entry.action}</dd>
				</div>

				<div class="info-item">
					<dt class="info-label">{$LL.admin_audit_logs_date_time()}</dt>
					<dd class="info-value">{formatDateTime(entry.createdAt)}</dd>
				</div>
			</div>
		</div>

		<!-- Actor Information -->
		<div class="panel">
			<h2 class="section-title-border">{$LL.admin_audit_logs_actor_information()}</h2>

			<div class="info-grid">
				<div class="info-item">
					<dt class="info-label">{$LL.admin_audit_logs_user_id()}</dt>
					<dd class="info-value">
						{#if entry.userId}
							<a href="/admin/users/{entry.userId}" class="mono">
								{entry.userId}
							</a>
						{:else}
							<span class="text-muted">{$LL.admin_audit_logs_system_anonymous()}</span>
						{/if}
					</dd>
				</div>

				<div class="info-item">
					<dt class="info-label">{$LL.admin_audit_logs_ip_address()}</dt>
					<dd class="info-value">{entry.ipAddress || '-'}</dd>
				</div>

				{#if entry.userAgent}
					{@const parsedUA = parseUserAgent(entry.userAgent)}
					<div class="info-item">
						<dt class="info-label">{$LL.admin_audit_logs_browser_os_label()}</dt>
						<dd class="info-value">
							{parsedUA
								? $LL.admin_audit_logs_browser_os({
										browser: parsedUA.browser,
										os: parsedUA.os
									})
								: '-'}
						</dd>
					</div>
				{/if}
			</div>

			{#if entry.userAgent}
				<div class="info-item" style="margin-top: 16px;">
					<dt class="info-label">{$LL.admin_audit_logs_full_user_agent()}</dt>
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
			<h2 class="section-title-border">{$LL.admin_audit_logs_resource_information()}</h2>

			<div class="info-grid">
				<div class="info-item">
					<dt class="info-label">{$LL.admin_audit_logs_resource_type()}</dt>
					<dd class="info-value">{entry.resourceType || '-'}</dd>
				</div>

				<div class="info-item">
					<dt class="info-label">{$LL.admin_audit_logs_resource_id()}</dt>
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
			<h2 class="section-title-border">{$LL.admin_audit_logs_metadata()}</h2>

			{#if entry.metadata && Object.keys(entry.metadata).length > 0}
				<pre class="code-block"><code>{formatMetadata(entry.metadata)}</code></pre>
			{:else}
				<p class="text-muted" style="font-style: italic; margin: 0;">
					{$LL.admin_audit_logs_no_additional_metadata()}
				</p>
			{/if}
		</div>
	{/if}
</div>
