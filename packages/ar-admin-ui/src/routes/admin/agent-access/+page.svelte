<script lang="ts">
	import {
		adminAgentAccessAPI,
		buildAgentAccessMcpUrl,
		type AdminAgentGrant,
		type AgentAccessSettings,
		type AgentScope
	} from '$lib/api/admin-agent-access';
	import { getTenantInfo } from '$lib/api/admin-info';
	import { AdminPageHeader, AdminPageShell, AgentAccessNav } from '$lib/components/admin';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { LL } from '$i18n/i18n-svelte';

	let grants: AdminAgentGrant[] = $state([]);
	let enabled = $state(false);
	let settings: AgentAccessSettings | null = $state(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let notice = $state('');
	let connectionUrl = $state('');
	let editingGrantId = $state<string | null>(null);
	let editUserData = $state(false);
	let editWrite = $state(false);
	let loadedTenantId = $state('');
	let loadGeneration = 0;
	const canWriteSettings = $derived(adminAuth.hasPermission('admin:agent_settings:write'));
	const canWriteGrants = $derived(adminAuth.hasPermission('admin:agent_grants:write'));

	const active = $derived(grants.filter((grant) => grant.status === 'active').length);
	const suspended = $derived(grants.filter((grant) => grant.status === 'suspended').length);
	const revoked = $derived(grants.filter((grant) => grant.status === 'revoked').length);

	async function loadOverview(tenantId: string): Promise<void> {
		const generation = ++loadGeneration;
		loading = true;
		error = '';
		notice = '';
		editingGrantId = null;
		try {
			const [grantResponse, loadedSettings, tenantInfo] = await Promise.all([
				adminAgentAccessAPI.listGrants({ limit: 100, tenantId }),
				adminAgentAccessAPI.getSettings(tenantId),
				getTenantInfo(tenantId)
			]);
			if (generation !== loadGeneration || tenantId !== settingsContext.tenantId) return;
			grants = grantResponse.grants;
			settings = loadedSettings;
			enabled = loadedSettings.enabled;
			connectionUrl = buildAgentAccessMcpUrl(tenantInfo.issuer);
			loadedTenantId = tenantId;
		} catch (caught) {
			if (generation !== loadGeneration || tenantId !== settingsContext.tenantId) return;
			settings = null;
			grants = [];
			connectionUrl = '';
			loadedTenantId = '';
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			if (generation === loadGeneration) loading = false;
		}
	}

	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (!tenantId) return;
		void loadOverview(tenantId);
	});

	async function changeEnabled() {
		if (!settings || !canWriteSettings || loadedTenantId !== settingsContext.tenantId) return;
		saving = true;
		error = '';
		notice = '';
		try {
			settings = await adminAgentAccessAPI.updateSettings(
				{
					...settings,
					enabled: !settings.enabled
				},
				loadedTenantId
			);
			enabled = settings.enabled;
			notice = enabled ? $LL.admin_agent_access_enabled() : $LL.admin_agent_access_disabled();
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			saving = false;
		}
	}

	async function copyUrl() {
		error = '';
		try {
			await navigator.clipboard.writeText(connectionUrl);
			notice = $LL.admin_agent_access_copied();
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		}
	}

	async function transition(grant: AdminAgentGrant, action: 'suspend' | 'revoke') {
		if (!canWriteGrants) return;
		const accepted = confirm(
			action === 'revoke'
				? $LL.admin_agent_access_revoke_confirm()
				: $LL.admin_agent_access_suspend_confirm()
		);
		if (!accepted) return;
		saving = true;
		try {
			if (action === 'revoke') await adminAgentAccessAPI.revokeGrant(grant.id, loadedTenantId);
			else await adminAgentAccessAPI.suspendGrant(grant.id, loadedTenantId);
			const response = await adminAgentAccessAPI.listGrants({
				limit: 100,
				tenantId: loadedTenantId
			});
			grants = response.grants;
			notice = $LL.admin_agent_access_transition_notice();
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			saving = false;
		}
	}

	function canEditConnection(grant: AdminAgentGrant): boolean {
		return (
			canWriteGrants &&
			grant.status === 'active' &&
			grant.management_mode === 'system_managed' &&
			grant.delegator_id === adminAuth.user?.userId &&
			grant.grantor_id === adminAuth.user?.userId
		);
	}

	function beginScopeEdit(grant: AdminAgentGrant) {
		editingGrantId = grant.id;
		editUserData = grant.scopes.includes('agent:user-data:read');
		editWrite = grant.scopes.includes('agent:write');
		notice = '';
		error = '';
	}

	function cancelScopeEdit() {
		editingGrantId = null;
	}

	async function saveScopes(grant: AdminAgentGrant) {
		if (!canEditConnection(grant)) return;
		const scopes: AgentScope[] = ['agent:read'];
		if (editUserData) scopes.push('agent:user-data:read');
		if (editWrite) scopes.push('agent:write');
		saving = true;
		error = '';
		try {
			const result = await adminAgentAccessAPI.updateSelfServiceScopes(
				grant.id,
				scopes,
				loadedTenantId
			);
			grants = grants.map((item) => (item.id === grant.id ? result.grant : item));
			editingGrantId = null;
			notice = result.changed
				? $LL.admin_agent_access_scope_updated_notice()
				: $LL.admin_agent_access_scope_unchanged_notice();
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			saving = false;
		}
	}

	function connectionType(grant: AdminAgentGrant): string {
		return grant.machine_principal_id
			? $LL.admin_agent_access_automation_connection()
			: $LL.admin_agent_access_interactive_connection();
	}

	function formatTime(value: number | null): string {
		return value ? new Date(value).toLocaleString() : '—';
	}
