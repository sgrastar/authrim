<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		adminAgentAccessAPI,
		type AgentScopePolicy,
		type AgentTaskSet
	} from '$lib/api/admin-agent-access';
	import { adminClientsAPI, type Client } from '$lib/api/admin-clients';
	import { adminAdminsAPI, type AdminUser } from '$lib/api/admin-admins';
	import { adminMachineAccessAPI, type AdminMachinePrincipal } from '$lib/api/admin-machine-access';
	import {
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AgentAccessNav
	} from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';

	let clients: Client[] = $state([]);
	let admins: AdminUser[] = $state([]);
	let principals: AdminMachinePrincipal[] = $state([]);
	let taskSets: AgentTaskSet[] = $state([]);
	let scopePolicies: AgentScopePolicy[] = $state([]);
	let clientId = $state('');
	let delegatorId = $state('');
	let principalId = $state('');
	let delegationMode = $state<'user_consent' | 'admin_pre_authorized'>('user_consent');
	let taskSetId = $state('');
	let scopePolicyId = $state('');
	let eligiblePermissions: string[] = $state([]);
	let eligibilityLoading = $state(false);
	let eligibilityError = $state('');
	let eligibilityRequest = 0;
	let purpose = $state('');
	let expiresOn = $state('');
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let showConnectionCreator = $state(false);
	let connectionName = $state('Local MCP client');
	let connectionRedirectUri = $state('http://localhost:18080/callback');
	let connectionCreating = $state(false);
	let connectionError = $state('');

	const eligibleTaskSets = $derived(
		taskSets.filter((taskSet) =>
			taskSet.permissions.every((permission) => eligiblePermissions.includes(permission))
		)
	);
	const selectedTaskSet = $derived(taskSets.find((taskSet) => taskSet.id === taskSetId));

	async function refreshEligibility(delegator: string, principal: string) {
		const request = ++eligibilityRequest;
		if (!delegator) {
			eligiblePermissions = [];
			taskSetId = '';
			eligibilityError = '';
			return;
		}
		eligibilityLoading = true;
		eligibilityError = '';
		try {
			const response = await adminAgentAccessAPI.getEligiblePermissions(
				delegator,
				principal || undefined
			);
			if (request !== eligibilityRequest) return;
			eligiblePermissions = response.permissions;
			const selected = taskSets.find((item) => item.id === taskSetId);
			if (selected?.permissions.some((permission) => !response.permissions.includes(permission))) {
				taskSetId = '';
			}
		} catch (caught) {
			if (request !== eligibilityRequest) return;
			eligiblePermissions = [];
			taskSetId = '';
			eligibilityError =
				caught instanceof Error ? caught.message : $LL.admin_agent_access_eligibility_error();
		} finally {
			if (request === eligibilityRequest) eligibilityLoading = false;
		}
	}

	$effect(() => {
		void refreshEligibility(delegatorId, principalId);
	});

	onMount(async () => {
		try {
			const [clientResponse, adminResponse, principalResponse, taskSetResponse, scopeResponse] =
				await Promise.all([
					adminClientsAPI.list({ limit: 100 }),
					adminAdminsAPI.list({ limit: 100, status: 'active' }),
					adminMachineAccessAPI
						.list({ status: 'active', limit: 100 })
						.catch(() => ({ items: [], page: 1, limit: 100 })),
					adminAgentAccessAPI.listTaskSets(),
					adminAgentAccessAPI.listScopePolicies()
				]);
			clients = clientResponse.clients.filter((client) =>
				client.requestable_scopes?.some((scope) => scope.startsWith('agent:'))
			);
			admins = adminResponse.items;
			principals = principalResponse.items.filter(
				(principal) =>
					principal.principalType === 'ai_agent' || principal.principalType === 'mcp_server'
			);
			taskSets = taskSetResponse.filter((item) => item.status === 'active');
			scopePolicies = scopeResponse.filter((item) => item.status === 'active');
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			loading = false;
		}
	});

	function isAllowedRedirectUri(value: string): boolean {
		try {
			const url = new URL(value);
			const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
			return (
				!url.username &&
				!url.password &&
				!url.hash &&
				(url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback))
			);
		} catch {
			return false;
		}
	}

	async function createMcpConnection() {
		const redirectUri = connectionRedirectUri.trim();
		if (!isAllowedRedirectUri(redirectUri)) {
			connectionError = $LL.admin_agent_access_connection_redirect_error();
			return;
		}
		if (!connectionName.trim()) {
			connectionError = $LL.admin_agent_access_connection_name_error();
			return;
		}
		connectionCreating = true;
		connectionError = '';
		try {
			const client = await adminClientsAPI.create({
				client_name: connectionName.trim(),
				description: 'MCP client connection for Authrim Admin Agent Access',
				redirect_uris: [redirectUri],
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
				token_endpoint_auth_method: 'none',
				scope: 'agent:read agent:write agent:execute',
				requestable_scopes: ['agent:read', 'agent:write', 'agent:execute'],
				require_pkce: true
			});
			clients = [...clients, client];
			clientId = client.client_id;
			showConnectionCreator = false;
		} catch (caught) {
			connectionError =
				caught instanceof Error ? caught.message : $LL.admin_agent_access_connection_create_error();
		} finally {
			connectionCreating = false;
		}
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (
			!clientId ||
			!delegatorId ||
			!taskSetId ||
			!scopePolicyId ||
			(delegationMode === 'admin_pre_authorized' && !principalId)
		) {
			error = $LL.admin_agent_access_required_selection();
			return;
		}
		saving = true;
		error = '';
		try {
			const selectedTaskSet = taskSets.find((item) => item.id === taskSetId);
			const selectedScopePolicy = scopePolicies.find((item) => item.id === scopePolicyId);
			if (!selectedTaskSet || !selectedScopePolicy) {
				error = $LL.admin_agent_access_required_selection();
				return;
			}
			const expiration = expiresOn ? new Date(`${expiresOn}T23:59:59.999`).getTime() : undefined;
			const result = await adminAgentAccessAPI.createGrant({
				client_id: clientId,
				delegator_id: delegatorId,
				machine_principal_id: principalId || undefined,
				delegation_mode: delegationMode,
				task_set_id: selectedTaskSet.id,
				task_set_version: selectedTaskSet.current_version,
				scope_policy_id: selectedScopePolicy.id,
				scope_policy_version: selectedScopePolicy.current_version,
				purpose: purpose.trim() || undefined,
				expires_at: expiration
			});
			await goto(`/admin/agent-access/grants/${encodeURIComponent(result.grant_id)}?created=1`);
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head><title>{$LL.admin_agent_access_grant_create_title()}</title></svelte:head>

<AdminPageShell width="narrow">
	<AdminPageHeader
		title={$LL.admin_agent_access_grant_create_title()}
		description={$LL.admin_agent_access_grant_create_description()}
	/>
	<AgentAccessNav />

	{#if loading}
		<div class="loading-state">{$LL.admin_agent_access_loading()}</div>
	{:else}
		{#if error}<div class="alert alert-error">{error}</div>{/if}
		<form onsubmit={submit}>
			<AdminSection>
				<div class="field">
					<label for="client">{$LL.admin_agent_access_client()}</label>
					<select id="client" bind:value={clientId} required>
						<option value="" disabled>—</option>
						{#each clients as client (client.client_id)}
							<option value={client.client_id}>{client.client_name} · {client.client_id}</option>
						{/each}
					</select>
					<p>{$LL.admin_agent_access_client_help()}</p>
					{#if clients.length === 0}
						<p class="field-error">{$LL.admin_agent_access_no_eligible_clients()}</p>
					{/if}
					<button
						class="btn btn-secondary connection-toggle"
						type="button"
						onclick={() => {
							showConnectionCreator = !showConnectionCreator;
							connectionError = '';
						}}
					>
						{$LL.admin_agent_access_add_connection()}
					</button>
				</div>
				{#if showConnectionCreator}
					<div class="connection-creator">
						<h3>{$LL.admin_agent_access_connection_title()}</h3>
						<p class="connection-description">
							{$LL.admin_agent_access_connection_help()}
						</p>
						<div class="connection-grid">
							<div class="field">
								<label for="connection-name">{$LL.admin_agent_access_connection_name()}</label>
								<input id="connection-name" bind:value={connectionName} maxlength="100" />
							</div>
							<div class="field">
								<label for="connection-redirect-uri"
									>{$LL.admin_agent_access_connection_redirect_uri()}</label
								>
								<input id="connection-redirect-uri" type="url" bind:value={connectionRedirectUri} />
							</div>
						</div>
						<p class="connection-description">
							{$LL.admin_agent_access_connection_redirect_help()}
						</p>
						{#if connectionError}<p class="field-error">{connectionError}</p>{/if}
						<button
							class="btn btn-primary"
							type="button"
							disabled={connectionCreating}
							onclick={createMcpConnection}
						>
							{connectionCreating
								? $LL.admin_agent_access_connection_creating()
								: $LL.admin_agent_access_connection_create()}
						</button>
					</div>
				{/if}
				<div class="field">
					<label for="delegator">{$LL.admin_agent_access_delegator()}</label>
					<select id="delegator" bind:value={delegatorId} required>
						<option value="" disabled>—</option>
						{#each admins as admin (admin.id)}
							<option value={admin.id}>{admin.name || admin.email} · {admin.id}</option>
						{/each}
					</select>
					<p>{$LL.admin_agent_access_delegator_help()}</p>
				</div>
				<div class="field">
					<label for="delegation-mode">{$LL.admin_agent_access_delegation_mode()}</label>
					<select id="delegation-mode" bind:value={delegationMode}>
						<option value="user_consent">{$LL.admin_agent_access_delegation_user()}</option>
						<option value="admin_pre_authorized">{$LL.admin_agent_access_delegation_admin()}</option
						>
					</select>
					<p>{$LL.admin_agent_access_delegation_help()}</p>
				</div>
				<div class="field">
					<label for="principal">{$LL.admin_agent_access_machine_principal()}</label>
					<select id="principal" bind:value={principalId}>
						<option value="">{$LL.admin_agent_access_machine_principal_none()}</option>
						{#each principals as principal (principal.id)}
							<option value={principal.id}
								>{principal.displayName} · {principal.principalType}</option
							>
						{/each}
					</select>
					<p>{$LL.admin_agent_access_machine_principal_help()}</p>
				</div>
			</AdminSection>

			<AdminSection>
				<div class="field">
					<label for="task-set">{$LL.admin_agent_access_task_sets_title()}</label>
					{#if eligibilityLoading}
						<p class="field-note">{$LL.admin_agent_access_loading()}</p>
					{:else if eligibilityError}
						<p class="field-error">{eligibilityError}</p>
					{:else if !delegatorId}
						<p class="field-note">{$LL.admin_agent_access_select_delegator_first()}</p>
					{:else}
						<select id="task-set" bind:value={taskSetId} required>
							<option value="" disabled>—</option>
							{#each eligibleTaskSets as taskSet (taskSet.id)}
								<option value={taskSet.id}>{taskSet.name} · v{taskSet.current_version}</option>
							{/each}
						</select>
						{#if selectedTaskSet?.description}
							<p class="field-note">{selectedTaskSet.description}</p>
						{/if}
						{#if eligibleTaskSets.length === 0}
							<p class="field-note">{$LL.admin_agent_access_no_eligible_permissions()}</p>
						{/if}
					{/if}
				</div>
				<div class="field">
					<label for="scope-policy">{$LL.admin_agent_access_scope_policies_title()}</label>
					<select id="scope-policy" bind:value={scopePolicyId} required>
						<option value="" disabled>—</option>
						{#each scopePolicies as policy (policy.id)}
							<option value={policy.id}>{policy.name} · v{policy.current_version}</option>
						{/each}
					</select>
				</div>
				<div class="field">
					<label for="purpose">{$LL.admin_agent_access_purpose()}</label>
					<textarea
						id="purpose"
						bind:value={purpose}
						maxlength="500"
						placeholder={$LL.admin_agent_access_purpose_placeholder()}
					></textarea>
				</div>
				<div class="field">
					<label for="expiration">{$LL.admin_agent_access_expiration()}</label>
					<input
						id="expiration"
						type="date"
						bind:value={expiresOn}
						min={new Date().toISOString().slice(0, 10)}
					/>
				</div>
			</AdminSection>

			<div class="actions">
				<a class="btn btn-secondary" href="/admin/agent-access/grants"
					>{$LL.admin_agent_access_cancel()}</a
				>
				<button class="btn btn-primary" type="submit" disabled={saving}>
					{saving ? $LL.admin_agent_access_saving() : $LL.admin_agent_access_create()}
				</button>
			</div>
		</form>
	{/if}
</AdminPageShell>

<style>
	form {
		display: grid;
		gap: 18px;
	}
	.field {
		display: grid;
		gap: 6px;
		margin-bottom: 18px;
	}
	.field:last-child {
		margin-bottom: 0;
	}
	label {
		color: var(--color-text);
		font-size: 0.84rem;
		font-weight: 700;
	}
	select,
	input,
	textarea {
		width: 100%;
		min-height: 42px;
		padding: 9px 11px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, var(--radius-sm));
		background: var(--color-surface);
		color: var(--color-text);
	}
	textarea {
		min-height: 96px;
		resize: vertical;
	}
	.field p {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.76rem;
		line-height: 1.5;
	}
	.field-error {
		margin: 0;
		color: var(--color-error) !important;
		font-size: 0.76rem;
		line-height: 1.5;
	}
	.field-note {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.76rem;
		line-height: 1.5;
	}
	.connection-toggle {
		justify-self: start;
		margin-top: 4px;
	}
	.connection-creator {
		margin: -4px 0 20px;
		padding: 16px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, var(--radius-sm));
		background: var(--color-surface-subtle, var(--color-surface));
	}
	.connection-creator h3 {
		margin: 0 0 6px;
		font-size: 0.92rem;
	}
	.connection-description {
		margin: 0 0 14px;
		color: var(--color-text-muted);
		font-size: 0.78rem;
		line-height: 1.5;
	}
	.connection-grid {
		display: grid;
		grid-template-columns: minmax(0, 2fr) minmax(120px, 1fr);
		gap: 12px;
	}
	.connection-grid .field {
		margin-bottom: 0;
	}
	@media (max-width: 640px) {
		.connection-grid {
			grid-template-columns: 1fr;
		}
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
	}
	.loading-state {
		padding: 32px;
		color: var(--color-text-muted);
		text-align: center;
	}
</style>
