<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		adminAgentAccessAPI,
		type AdminAgentGrant,
		type AgentGrantStatus
	} from '$lib/api/admin-agent-access';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AgentAccessNav
	} from '$lib/components/admin';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import { LL } from '$i18n/i18n-svelte';

	let grants: AdminAgentGrant[] = $state([]);
	let loading = $state(true);
	let error = $state('');
	let status: '' | AgentGrantStatus = $state('');
	const canCreate = $derived(adminAuth.hasPermission('admin:agent_grants:write'));

	function statusLabel(value: AgentGrantStatus): string {
		if (value === 'active') return $LL.admin_agent_access_status_active();
		if (value === 'suspended') return $LL.admin_agent_access_status_suspended();
		return $LL.admin_agent_access_status_revoked();
	}

	function formatDate(value: number | null): string {
		return value ? new Date(value).toLocaleString() : '-';
	}

	async function load() {
		loading = true;
		error = '';
		try {
			const response = await adminAgentAccessAPI.listGrants({
				status: status || undefined,
				limit: 100
			});
			grants = response.grants;
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			loading = false;
		}
	}

	onMount(load);
</script>

<svelte:head><title>{$LL.admin_agent_access_grants_title()}</title></svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_agent_access_grants_title()}
		description={$LL.admin_agent_access_grants_description()}
	>
		{#snippet actions()}
			{#if canCreate}
				<a class="btn btn-primary" href="/admin/agent-access/grants/new">
					<i class="i-ph-plus" aria-hidden="true"></i>
					{$LL.admin_agent_access_new_grant()}
				</a>
			{/if}
		{/snippet}
	</AdminPageHeader>
	<AgentAccessNav />

	<div class="filters">
		<select bind:value={status} onchange={load} aria-label={$LL.admin_agent_access_col_status()}>
			<option value="">{$LL.admin_agent_access_filter_all()}</option>
			<option value="active">{$LL.admin_agent_access_status_active()}</option>
			<option value="suspended">{$LL.admin_agent_access_status_suspended()}</option>
			<option value="revoked">{$LL.admin_agent_access_status_revoked()}</option>
		</select>
	</div>

	{#if loading}
		<div class="loading-state">{$LL.admin_agent_access_loading()}</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else}
		<AdminSection>
			<AdminDataTable>
				<thead
					><tr>
						<th>{$LL.admin_agent_access_col_client()}</th>
						<th>{$LL.admin_agent_access_col_delegator()}</th>
						<th>{$LL.admin_agent_access_col_permissions()}</th>
						<th>{$LL.admin_agent_access_col_status()}</th>
						<th>{$LL.admin_agent_access_col_updated()}</th>
					</tr></thead
				>
				<tbody>
					{#each grants as grant (grant.id)}
						<tr
							data-clickable="true"
							tabindex="0"
							role="button"
							onclick={() => goto(`/admin/agent-access/grants/${encodeURIComponent(grant.id)}`)}
							onkeydown={(event) =>
								event.key === 'Enter' &&
								goto(`/admin/agent-access/grants/${encodeURIComponent(grant.id)}`)}
						>
							<td
								><strong>{grant.client_id}</strong>
								<div class="purpose">{grant.purpose || grant.id}</div></td
							>
							<td class="mono">{grant.delegator_id}</td>
							<td>{grant.permissions.length}</td>
							<td
								><span class="status" data-status={grant.status}>{statusLabel(grant.status)}</span
								></td
							>
							<td class="nowrap">{formatDate(grant.updated_at)}</td>
						</tr>
					{:else}
						<tr><td colspan="5" class="empty">{$LL.admin_agent_access_grants_empty()}</td></tr>
					{/each}
				</tbody>
			</AdminDataTable>
		</AdminSection>
	{/if}
</AdminPageShell>

<style>
	.filters {
		display: flex;
		justify-content: flex-end;
		margin-bottom: 14px;
	}
	select {
		min-height: 38px;
		padding: 7px 34px 7px 10px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, var(--radius-sm));
		background: var(--color-surface);
		color: var(--color-text);
	}
	.purpose {
		max-width: 440px;
		margin-top: 3px;
		color: var(--color-text-muted);
		font-size: 0.76rem;
		overflow-wrap: anywhere;
	}
	.mono {
		font-family: var(--font-mono);
		font-size: 0.78rem;
	}
	.nowrap {
		white-space: nowrap;
	}
	.status {
		display: inline-flex;
		padding: 2px 8px;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		font-size: 0.72rem;
		font-weight: 700;
	}
	.status[data-status='active'] {
		color: var(--color-success);
		border-color: color-mix(in srgb, var(--color-success) 45%, var(--color-border));
	}
	.status[data-status='suspended'] {
		color: var(--color-warning);
	}
	.status[data-status='revoked'] {
		color: var(--color-error);
	}
	.empty,
	.loading-state {
		padding: 32px;
		color: var(--color-text-muted);
		text-align: center;
	}
</style>