</script>

<svelte:head><title>{$LL.admin_agent_access_page_title()}</title></svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_agent_access_title()}
		description={$LL.admin_agent_access_description()}
	>
		{#snippet titleAccessory()}
			<span class="status" data-enabled={enabled}>
				{enabled ? $LL.admin_agent_access_enabled() : $LL.admin_agent_access_disabled()}
			</span>
		{/snippet}
	</AdminPageHeader>
	<AgentAccessNav />

	{#if loading}
		<div class="loading-state">{$LL.admin_agent_access_loading()}</div>
	{:else if !settings}
		<div class="alert alert-error">{error}</div>
	{:else}
		{#if error}<div class="alert alert-error">{error}</div>{/if}
		{#if notice}<div class="alert alert-success">{notice}</div>{/if}
		<section class="connection-panel">
			<div>
				<h2>{$LL.admin_agent_access_connection_url()}</h2>
				<p>{$LL.admin_agent_access_connection_url_help()}</p>
			</div>
			<div class="url-row">
				<code>{connectionUrl}</code>
				<button class="btn btn-secondary" type="button" onclick={copyUrl} disabled={!connectionUrl}>
					{$LL.admin_agent_access_copy_url()}
				</button>
			</div>
			<div class="tenant-toggle">
				<div>
					<strong
						>{enabled
							? $LL.admin_agent_access_enabled()
							: $LL.admin_agent_access_disabled()}</strong
					>
					<p>{$LL.admin_agent_access_toggle_help()}</p>
				</div>
				{#if canWriteSettings}
					<button class="btn btn-primary" type="button" onclick={changeEnabled} disabled={saving}>
						{enabled ? $LL.admin_agent_access_toggle_off() : $LL.admin_agent_access_toggle_on()}
					</button>
				{/if}
			</div>
		</section>

		<section class="metric-grid" aria-label={$LL.admin_agent_access_tab_overview()}>
			<div class="metric">
				<span>{active}</span>
				<p>{$LL.admin_agent_access_active_grants()}</p>
			</div>
			<div class="metric">
				<span>{suspended}</span>
				<p>{$LL.admin_agent_access_suspended_grants()}</p>
			</div>
			<div class="metric">
				<span>{revoked}</span>
				<p>{$LL.admin_agent_access_revoked_grants()}</p>
			</div>
		</section>

		<section class="connected-section">
			<div class="section-heading">
				<div>
					<h2>{$LL.admin_agent_access_connected_title()}</h2>
					<p>{$LL.admin_agent_access_connected_description()}</p>
				</div>
			</div>
			{#if grants.length === 0}
				<div class="empty-state">{$LL.admin_agent_access_connected_empty()}</div>
			{:else}
				<div class="connection-list">
					{#each grants as grant (grant.id)}
						<article class="connection-card">
							<div class="connection-main">
								<div>
									<strong>{grant.client_id}</strong>
									<span>{connectionType(grant)}</span>
								</div>
								<span class="status" data-enabled={grant.status === 'active'}>{grant.status}</span>
							</div>
							<dl>
								<div>
									<dt>{$LL.admin_agent_access_col_delegator()}</dt>
									<dd>{grant.delegator_id}</dd>
								</div>
								<div>
									<dt>{$LL.admin_agent_access_scope()}</dt>
									<dd>{grant.scopes.join(', ')}</dd>
								</div>
								<div>
									<dt>{$LL.admin_agent_access_last_used()}</dt>
									<dd>{formatTime(grant.last_used_at)}</dd>
								</div>
								<div>
									<dt>{$LL.admin_agent_access_expiration()}</dt>
									<dd>{formatTime(grant.expires_at)}</dd>
								</div>
							</dl>
							{#if editingGrantId === grant.id}
								<fieldset class="scope-editor" disabled={saving}>
									<legend>{$LL.admin_agent_access_edit_permissions()}</legend>
									<label>
										<input type="checkbox" checked disabled />
										<span>
											<strong>{$LL.admin_agent_access_scope_read()}</strong>
											<small>{$LL.admin_agent_access_scope_read_help()}</small>
										</span>
									</label>
									<label>
										<input type="checkbox" bind:checked={editUserData} />
										<span>
											<strong>{$LL.admin_agent_access_scope_user_data()}</strong>
											<small>{$LL.admin_agent_access_scope_user_data_help()}</small>
										</span>
									</label>
									<label>
										<input type="checkbox" bind:checked={editWrite} />
										<span>
											<strong>{$LL.admin_agent_access_scope_write()}</strong>
											<small>{$LL.admin_agent_access_scope_write_help()}</small>
										</span>
									</label>
									<p>{$LL.admin_agent_access_scope_change_help()}</p>
									<div class="scope-editor-actions">
										<button class="btn btn-secondary" type="button" onclick={cancelScopeEdit}
											>{$LL.admin_agent_access_cancel()}</button
										>
										<button class="btn btn-primary" type="button" onclick={() => saveScopes(grant)}
											>{$LL.admin_agent_access_save_permissions()}</button
										>
									</div>
								</fieldset>
							{/if}
							<div class="connection-actions">
								<a class="btn btn-secondary" href={`/admin/agent-access/grants/${grant.id}`}
									>{$LL.admin_agent_access_grant_detail_title()}</a
								>
								{#if canEditConnection(grant) && editingGrantId !== grant.id}
									<button
										class="btn btn-secondary"
										type="button"
										onclick={() => beginScopeEdit(grant)}
										disabled={saving}>{$LL.admin_agent_access_edit_permissions()}</button
									>
								{/if}
								{#if canWriteGrants && grant.status === 'active'}
									<button
										class="btn btn-secondary"
										type="button"
										onclick={() => transition(grant, 'suspend')}
										disabled={saving}>{$LL.admin_agent_access_suspend_connection()}</button
									>
									<button
										class="btn btn-danger"
										type="button"
										onclick={() => transition(grant, 'revoke')}
										disabled={saving}>{$LL.admin_agent_access_revoke_connection()}</button
									>
								{/if}
							</div>
						</article>
					{/each}
				</div>
			{/if}
		</section>

		<div class="action-grid">
			<a href="/admin/agent-access/grants">
				<i class="i-ph-keyhole" aria-hidden="true"></i>
				<span>{$LL.admin_agent_access_tab_advanced()}</span>
				<i class="i-ph-arrow-right" aria-hidden="true"></i>
			</a>
			<a href="/admin/agent-access/settings">
				<i class="i-ph-sliders-horizontal" aria-hidden="true"></i>
				<span>{$LL.admin_agent_access_open_settings()}</span>
				<i class="i-ph-arrow-right" aria-hidden="true"></i>
			</a>
		</div>
	{/if}
</AdminPageShell>

<style>
	.status {
		display: inline-flex;
		padding: 3px 9px;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		color: var(--color-text-muted);
		font-size: 0.72rem;
		font-weight: 700;
	}
	.status[data-enabled='true'] {
		color: var(--color-success);
		border-color: color-mix(in srgb, var(--color-success) 45%, var(--color-border));
		background: color-mix(in srgb, var(--color-success) 8%, transparent);
	}
	.connection-panel,
	.connected-section {
		display: grid;
		gap: 16px;
		margin-bottom: 20px;
		padding: 20px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, var(--radius-md));
		background: var(--color-surface);
	}
	.connection-panel h2,
	.connected-section h2 {
		margin: 0;
		font-size: 1.1rem;
	}
	.connection-panel p,
	.connected-section p {
		margin: 5px 0 0;
		color: var(--color-text-muted);
		font-size: 0.82rem;
		line-height: 1.5;
	}
	.url-row,
	.tenant-toggle,
	.connection-main,
	.connection-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.url-row code {
		flex: 1;
		padding: 11px 12px;
		overflow-x: auto;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, var(--radius-sm));
		background: var(--color-surface-raised);
		font-size: 0.82rem;
	}
	.tenant-toggle {
		padding-top: 14px;
		border-top: 1px solid var(--color-border);
	}
	.connection-list {
		display: grid;
		gap: 12px;
	}
	.connection-card {
		display: grid;
		gap: 14px;
		padding: 16px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, var(--radius-sm));
	}
	.connection-main > div {
		display: grid;
		gap: 3px;
	}
	.connection-main span:not(.status) {
		color: var(--color-text-muted);
		font-size: 0.78rem;
	}
	dl {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px 18px;
		margin: 0;
	}
	dl div {
		min-width: 0;
	}
	dt {
		color: var(--color-text-muted);
		font-size: 0.72rem;
	}
	dd {
		margin: 3px 0 0;
		overflow-wrap: anywhere;
		font-size: 0.82rem;
	}
	.connection-actions {
		justify-content: flex-end;
		flex-wrap: wrap;
	}
	.scope-editor {
		display: grid;
		gap: 12px;
		margin: 0;
		padding: 16px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, var(--radius-sm));
		background: var(--color-surface-raised);
	}
	.scope-editor legend {
		padding: 0 6px;
		font-weight: 700;
	}
	.scope-editor label {
		display: flex;
		align-items: flex-start;
		gap: 10px;
	}
	.scope-editor label span {
		display: grid;
		gap: 2px;
	}
	.scope-editor small,
	.scope-editor p {
		color: var(--color-text-muted);
		font-size: 0.78rem;
		line-height: 1.45;
	}
	.scope-editor p {
		margin: 0;
	}
	.scope-editor-actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
	}
	.empty-state {
		padding: 24px;
		border: 1px dashed var(--color-border);
		border-radius: var(--radius-control, var(--radius-sm));
		color: var(--color-text-muted);
		text-align: center;
	}
	.metric-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 14px;
	}
	.metric {
		padding: 20px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, var(--radius-md));
		background: var(--color-surface);
	}
	.metric span {
		font-family: var(--font-display);
		font-size: 1.7rem;
		font-weight: 750;
	}
	.metric p {
		margin: 5px 0 0;
		color: var(--color-text-muted);
		font-size: 0.82rem;
	}
	.action-grid {
		display: grid;
		gap: 10px;
		margin-top: 20px;
	}
	.action-grid a {
		display: grid;
		grid-template-columns: 24px 1fr 20px;
		align-items: center;
		gap: 12px;
		padding: 15px 16px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, var(--radius-sm));
		color: var(--color-text);
		text-decoration: none;
	}
	.action-grid a:hover {
		border-color: var(--color-accent);
		background: var(--color-surface-raised);
	}
	.loading-state {
		padding: 32px;
		color: var(--color-text-muted);
		text-align: center;
	}
	@media (max-width: 720px) {
		.metric-grid {
			grid-template-columns: 1fr;
		}
		.url-row,
		.tenant-toggle {
			align-items: stretch;
			flex-direction: column;
		}
		dl {
			grid-template-columns: 1fr;
		}
	}
</style>
